//
//
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
use tungstenite::http::header::{AUTHORIZATION, USER_AGENT};
use tungstenite::http::HeaderValue;

const WS_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
const SCOPE: &str = "openai/live";

const DEFAULT_MODEL: &str = "gpt-live-transcribe";

const SAMPLE_RATE: u32 = 16000;

///
const DELAY: &str = "low";

///
const KEYWORD_LIMIT: usize = 100;

#[cfg(test)]
pub fn keyword_limit_for_docs() -> usize {
    KEYWORD_LIMIT
}

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

///
fn build_keywords(hotwords: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    hotwords
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .filter(|w| !w.contains('<') && !w.contains('>'))
        .filter(|w| !w.contains('\n') && !w.contains('\r'))
        .filter(|w| seen.insert(w.to_lowercase()))
        .take(KEYWORD_LIMIT)
        .map(|w| w.to_string())
        .collect()
}

///
fn session_update_payload(model: &str, hotwords: &[String]) -> serde_json::Value {
    let mut transcription = serde_json::json!({
        "model": model,
        "delay": DELAY,
    });
    let keywords = build_keywords(hotwords);
    if !keywords.is_empty() {
        diag::log(
            SCOPE,
            "hotwords",
            &format!("keywords={} of={}", keywords.len(), hotwords.len()),
        );
        transcription["keywords"] = serde_json::json!(keywords);
    }
    serde_json::json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": SAMPLE_RATE },
                    "transcription": transcription,
                    "turn_detection": serde_json::Value::Null,
                }
            }
        }
    })
}

fn append_audio_payload(pcm_b64: &str) -> serde_json::Value {
    serde_json::json!({ "type": "input_audio_buffer.append", "audio": pcm_b64 })
}

fn commit_payload() -> serde_json::Value {
    serde_json::json!({ "type": "input_audio_buffer.commit" })
}

fn event_type(ev: &serde_json::Value) -> &str {
    ev.get("type").and_then(|t| t.as_str()).unwrap_or("")
}

fn error_message(ev: &serde_json::Value) -> String {
    ev.get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown error")
        .to_string()
}

fn is_session_ready(event: &str) -> bool {
    event == "session.updated" || event == "transcription_session.updated"
}


///
#[derive(Default)]
struct Transcript {
    committed: String,
    partial: String,
    finished: bool,
    error: Option<String>,
        delta_events: usize,
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
        match event_type(ev) {
            "conversation.item.input_audio_transcription.delta" => {
                let delta = ev.get("delta").and_then(|d| d.as_str()).unwrap_or("");
                if delta.is_empty() {
                    return Applied::Ignored;
                }
                self.partial.push_str(delta);
                self.delta_events += 1;
                Applied::Updated
            }
            "conversation.item.input_audio_transcription.completed" => {
                let transcript = ev.get("transcript").and_then(|t| t.as_str()).unwrap_or("");
                self.partial.clear();
                if !transcript.is_empty() {
                    self.committed.push_str(transcript);
                }
                self.finished = true;
                Applied::Finished
            }
            "error" => {
                self.error = Some(error_message(ev));
                self.finished = true;
                Applied::Failed
            }
            _ => Applied::Ignored,
        }
    }
}


