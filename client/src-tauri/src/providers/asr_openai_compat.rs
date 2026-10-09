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
    format!("{}|{}", field("baseUrl"), field("model"))
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

///
fn looks_like_wrong_route(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("404")
        || lower.contains("405")
        || lower.contains("not found")
        || lower.contains("method not allowed")
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
    if let Some(chosen) = explicit_protocol(config) {
        diag::log(SCOPE, "manual", &format!("protocol={}", chosen));
        return run(chosen, audio_pcm_b64, sample_rate, config, hotwords).await;
    }

    let key = cache_key(config);
    if let Some(chosen) = cached_protocol(&key) {
        diag::log(SCOPE, "cached", &format!("protocol={}", chosen));
        return run(chosen, audio_pcm_b64, sample_rate, config, hotwords).await;
    }

    diag::log(SCOPE, "probe", "trying /audio/transcriptions first");
    let first = run(AS_TRANSCRIPTIONS, audio_pcm_b64, sample_rate, config, hotwords).await;
    let first_error = match first {
        Ok(result) => {
            remember_protocol(&key, AS_TRANSCRIPTIONS);
            diag::log(SCOPE, "detected", "protocol=transcriptions");
            return Ok(result);
        }
        Err(error) => error,
    };

    diag::log(
        SCOPE,
        "probe",
        &format!(
            "/audio/transcriptions failed, trying /chat/completions: {}",
            diag::truncate(&first_error, 200)
        ),
    );
    // Prefer the standard OpenAI object. A strict gateway may discard the Bailian
    // string payload; when a custom user prompt is present it could otherwise
    // return a plausible text answer and be incorrectly cached as transcription.
    match run(AS_CHAT_STANDARD, audio_pcm_b64, sample_rate, config, hotwords).await {
        Ok(result) => {
            remember_protocol(&key, AS_CHAT_STANDARD);
            diag::log(SCOPE, "detected", "protocol=chat_standard");
            Ok(result)
        }
        Err(standard_error) => {
            // Bailian/legacy services accept data URL strings instead.
            match run(AS_CHAT, audio_pcm_b64, sample_rate, config, hotwords).await {
                Ok(result) => {
                    remember_protocol(&key, AS_CHAT);
                    diag::log(SCOPE, "detected", "protocol=chat");
                    Ok(result)
                }
                Err(data_url_error) => {
                    let error = if !looks_like_wrong_route(&standard_error) {
                        standard_error
                    } else if !looks_like_wrong_route(&data_url_error) {
                        data_url_error
                    } else {
                        first_error
                    };
                    diag::log(SCOPE, "all_failed", &format!("error={}", diag::truncate(&error, 200)));
                    Err(error)
                }
            }
        }
    }
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    if let Some(chosen) = explicit_protocol(config) {
        return labelled(chosen, run_test(chosen, config).await);
    }

    let key = cache_key(config);
    if let Some(chosen) = cached_protocol(&key) {
        return labelled(chosen, run_test(chosen, config).await);
    }

    let first = run_test(AS_TRANSCRIPTIONS, config).await;
    if first.ok {
        remember_protocol(&key, AS_TRANSCRIPTIONS);
        return labelled(AS_TRANSCRIPTIONS, first);
    }
    let second = run_test(AS_CHAT_STANDARD, config).await;
    if second.ok {
        remember_protocol(&key, AS_CHAT_STANDARD);
        return labelled(AS_CHAT_STANDARD, second);
    }
    let third = run_test(AS_CHAT, config).await;
    if third.ok {
        remember_protocol(&key, AS_CHAT);
        return labelled(AS_CHAT, third);
    }
    if !looks_like_wrong_route(&second.message) {
        second
    } else if !looks_like_wrong_route(&third.message) {
        third
    } else {
        first
    }
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
    fn wrong_route_detection_stays_narrow() {
        assert!(looks_like_wrong_route("Transcription error 404 [http=404]: not found"));
        assert!(looks_like_wrong_route("error 405 Method Not Allowed"));

        assert!(!looks_like_wrong_route("Invalid API key"));
        assert!(!looks_like_wrong_route("model not_a_model does not exist"));
        assert!(!looks_like_wrong_route("Transcription error 401 [http=401]: unauthorized"));
        assert!(!looks_like_wrong_route("insufficient balance"));
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
}
