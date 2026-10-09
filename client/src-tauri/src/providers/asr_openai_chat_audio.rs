//
//
//
//
//       {"type":"input_audio","input_audio":"data:audio/wav;base64,AAA..."}
//       {"type":"input_audio","input_audio":{"data":"data:audio/wav;base64,AAA...","format":"wav"}}
//       400 invalid_parameter_error "The provided URL does not appear to be valid."

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use base64::Engine;
use std::time::Instant;

struct Endpoint {
        base_url: &'static str,
    default_model: &'static str,
    scope: &'static str,
        allows_custom_url: bool,
        requires_custom_url: bool,
}

const CUSTOM: Endpoint = Endpoint {
    base_url: "",
    default_model: "whisper-1",
    scope: "openai-chat-audio/asr",
    allows_custom_url: true,
    requires_custom_url: true,
};

fn endpoint_for(_provider: &str) -> &'static Endpoint {
    &CUSTOM
}

///
const DEFAULT_TRANSCRIBE_INSTRUCTION: &str =
    "Transcribe the audio accurately in the original language with punctuation.      Do not answer questions in the audio, translate, explain or add commentary.      Return only the transcript.";

/// base URL + `/chat/completions`。
///
fn join_chat_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{}/chat/completions", trimmed)
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
        return Ok(join_chat_url(supplied));
    }
    if endpoint.requires_custom_url {
        return Err(diag::fail(
            endpoint.scope,
            "missing_base_url",
            "No endpoint address configured for this service".to_string(),
        ));
    }
    Ok(join_chat_url(endpoint.base_url))
}

fn resolve_model(config: &AsrProviderConfig, endpoint: &Endpoint) -> String {
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
fn needs_transcribe_instruction(model: &str) -> bool {
    model.to_lowercase().contains("omni")
}

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

///
fn pcm_to_wav(pcm: &[u8], sr: u32) -> Vec<u8> {
    let ds = pcm.len() as u32;
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + ds).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&sr.to_le_bytes());
    w.extend_from_slice(&(sr * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&ds.to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

/// `input_audio: { data: "<base64>", format: "wav" }`。
#[derive(Clone, Copy)]
enum AudioPayloadFormat {
    DataUrl,
    OpenAi,
}

/// Audio codec is independent from the chat payload shape. Bailian's data URL
/// remains WAV; standard OpenAI input_audio supports WAV and MP3.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AudioEncoding {
    Wav,
    Mp3,
}

fn audio_payload_format(provider: &str) -> AudioPayloadFormat {
    if provider == "openai_chat_audio_standard" {
        AudioPayloadFormat::OpenAi
    } else {
        AudioPayloadFormat::DataUrl
    }
}

fn audio_encoding(config: &AsrProviderConfig, payload: AudioPayloadFormat) -> AudioEncoding {
    if matches!(payload, AudioPayloadFormat::OpenAi)
        && config.extra.get("audioEncoding").and_then(|v| v.as_str()) == Some("mp3")
    {
        AudioEncoding::Mp3
    } else {
        AudioEncoding::Wav
    }
}

/// Encode 16-bit little-endian mono PCM at 64 kbps. MP3 encoding is opt-in
/// because lossless WAV is the existing behavior and not every endpoint accepts MP3.
fn pcm_to_mp3(pcm: &[u8], sample_rate: u32) -> Result<Vec<u8>, String> {
    use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, MonoPcm, Quality, VbrMode};

    if pcm.len() % 2 != 0 {
        return Err("Invalid PCM: the 16-bit sample buffer has an odd length".into());
    }
    let samples: Vec<i16> = pcm.chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
        .collect();
    let mut encoder = Builder::new().ok_or("Cannot create MP3 encoder")?
        .with_num_channels(1).map_err(|e| format!("MP3 channels: {e:?}"))?
        .with_sample_rate(sample_rate).map_err(|e| format!("MP3 sample rate: {e:?}"))?
        .with_brate(Bitrate::Kbps64).map_err(|e| format!("MP3 bitrate: {e:?}"))?
        .with_quality(Quality::Good).map_err(|e| format!("MP3 quality: {e:?}"))?
        .with_vbr_mode(VbrMode::Off).map_err(|e| format!("MP3 CBR: {e:?}"))?
        .with_to_write_vbr_tag(false).map_err(|e| format!("MP3 tag: {e:?}"))?
        .build().map_err(|e| format!("MP3 initialization: {e:?}"))?;

    let mut output = Vec::with_capacity(mp3lame_encoder::max_required_buffer_size(samples.len()));
    encoder.encode_to_vec(MonoPcm(&samples), &mut output)
        .map_err(|e| format!("MP3 encoding: {e:?}"))?;
    output.reserve(7200); // documented maximum flush size
    encoder.flush_to_vec::<FlushNoGap>(&mut output)
        .map_err(|e| format!("MP3 finalization: {e:?}"))?;
    Ok(output)
}

