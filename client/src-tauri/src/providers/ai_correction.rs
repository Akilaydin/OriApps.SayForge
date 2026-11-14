use crate::error_protocol;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_SYSTEM_PROMPT: &str = "You are an accurate speech transcription proofreader. Return only the corrected transcription, preserving the speaker's language and meaning.";
static THINKING_BLOCK: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r"(?is)<think>.*?</think>").expect("valid thinking tag pattern")
});

#[derive(Deserialize)]
pub struct CloudPolishRequest {
    text: String,
    ai_config: AiConfig,
    #[serde(default)]
    system_prompt: Option<String>,
}

#[derive(Deserialize)]
struct AiConfig {
    provider: String,
    api_url: String,
    api_key: String,
    model: String,
}

#[derive(Serialize)]
pub struct PolishResult {
    text: String,
    elapsed_ms: u64,
}

fn chat_url(configured: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(configured.trim())
        .map_err(|_| error_protocol::encode("connect_failed", "Invalid AI correction URL"))?;
    if !matches!(url.scheme(), "http" | "https") || !url.has_host() {
        return Err(error_protocol::encode(
            "connect_failed",
            "Invalid AI correction URL",
        ));
    }

    let path = url.path().trim_end_matches('/');
    let versioned = path
        .rsplit('/')
        .next()
        .and_then(|segment| segment.strip_prefix('v'))
        .is_some_and(|version| {
            !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
        });
    let endpoint = if path.ends_with("/chat/completions") {
        path.to_string()
    } else if versioned {
        format!("{path}/chat/completions")
    } else {
        format!("{path}/v1/chat/completions")
    };
    url.set_path(&endpoint);
    Ok(url)
}

fn chat_body(config: &AiConfig, text: &str, system_prompt: Option<&str>) -> Value {
    json!({
        "model": config.model,
        "messages": [
            { "role": "system", "content": system_prompt.unwrap_or(DEFAULT_SYSTEM_PROMPT) },
            { "role": "user", "content": text },
        ],
    })
}

fn chat_request(url: reqwest::Url, config: &AiConfig, body: &Value) -> reqwest::RequestBuilder {
    super::http_client::shared()
        .post(url)
        .bearer_auth(&config.api_key)
        .json(body)
        .timeout(TIMEOUT)
}

fn response_text(body: &Value) -> Option<String> {
    let content = body.pointer("/choices/0/message/content")?;
    let text = match content {
        Value::String(value) => value.to_string(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<String>(),
        _ => return None,
    };
    let clean = THINKING_BLOCK.replace_all(&text, "");
    let trimmed = clean.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        error_protocol::encode("provider_timeout", "AI correction timed out")
    } else {
        error_protocol::encode("provider_unreachable", "AI correction request failed")
    }
}

fn http_error(status: reqwest::StatusCode) -> String {
    use reqwest::StatusCode;
    let code = match status {
        StatusCode::UNAUTHORIZED => "provider_bad_key",
        StatusCode::FORBIDDEN => "provider_forbidden",
        StatusCode::PAYMENT_REQUIRED => "provider_insufficient_balance",
        StatusCode::TOO_MANY_REQUESTS => "provider_rate_limit",
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => "provider_timeout",
        status if status.is_server_error() => "provider_internal",
        _ => "connect_failed",
    };
    error_protocol::encode(code, format!("HTTP {}", status.as_u16()))
}

