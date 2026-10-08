
use super::diag;
use super::prompt::wrap_user_text;
use super::types::{AiProviderConfig, AiResult, TestResult, TextContext};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const SCOPE: &str = "ai/openai-compat";

fn http() -> &'static reqwest::Client {
    super::http_client::shared()
}

///
///
fn disable_thinking_overrides() -> serde_json::Value {
    serde_json::json!({
        "enable_thinking": false,
        "thinking": { "type": "disabled" },
        "reasoning": { "effort": "none" },
        "reasoning_effort": "none",
    })
}

///
fn thinking_overrides(config: &AiProviderConfig) -> Option<serde_json::Value> {
    if is_strict_openai_host(&config.api_url) {
        None
    } else {
        Some(disable_thinking_overrides())
    }
}

fn host_of(api_url: &str) -> Option<String> {
    reqwest::Url::parse(api_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
}

fn is_strict_openai_host(api_url: &str) -> bool {
    host_of(api_url).is_some_and(|host| {
        host == "api.openai.com"
            || host.ends_with(".openai.azure.com")
            || host.ends_with(".cognitiveservices.azure.com")
    })
}

fn merge_overrides(body: &mut serde_json::Value, overrides: &serde_json::Value) {
    let (Some(target), Some(source)) = (body.as_object_mut(), overrides.as_object()) else {
        return;
    };
    for (key, value) in source {
        target.insert(key.clone(), value.clone());
    }
}

///
///
fn thinking_memo() -> &'static Mutex<HashMap<String, Option<serde_json::Value>>> {
    static MEMO: OnceLock<Mutex<HashMap<String, Option<serde_json::Value>>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn endpoint_key(config: &AiProviderConfig) -> String {
    let host = host_of(&config.api_url).unwrap_or_else(|| config.api_url.trim().to_string());
    format!("{}|{}", host, config.model)
}

fn remembered_thinking(config: &AiProviderConfig) -> Option<Option<serde_json::Value>> {
    thinking_memo()
        .lock()
        .ok()
        .and_then(|memo| memo.get(&endpoint_key(config)).cloned())
}

fn remember_thinking(config: &AiProviderConfig, overrides: Option<serde_json::Value>) {
    if let Ok(mut memo) = thinking_memo().lock() {
        memo.insert(endpoint_key(config), overrides);
    }
}

///
fn rejected_thinking_field(body: &str, overrides: &serde_json::Value) -> Option<String> {
    let object = overrides.as_object()?;
    object
        .keys()
        .find(|key| body.contains(key.as_str()))
        .cloned()
}

struct ChatHttpResponse {
    status: reqwest::StatusCode,
    summary: String,
    body: String,
}

enum ChatHttpError {
    Send(reqwest::Error),
    ReadBody(reqwest::Error),
}

async fn send_chat_once(
    url: &str,
    config: &AiProviderConfig,
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<ChatHttpResponse, ChatHttpError> {
    let req = http()
        .post(url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json");

    let resp = req
        .json(body)
        .timeout(timeout)
        .send()
        .await
        .map_err(ChatHttpError::Send)?;

    let status = resp.status();
    let summary = diag::http_summary(status, resp.headers());
    let body = resp.text().await.map_err(ChatHttpError::ReadBody)?;

    Ok(ChatHttpResponse {
        status,
        summary,
        body,
    })
}

///
///
async fn send_chat_with_thinking_fallback(
    url: &str,
    config: &AiProviderConfig,
    base_body: &serde_json::Value,
    timeout: Duration,
    scope: &str,
) -> Result<ChatHttpResponse, ChatHttpError> {
    let overrides = match remembered_thinking(config) {
        Some(remembered) => remembered,
        None => thinking_overrides(config),
    };

    let Some(overrides) = overrides else {
        return send_chat_once(url, config, base_body, timeout).await;
    };

    let mut body = base_body.clone();
    merge_overrides(&mut body, &overrides);
    let resp = send_chat_once(url, config, &body, timeout).await?;

    if resp.status.is_success() {
        return Ok(resp);
    }

    //
    let Some(field) = rejected_thinking_field(&resp.body, &overrides) else {
        return Ok(resp);
    };
    diag::log(
        scope,
        "thinking_params_rejected",
        &format!("Endpoint rejected optional field={field}; retrying without thinking parameters"),
    );
    let retried = send_chat_once(url, config, base_body, timeout).await?;
    if retried.status.is_success() {
        remember_thinking(config, None);
    }
    Ok(retried)
}

pub async fn polish(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: Option<&str>,
    text_context: Option<&TextContext>,
) -> Result<AiResult, String> {
    if text.trim().is_empty() {
        return Ok(AiResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let base_url = normalize_base_url(&config.api_url);
    let url = format!("{}/chat/completions", base_url);

    let sys_prompt = system_prompt.unwrap_or("You are an accurate speech transcription proofreader.");
    let user_content = wrap_user_text(text, text_context);

    let base_body = serde_json::json!({
        "model": config.model,
        "temperature": 0.2,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": sys_prompt },
            { "role": "user", "content": user_content },
        ]
    });

    let start = Instant::now();

    diag::log(
        SCOPE,
        "start",
        &format!(
            "provider={} model={} chars={} url={}",
            config.provider,
            config.model,
            text.chars().count(),
            url
        ),
    );

    let resp = send_chat_with_thinking_fallback(
        &url,
        config,
        &base_body,
        Duration::from_secs(60),
        SCOPE,
    )
    .await
    .map_err(|e| match e {
        ChatHttpError::Send(e) => diag::fail(
            SCOPE,
            "http_send",
            format!("HTTP request failed: {}", describe_reqwest_error(&e)),
        ),
        ChatHttpError::ReadBody(e) => diag::fail(
            SCOPE,
            "read_body",
            format!("Failed to read response: {}", e),
        ),
    })?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let ChatHttpResponse {
        status,
        summary: http_summary,
        body: body_text,
    } = resp;

    if !status.is_success() {
        return Err(diag::fail(
            SCOPE,
            "http_status",
            format!(
                "API returned error {} [{}]: {}",
                status,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        ));
    }

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

    let result_text = match extract_chat_completion_text(&data) {
        Some(t) => t,
        None => {
            diag::log(
                SCOPE,
                "no_content_fallback_to_input",
                &format!(
                    "Response contained no usable content; returned the original text [{}] {}",
                    http_summary,
                    diag::describe_json(&body_text)
                ),
            );
            text.to_string()
        }
    };

    let cleaned = strip_thinking(&result_text);

    if cleaned.is_empty() {
        diag::log(
            SCOPE,
            "empty_after_strip_thinking",
            &format!(
                "Output was empty after removing the reasoning block; returned the original text model={} raw_chars={}",
                config.model,
                result_text.chars().count()
            ),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, cleaned.chars().count());
    }

    Ok(AiResult {
        text: if cleaned.is_empty() {
            text.to_string()
        } else {
            cleaned
        },
        elapsed_ms,
    })
}

pub async fn test_connection(config: &AiProviderConfig) -> TestResult {
    let base_url = normalize_base_url(&config.api_url);
    let url = format!("{}/chat/completions", base_url);

    let system_prompt = "Reply with OK only. Do not output anything else.";
    let user_prompt = "Connection test";

    let base_body = serde_json::json!({
        "model": config.model,
        "temperature": 0,
        "max_tokens": 512,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });

    let start = Instant::now();

    let result = send_chat_with_thinking_fallback(
        &url,
        config,
        &base_body,
        Duration::from_secs(30),
        "ai/openai-compat-test",
    )
    .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status.is_success() => {
            let data: serde_json::Value =
                serde_json::from_str(&resp.body).unwrap_or(serde_json::Value::Null);
            let raw_reply = data
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let reply = strip_thinking(&raw_reply);
            let detail = format!(
                "Elapsed: {}ms\nModel: {}\nSent: system=\"{}\" user=\"{}\"\nReply: {}",
                elapsed_ms,
                config.model,
                system_prompt,
                user_prompt,
                if reply.is_empty() { "(empty)" } else { &reply }
            );
            TestResult {
                ok: true,
                message: format!("Connection successful ({}ms)", elapsed_ms),
                elapsed_ms,
                detail,
            }
        }
        Ok(resp) => TestResult {
            ok: false,
            message: diag::fail(
                "ai/openai-compat-test",
                "http_status",
                format!(
                    "API returned {} [{}]: {}",
                    resp.status,
                    resp.summary,
                    diag::truncate(&resp.body, 100)
                ),
            ),
            elapsed_ms,
            detail: format!("Model: {}\nRequest URL: {}", config.model, url),
        },
        Err(ChatHttpError::Send(e)) => TestResult {
            ok: false,
            message: diag::fail(
                "ai/openai-compat-test",
                "http_send",
                format!("Connection failed: {}", describe_reqwest_error(&e)),
            ),
            elapsed_ms,
            detail: format!("Model: {}\nRequest URL: {}", config.model, url),
        },
        Err(ChatHttpError::ReadBody(e)) => TestResult {
            ok: false,
            message: diag::fail(
                "ai/openai-compat-test",
                "read_body",
                format!("Failed to read response: {}", e),
            ),
            elapsed_ms,
            detail: format!("Model: {}\nRequest URL: {}", config.model, url),
        },
    }
}

/// Convert reqwest errors into concise diagnostic details.
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    let raw = format!("{}", e);
    if e.is_timeout() {
        return "Request timed out; check the network connection and API URL".to_string();
    }
    if e.is_connect() {
        let lower = raw.to_lowercase();
        if lower.contains("dns") || lower.contains("resolve") || lower.contains("getaddrinfo") {
            return format!(
                "DNS lookup failed; the host may not exist or the network may be unavailable: {}",
                raw
            );
        }
        if lower.contains("ssl")
            || lower.contains("tls")
            || lower.contains("certificate")
            || lower.contains("handshake")
            || lower.contains("schannel")
        {
            return format!("TLS/SSL handshake failed; check the certificate: {}", raw);
        }
        if lower.contains("refused") {
            return format!(
                "Connection refused; the service may not be running: {}",
                raw
            );
        }
        return format!("Could not connect to the server: {}", raw);
    }
    raw
}

fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let trimmed = trimmed
        .strip_suffix("/chat/completions")
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    let has_version_suffix = trimmed
        .rsplit('/')
        .next()
        .and_then(|segment| segment.strip_prefix('v'))
        .is_some_and(|version| !version.is_empty() && version.chars().all(|c| c.is_ascii_digit()));

    if has_version_suffix {
        trimmed.to_string()
    } else {
        format!("{}/v1", trimmed)
    }
}

fn extract_chat_completion_text(data: &serde_json::Value) -> Option<String> {
    let content = data
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?;

    match content {
        serde_json::Value::String(s) => Some(s.trim().to_string()),
        serde_json::Value::Array(arr) => {
            let text: String = arr
                .iter()
                .filter_map(|item| {
                    if item.get("type")?.as_str()? == "text" {
                        item.get("text")?.as_str().map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("");
            Some(text.trim().to_string())
        }
        _ => None,
    }
}

fn strip_thinking(text: &str) -> String {
    let re = regex::Regex::new(r"(?is)<think>.*?</think>").unwrap_or_else(|_| {
        regex::Regex::new(r"^$").unwrap()
    });
    let cleaned = re.replace_all(text, "");
    let cleaned = cleaned.trim();

    cleaned.to_string()
}
#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider: &str, api_url: &str, model: &str) -> AiProviderConfig {
        AiProviderConfig {
            provider: provider.to_string(),
            api_url: api_url.to_string(),
            api_key: "sk-test".to_string(),
            model: model.to_string(),
            extra: serde_json::Value::Null,
        }
    }

    fn keys(value: &serde_json::Value) -> Vec<String> {
        let mut out: Vec<String> = value
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        out.sort();
        out
    }

    #[test]
    fn unknown_gateways_use_generic_thinking_fallback_parameters() {
        let overrides = thinking_overrides(&config("openai_compat", "https://gateway.example/v1", "example"))
            .expect("unknown OpenAI-compatible gateways may support an explicit no-thinking flag");
        assert_eq!(
            keys(&overrides),
            vec!["enable_thinking", "reasoning", "reasoning_effort", "thinking"]
        );
    }

    #[test]
    fn normalizes_user_typed_base_urls() {
        let cases = [
            ("https://example.com/v4/", "https://example.com/v4"),
            ("https://example.com/v4/chat/completions", "https://example.com/v4"),
            ("https://example.com", "https://example.com/v1"),
            ("https://api.groq.com/openai/v1", "https://api.groq.com/openai/v1"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_base_url(input), expected);
        }
    }

    #[test]
    fn strict_openai_hosts_get_no_thinking_params() {
        for url in [
            "https://api.openai.com/v1",
            "https://my-resource.openai.azure.com/openai/deployments/gpt5",
            "https://my-resource.cognitiveservices.azure.com/openai/v1",
        ] {
            assert!(is_strict_openai_host(url), "{} should be strict", url);
            assert!(
                thinking_overrides(&config("openai_compat", url, "gpt-5")).is_none(),
                "{} should not receive thinking params",
                url
            );
        }
    }

    #[test]
    fn unknown_endpoints_get_the_catch_all_set() {
        for (provider, url) in [
            ("openai_compat", "https://openrouter.ai/api/v1"),
            ("openai_compat", "http://192.168.1.10:3000/v1"),
            ("openai_compat", "https://generic-gateway.example/api/v1"),
            ("groq", "https://api.groq.com/openai/v1"),
        ] {
            let overrides = thinking_overrides(&config(provider, url, "m"))
                .unwrap_or_else(|| panic!("{} should receive thinking params", url));
            assert_eq!(
                keys(&overrides),
                vec![
                    "enable_thinking",
                    "reasoning",
                    "reasoning_effort",
                    "thinking"
                ],
                "{}",
                url
            );
        }
    }

    #[test]
    fn merge_overrides_replaces_top_level_keys_only() {
        let mut body = serde_json::json!({
            "model": "m",
            "messages": [],
            "thinking": { "type": "enabled", "budget": 100 },
        });
        merge_overrides(&mut body, &disable_thinking_overrides());

        assert_eq!(body["thinking"], serde_json::json!({"type": "disabled"}));
        assert_eq!(body["model"], serde_json::json!("m"));
        assert!(body["messages"].is_array());
    }

    #[test]
    fn rejection_detection_only_fires_when_our_field_is_named() {
        let overrides = disable_thinking_overrides();

        let named = r#"{"error":{"message":"Unrecognized request argument supplied: thinking"}}"#;
        assert_eq!(
            rejected_thinking_field(named, &overrides).as_deref(),
            Some("thinking")
        );

        let unsupported_value =
            r#"{"error":{"code":"unsupported_value","param":"reasoning_effort"}}"#;
        assert!(rejected_thinking_field(unsupported_value, &overrides).is_some());

        for body in [
            r#"{"error":{"message":"Incorrect API key provided"}}"#,
            r#"{"error":{"message":"The model `gpt-9` does not exist"}}"#,
            r#"{"error":{"message":"max_tokens is too small"}}"#,
        ] {
            assert!(
                rejected_thinking_field(body, &overrides).is_none(),
                "should not retry for: {}",
                body
            );
        }
    }

    #[test]
    fn rejection_cache_is_scoped_to_host_and_model() {
        let a = config("openai_compat", "https://cache-test.invalid/v1", "model-a");
        let b = config("openai_compat", "https://cache-test.invalid/v1", "model-b");

        assert!(remembered_thinking(&a).is_none());
        remember_thinking(&a, None);
        assert_eq!(remembered_thinking(&a), Some(None));
        assert!(remembered_thinking(&b).is_none());
    }

        ///
                #[test]
    fn cache_remembers_which_fallback_worked() {
        let config = config("openai_compat", "https://cache-fallback.invalid/v1", "generic");
        remember_thinking(&config, None);
        assert_eq!(remembered_thinking(&config), Some(None));
    }

}
