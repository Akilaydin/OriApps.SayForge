//
//
//
//
// ── MEASURED 2026-09-16（`dev-scripts/probe_new_asr_providers.py --target gemini-file`，
//

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::time::Instant;

const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const SCOPE: &str = "gemini/asr";
const DEFAULT_MODEL: &str = "gemini-3.5-transcribe";

///
///
const TRANSCRIBE_PROMPT: &str = "Transcribe this audio verbatim. Output only the transcript text with natural punctuation. Do not add explanations, prefixes, quotation marks, timestamps, or speaker labels. If the audio contains no intelligible speech, output nothing at all.";

///
const HOTWORD_LIMIT: usize = 100;

#[cfg(test)]
pub fn hotword_limit_for_docs() -> usize {
    HOTWORD_LIMIT
}

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

const LIVE_PROVIDER: &str = "gemini_live_transcribe";

///
fn resolve_model(config: &AsrProviderConfig) -> String {
    if config.provider == LIVE_PROVIDER {
        return DEFAULT_MODEL.to_string();
    }
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
fn language_hint(config: &AsrProviderConfig) -> Option<String> {
    let raw = config
        .extra
        .get("language")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("auto");
    match raw {
        "auto" => None,
        other => Some(format!(" The audio is in this language: {}.", other)),
    }
}

fn build_prompt(config: &AsrProviderConfig, hotwords: &[String]) -> String {
    let mut prompt = String::from(TRANSCRIBE_PROMPT);
    if let Some(lang) = language_hint(config) {
        prompt.push_str(&lang);
    }
    let mut seen = std::collections::HashSet::new();
    let words: Vec<&str> = hotwords
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .filter(|w| seen.insert(w.to_lowercase()))
        .take(HOTWORD_LIMIT)
        .collect();
    if !words.is_empty() {
        diag::log(
            SCOPE,
            "hotwords",
            &format!("vocabulary={} of={}", words.len(), hotwords.len()),
        );
        prompt.push_str(
            " These terms may appear in the audio; spell them exactly as written here: ",
        );
        prompt.push_str(&words.join(", "));
        prompt.push('.');
    }
    prompt
}

fn build_body(prompt: &str, wav_b64: String) -> serde_json::Value {
    serde_json::json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "text": prompt },
                { "inline_data": { "mime_type": "audio/wav", "data": wav_b64 } }
            ]
        }],
        "generationConfig": { "temperature": 0 }
    })
}

///
///
///
fn extract_text(data: &serde_json::Value) -> String {
    let Some(parts) = data
        .pointer("/candidates/0/content/parts")
        .and_then(|p| p.as_array())
    else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(|p| {
            p.pointer("/audioTranscription/text")
                .and_then(|t| t.as_str())
                .or_else(|| p.get("text").and_then(|t| t.as_str()))
        })
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string()
}

///
fn describe_empty(data: &serde_json::Value) -> String {
    if let Some(reason) = data
        .pointer("/promptFeedback/blockReason")
        .and_then(|r| r.as_str())
    {
        return format!("blocked by content filter: {}", reason);
    }
    let finish = data
        .pointer("/candidates/0/finishReason")
        .and_then(|r| r.as_str());
    if let Some(parts) = data
        .pointer("/candidates/0/content/parts")
        .and_then(|p| p.as_array())
    {
        if !parts.is_empty() {
            let keys: Vec<&str> = parts
                .iter()
                .filter_map(|p| p.as_object())
                .flat_map(|o| o.keys().map(|k| k.as_str()))
                .collect();
            return format!(
                "response had {} part(s) but no field we recognize (keys: {}) finishReason={} \
                 -- this is our parsing bug, not an audio problem",
                parts.len(),
                keys.join(","),
                finish.unwrap_or("?")
            );
        }
    }
    match finish {
        Some(reason) => format!("finishReason={}", reason),
        None => "no candidates in response".to_string(),
    }
}

