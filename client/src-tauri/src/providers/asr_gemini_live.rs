//
//
//
//
// ── MEASURED 2026-09-16（`dev-scripts/probe_new_asr_providers.py --target gemini-live`，
//   {"setupComplete": {}}
//   {"serverContent": {}, "voiceActivity": {"type":"ACTIVITY_START","audioOffset":"0.840s"}}
//   {"serverContent": {"generationComplete": true}}
//
//

use super::{diag, types::AsrProviderConfig};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::USER_AGENT;
use tungstenite::http::HeaderValue;

const WS_HOST: &str = "generativelanguage.googleapis.com";
const WS_PATH: &str =
    "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const SCOPE: &str = "gemini/live";
const DEFAULT_MODEL: &str = "gemini-3.5-transcribe-live";
const SAMPLE_RATE: u32 = 16000;

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;
type WsSink = SplitSink<WsStream, tungstenite::Message>;


fn resolve_model(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string()
}

fn qualified_model(model: &str) -> String {
    if model.starts_with("models/") {
        model.to_string()
    } else {
        format!("models/{}", model)
    }
}

fn ws_url(api_key: &str) -> String {
    format!(
        "wss://{}{}?key={}",
        WS_HOST,
        WS_PATH,
        urlencoding_minimal(api_key)
    )
}

///
fn urlencoding_minimal(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                vec![c]
            } else {
                format!("%{:02X}", c as u32).chars().collect()
            }
        })
        .collect()
}

///
fn setup_payload(model: &str) -> serde_json::Value {
    serde_json::json!({
        "setup": {
            "model": qualified_model(model),
            "generationConfig": { "responseModalities": ["TEXT"] },
            "inputAudioTranscription": {}
        }
    })
}

///
///
fn audio_payload(pcm_b64: &str) -> serde_json::Value {
    serde_json::json!({
        "realtimeInput": {
            "audio": {
                "mimeType": format!("audio/pcm;rate={}", SAMPLE_RATE),
                "data": pcm_b64
            }
        }
    })
}

fn audio_end_payload() -> serde_json::Value {
    serde_json::json!({ "realtimeInput": { "audioStreamEnd": true } })
}

///
fn interim_transcription(ev: &serde_json::Value) -> Option<&str> {
    ev.pointer("/serverContent/interimInputTranscription/text")
        .or_else(|| ev.pointer("/serverContent/interim_input_transcription/text"))
        .and_then(|t| t.as_str())
}

///
fn final_transcription(ev: &serde_json::Value) -> Option<&str> {
    ev.pointer("/serverContent/inputTranscription/text")
        .or_else(|| ev.pointer("/serverContent/input_transcription/text"))
        .and_then(|t| t.as_str())
}

fn is_setup_complete(ev: &serde_json::Value) -> bool {
    ev.get("setupComplete").is_some() || ev.get("setup_complete").is_some()
}

fn is_turn_done(ev: &serde_json::Value) -> bool {
    let truthy = |v: Option<&serde_json::Value>| v.map(|x| x.as_bool() != Some(false)).unwrap_or(false);
    truthy(ev.pointer("/serverContent/turnComplete"))
        || truthy(ev.pointer("/serverContent/turn_complete"))
        || truthy(ev.pointer("/serverContent/generationComplete"))
        || truthy(ev.pointer("/serverContent/generation_complete"))
}

fn error_message(ev: &serde_json::Value) -> Option<String> {
    let err = ev.get("error")?;
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown error");
    let code = err
        .get("code")
        .map(|c| format!(" code={}", c))
        .unwrap_or_default();
    Some(format!("{}{}", msg, code))
}


///
///
#[derive(Default)]
struct Transcript {
    committed: String,
    partial: String,
    finished: bool,
    error: Option<String>,
    interim_events: usize,
    final_events: usize,
}

enum Applied {
    Ignored,
    Updated,
    Finished,
    Failed,
}

impl Transcript {
    fn display(&self) -> String {
        format!("{}{}", self.committed, self.partial)
    }

