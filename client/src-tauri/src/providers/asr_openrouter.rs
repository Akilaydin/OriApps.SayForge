//
//
//
//
// `python dev-scripts/probe_new_asr_providers.py --target openrouter --list-models`
//

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::time::Instant;

const API_URL: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const SCOPE: &str = "openrouter/asr";

const DEFAULT_MODEL: &str = "openai/gpt-transcribe";

const AUDIO_FORMAT: &str = "wav";

///
const REFERER: &str = "https://github.com/Akilaydin/OriApps.SayForge";
const TITLE: &str = "SayForge";

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

fn build_body(
    model: &str,
    wav_b64: String,
    language: Option<&str>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "input_audio": { "data": wav_b64, "format": AUDIO_FORMAT },
        "temperature": 0,
        "response_format": "json",
    });
    if let Some(lang) = language {
        body["language"] = serde_json::json!(lang);
    }
    body
}

fn extract_text(data: &serde_json::Value) -> String {
    data.get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

///
fn describe_usage(data: &serde_json::Value) -> String {
    let usage = match data.get("usage") {
        Some(u) => u,
        None => return "usage=absent".to_string(),
    };
    let num = |key: &str| {
        usage
            .get(key)
            .and_then(|v| v.as_f64())
            .map(|v| format!("{}={}", key, v))
    };
    let parts: Vec<String> = ["seconds", "total_tokens", "cost"]
        .iter()
        .filter_map(|k| num(k))
        .collect();
    if parts.is_empty() {
        "usage=empty".to_string()
    } else {
        parts.join(" ")
    }
}

fn generation_id(headers: &reqwest::header::HeaderMap) -> String {
    headers
        .get("x-generation-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_string()
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    if !hotwords.is_empty() {
        diag::log(
            SCOPE,
            "hotwords_ignored",
            &format!("count={} reason=protocol_has_no_slot", hotwords.len()),
        );
    }

    if config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            SCOPE,
            "credentials",
            "provider_bad_key",
            "OpenRouter is missing the API Key; complete it in Settings".to_string(),
        ));
    }

    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, audio_pcm_b64)
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "decode_b64",
                format!("Failed to decode base64 audio: {}", e),
            )
        })?;
    if pcm.is_empty() {
        diag::empty_result(SCOPE, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let audio_sec = pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0);
    let model = resolve_model(config);
    let language = resolve_language(config);
    let wav = pcm_to_wav(&pcm, sample_rate);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);

    diag::log(
        SCOPE,
        "start",
        &format!(
            "model={} wav_bytes={} audio_sec={:.1} rate={} language={}",
            model,
            wav.len(),
            audio_sec,
            sample_rate,
            language.as_deref().unwrap_or("auto(omitted)")
        ),
    );

    let client = super::http_client::shared();
    let start = Instant::now();
    let resp = client
        .post(API_URL)
        .header(
            "Authorization",
            format!("Bearer {}", config.api_key.trim()),
        )
        .header("HTTP-Referer", REFERER)
        .header("X-Title", TITLE)
        .json(&build_body(&model, wav_b64, language.as_deref()))
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| diag::fail(SCOPE, "http_send", format!("Request failed: {}", e)))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let http_summary = diag::http_summary(resp.status(), resp.headers());
    let gen_id = generation_id(resp.headers());

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(diag::fail(
            SCOPE,
            "http_status",
            format!(
                "OpenRouter transcription error {} [{}] gen={}: {}",
                status,
                http_summary,
                gen_id,
                diag::truncate(&body, 300)
            ),
        ));
    }

    let body_text = resp
        .text()
        .await
        .map_err(|e| diag::fail(SCOPE, "read_body", format!("Failed to read response: {}", e)))?;
    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        diag::fail(
            SCOPE,
            "parse_json",
            format!(
                "Failed to parse response: {} [{}] response excerpt: {}",
                e,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        )
    })?;

    let text = extract_text(&data);
    if text.is_empty() {
        diag::empty_result(
            SCOPE,
            &format!(
                "Response contained no transcript model={} audio_sec={:.1} elapsed={}ms \
                 [{}] gen={} {}",
                model,
                audio_sec,
                elapsed_ms,
                http_summary,
                gen_id,
                describe_usage(&data)
            ),
        );
    } else {
        diag::log(
            SCOPE,
            "usage",
            &format!("model={} gen={} {}", model, gen_id, describe_usage(&data)),
        );
        diag::ok(SCOPE, elapsed_ms, text.chars().count());
    }

    Ok(AsrResult { text, elapsed_ms })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let model = resolve_model(config);
    let silence = vec![0u8; 16000];
    let wav = pcm_to_wav(&silence, 16000);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);

    let client = super::http_client::shared();
    let start = Instant::now();
    let result = client
        .post(API_URL)
        .header(
            "Authorization",
            format!("Bearer {}", config.api_key.trim()),
        )
        .header("HTTP-Referer", REFERER)
        .header("X-Title", TITLE)
        .json(&build_body(&model, wav_b64, None))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(resp) if resp.status().is_success() => TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: format!("model: {}", model),
        },
        Ok(resp) => {
            let status = resp.status();
            let summary = diag::http_summary(status, resp.headers());
            let gen_id = generation_id(resp.headers());
            let body = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: diag::fail(
                    SCOPE,
                    "http_status",
                    format!(
                        "API error {} [{}] gen={}: {}",
                        status,
                        summary,
                        gen_id,
                        diag::truncate(&body, 150)
                    ),
                ),
                elapsed_ms,
                detail: String::new(),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: diag::fail(SCOPE, "http_send", format!("Connection failed: {}", e)),
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
            provider: "openrouter_transcribe".to_string(),
            api_key: "sk-or-test".to_string(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn model_falls_back_to_a_punctuating_default() {
        assert_eq!(resolve_model(&config(serde_json::json!({}))), DEFAULT_MODEL);
        assert_eq!(
            resolve_model(&config(serde_json::json!({ "model": "  " }))),
            DEFAULT_MODEL
        );
        assert_eq!(
            resolve_model(&config(serde_json::json!({ "model": "openai/whisper-1" }))),
            "openai/whisper-1"
        );
    }

        #[test]
    fn default_model_is_namespaced() {
        assert!(DEFAULT_MODEL.contains('/'), "slug must be vendor-prefixed");
    }

            #[test]
    fn body_matches_the_documented_shape() {
        let body = build_body(DEFAULT_MODEL, "QUJD".to_string(), None);
        assert_eq!(body["model"], DEFAULT_MODEL);
        assert_eq!(body["input_audio"]["data"], "QUJD");
        assert_eq!(body["input_audio"]["format"], "wav");
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["response_format"], "json");
        assert!(body.get("language").is_none());
    }

    #[test]
    fn explicit_language_is_passed_but_auto_is_omitted() {
        assert_eq!(resolve_language(&config(serde_json::json!({}))), None);
        assert_eq!(
            resolve_language(&config(serde_json::json!({ "language": "auto" }))),
            None
        );
        assert_eq!(
            resolve_language(&config(serde_json::json!({ "language": "zh" }))),
            Some("zh".to_string())
        );
        let body = build_body(DEFAULT_MODEL, "x".to_string(), Some("ja"));
        assert_eq!(body["language"], "ja");
    }

    #[test]
    fn extracts_text_field() {
        let data = serde_json::json!({ "text": "  Transcription succeeded.  " });
        assert_eq!(extract_text(&data), "Transcription succeeded.");
        assert_eq!(extract_text(&serde_json::json!({})), "");
    }

                #[test]
    fn payment_required_is_classified_as_insufficient_balance() {
        let message = super::super::diag::fail(
            SCOPE,
            "http_status",
            "OpenRouter transcription error 402 Payment Required [http=402] gen=-: \
             {\"error\":{\"message\":\"This request requires at least $0.50 in balance for audio\"}}"
                .to_string(),
        );
        assert!(
            message.contains("provider_insufficient_balance"),
            "402 must not fall back to connect_failed: {}",
            message
        );
        assert!(message.contains("$0.50"));
    }

            #[test]
    fn usage_reports_numbers_only() {
        let data = serde_json::json!({
            "text": "Sensitive transcript content",
            "usage": { "seconds": 3.05, "total_tokens": 143, "cost": 0.00012 }
        });
        let summary = describe_usage(&data);
        assert!(summary.contains("seconds=3.05"));
        assert!(summary.contains("total_tokens=143"));
        assert!(summary.contains("cost=0.00012"));
        assert!(!summary.contains("Sensitive transcript"), "must never carry transcript text");

        assert_eq!(describe_usage(&serde_json::json!({})), "usage=absent");
        assert_eq!(
            describe_usage(&serde_json::json!({ "usage": {} })),
            "usage=empty"
        );
    }

    #[test]
    fn wav_header_is_well_formed() {
        let pcm = vec![0u8; 320];
        let wav = pcm_to_wav(&pcm, 16000);
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        let data_size = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]);
        assert_eq!(data_size as usize, pcm.len());
    }
}