#[tauri::command]
pub async fn cloud_polish(request: CloudPolishRequest) -> Result<PolishResult, String> {
    if request.text.trim().is_empty() {
        return Ok(PolishResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }
    if request.ai_config.provider != "openai_compat" {
        return Err(error_protocol::encode(
            "connect_failed",
            "Unsupported AI correction provider",
        ));
    }

    let url = chat_url(&request.ai_config.api_url)?;
    let body = chat_body(
        &request.ai_config,
        &request.text,
        request.system_prompt.as_deref(),
    );
    let started = Instant::now();
    let response = chat_request(url, &request.ai_config, &body)
        .send()
        .await
        .map_err(|error| request_error(&error))?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|_| error_protocol::encode("connect_failed", "Invalid AI correction response"))?;
    // An empty provider response is not a successful correction. Let the
    // frontend record the failure and fall back to the original ASR text.
    let text = response_text(&payload).unwrap_or_default();
    Ok(PolishResult {
        text,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AiConfig {
        AiConfig {
            provider: "openai_compat".into(),
            api_url: "https://example.invalid/v1".into(),
            api_key: "sk-synthetic".into(),
            model: "sample-model".into(),
        }
    }

    #[test]
    fn url_supports_base_versioned_and_complete_chat_endpoints() {
        let cases = [
            (
                "https://example.invalid",
                "https://example.invalid/v1/chat/completions",
            ),
            (
                "https://example.invalid/v1/",
                "https://example.invalid/v1/chat/completions",
            ),
            (
                "https://gateway.example/openai/v2",
                "https://gateway.example/openai/v2/chat/completions",
            ),
            (
                "https://gateway.example/api/v1/chat/completions",
                "https://gateway.example/api/v1/chat/completions",
            ),
            (
                "http://localhost:3000/v1/chat/completions/",
                "http://localhost:3000/v1/chat/completions",
            ),
        ];
        for (configured, expected) in cases {
            assert_eq!(chat_url(configured).unwrap().as_str(), expected);
        }
    }

    #[test]
    fn request_uses_bearer_post_json_and_a_fifteen_second_timeout() {
        let config = config();
        let body = chat_body(
            &config,
            "Synthetic transcript",
            Some("Correct punctuation only"),
        );
        assert_eq!(body["model"], "sample-model");
        assert_eq!(
            body["messages"][0],
            json!({"role": "system", "content": "Correct punctuation only"})
        );
        assert_eq!(
            body["messages"][1],
            json!({"role": "user", "content": "Synthetic transcript"})
        );
        assert!(!body.to_string().contains(&config.api_key));

        let request = chat_request(chat_url(&config.api_url).unwrap(), &config, &body)
            .build()
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url().path(), "/v1/chat/completions");
        assert_eq!(
            request.headers()[reqwest::header::AUTHORIZATION],
            "Bearer sk-synthetic"
        );
        assert_eq!(request.timeout(), Some(&TIMEOUT));
    }

    #[test]
    fn missing_system_prompt_uses_proofreader_default() {
        let body = chat_body(&config(), "One two", None);
        assert_eq!(body["messages"][0]["content"], DEFAULT_SYSTEM_PROMPT);
    }

    #[test]
    fn response_supports_string_and_text_parts() {
        let plain = json!({"choices": [{"message": {"content": "  Corrected.  "}}]});
        assert_eq!(response_text(&plain).as_deref(), Some("Corrected."));

        let array = json!({"choices": [{"message": {"content": [
            {"type": "text", "text": "Correct "},
            {"type": "image_url", "image_url": "synthetic"},
            {"type": "text", "text": "text."}
        ]}}]});
        assert_eq!(response_text(&array).as_deref(), Some("Correct text."));
        let reasoning = json!({"choices": [{"message": {"content": "<think>Internal reasoning</think>Corrected."}}]});
        assert_eq!(response_text(&reasoning).as_deref(), Some("Corrected."));
        assert_eq!(response_text(&json!({"choices": []})), None);
        assert_eq!(
            response_text(&json!({"choices": [{"message": {"content": "  "}}]})),
            None
        );
    }

    #[test]
    fn error_messages_cannot_expose_url_key_or_provider_body() {
        let secret = "sk-synthetic-secret";
        let invalid_url_error = chat_url(&format!("http://[{secret}")).unwrap_err();
        assert!(!invalid_url_error.contains(secret));
        for status in [401, 403, 429, 500] {
            let message = http_error(reqwest::StatusCode::from_u16(status).unwrap());
            assert!(message.contains(&status.to_string()));
            assert!(!message.contains(secret));
        }
    }
}