    fn apply(&mut self, ev: &serde_json::Value) -> Applied {
        if let Some(err) = error_message(ev) {
            self.error = Some(err);
            self.finished = true;
            return Applied::Failed;
        }
        if let Some(text) = final_transcription(ev) {
            self.partial.clear();
            if text.is_empty() {
                return Applied::Ignored;
            }
            self.committed.push_str(text);
            self.final_events += 1;
            return Applied::Updated;
        }
        if let Some(text) = interim_transcription(ev) {
            if text.is_empty() {
                return Applied::Ignored;
            }
            self.partial.clear();
            self.partial.push_str(text);
            self.interim_events += 1;
            return Applied::Updated;
        }
        if is_turn_done(ev) {
            self.finished = true;
            return Applied::Finished;
        }
        Applied::Ignored
    }
}


async fn open_session(config: &AsrProviderConfig) -> Result<(WsStream, String), String> {
    if config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            SCOPE,
            "credentials",
            "provider_bad_key",
            "Gemini live transcription is missing the API Key; complete it in Settings".to_string(),
        ));
    }

    let model = resolve_model(config);
    let url = ws_url(&config.api_key);
    let mut request = url.as_str().into_client_request().map_err(|e| {
        let _ = e;
        diag::fail(
            SCOPE,
            "build_request",
            "Failed to build the request; check the API Key for stray characters".to_string(),
        )
    })?;
    request.headers_mut().insert(
        USER_AGENT,
        HeaderValue::from_static(concat!("SayForge/", env!("CARGO_PKG_VERSION"))),
    );

    let (mut ws, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "connect",
                format!("WebSocket connection failed: {}", e),
            )
        })?;
    diag::log(
        SCOPE,
        "connected",
        &format!(
            "status={} host={} model={} rate={}",
            response.status(),
            WS_HOST,
            model,
            SAMPLE_RATE
        ),
    );

    ws.send(tungstenite::Message::Text(
        serde_json::to_string(&setup_payload(&model))
            .unwrap()
            .into(),
    ))
    .await
    .map_err(|e| diag::fail(SCOPE, "send_setup", format!("Failed to send setup: {}", e)))?;

    let ready = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| {
                diag::fail(
                    SCOPE,
                    "recv_ack",
                    format!("Failed to receive acknowledgement: {}", e),
                )
            })?;
            let text = match msg {
                tungstenite::Message::Text(t) => t.to_string(),
                tungstenite::Message::Binary(b) => match String::from_utf8(b.to_vec()) {
                    Ok(s) => s,
                    Err(_) => continue,
                },
                tungstenite::Message::Close(frame) => {
                    let reason = frame
                        .map(|f| f.reason.to_string())
                        .unwrap_or_else(|| "No reason".to_string());
                    return Err(diag::fail(
                        SCOPE,
                        "closed_before_ready",
                        format!("Server closed the session: {}", reason),
                    ));
                }
                _ => continue,
            };
            let Ok(ev) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            if is_setup_complete(&ev) {
                return Ok(true);
            }
            if let Some(err) = error_message(&ev) {
                return Err(diag::fail(
                    SCOPE,
                    "server_error",
                    format!("Server rejected the session: {}", err),
                ));
            }
        }
        Ok(false)
    })
    .await
    .map_err(|_| {
        diag::fail(
            SCOPE,
            "setup_timeout",
            "Timed out waiting for the live session to start".to_string(),
        )
    })??;

    if !ready {
        return Err(diag::fail(
            SCOPE,
            "closed_before_ready",
            "WebSocket closed before setup completed".to_string(),
        ));
    }
    diag::log(SCOPE, "session_ready", &format!("model={}", model));
    Ok((ws, model))
}