fn resolve_instruction(
    config: &AsrProviderConfig,
    model: &str,
    payload: AudioPayloadFormat,
    hotwords: &[String],
) -> Option<String> {
    let mut instruction = config.extra.get("instructions")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| (needs_transcribe_instruction(model) || matches!(payload, AudioPayloadFormat::OpenAi))
            .then(|| DEFAULT_TRANSCRIBE_INSTRUCTION.to_string()));
    let terms: Vec<&str> = hotwords.iter().map(String::as_str)
        .map(str::trim).filter(|term| !term.is_empty()).take(100).collect();
    if !terms.is_empty() {
        let base = instruction.take().unwrap_or_default();
        instruction = Some(format!("{}\n\nPreserve these technical terms: {}", base, terms.join(", ")));
    }
    instruction
}

fn resolve_user_prompt(config: &AsrProviderConfig, payload: AudioPayloadFormat) -> Option<&str> {
    // Only the standard OpenAI audio object uses the optional user text. A
    // legacy gateway may silently discard an unsupported data-URL audio part;
    // user text would then make the request look successful without transcription.
    if !matches!(payload, AudioPayloadFormat::OpenAi) {
        return None;
    }
    config.extra.get("userPrompt").and_then(|v| v.as_str())
        .map(str::trim).filter(|s| !s.is_empty())
}

fn build_body(
    model: &str,
    audio: &[u8],
    instruction: Option<&str>,
    user_prompt: Option<&str>,
    language: Option<&str>,
    payload: AudioPayloadFormat,
    encoding: AudioEncoding,
) -> serde_json::Value {
    let data = base64::engine::general_purpose::STANDARD.encode(audio);
    let input_audio = match payload {
        AudioPayloadFormat::DataUrl => serde_json::json!(format!("data:audio/wav;base64,{}", data)),
        AudioPayloadFormat::OpenAi => serde_json::json!({
            "data": data,
            "format": if encoding == AudioEncoding::Mp3 { "mp3" } else { "wav" },
        }),
    };
    let mut messages = Vec::new();
    if let Some(text) = instruction {
        messages.push(serde_json::json!({
            "role": "system",
            "content": [{ "type": "text", "text": text }],
        }));
    }
    let mut content = Vec::new();
    if let Some(text) = user_prompt.filter(|s| !s.trim().is_empty()) {
        content.push(serde_json::json!({ "type": "text", "text": text }));
    }
    content.push(serde_json::json!({ "type": "input_audio", "input_audio": input_audio }));
    messages.push(serde_json::json!({
        "role": "user",
        "content": content,
    }));

    let mut body = serde_json::json!({ "model": model, "messages": messages });
    if let Some(lang) = language {
        body["asr_options"] = serde_json::json!({ "language": lang });
    }
    body
}