fn endpoint(model: &str) -> String {
    format!("{}/{}:generateContent", API_BASE, model)
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    if config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            SCOPE,
            "credentials",
            "provider_bad_key",
            "Gemini transcription is missing the API Key; complete it in Settings".to_string(),
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
    let prompt = build_prompt(config, hotwords);
    let wav = pcm_to_wav(&pcm, sample_rate);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);

    diag::log(
        SCOPE,
        "start",
        &format!(
            "model={} wav_bytes={} audio_sec={:.1} rate={} hotwords={}",
            model,
            wav.len(),
            audio_sec,
            sample_rate,
            hotwords.len()
        ),
    );

    let client = super::http_client::shared();
    let start = Instant::now();
    let resp = client
        .post(endpoint(&model))
        .header("x-goog-api-key", config.api_key.trim())
        .json(&build_body(&prompt, wav_b64))
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| diag::fail(SCOPE, "http_send", format!("Request failed: {}", e)))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let http_summary = diag::http_summary(resp.status(), resp.headers());

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(diag::fail(
            SCOPE,
            "http_status",
            format!(
                "Gemini transcription error {} [{}]: {}",
                status,
                http_summary,
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
                "Response contained no transcript audio_sec={:.1} elapsed={}ms [{}] {}",
                audio_sec,
                elapsed_ms,
                http_summary,
                describe_empty(&data)
            ),
        );
    } else {
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
        .post(endpoint(&model))
        .header("x-goog-api-key", config.api_key.trim())
        .json(&build_body(TRANSCRIBE_PROMPT, wav_b64))
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
            let body = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: diag::fail(
                    SCOPE,
                    "http_status",
                    format!(
                        "API error {} [{}]: {}",
                        status,
                        summary,
                        diag::truncate(&body, 100)
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
            provider: "gemini_transcribe".to_string(),
            api_key: "key".to_string(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn model_falls_back_to_the_default() {
        assert_eq!(resolve_model(&config(serde_json::json!({}))), DEFAULT_MODEL);
        assert_eq!(
            resolve_model(&config(serde_json::json!({ "model": "  " }))),
            DEFAULT_MODEL
        );
        assert_eq!(
            resolve_model(&config(serde_json::json!({ "model": "gemini-3.5-flash" }))),
            "gemini-3.5-flash"
        );
    }

            #[test]
    fn live_card_falling_back_ignores_the_streaming_model() {
        let mut cfg = config(serde_json::json!({ "model": "gemini-3.5-transcribe-live" }));
        cfg.provider = LIVE_PROVIDER.to_string();
        assert_eq!(resolve_model(&cfg), DEFAULT_MODEL);
    }

    #[test]
    fn endpoint_targets_generate_content() {
        assert_eq!(
            endpoint("gemini-3.5-transcribe"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent"
        );
    }

        #[test]
    fn auto_language_adds_no_hint() {
        assert_eq!(language_hint(&config(serde_json::json!({}))), None);
        assert_eq!(
            language_hint(&config(serde_json::json!({ "language": "auto" }))),
            None
        );
        assert!(language_hint(&config(serde_json::json!({ "language": "zh" })))
            .unwrap()
            .contains("zh"));
    }

        #[test]
    fn prompt_forbids_commentary_and_hallucination() {
        let prompt = build_prompt(&config(serde_json::json!({})), &[]);
        assert!(prompt.contains("Output only the transcript"));
        assert!(prompt.contains("Do not add explanations"));
        assert!(prompt.contains("output nothing at all"));
    }

    #[test]
    fn hotwords_go_into_the_prompt_deduped_and_capped() {
        let words = vec!["SayIt".to_string(), "sayit".to_string(), " Kiro ".to_string()];
        let prompt = build_prompt(&config(serde_json::json!({})), &words);
        assert!(prompt.contains("SayIt, Kiro"));

        let many: Vec<String> = (0..HOTWORD_LIMIT + 20).map(|i| format!("w{}", i)).collect();
        let capped = build_prompt(&config(serde_json::json!({})), &many);
        assert!(capped.contains("w0"));
        assert!(!capped.contains(&format!("w{}", HOTWORD_LIMIT + 5)));
    }

    #[test]
    fn body_carries_audio_inline() {
        let body = build_body("say it", "QUJD".to_string());
        let parts = &body["contents"][0]["parts"];
        assert_eq!(parts[0]["text"], "say it");
        assert_eq!(parts[1]["inline_data"]["mime_type"], "audio/wav");
        assert_eq!(parts[1]["inline_data"]["data"], "QUJD");
        assert_eq!(body["generationConfig"]["temperature"], 0);
    }

        #[test]
    fn extracts_and_joins_all_text_parts() {
        let data = serde_json::json!({
            "candidates": [{ "content": { "parts": [{ "text": "  Hello" }, { "text": ", world. " }] } }]
        });
        assert_eq!(extract_text(&data), "Hello, world.");
        assert_eq!(extract_text(&serde_json::json!({})), "");
    }

            #[test]
    fn extracts_the_dedicated_audio_transcription_field() {
        let data = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{ "audioTranscription": { "text": "Voice transcription completed successfully." } }],
                    "role": "model"
                },
                "finishReason": "STOP"
            }],
            "modelVersion": "gemini-3.5-transcribe"
        });
        assert_eq!(extract_text(&data), "Voice transcription completed successfully.");
    }

        #[test]
    fn handles_both_part_shapes_together() {
        let data = serde_json::json!({
            "candidates": [{ "content": { "parts": [
                { "audioTranscription": { "text": "First half" } },
                { "text": "Second half" }
            ] } }]
        });
        assert_eq!(extract_text(&data), "First halfSecond half");
    }

        #[test]
    fn empty_reason_distinguishes_safety_block() {
        let blocked = serde_json::json!({ "promptFeedback": { "blockReason": "SAFETY" } });
        assert!(describe_empty(&blocked).contains("content filter"));
        assert!(describe_empty(&blocked).contains("SAFETY"));

        let stopped = serde_json::json!({ "candidates": [{ "finishReason": "MAX_TOKENS" }] });
        assert!(describe_empty(&stopped).contains("MAX_TOKENS"));

        assert!(describe_empty(&serde_json::json!({})).contains("no candidates"));
    }

        ///
            #[test]
    fn empty_reason_calls_out_unrecognized_part_fields() {
        let data = serde_json::json!({
            "candidates": [{
                "content": { "parts": [{ "somethingNew": { "text": "hi" } }] },
                "finishReason": "STOP"
            }]
        });
        let why = describe_empty(&data);
        assert!(why.contains("somethingNew"), "must name the unknown key: {}", why);
        assert!(why.contains("parsing bug"), "must say it is our bug: {}", why);
        assert!(why.contains("STOP"));
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