static SINK: once_cell::sync::Lazy<Arc<Mutex<Option<WsSink>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
static READER: once_cell::sync::Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
static STATE: once_cell::sync::Lazy<Arc<Mutex<Transcript>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(Transcript::default())));
static ACTIVE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn gemini_live_open(
    app: AppHandle,
    config: AsrProviderConfig,
    hotwords: Option<Vec<String>>,
    realtime: Option<bool>,
) -> Result<(), String> {
    let realtime = realtime.unwrap_or(false);
    cleanup().await;

    let hotword_count = hotwords.as_ref().map(|h| h.len()).unwrap_or(0);
    let (ws, model) = open_session(&config).await?;

    let (sink, stream) = ws.split();
    *STATE.lock().await = Transcript::default();
    *SINK.lock().await = Some(sink);
    let handle = tokio::spawn(run_reader(stream, app, STATE.clone(), realtime));
    *READER.lock().await = Some(handle);
    ACTIVE.store(true, Ordering::SeqCst);
    diag::log(
        SCOPE,
        "stream_open",
        &format!(
            "realtime={} model={} hotwords_ignored={}",
            realtime, model, hotword_count
        ),
    );
    Ok(())
}

async fn run_reader(
    mut stream: SplitStream<WsStream>,
    app: AppHandle,
    state: Arc<Mutex<Transcript>>,
    realtime: bool,
) {
    let mut emitted = 0usize;
    let mut ended_cleanly = false;
    let mut close_reason = String::new();
    while let Some(msg) = stream.next().await {
        let text = match msg {
            Ok(tungstenite::Message::Text(t)) => t.to_string(),
            Ok(tungstenite::Message::Binary(b)) => match String::from_utf8(b.to_vec()) {
                Ok(s) => s,
                Err(_) => continue,
            },
            Ok(tungstenite::Message::Close(frame)) => {
                close_reason = frame
                    .map(|f| f.reason.to_string())
                    .unwrap_or_else(|| "no reason".to_string());
                break;
            }
            Err(e) => {
                close_reason = e.to_string();
                break;
            }
            Ok(_) => continue,
        };
        let Ok(ev) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };

        let (applied, display) = {
            let mut s = state.lock().await;
            let applied = s.apply(&ev);
            (applied, s.display())
        };
        match applied {
            Applied::Updated => {
                if realtime {
                    emitted += 1;
                    if emitted == 1 {
                        diag::log(SCOPE, "first_partial", "");
                    }
                    let _ = app.emit(
                        "asr-partial",
                        serde_json::json!({ "text": display, "provider": "gemini_live" }),
                    );
                }
            }
            Applied::Finished | Applied::Failed => {
                ended_cleanly = true;
                break;
            }
            Applied::Ignored => {}
        }
    }
    let mut s = state.lock().await;
    s.finished = true;
    if !ended_cleanly && s.error.is_none() {
        s.error = Some(format!(
            "connection closed before the turn completed: {}",
            diag::truncate(&close_reason, 200)
        ));
    }
    diag::log(
        SCOPE,
        "reader_stopped",
        &format!(
            "emits={} interim={} final={} clean={}",
            emitted, s.interim_events, s.final_events, ended_cleanly
        ),
    );
}

async fn cleanup() {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Some(mut sink) = SINK.lock().await.take() {
        let _ = sink.close().await;
    }
    if let Some(handle) = READER.lock().await.take() {
        handle.abort();
    }
    *STATE.lock().await = Transcript::default();
}

#[tauri::command]
pub async fn gemini_live_send(pcm_b64: String) -> Result<(), String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail(
            SCOPE,
            "send_without_session",
            "Session is not open".to_string(),
        ));
    }
    let payload = serde_json::to_string(&audio_payload(&pcm_b64)).unwrap();
    let mut sink = SINK.lock().await;
    let s = sink.as_mut().ok_or_else(|| {
        diag::fail(
            SCOPE,
            "send_without_session",
            "Session is not open".to_string(),
        )
    })?;
    s.send(tungstenite::Message::Text(payload.into()))
        .await
        .map_err(|e| diag::fail(SCOPE, "send_audio", format!("Failed to send audio: {}", e)))
}