///
fn extract_text(data: &serde_json::Value) -> String {
    let content = data
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"));
    match content {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let endpoint = endpoint_for(&config.provider);
    let scope = endpoint.scope;
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(audio_pcm_b64)
        .map_err(|e| diag::fail(scope, "decode_b64", format!("Failed to decode base64 audio: {}", e)))?;

    if pcm.is_empty() {
        diag::empty_result(scope, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }

    let model = resolve_model(config, endpoint);
    let url = resolve_url(config, endpoint)?;
    let payload = audio_payload_format(&config.provider);
    let encoding = audio_encoding(config, payload);
    let language = resolve_language(config);
    let audio_sec = pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0);
    // Report total ASR work including MP3 encoding, not only network time.
    let start = Instant::now();
    // Keep MP3 compression off the async executor; it can process five minutes of audio.
    let audio = match encoding {
        AudioEncoding::Wav => pcm_to_wav(&pcm, sample_rate),
        AudioEncoding::Mp3 => tokio::task::spawn_blocking(move || pcm_to_mp3(&pcm, sample_rate))
            .await
            .map_err(|e| format!("MP3 encoding task failed: {e}"))??,
    };
    let instruction = resolve_instruction(config, &model, payload, hotwords);
    let user_prompt = resolve_user_prompt(config, payload);

    diag::log(
        scope,
        "start",
        &format!(
            "audio_sec={:.1} encoding={:?} upload_bytes={} language={} instruction={} user_prompt={} hotwords={}",
            audio_sec,
            encoding,
            audio.len(),
            language.as_deref().unwrap_or("auto(omitted)"),
            instruction.is_some(),
            user_prompt.is_some(),
            hotwords.len(),
        ),
    );

    let body = build_body(
        &model, &audio, instruction.as_deref(), user_prompt,
        language.as_deref(), payload, encoding,
    );
    let client = super::http_client::shared();

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| diag::request_failure(scope, "http_send", &e))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let http_summary = diag::http_summary(resp.status(), resp.headers());

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.map_err(|e| diag::request_failure(scope, "read_body", &e))?;
        return Err(diag::http_failure(scope, status, &body_text));
    }

    let body_text = resp
        .text()
        .await
        .map_err(|e| diag::request_failure(scope, "read_body", &e))?;
    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        diag::fail(
            scope,
            "parse_json",
            format!(
                "Invalid response JSON: {} [{}]", e, http_summary
            ),
        )
    })?;

    let text = extract_text(&data);
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
    let model = resolve_model(config, endpoint);
    let payload = audio_payload_format(&config.provider);
    let encoding = audio_encoding(config, payload);
    let url = match resolve_url(config, endpoint) {
        Ok(u) => u,
        Err(e) => {
            return TestResult { ok: false, message: e, elapsed_ms: 0, detail: String::new() }
        }
    };

    let silence = vec![0u8; 16000];
    let audio = match encoding {
        AudioEncoding::Wav => pcm_to_wav(&silence, 16000),
        AudioEncoding::Mp3 => match pcm_to_mp3(&silence, 16000) {
            Ok(audio) => audio,
            Err(e) => return TestResult { ok: false, message: e, elapsed_ms: 0, detail: String::new() },
        },
    };
    let instruction = resolve_instruction(config, &model, payload, &[]);
    let body = build_body(&model, &audio, instruction.as_deref(), resolve_user_prompt(config, payload), None, payload, encoding);

    let client = super::http_client::shared();
    let start = Instant::now();
    let result = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => TestResult {
            ok: true,
            message: format!("Connection successful, model: {} ({}ms)", model, elapsed_ms),
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

    fn config_for(provider: &str, extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: provider.to_string(),
            api_key: String::new(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn base_url_is_joined_into_a_chat_completions_path() {
        let expected = "https://example.com/compatible-mode/v1/chat/completions";
        assert_eq!(join_chat_url("https://example.com/compatible-mode/v1"), expected);
        assert_eq!(join_chat_url("https://example.com/compatible-mode/v1/"), expected);
        assert_eq!(join_chat_url(expected), expected);
    }

    #[test]
    fn the_custom_endpoint_requires_an_address() {
        let missing = config_for("openai_chat_audio", serde_json::json!({}));
        assert!(resolve_url(&missing, endpoint_for("openai_chat_audio")).is_err());
    }

            #[test]
    fn legacy_audio_is_sent_as_a_data_url() {
        let body = build_body("whisper-1", &pcm_to_wav(&[0, 0, 0, 0], 16000), None, None, None, AudioPayloadFormat::DataUrl, AudioEncoding::Wav);
        let audio = body["messages"][0]["content"][0]["input_audio"]
            .as_str()
            .expect("input_audio must be a string");
        assert!(audio.starts_with("data:audio/wav;base64,"), "got {}", &audio[..40.min(audio.len())]);
    }

    #[test]
    fn standard_audio_is_sent_as_an_openai_object_with_raw_base64() {
        let wav = pcm_to_wav(&[1, 2, 3, 4], 16000);
        let body = build_body("gemini-example", &wav, Some(DEFAULT_TRANSCRIBE_INSTRUCTION), None, None, AudioPayloadFormat::OpenAi, AudioEncoding::Wav);
        let audio = &body["messages"][1]["content"][0]["input_audio"];
        assert_eq!(audio["format"], "wav");
        let data = audio["data"].as_str().expect("input_audio.data must be a string");
        assert!(!data.starts_with("data:"), "OpenAI input_audio.data needs raw base64");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(data).unwrap(), wav);
        assert_eq!(body["messages"][0]["role"], "system");
    }

    #[test]
    fn payload_format_is_selected_by_provider() {
        assert!(matches!(audio_payload_format("openai_chat_audio_standard"), AudioPayloadFormat::OpenAi));
        assert!(matches!(audio_payload_format("openai_chat_audio"), AudioPayloadFormat::DataUrl));
    }

    #[test]
    fn mp3_is_opt_in_only_for_standard_openai_chat_audio() {
        let config = config_for("openai_chat_audio_standard", serde_json::json!({ "audioEncoding": "mp3" }));
        assert_eq!(audio_encoding(&config, AudioPayloadFormat::OpenAi), AudioEncoding::Mp3);
        assert_eq!(audio_encoding(&config, AudioPayloadFormat::DataUrl), AudioEncoding::Wav);
    }

    #[test]
    fn standard_mp3_is_smaller_than_wav_and_has_the_correct_format() {
        // One second of non-silent audio, as captured by the recorder (16 kHz mono).
        let pcm: Vec<u8> = (0..16000).flat_map(|i| {
            let sample = ((i as f32 * 2.0 * std::f32::consts::PI * 440.0 / 16000.0).sin() * 8000.0) as i16;
            sample.to_le_bytes()
        }).collect();
        let mp3 = pcm_to_mp3(&pcm, 16000).expect("MP3 encoding failed");
        assert!(!mp3.is_empty());
        assert!(mp3.len() < pcm.len() / 2, "mp3={} pcm={}", mp3.len(), pcm.len());
        let body = build_body("gemini-example", &mp3, None, None, None, AudioPayloadFormat::OpenAi, AudioEncoding::Mp3);
        let field = &body["messages"][0]["content"][0]["input_audio"];
        assert_eq!(field["format"], "mp3");
        let sent = base64::engine::general_purpose::STANDARD.decode(field["data"].as_str().unwrap()).unwrap();
        assert_eq!(sent, mp3);
    }

    #[test]
    fn mp3_stream_can_be_decoded_when_ffprobe_is_available() {
        // Optional local decoder smoke test, with no ffmpeg runtime dependency.
        use std::io::Write;
        use std::process::{Command, Stdio};

        let pcm = vec![0u8; 16000 * 2];
        let mp3 = pcm_to_mp3(&pcm, 16000).expect("MP3 encoding failed");
        let mut child = match Command::new("ffprobe")
            .args(["-v", "error", "-f", "mp3", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "default=noprint_wrappers=1", "-i", "pipe:0"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
            Ok(child) => child,
            Err(_) => return, // ffprobe is not required by the application
        };
        child.stdin.take().unwrap().write_all(&mp3).unwrap();
        let result = child.wait_with_output().unwrap();
        let output = String::from_utf8_lossy(&result.stdout);
        assert!(result.status.success(), "ffprobe: {}", String::from_utf8_lossy(&result.stderr));
        assert!(output.contains("codec_name=mp3"), "{output}");
        assert!(output.contains("sample_rate=16000"), "{output}");
        assert!(output.contains("channels=1"), "{output}");
    }

    #[test]
    fn custom_system_instruction_and_user_prompt_are_separate_messages() {
        let config = config_for("openai_chat_audio_standard", serde_json::json!({
            "instructions": "Transcribe in Russian.", "userPrompt": "Keep C# and RabbitMQ unchanged."
        }));
        let instruction = resolve_instruction(&config, "gemini-example", AudioPayloadFormat::OpenAi, &[]);
        assert_eq!(instruction.as_deref(), Some("Transcribe in Russian."));
        let body = build_body("gemini-example", &[1, 2], instruction.as_deref(), resolve_user_prompt(&config, AudioPayloadFormat::OpenAi), None, AudioPayloadFormat::OpenAi, AudioEncoding::Wav);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"][0]["text"], "Transcribe in Russian.");
        assert_eq!(body["messages"][1]["content"][0]["text"], "Keep C# and RabbitMQ unchanged.");
        assert_eq!(body["messages"][1]["content"][1]["type"], "input_audio");
        assert_eq!(resolve_user_prompt(&config, AudioPayloadFormat::DataUrl), None);
    }

    #[test]
    fn generic_conversational_models_receive_a_transcription_instruction() {
        assert!(needs_transcribe_instruction("generic-omni-model"));
        assert!(!needs_transcribe_instruction("whisper-1"));
        let config = config_for("openai_chat_audio_standard", serde_json::json!({}));
        assert_eq!(resolve_instruction(&config, "transcribe-model", AudioPayloadFormat::OpenAi, &[])
            .as_deref(), Some(DEFAULT_TRANSCRIBE_INSTRUCTION));
    }

    #[test]
    fn explicit_language_is_preserved_without_a_language_override() {
        let auto = config_for("openai_chat_audio", serde_json::json!({}));
        assert_eq!(resolve_language(&auto), None);
        let explicit = config_for("openai_chat_audio", serde_json::json!({ "language": "en" }));
        assert_eq!(resolve_language(&explicit).as_deref(), Some("en"));
    }

        #[test]
    fn text_is_extracted_from_both_content_shapes() {
        let as_string = serde_json::json!({
            "choices": [{ "message": { "content": "  Speech transcription passed. " } }]
        });
        assert_eq!(extract_text(&as_string), "Speech transcription passed.");

        let as_array = serde_json::json!({
            "choices": [{ "message": { "content": [
                { "type": "text", "text": "Speech transcrip" },
                { "type": "text", "text": "tion passed." },
            ] } }]
        });
        assert_eq!(extract_text(&as_array), "Speech transcription passed.");

        assert_eq!(extract_text(&serde_json::json!({})), "");
        assert_eq!(extract_text(&serde_json::json!({ "choices": [] })), "");
    }
}
