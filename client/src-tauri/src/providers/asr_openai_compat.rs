//
//
// `dev-scripts/probe_bailian_openai_audio.py`）：
//
//
//
//

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::collections::HashMap;
use std::sync::Mutex;

const SCOPE: &str = "openai-compat/dispatch";

const AS_TRANSCRIPTIONS: &str = "openai_compat_transcribe";
const AS_CHAT: &str = "openai_chat_audio";
const AS_CHAT_STANDARD: &str = "openai_chat_audio_standard";

///
static PROTOCOL_CACHE: Mutex<Option<HashMap<String, &'static str>>> = Mutex::new(None);

fn cache_key_from_extra(extra: &serde_json::Value) -> String {
    let field = |name: &str| {
        extra
            .get(name)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    serde_json::to_string(&(field("baseUrl").trim_end_matches('/'), field("model"))).unwrap()
}

fn cache_key(config: &AsrProviderConfig) -> String {
    cache_key_from_extra(&config.extra)
}

///
///
pub fn detected_protocol(extra: &serde_json::Value) -> Option<&'static str> {
    cached_protocol(&cache_key_from_extra(extra))
}

fn cached_protocol(key: &str) -> Option<&'static str> {
    let guard = PROTOCOL_CACHE.lock().ok()?;
    guard.as_ref()?.get(key).copied()
}

fn remember_protocol(key: &str, protocol: &'static str) {
    if let Ok(mut guard) = PROTOCOL_CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(key.to_string(), protocol);
    }
}

fn explicit_protocol(config: &AsrProviderConfig) -> Option<&'static str> {
    match config.extra.get("protocol").and_then(|v| v.as_str()) {
        Some("transcriptions") => Some(AS_TRANSCRIPTIONS),
        Some("chat") => Some(AS_CHAT),
        Some("chat_standard") => Some(AS_CHAT_STANDARD),
        _ => None,
    }
}

fn with_provider(config: &AsrProviderConfig, provider: &str) -> AsrProviderConfig {
    AsrProviderConfig {
        provider: provider.to_string(),
        api_key: config.api_key.clone(),
        app_id: config.app_id.clone(),
        extra: config.extra.clone(),
    }
}

pub(super) fn may_probe_next(error: &str) -> bool {
    matches!(crate::error_protocol::code(error), Some("asr_route_unsupported" | "asr_protocol_unsupported"))
}

fn forget_protocol(key: &str) {
    if let Ok(mut guard) = PROTOCOL_CACHE.lock() {
        if let Some(cache) = guard.as_mut() { cache.remove(key); }
    }
}

fn candidates(key: &str) -> Vec<&'static str> {
    let mut result = Vec::with_capacity(3);
    if let Some(cached) = cached_protocol(key) { result.push(cached); }
    for protocol in [AS_TRANSCRIPTIONS, AS_CHAT_STANDARD, AS_CHAT] {
        if !result.contains(&protocol) { result.push(protocol); }
    }
    result
}

async fn run(
    provider: &str,
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let scoped = with_provider(config, provider);
    if provider == AS_CHAT || provider == AS_CHAT_STANDARD {
        super::asr_openai_chat_audio::transcribe(audio_pcm_b64, sample_rate, &scoped, hotwords).await
    } else {
        super::asr_transcriptions::transcribe(audio_pcm_b64, sample_rate, &scoped, hotwords).await
    }
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    if audio_pcm_b64.is_empty() {
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }
    if let Some(chosen) = explicit_protocol(config) {
        diag::log(SCOPE, "manual", &format!("protocol={}", chosen));
        return run(chosen, audio_pcm_b64, sample_rate, config, hotwords).await;
    }

    let key = cache_key(config);
    let mut last_error = String::new();
    for (index, chosen) in candidates(&key).into_iter().enumerate() {
        diag::log(SCOPE, "attempt", &format!("number={} protocol={chosen}", index + 1));
        match run(chosen, audio_pcm_b64, sample_rate, config, hotwords).await {
            Ok(result) => {
                remember_protocol(&key, chosen);
                return Ok(result);
            }
            Err(error) => {
                if !may_probe_next(&error) { return Err(error); }
                forget_protocol(&key);
                last_error = error;
            }
        }
    }
    Err(last_error)
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    if let Some(chosen) = explicit_protocol(config) {
        return labelled(chosen, run_test(chosen, config).await);
    }
    let key = cache_key(config);
    let mut last = None;
    for chosen in candidates(&key) {
        let result = run_test(chosen, config).await;
        if result.ok {
            remember_protocol(&key, chosen);
            return labelled(chosen, result);
        }
        if !may_probe_next(&result.message) { return result; }
        forget_protocol(&key);
        last = Some(result);
    }
    last.expect("protocol candidates are nonempty")
}