#[tauri::command]
pub async fn gemini_live_finish() -> Result<String, String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail(
            SCOPE,
            "finish_without_session",
            "Session is not open".to_string(),
        ));
    }
    {
        let mut sink = SINK.lock().await;
        let s = sink.as_mut().ok_or_else(|| {
            diag::fail(
                SCOPE,
                "finish_without_session",
                "Session is not open".to_string(),
            )
        })?;
        if let Err(e) = s
            .send(tungstenite::Message::Text(
                serde_json::to_string(&audio_end_payload()).unwrap().into(),
            ))
            .await
        {
            diag::log(SCOPE, "audio_end_send_err_ignored", &e.to_string());
        }
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        {
            let st = STATE.lock().await;
            if st.finished {
                let err = st.error.clone();
                let text = st.display().trim().to_string();
                let chunks = st.final_events;
                drop(st);
                cleanup().await;
                if !text.is_empty() {
                    if let Some(err) = &err {
                        diag::log(SCOPE, "finished_with_error", err);
                    }
                    return Ok(text);
                }
                if let Some(err) = err {
                    return Err(diag::fail(
                        SCOPE,
                        "task_failed",
                        format!("Transcription failed: {}", err),
                    ));
                }
                diag::empty_result(
                    SCOPE,
                    &format!("Session finished with no transcript chunks={}", chunks),
                );
                return Ok(String::new());
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    let text = STATE.lock().await.display().trim().to_string();
    diag::log(
        SCOPE,
        "finish_timeout",
        &format!("returning partial chars={}", text.chars().count()),
    );
    cleanup().await;
    Ok(text)
}

#[tauri::command]
pub async fn gemini_live_close() -> Result<(), String> {
    cleanup().await;
    Ok(())
}


pub async fn test_connection(config: &AsrProviderConfig) -> super::types::TestResult {
    let start = Instant::now();
    let model = resolve_model(config);
    let result = async {
        let (mut ws, _) = open_session(config).await?;
        let _ = ws.close(None).await;
        Ok::<(), String>(())
    }
    .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(()) => super::types::TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: format!("model: {}", model),
        },
        Err(message) => super::types::TestResult {
            ok: false,
            message,
            elapsed_ms,
            detail: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: "gemini_live_transcribe".to_string(),
            api_key: "AIza-test".to_string(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn model_falls_back_to_the_live_default() {
        assert_eq!(resolve_model(&config(serde_json::json!({}))), DEFAULT_MODEL);
        assert_eq!(
            resolve_model(&config(serde_json::json!({ "model": " " }))),
            DEFAULT_MODEL
        );
    }

        #[test]
    fn model_is_qualified_exactly_once() {
        assert_eq!(
            qualified_model("gemini-3.5-transcribe-live"),
            "models/gemini-3.5-transcribe-live"
        );
        assert_eq!(
            qualified_model("models/gemini-3.5-transcribe-live"),
            "models/gemini-3.5-transcribe-live"
        );
    }

            #[test]
    fn setup_asks_for_text_only_and_input_transcription() {
        let payload = setup_payload(DEFAULT_MODEL);
        assert_eq!(payload["setup"]["model"], "models/gemini-3.5-transcribe-live");
        assert_eq!(
            payload["setup"]["generationConfig"]["responseModalities"][0],
            "TEXT"
        );
        assert!(payload["setup"]["inputAudioTranscription"].is_object());
    }

        #[test]
    fn audio_mime_type_carries_the_sample_rate() {
        let payload = audio_payload("QUJD");
        assert_eq!(
            payload["realtimeInput"]["audio"]["mimeType"],
            "audio/pcm;rate=16000"
        );
        assert_eq!(payload["realtimeInput"]["audio"]["data"], "QUJD");
        assert_eq!(audio_end_payload()["realtimeInput"]["audioStreamEnd"], true);
    }

            #[test]
    fn ws_url_strips_whitespace_from_the_key() {
        let url = ws_url(" AIza_abc-123 \n");
        assert!(url.starts_with("wss://generativelanguage.googleapis.com/ws/"));
        assert!(url.ends_with("?key=AIza_abc-123"));
        assert!(!url.contains(' '));
        assert!(!url.contains('\n'));
    }

    #[test]
    fn setup_complete_accepts_both_spellings() {
        assert!(is_setup_complete(&serde_json::json!({ "setupComplete": {} })));
        assert!(is_setup_complete(&serde_json::json!({ "setup_complete": {} })));
        assert!(!is_setup_complete(&serde_json::json!({ "serverContent": {} })));
    }

        #[test]
    fn transcript_reads_both_namings_and_turn_signals() {
        let camel = serde_json::json!({
            "serverContent": { "inputTranscription": { "text": "Hello" } }
        });
        assert_eq!(final_transcription(&camel), Some("Hello"));
        let snake = serde_json::json!({
            "serverContent": { "input_transcription": { "text": "hi" } }
        });
        assert_eq!(final_transcription(&snake), Some("hi"));
        let interim = serde_json::json!({
            "serverContent": { "interimInputTranscription": { "text": "In progress" } }
        });
        assert_eq!(interim_transcription(&interim), Some("In progress"));
        assert_eq!(final_transcription(&interim), None);
        assert_eq!(interim_transcription(&camel), None);

        assert!(is_turn_done(&serde_json::json!({
            "serverContent": { "generationComplete": true }
        })));
        assert!(is_turn_done(&serde_json::json!({
            "serverContent": { "turnComplete": true }
        })));
        assert!(!is_turn_done(&serde_json::json!({
            "serverContent": { "turnComplete": false }
        })));
    }

        ///
                #[test]
    fn replays_the_measured_event_stream() {
        let mut t = Transcript::default();
        let interims = ["Voice input", "Voice input method", "Voice input method test", "Voice input method test succeeded."];
        for text in interims {
            assert!(matches!(
                t.apply(&serde_json::json!({
                    "serverContent": { "interimInputTranscription": { "text": text } }
                })),
                Applied::Updated
            ));
            assert_eq!(t.display(), text);
        }
        assert_eq!(t.interim_events, 4);

        assert!(matches!(
            t.apply(&serde_json::json!({
                "serverContent": { "inputTranscription": { "text": "Voice input method test succeeded." } }
            })),
            Applied::Updated
        ));
        assert_eq!(t.display(), "Voice input method test succeeded.");
        assert_eq!(t.final_events, 1);

        assert!(matches!(
            t.apply(&serde_json::json!({ "serverContent": { "generationComplete": true } })),
            Applied::Finished
        ));
        assert!(t.finished);
    }

        #[test]
    fn multiple_final_turns_accumulate() {
        let mut t = Transcript::default();
        t.apply(&serde_json::json!({
            "serverContent": { "inputTranscription": { "text": "First sentence." } }
        }));
        t.apply(&serde_json::json!({
            "serverContent": { "interimInputTranscription": { "text": "Second" } }
        }));
        assert_eq!(t.display(), "First sentence.Second");
        t.apply(&serde_json::json!({
            "serverContent": { "inputTranscription": { "text": "Second sentence." } }
        }));
        assert_eq!(t.display(), "First sentence.Second sentence.");
    }

    #[test]
    fn empty_chunks_and_unknown_events_are_ignored() {
        let mut t = Transcript::default();
        assert!(matches!(
            t.apply(&serde_json::json!({
                "serverContent": { "interimInputTranscription": { "text": "" } }
            })),
            Applied::Ignored
        ));
        assert!(matches!(
            t.apply(&serde_json::json!({ "usageMetadata": { "totalTokenCount": 3 } })),
            Applied::Ignored
        ));
        assert!(matches!(
            t.apply(&serde_json::json!({
                "serverContent": {},
                "voiceActivity": { "type": "ACTIVITY_START", "audioOffset": "0.840s" }
            })),
            Applied::Ignored
        ));
        assert_eq!(t.interim_events, 0);
        assert_eq!(t.final_events, 0);
    }

    #[test]
    fn server_error_is_captured_with_code() {
        let mut t = Transcript::default();
        assert!(matches!(
            t.apply(&serde_json::json!({
                "error": { "code": 429, "message": "RESOURCE_EXHAUSTED" }
            })),
            Applied::Failed
        ));
        let err = t.error.unwrap();
        assert!(err.contains("RESOURCE_EXHAUSTED"));
        assert!(err.contains("429"));
    }
}