async fn open_session(
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<(WsStream, String), String> {
    if config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            SCOPE,
            "credentials",
            "provider_bad_key",
            "OpenAI transcription is missing the API Key; complete it in Settings".to_string(),
        ));
    }

    let model = resolve_model(config);
    let mut request = WS_URL.into_client_request().map_err(|e| {
        diag::fail(
            SCOPE,
            "build_request",
            format!("Failed to build request: {}", e),
        )
    })?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", config.api_key.trim())).map_err(|e| {
            diag::fail_code(
                SCOPE,
                "authorization_header",
                "provider_bad_key",
                format!("Invalid Authorization header: {}", e),
            )
        })?,
    );
    request
        .headers_mut()
        .insert("openai-beta", HeaderValue::from_static("realtime=v1"));
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
            "status={} model={} rate={}",
            response.status(),
            model,
            SAMPLE_RATE
        ),
    );

    let payload = session_update_payload(&model, hotwords);
    ws.send(tungstenite::Message::Text(
        serde_json::to_string(&payload).unwrap().into(),
    ))
    .await
    .map_err(|e| {
        diag::fail(
            SCOPE,
            "send_session_update",
            format!("Failed to send session.update: {}", e),
        )
    })?;

    let ready = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| {
                diag::fail(
                    SCOPE,
                    "recv_ack",
                    format!("Failed to receive acknowledgement: {}", e),
                )
            })?;
            match msg {
                tungstenite::Message::Text(text) => {
                    let Ok(ev) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    let name = event_type(&ev);
                    if is_session_ready(name) {
                        return Ok(true);
                    }
                    if name == "error" {
                        return Err(diag::fail(
                            SCOPE,
                            "server_error",
                            format!("Server rejected the session: {}", error_message(&ev)),
                        ));
                    }
                }
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
                _ => {}
            }
        }
        Ok(false)
    })
    .await
    .map_err(|_| {
        diag::fail(
            SCOPE,
            "session_ready_timeout",
            "Timed out waiting for the transcription session to start".to_string(),
        )
    })??;

    if !ready {
        return Err(diag::fail(
            SCOPE,
            "closed_before_ready",
            "WebSocket closed before the session became ready".to_string(),
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

///
#[tauri::command]
pub async fn openai_live_open(
    app: AppHandle,
    config: AsrProviderConfig,
    hotwords: Option<Vec<String>>,
    realtime: Option<bool>,
) -> Result<(), String> {
    let realtime = realtime.unwrap_or(false);
    cleanup().await;

    let hotwords = hotwords.unwrap_or_default();
    let (ws, model) = open_session(&config, &hotwords).await?;

    let (sink, stream) = ws.split();
    *STATE.lock().await = Transcript::default();
    *SINK.lock().await = Some(sink);
    let handle = tokio::spawn(run_reader(stream, app, STATE.clone(), realtime));
    *READER.lock().await = Some(handle);
    ACTIVE.store(true, Ordering::SeqCst);
    diag::log(
        SCOPE,
        "stream_open",
        &format!("realtime={} model={}", realtime, model),
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
            Ok(tungstenite::Message::Text(t)) => t,
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
                        serde_json::json!({ "text": display, "provider": "openai_live" }),
                    );
                }
            }
            Applied::Finished => {
                if realtime {
                    let _ = app.emit(
                        "asr-partial",
                        serde_json::json!({ "text": display, "provider": "openai_live" }),
                    );
                }
                ended_cleanly = true;
                break;
            }
            Applied::Failed => {
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
            "connection closed before the transcript completed: {}",
            diag::truncate(&close_reason, 200)
        ));
    }
    diag::log(
        SCOPE,
        "reader_stopped",
        &format!(
            "emits={} deltas={} clean={}",
            emitted, s.delta_events, ended_cleanly
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
pub async fn openai_live_send(pcm_b64: String) -> Result<(), String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail(
            SCOPE,
            "send_without_session",
            "Session is not open".to_string(),
        ));
    }
    let payload = serde_json::to_string(&append_audio_payload(&pcm_b64)).unwrap();
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
pub async fn openai_live_finish() -> Result<String, String> {
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
                serde_json::to_string(&commit_payload()).unwrap().into(),
            ))
            .await
        {
            diag::log(SCOPE, "commit_send_err_ignored", &e.to_string());
        }
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        {
            let st = STATE.lock().await;
            if st.finished {
                let err = st.error.clone();
                let text = st.display().trim().to_string();
                let deltas = st.delta_events;
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
                    &format!("Session finished with no transcript deltas={}", deltas),
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
pub async fn openai_live_close() -> Result<(), String> {
    cleanup().await;
    Ok(())
}


///
pub async fn test_connection(config: &AsrProviderConfig) -> super::types::TestResult {
    let start = Instant::now();
    let model = resolve_model(config);
    let result = async {
        let (mut ws, _) = open_session(config, &[]).await?;
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
            provider: "openai_live_transcribe".to_string(),
            api_key: "sk-test".to_string(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn model_falls_back_to_the_live_default() {
        assert_eq!(resolve_model(&config(serde_json::json!({}))), DEFAULT_MODEL);
        assert_eq!(
            resolve_model(&config(serde_json::json!({ "model": "   " }))),
            DEFAULT_MODEL
        );
        assert_eq!(
            resolve_model(&config(serde_json::json!({ "model": "gpt-transcribe" }))),
            "gpt-transcribe"
        );
    }

            #[test]
    fn session_update_matches_the_documented_shape() {
        let payload = session_update_payload(DEFAULT_MODEL, &[]);
        assert_eq!(payload["type"], "session.update");
        assert_eq!(payload["session"]["type"], "transcription");
        let input = &payload["session"]["audio"]["input"];
        assert_eq!(input["format"]["type"], "audio/pcm");
        assert_eq!(input["format"]["rate"], SAMPLE_RATE);
        assert_eq!(input["transcription"]["model"], DEFAULT_MODEL);
        assert_eq!(input["transcription"]["delay"], DELAY);
        assert!(input["turn_detection"].is_null());
        assert!(input["transcription"].get("keywords").is_none());
    }

    #[test]
    fn hotwords_become_keywords() {
        let words = vec!["SayForge".to_string(), " Kiro ".to_string()];
        let payload = session_update_payload(DEFAULT_MODEL, &words);
        let keywords = &payload["session"]["audio"]["input"]["transcription"]["keywords"];
        assert_eq!(keywords[0], "SayForge");
        assert_eq!(keywords[1], "Kiro");
    }

            #[test]
    fn illegal_keywords_are_dropped_not_forwarded() {
        let words = vec![
            "good".to_string(),
            "bad<tag>".to_string(),
            "two\nlines".to_string(),
            "carriage\rreturn".to_string(),
        ];
        assert_eq!(build_keywords(&words), vec!["good".to_string()]);
    }

    #[test]
    fn keywords_are_deduped_and_capped() {
        let words = vec!["SayForge".to_string(), "sayforge".to_string()];
        assert_eq!(build_keywords(&words).len(), 1);
        let many: Vec<String> = (0..KEYWORD_LIMIT + 50).map(|i| format!("w{}", i)).collect();
        assert_eq!(build_keywords(&many).len(), KEYWORD_LIMIT);
    }

            #[test]
    fn deltas_accumulate_and_completed_replaces_them() {
        let mut t = Transcript::default();
        t.apply(&serde_json::json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "delta": "Hello,"
        }));
        t.apply(&serde_json::json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "delta": " how are"
        }));
        assert_eq!(t.display(), "Hello, how are");
        assert_eq!(t.delta_events, 2);

        t.apply(&serde_json::json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "Hello, how are you?"
        }));
        assert_eq!(t.display(), "Hello, how are you?");
        assert!(t.finished);
    }

    #[test]
    fn empty_deltas_are_ignored() {
        let mut t = Transcript::default();
        assert!(matches!(
            t.apply(&serde_json::json!({
                "type": "conversation.item.input_audio_transcription.delta",
                "delta": ""
            })),
            Applied::Ignored
        ));
        assert_eq!(t.delta_events, 0);
        assert!(matches!(
            t.apply(&serde_json::json!({ "type": "input_audio_buffer.committed" })),
            Applied::Ignored
        ));
    }

    #[test]
    fn server_error_is_captured() {
        let mut t = Transcript::default();
        assert!(matches!(
            t.apply(&serde_json::json!({
                "type": "error",
                "error": { "message": "insufficient_quota" }
            })),
            Applied::Failed
        ));
        assert_eq!(t.error.as_deref(), Some("insufficient_quota"));
        assert!(t.finished);
    }

            #[test]
    fn both_ready_event_names_are_accepted() {
        assert!(is_session_ready("session.updated"));
        assert!(is_session_ready("transcription_session.updated"));
        assert!(!is_session_ready("session.created"));
    }
}