async fn run_test(provider: &str, config: &AsrProviderConfig) -> TestResult {
    let scoped = with_provider(config, provider);
    if provider == AS_CHAT || provider == AS_CHAT_STANDARD {
        super::asr_openai_chat_audio::test_connection(&scoped).await
    } else {
        super::asr_transcriptions::test_connection(&scoped).await
    }
}

///
fn labelled(provider: &str, mut result: TestResult) -> TestResult {
    if result.ok {
        let name = if provider == AS_CHAT_STANDARD {
            "/chat/completions (standard input_audio)"
        } else if provider == AS_CHAT {
            "/chat/completions"
        } else {
            "/audio/transcriptions"
        };
        let hotwords = if provider == AS_CHAT || provider == AS_CHAT_STANDARD {
            "hotwords: sent as context"
        } else {
            "hotwords: not sent on this protocol"
        };
        result.message = format!("{} [{} · {}]", result.message, name, hotwords);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: "openai_compat".to_string(),
            api_key: "k".to_string(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn explicit_protocol_wins_over_detection() {
        assert_eq!(
            explicit_protocol(&config(serde_json::json!({ "protocol": "chat" }))),
            Some(AS_CHAT),
        );
        assert_eq!(
            explicit_protocol(&config(serde_json::json!({ "protocol": "chat_standard" }))),
            Some(AS_CHAT_STANDARD),
        );
        assert_eq!(
            explicit_protocol(&config(serde_json::json!({ "protocol": "transcriptions" }))),
            Some(AS_TRANSCRIPTIONS),
        );
        assert_eq!(explicit_protocol(&config(serde_json::json!({ "protocol": "auto" }))), None);
        assert_eq!(explicit_protocol(&config(serde_json::json!({}))), None);
        assert_eq!(explicit_protocol(&config(serde_json::json!({ "protocol": "nope" }))), None);
    }

            #[test]
    fn cache_key_covers_both_address_and_model() {
        let a = cache_key(&config(serde_json::json!({ "baseUrl": "http://x/v1", "model": "m1" })));
        let b = cache_key(&config(serde_json::json!({ "baseUrl": "http://x/v1", "model": "m2" })));
        let c = cache_key(&config(serde_json::json!({ "baseUrl": "http://y/v1", "model": "m1" })));
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(
            a,
            cache_key(&config(serde_json::json!({ "baseUrl": "http://x/v1", "model": "m1" }))),
        );
    }

    #[test]
    fn the_cache_round_trips() {
        let key = "cache-round-trip|model";
        assert_eq!(cached_protocol(key), None);
        remember_protocol(key, AS_CHAT);
        assert_eq!(cached_protocol(key), Some(AS_CHAT));
    }

        ///
            #[test]
    fn protocol_probe_requires_a_structured_compatibility_error() {
        for code in ["asr_route_unsupported", "asr_protocol_unsupported"] {
            assert!(may_probe_next(&crate::error_protocol::encode(code, "synthetic")));
        }
        for code in ["provider_bad_key", "provider_forbidden", "provider_rate_limit", "provider_timeout",
            "provider_unreachable", "provider_internal", "asr_audio_unsupported", "connect_failed"] {
            assert!(!may_probe_next(&crate::error_protocol::encode(code, "404 not found")));
        }
        assert!(!may_probe_next("404 not found"));
    }

        #[test]
    fn the_detected_protocol_shows_up_in_a_successful_test() {
        let ok = labelled(AS_CHAT, TestResult {
            ok: true,
            message: "Connection successful".to_string(),
            elapsed_ms: 1,
            detail: String::new(),
        });
        assert!(ok.message.contains("/chat/completions"), "got {}", ok.message);

        let failed = labelled(AS_CHAT, TestResult {
            ok: false,
            message: "Invalid API key".to_string(),
            elapsed_ms: 1,
            detail: String::new(),
        });
        assert_eq!(failed.message, "Invalid API key");
    }

    fn mock_http(responses: Vec<(u16, &'static str)>) -> (
        String, std::sync::Arc<std::sync::atomic::AtomicBool>, std::thread::JoinHandle<Vec<(String, Vec<u8>)>>,
    ) {
        mock_http_throttled(responses, None)
    }

    fn mock_http_throttled(responses: Vec<(u16, &'static str)>, bytes_per_second: Option<u64>) -> (
        String, std::sync::Arc<std::sync::atomic::AtomicBool>, std::thread::JoinHandle<Vec<(String, Vec<u8>)>>,
    ) {
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let handle = std::thread::spawn(move || {
            let mut paths = Vec::new();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while !done.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(_) => { std::thread::sleep(std::time::Duration::from_millis(1)); continue; }
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(1))).unwrap();
                let mut request = Vec::new();
                let header_end = loop {
                    let mut chunk = [0u8; 4096];
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") { break end + 4; }
                };
                let header = String::from_utf8_lossy(&request[..header_end]);
                let path = header.lines().next().unwrap().split_whitespace().nth(1).unwrap().to_string();
                let length = header.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|n| n.trim().parse::<usize>().unwrap())).unwrap_or(0);
                while request.len() < header_end + length {
                    let mut chunk = [0u8; 4096];
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(rate) = bytes_per_second {
                        std::thread::sleep(std::time::Duration::from_secs_f64(n as f64 / rate as f64));
                    }
                }
                let (status, body) = responses.get(paths.len()).copied().unwrap_or((500, "unexpected request"));
                paths.push((path, request));
                if status != 0 {
                    write!(stream, "HTTP/1.1 {status} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
            }
            paths
        });
        (url, stop, handle)
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    fn stop_server(stop: std::sync::Arc<std::sync::atomic::AtomicBool>, handle: std::thread::JoinHandle<Vec<(String, Vec<u8>)>>) -> Vec<String> {
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        handle.join().unwrap().into_iter().map(|(path, _)| path).collect()
    }

    #[test]
    fn normal_api_and_network_failures_make_exactly_one_attempt() {
        use base64::Engine;
        let audio = base64::engine::general_purpose::STANDARD.encode([0u8; 320]);
        for (status, body) in [
            (401, r#"{"error":{"message":"prompt unsupported 404 not found"}}"#),
            (403, "404 not found"), (429, "prompt unsupported"), (500, "prompt unsupported"),
            (502, "404"), (415, "unsupported MP3"), (400, "unknown error"),
            (404, r#"{"error":{"code":"model_not_found"}}"#), (0, ""),
        ] {
            for connection_test in [false, true] {
                let (url, stop, server) = mock_http(vec![(status, body)]);
                let cfg = config(serde_json::json!({"baseUrl": url, "model": "synthetic"}));
                runtime().block_on(async {
                    if connection_test { assert!(!test_connection(&cfg).await.ok); }
                    else { assert!(transcribe(&audio, 16000, &cfg, &[]).await.is_err()); }
                });
                assert_eq!(stop_server(stop, server), ["/v1/audio/transcriptions"], "status={status} test={connection_test}");
            }
        }
    }

    #[test]
    fn detects_caches_and_invalidates_only_an_incompatible_cached_protocol() {
        use base64::Engine;
        let audio = base64::engine::general_purpose::STANDARD.encode([0u8; 320]);
        let (url, stop, server) = mock_http(vec![
            (404, r#"{"detail":"Not Found"}"#),
            (200, r#"{"choices":[{"message":{"content":"Synthetic"}}]}"#),
            (405, ""), (200, r#"{"text":"Synthetic"}"#),
        ]);
        let cfg = config(serde_json::json!({"baseUrl": url, "model": "synthetic"}));
        runtime().block_on(async {
            assert_eq!(transcribe(&audio, 16000, &cfg, &[]).await.unwrap().text, "Synthetic");
            assert_eq!(detected_protocol(&cfg.extra), Some(AS_CHAT_STANDARD));
            assert_eq!(transcribe(&audio, 16000, &cfg, &[]).await.unwrap().text, "Synthetic");
            assert_eq!(detected_protocol(&cfg.extra), Some(AS_TRANSCRIPTIONS));
        });
        assert_eq!(stop_server(stop, server), ["/v1/audio/transcriptions", "/v1/chat/completions", "/v1/chat/completions", "/v1/audio/transcriptions"]);
    }

    #[test]
    fn explicit_protocol_never_falls_back_and_empty_audio_never_sets_detection() {
        use base64::Engine;
        let (url, stop, server) = mock_http(vec![(405, "")]);
        let cfg = config(serde_json::json!({"baseUrl": url, "model": "synthetic", "protocol": "chat_standard"}));
        runtime().block_on(async {
            assert!(transcribe(&base64::engine::general_purpose::STANDARD.encode([0u8; 320]), 16000, &cfg, &[]).await.is_err());
            assert!(transcribe("", 16000, &cfg, &[]).await.unwrap().text.is_empty());
            assert_eq!(detected_protocol(&cfg.extra), None);
        });
        assert_eq!(stop_server(stop, server), ["/v1/chat/completions"]);
    }

    #[test]
    fn only_a_structured_audio_shape_error_tries_legacy_chat() {
        use base64::Engine;
        let (url, stop, server) = mock_http(vec![
            (404, r#"{"detail":"Not Found"}"#),
            (422, r#"{"detail":[{"type":"string_type","loc":["messages",1,"content",0,"input_audio"]}]}"#),
            (200, r#"{"choices":[{"message":{"content":"Synthetic"}}]}"#),
        ]);
        let cfg = config(serde_json::json!({"baseUrl": url, "model": "synthetic"}));
        runtime().block_on(async {
            assert!(test_connection(&cfg).await.ok);
            assert_eq!(detected_protocol(&cfg.extra), Some(AS_CHAT));
        });
        assert_eq!(stop_server(stop, server), ["/v1/audio/transcriptions", "/v1/chat/completions", "/v1/chat/completions"]);
    }

    #[test]
    fn a_real_request_timeout_is_not_a_protocol_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        runtime().block_on(async {
            let error = reqwest::Client::new().get(url).timeout(std::time::Duration::from_millis(10)).send().await.unwrap_err();
            assert!(error.is_timeout());
            let encoded = diag::request_failure("synthetic", "http_send", &error);
            assert_eq!(crate::error_protocol::code(&encoded), Some("provider_timeout"));
            assert!(!may_probe_next(&encoded));
        });
    }

    fn synthetic_pcm(seconds: usize) -> Vec<u8> {
        (0..16000 * seconds).flat_map(|i| {
            let sample = ((i as f32 * 2.0 * std::f32::consts::PI * 440.0 / 16000.0).sin() * 8000.0) as i16;
            sample.to_le_bytes()
        }).collect()
    }

    #[test]
    fn selected_codec_reaches_multipart_standard_chat_and_legacy_chat() {
        use base64::Engine;
        let pcm = synthetic_pcm(1);
        let audio = base64::engine::general_purpose::STANDARD.encode(&pcm);
        for protocol in ["transcriptions", "chat_standard", "chat"] {
            for encoding in ["mp3", "wav"] {
                let (url, stop, server) = mock_http(vec![(200, r#"{"text":"Synthetic","choices":[{"message":{"content":"Synthetic"}}]}"#)]);
                let cfg = config(serde_json::json!({"baseUrl":url,"model":"synthetic","protocol":protocol,"audioEncoding":encoding}));
                runtime().block_on(async { assert_eq!(transcribe(&audio, 16000, &cfg, &[]).await.unwrap().text, "Synthetic"); });
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
                let requests = server.join().unwrap();
                assert_eq!(requests.len(), 1);
                let request = &requests[0].1;
                let header_end = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
                let body = &request[header_end..];
                if protocol == "transcriptions" {
                    let text = String::from_utf8_lossy(body);
                    assert!(text.contains(&format!("filename=\"audio.{encoding}\"")));
                    assert!(text.contains(if encoding == "mp3" { "audio/mpeg" } else { "audio/wav" }));
                    if encoding == "wav" { assert!(body.windows(4).any(|w| w == b"RIFF")); }
                } else {
                    let json: serde_json::Value = serde_json::from_slice(body).unwrap();
                    let fields: Vec<_> = json["messages"].as_array().unwrap().iter().flat_map(|m| m["content"].as_array().unwrap()).collect();
                    let input = &fields.iter().find(|f| f["type"] == "input_audio").unwrap()["input_audio"];
                    if protocol == "chat" { assert!(input.as_str().unwrap().starts_with("data:audio/wav;base64,")); }
                    else {
                        assert_eq!(input["format"], encoding);
                        let bytes = base64::engine::general_purpose::STANDARD.decode(input["data"].as_str().unwrap()).unwrap();
                        if encoding == "wav" { assert_eq!(&bytes[44..], pcm); }
                        else { assert!(bytes.len() < pcm.len() / 2); }
                    }
                }
            }
        }
        assert!(super::super::asr_openai_chat_audio::pcm_to_mp3(&[0], 16000).is_err());
    }

    #[test]
    #[ignore = "synthetic encoding/upload benchmark; run explicitly with --nocapture"]
    fn benchmark_cloud_audio_formats() {
        use base64::Engine;
        for seconds in [8, 30, 60] {
            let pcm = synthetic_pcm(seconds);
            for encoding in ["wav", "mp3"] {
                let start = std::time::Instant::now();
                let encoded = if encoding == "mp3" { super::super::asr_openai_chat_audio::pcm_to_mp3(&pcm, 16000).unwrap() }
                    else { super::super::asr_openai_chat_audio::pcm_to_wav(&pcm, 16000) };
                let encode_ms = start.elapsed().as_secs_f64() * 1000.0;
                for rate in [None, Some(256_000)] {
                    let (url, stop, server) = mock_http_throttled(vec![(200, r#"{"text":"Synthetic"}"#)], rate);
                    let cfg = config(serde_json::json!({"baseUrl":url,"model":"synthetic","protocol":"transcriptions","audioEncoding":encoding}));
                    let input = base64::engine::general_purpose::STANDARD.encode(&pcm);
                    let start = std::time::Instant::now();
                    runtime().block_on(async { transcribe(&input, 16000, &cfg, &[]).await.unwrap(); });
                    let total_ms = start.elapsed().as_secs_f64() * 1000.0;
                    stop.store(true, std::sync::atomic::Ordering::SeqCst);
                    let requests = server.join().unwrap();
                    let request = &requests[0].1;
                    let body_start = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
                    println!("BENCH seconds={seconds} codec={encoding} bytes={} encode_ms={encode_ms:.3} rate={rate:?} body_bytes={} native_total_ms={total_ms:.3}", encoded.len(), request.len() - body_start);
                }
            }
        }
    }
}
