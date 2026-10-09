use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::time::Instant;

struct Endpoint {
    url: &'static str,
        default_model: &'static str,
        scope: &'static str,
        ///
                        honors_selected_model: bool,
        ///
                    allows_custom_url: bool,
        requires_custom_url: bool,
        ///
            retry_without_prompt: bool,
}

///
const OPENAI_COMPAT: Endpoint = Endpoint {
    url: "",
    default_model: "whisper-1",
    scope: "openai-compat/asr",
    honors_selected_model: true,
    allows_custom_url: true,
    requires_custom_url: true,
    retry_without_prompt: true,
};

fn endpoint_for(_provider: &str) -> &'static Endpoint {
    &OPENAI_COMPAT
}

///
fn join_transcriptions_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/audio/transcriptions") {
        trimmed.to_string()
    } else {
        format!("{}/audio/transcriptions", trimmed)
    }
}

fn resolve_url(config: &AsrProviderConfig, endpoint: &Endpoint) -> Result<String, String> {
    let supplied = if endpoint.allows_custom_url {
        config
            .extra
            .get("baseUrl")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
    } else {
        ""
    };
    if !supplied.is_empty() {
        return Ok(join_transcriptions_url(supplied));
    }
    if endpoint.requires_custom_url {
        return Err(diag::fail(
            endpoint.scope,
            "missing_base_url",
            "No endpoint address configured for this service".to_string(),
        ));
    }
    Ok(endpoint.url.to_string())
}

///
fn resolve_model(config: &AsrProviderConfig, endpoint: &Endpoint) -> String {
    if !endpoint.honors_selected_model {
        return endpoint.default_model.to_string();
    }
    config
        .extra
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(endpoint.default_model)
        .to_string()
}

///
///
///
///
///
const PUNCTUATION_PROMPT: &str = "Transcribe the audio faithfully, with natural punctuation, correct capitalization, and no extra explanation.";

///
fn pcm_to_wav(pcm: &[u8], sr: u32) -> Vec<u8> {
    let ds = pcm.len() as u32;
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + ds).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&sr.to_le_bytes());
    w.extend_from_slice(&(sr * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&ds.to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

///
fn resolve_language(config: &AsrProviderConfig) -> Option<String> {
    let raw = config
        .extra
        .get("language")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("auto");
    match raw {
        "auto" => None,
        other => Some(other.to_string()),
    }
}

fn build_form(
    wav: Vec<u8>,
    model: &str,
    language: Option<&str>,
    scope: &str,
    with_prompt: bool,
) -> Result<reqwest::multipart::Form, String> {
    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| diag::fail(scope, "build_form", format!("Failed to build the audio part: {}", e)))?;

    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string())
        .text("response_format", "json");
    if with_prompt {
        form = form.text("prompt", PUNCTUATION_PROMPT);
    }
    if let Some(lang) = language {
        form = form.text("language", lang.to_string());
    }
    Ok(form)
}

fn extract_text(data: &serde_json::Value) -> String {
    data.get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

///
///
fn extract_text_or_plain(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(data) => extract_text(&data),
        Err(_) => body.trim().to_string(),
    }
}

///
fn complains_about_prompt(body: &str) -> bool {
    let lower = body.to_lowercase();
    lower.contains("prompt")
        && (lower.contains("unknown")
            || lower.contains("unexpected")
            || lower.contains("not allowed")
            || lower.contains("unsupported")
            || lower.contains("extra")
            || lower.contains("invalid"))
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let endpoint = endpoint_for(&config.provider);
    let scope = endpoint.scope;

    //
    if !hotwords.is_empty() {
        diag::log(
            scope,
            "hotwords_ignored",
            &format!(
                "count={} reason=prompt_field_used_for_punctuation",
                hotwords.len()
            ),
        );
    }
    let pcm = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        audio_pcm_b64,
    )
    .map_err(|e| diag::fail(scope, "decode_b64", format!("Failed to decode base64 audio: {}", e)))?;

    if pcm.is_empty() {
        diag::empty_result(scope, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }

    let audio_sec = pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0);
    let language = resolve_language(config);
    let model = resolve_model(config, endpoint);
    let url = resolve_url(config, endpoint)?;
    let wav = pcm_to_wav(&pcm, sample_rate);

    diag::log(
        scope,
        "start",
        &format!(
            "wav_bytes={} audio_sec={:.1} rate={} language={}",
            wav.len(),
            audio_sec,
            sample_rate,
            language.as_deref().unwrap_or("auto(omitted)")
        ),
    );

    let client = super::http_client::shared();
    let start = Instant::now();

    let mut with_prompt = true;
    let (body_text, http_summary, elapsed_ms) = loop {
        let form = build_form(wav.clone(), &model, language.as_deref(), scope, with_prompt)?;
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .multipart(form)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| diag::request_failure(scope, "http_send", &e))?;

        let elapsed_ms = start.elapsed().as_millis() as u64;
        let http_summary = diag::http_summary(resp.status(), resp.headers());

        if resp.status().is_success() {
            let body_text = resp.text().await.map_err(|e| {
                diag::request_failure(scope, "read_body", &e)
            })?;
            break (body_text, http_summary, elapsed_ms);
        }

        let status = resp.status();
        let body = resp.text().await.map_err(|e| diag::request_failure(scope, "read_body", &e))?;
        if with_prompt && endpoint.retry_without_prompt
            && matches!(status, reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNPROCESSABLE_ENTITY)
            && complains_about_prompt(&body) {
            diag::log(
                scope,
                "retry_without_prompt",
                &format!(
                    "The endpoint rejected the prompt field; retrying without it \
                     (Chinese punctuation may be missing). {}",
                    "prompt field unsupported"
                ),
            );
            with_prompt = false;
            continue;
        }
        return Err(diag::http_failure(scope, status, &body));
    };

    //
    let text = if endpoint.requires_custom_url {
        extract_text_or_plain(&body_text)
    } else {
        let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
            diag::fail(
                scope,
                "parse_json",
                format!(
                    "Invalid response JSON: {} [{}]", e, http_summary
                ),
            )
        })?;
        extract_text(&data)
    };
    if text.is_empty() {
        diag::empty_result(
            scope,
            &format!(
                "Response contained no transcript audio_sec={:.1} elapsed={}ms [{}] {}",
                audio_sec,
                elapsed_ms,
                http_summary,
                diag::describe_json(&body_text)
            ),
        );
    } else {
        diag::ok(scope, elapsed_ms, text.chars().count());
    }

    Ok(AsrResult { text, elapsed_ms })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let endpoint = endpoint_for(&config.provider);
    let silence = vec![0u8; 16000];
    let wav = pcm_to_wav(&silence, 16000);
    let model = resolve_model(config, endpoint);

    let url = match resolve_url(config, endpoint) {
        Ok(u) => u,
        Err(e) => {
            return TestResult {
                ok: false,
                message: e,
                elapsed_ms: 0,
                detail: String::new(),
            }
        }
    };

    let form = match build_form(wav, &model, None, endpoint.scope, true) {
        Ok(f) => f,
        Err(e) => {
            return TestResult {
                ok: false,
                message: e,
                elapsed_ms: 0,
                detail: String::new(),
            }
        }
    };

    let client = super::http_client::shared();
    let start = Instant::now();

    let result = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .multipart(form)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: String::new(),
        },
        Ok(resp) => {
            let status = resp.status();
            let message = match resp.text().await {
                Ok(body) => diag::http_failure(endpoint.scope, status, &body),
                Err(e) => diag::request_failure(endpoint.scope, "read_body", &e),
            };
            TestResult { ok: false, message, elapsed_ms, detail: String::new() }
        }
        Err(e) => TestResult {
            ok: false,
            message: diag::request_failure(endpoint.scope, "http_send", &e),
            elapsed_ms,
            detail: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_language(value: serde_json::Value) -> AsrProviderConfig {
        config_for("openai_compat_transcribe", value)
    }

    fn config_for(provider: &str, extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: provider.to_string(),
            api_key: String::new(),
            app_id: String::new(),
            extra,
        }
    }

        ///
            #[test]
    fn base_url_is_joined_into_a_transcriptions_path() {
        let expected = "http://127.0.0.1:8000/v1/audio/transcriptions";
        assert_eq!(join_transcriptions_url("http://127.0.0.1:8000/v1"), expected);
        assert_eq!(join_transcriptions_url("http://127.0.0.1:8000/v1/"), expected);
        assert_eq!(join_transcriptions_url("  http://127.0.0.1:8000/v1  "), expected);
        assert_eq!(join_transcriptions_url(expected), expected);
        assert_eq!(join_transcriptions_url(&format!("{expected}/")), expected);
    }

        #[test]
    fn a_custom_endpoint_without_an_address_fails_before_sending() {
        let missing = config_for("openai_compat_transcribe", serde_json::json!({}));
        assert!(resolve_url(&missing, endpoint_for("openai_compat_transcribe")).is_err());
        let blank = config_for("openai_compat_transcribe", serde_json::json!({ "baseUrl": "   " }));
        assert!(resolve_url(&blank, endpoint_for("openai_compat_transcribe")).is_err());

        let filled = config_for(
            "openai_compat_transcribe",
            serde_json::json!({ "baseUrl": "http://localhost:9000/v1" }),
        );
        assert_eq!(
            resolve_url(&filled, endpoint_for("openai_compat_transcribe")).unwrap(),
            "http://localhost:9000/v1/audio/transcriptions",
        );
    }

        ///
        #[test]
    fn prompt_retry_only_triggers_on_complaints_about_prompt() {
        assert!(complains_about_prompt(
            r#"{"error":{"message":"Unknown parameter: 'prompt'"}}"#
        ));
        assert!(complains_about_prompt(
            r#"{"detail":"Extra inputs are not permitted: prompt"}"#
        ));
        assert!(complains_about_prompt("unsupported field prompt"));

        assert!(!complains_about_prompt(r#"{"error":{"message":"Invalid API key"}}"#));
        assert!(!complains_about_prompt(r#"{"error":{"message":"model not found"}}"#));
        assert!(!complains_about_prompt("Internal Server Error"));
        assert!(!complains_about_prompt("your prompt was transcribed"));
    }

        ///
                #[test]
    fn only_the_protocol_card_tolerates_a_plain_text_body() {
        assert!(endpoint_for("openai_compat_transcribe").requires_custom_url);

        assert_eq!(extract_text_or_plain(r#"{"text":"From JSON"}"#), "From JSON");
        assert_eq!(extract_text_or_plain("  Plain response  "), "Plain response");
    }

    #[test]
    fn selected_model_and_default_are_preserved() {
        let config = config_for("openai_compat_transcribe", serde_json::json!({"model":"my-model"}));
        assert_eq!(resolve_model(&config, &OPENAI_COMPAT), "my-model");
        let empty = config_for("openai_compat_transcribe", serde_json::json!({}));
        assert_eq!(resolve_model(&empty, &OPENAI_COMPAT), "whisper-1");
    }

    #[test]
    fn auto_language_is_omitted() {
        assert_eq!(resolve_language(&config_with_language(serde_json::json!({}))), None);
        assert_eq!(
            resolve_language(&config_with_language(serde_json::json!({"language": "auto"}))),
            None
        );
        assert_eq!(
            resolve_language(&config_with_language(serde_json::json!({"language": "  "}))),
            None
        );
    }

    #[test]
    fn explicit_language_is_passed_through() {
        assert_eq!(
            resolve_language(&config_with_language(serde_json::json!({"language": "zh"}))),
            Some("zh".to_string())
        );
    }

            #[test]
    fn wav_header_is_well_formed() {
        let pcm = vec![0u8; 320];
        let wav = pcm_to_wav(&pcm, 16000);
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        let riff_size = u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]);
        assert_eq!(riff_size as usize, 36 + pcm.len());
        let data_size = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]);
        assert_eq!(data_size as usize, pcm.len());
    }

                ///
            #[test]
    fn punctuation_prompt_requests_accurate_transcription_in_any_language() {
        assert!(PUNCTUATION_PROMPT.contains("Transcribe"));
        assert!(PUNCTUATION_PROMPT.contains("punctuation"));
        assert!(PUNCTUATION_PROMPT.contains("capitalization"));
    }

    #[test]
    fn extracts_text_field() {
        let data = serde_json::json!({ "text": "  hello there  " });
        assert_eq!(extract_text(&data), "hello there");
        assert_eq!(extract_text(&serde_json::json!({})), "");
    }
}
