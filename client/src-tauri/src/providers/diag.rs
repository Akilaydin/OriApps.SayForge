//
//
//

use crate::commands::system::write_log_line;
use crate::error_protocol;

const TAG: &str = "[RUST] [provider]";

///
pub fn truncate(s: &str, max_chars: usize) -> String {
    let mut out: String = s
        .chars()
        .take(max_chars)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if s.chars().nth(max_chars).is_some() {
        out.push('…');
    }
    out
}

pub fn log(scope: &str, stage: &str, detail: &str) {
    if detail.is_empty() {
        write_log_line(&format!("{} {} {}", TAG, scope, stage));
    } else {
        write_log_line(&format!("{} {} {} {}", TAG, scope, stage, detail));
    }
}

///
/// ```ignore
/// ```
///
pub fn fail(scope: &str, stage: &str, user_msg: String) -> String {
    write_log_line(&format!(
        "{} {} {} FAILED {}",
        TAG,
        scope,
        stage,
        truncate(&user_msg, 400)
    ));
    error_protocol::encode(classify_failure(stage, &user_msg), user_msg)
}

/// Classify actual HTTP status and structured validation fields, never arbitrary prose.
pub fn http_failure(scope: &str, status: reqwest::StatusCode, body: &str) -> String {
    let code = http_failure_code(status, body);
    log(scope, "http_status", &format!("FAILED code={code} http={}", status.as_u16()));
    // Provider errors can echo credentials, prompts or transcripts. Do not log their body.
    error_protocol::encode(code, format!("HTTP {status}"))
}

fn http_failure_code(status: reqwest::StatusCode, body: &str) -> &'static str {
    use reqwest::StatusCode;
    let data = serde_json::from_str::<serde_json::Value>(body).unwrap_or_default();
    let error = &data["error"];
    let code = error.get("code").or_else(|| data.get("code")).and_then(serde_json::Value::as_str);
    match status {
        StatusCode::UNAUTHORIZED => "provider_bad_key",
        StatusCode::FORBIDDEN => "provider_forbidden",
        StatusCode::PAYMENT_REQUIRED => "provider_insufficient_balance",
        StatusCode::TOO_MANY_REQUESTS => "provider_rate_limit",
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => "provider_timeout",
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "asr_audio_unsupported",
        status if status.is_server_error() => "provider_internal",
        StatusCode::METHOD_NOT_ALLOWED => "asr_route_unsupported",
        StatusCode::NOT_FOUND => {
            if code == Some("model_not_found") || error["param"] == "model" {
                "provider_no_model"
            } else if body.trim().is_empty() || data["detail"] == "Not Found"
                || matches!(code, Some("route_not_found" | "endpoint_not_found")) {
                "asr_route_unsupported"
            } else {
                "connect_failed"
            }
        }
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => {
            let wrong_audio_shape = data["detail"].as_array().is_some_and(|errors| errors.iter().any(|e| {
                matches!(e["type"].as_str(), Some("string_type" | "dict_type"))
                    && e["loc"].as_array().and_then(|loc| loc.last()).and_then(serde_json::Value::as_str) == Some("input_audio")
            }));
            if wrong_audio_shape || matches!(code, Some("invalid_input_audio_type" | "unsupported_audio_payload")) {
                "asr_protocol_unsupported"
            } else {
                "connect_failed"
            }
        }
        _ => "connect_failed",
    }
}

pub fn request_failure(scope: &str, stage: &str, error: &reqwest::Error) -> String {
    let code = if error.is_timeout() { "provider_timeout" } else { "provider_unreachable" };
    log(scope, stage, &format!("FAILED code={code}"));
    error_protocol::encode(code, if error.is_timeout() { "Request timed out" } else { "Network request failed" })
}

fn contains_http_status(message: &str, expected: &[u16]) -> bool {
    message
        .split(|ch: char| !ch.is_ascii_digit())
        .filter_map(|part| (part.len() == 3).then(|| part.parse::<u16>().ok()).flatten())
        .any(|status| expected.contains(&status))
}

fn classify_failure(stage: &str, message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if contains_http_status(message, &[401])
        || lower.contains("unauthorized")
        || lower.contains("invalid api key")
        || lower.contains("invalid_api_key")
    {
        return "provider_bad_key";
    }
    //
    // `This request requires at least $0.50 in balance for audio`.
    if contains_http_status(message, &[402])
        || lower.contains("payment required")
        || lower.contains("insufficient balance")
        || lower.contains("in balance")
        || lower.contains("insufficient_quota")
    {
        return "provider_insufficient_balance";
    }
    if contains_http_status(message, &[429])
        || lower.contains("rate limit")
        || lower.contains("quota")
    {
        return "provider_rate_limit";
    }
    if contains_http_status(message, &[403]) {
        return "provider_forbidden";
    }
    if contains_http_status(message, &[404])
        || lower.contains("model not found")
        || lower.contains("model does not exist")
    {
        return "provider_no_model";
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return "provider_timeout";
    }
    if matches!(
        stage,
        "http_send" | "connect" | "send_request" | "recv" | "recv_ack"
    ) {
        return "provider_unreachable";
    }
    "connect_failed"
}

///
pub fn empty_result(scope: &str, detail: &str) {
    write_log_line(&format!("{} {} EMPTY_RESULT {}", TAG, scope, detail));
}

pub fn ok(scope: &str, elapsed_ms: u64, text_chars: usize) {
    write_log_line(&format!(
        "{} {} ok elapsed={}ms chars={}",
        TAG, scope, elapsed_ms, text_chars
    ));
}

const SAFE_FIELDS: &[&str] = &[
    "code",
    "error_code",
    "message",
    "msg",
    "status",
    "request_id",
    "finish_reason",
];

const TEXT_FIELDS: &[&str] = &["text", "content", "transcript", "delta", "utterances"];

fn collect_safe_fields(value: &serde_json::Value, depth: usize, out: &mut Vec<String>) {
    if depth > 4 || out.len() >= 6 {
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if TEXT_FIELDS.iter().any(|t| k.eq_ignore_ascii_case(t)) {
                    continue;
                }
                let is_scalar = v.is_string() || v.is_number() || v.is_boolean();
                if is_scalar && SAFE_FIELDS.iter().any(|s| k.eq_ignore_ascii_case(s)) {
                    let raw = match v {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    if !raw.is_empty() {
                        out.push(format!("{}={}", k, truncate(&raw, 120)));
                    }
                }
                collect_safe_fields(v, depth + 1, out);
            }
        }
        serde_json::Value::Array(items) => {
            for v in items.iter().take(3) {
                collect_safe_fields(v, depth + 1, out);
            }
        }
        _ => {}
    }
}

///
pub fn describe_json(raw: &str) -> String {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) else {
        return format!("body_bytes={} (non-JSON)", raw.len());
    };
    let mut parts = vec![format!("body_bytes={}", raw.len())];
    if let Some(obj) = json.as_object() {
        let keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        parts.push(format!("keys=[{}]", keys.join(",")));
    }
    let mut fields = Vec::new();
    collect_safe_fields(&json, 0, &mut fields);
    parts.extend(fields);
    parts.join(" ")
}

const TRACE_HEADERS: &[&str] = &[
    "X-Tt-Logid",
    "x-request-id",
    "x-ds-trace-id",   // DeepSeek
    "req-id",
];

pub fn http_summary(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
) -> String {
    let mut parts = vec![format!("http={}", status.as_u16())];
    for name in TRACE_HEADERS {
        if let Some(v) = headers.get(*name).and_then(|v| v.to_str().ok()) {
            parts.push(format!("{}={}", name, v));
        }
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_classification_uses_status_and_structured_fields() {
        use reqwest::StatusCode;
        for status in [401, 403, 429, 500, 502, 504, 415] {
            let error = http_failure("synthetic", StatusCode::from_u16(status).unwrap(), "404 not found; prompt unsupported; synthetic secret");
            assert!(!super::super::asr_openai_compat::may_probe_next(&error));
            assert!(!error.contains("secret"));
        }
        assert_eq!(http_failure_code(StatusCode::NOT_FOUND, r#"{"error":{"code":"model_not_found"}}"#), "provider_no_model");
        assert_eq!(http_failure_code(StatusCode::NOT_FOUND, r#"{"error":{"message":"model not found"}}"#), "connect_failed");
        assert_eq!(http_failure_code(StatusCode::NOT_FOUND, r#"{"detail":"Not Found"}"#), "asr_route_unsupported");
        assert_eq!(http_failure_code(StatusCode::METHOD_NOT_ALLOWED, ""), "asr_route_unsupported");
        assert_eq!(http_failure_code(StatusCode::BAD_REQUEST, r#"{"error":{"code":"invalid_input_audio_type"}}"#), "asr_protocol_unsupported");
        assert_eq!(http_failure_code(StatusCode::BAD_REQUEST, "input_audio unsupported"), "connect_failed");
    }

    #[test]
    fn classifies_provider_failures_before_the_detail_is_translated() {
        assert_eq!(classify_failure("http_status", "HTTP 401 Unauthorized"), "provider_bad_key");
        assert_eq!(classify_failure("http_status", "HTTP 429 Too Many Requests"), "provider_rate_limit");
        assert_eq!(classify_failure("http_send", "request timed out"), "provider_timeout");
        assert_eq!(classify_failure("connect", "socket closed"), "provider_unreachable");
    }

        ///
                #[test]
    fn forbidden_is_not_reported_as_a_bad_key() {
        assert_eq!(
            classify_failure(
                "http_status",
                r#"API error 403 Forbidden [http=403]: {"error":{"message":"Forbidden"}}"#
            ),
            "provider_forbidden"
        );
        assert_eq!(
            classify_failure("http_status", "HTTP 403: Invalid API Key"),
            "provider_bad_key"
        );
        assert_eq!(
            classify_failure("http_status", "HTTP 403: quota exceeded"),
            "provider_rate_limit"
        );
    }

            #[test]
    fn truncates_multibyte_without_panicking() {
        let body = "Network request failed: retry later";
        let out = truncate(body, 7);
        assert_eq!(out, "Network…");
    }

    #[test]
    fn keeps_short_strings_intact() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("", 10), "");
    }

        #[test]
    fn no_ellipsis_at_exact_length() {
        assert_eq!(truncate("abcd", 4), "abcd");
        assert_eq!(truncate("abcde", 4), "abcd…");
    }

        #[test]
    fn flattens_newlines() {
        assert_eq!(truncate("a\nb\r\nc", 20), "a b  c");
    }

            #[test]
    fn describe_json_never_leaks_recognized_text() {
        let body = r#"{"choices":[{"message":{"content":"My private banking password is confidential"},
            "finish_reason":"stop"}],"request_id":"req-42"}"#;
        let out = describe_json(body);
        assert!(!out.contains("banking"), "Transcript leaked into diagnostic output: {}", out);
        assert!(!out.contains("password"), "Transcript leaked into diagnostic output: {}", out);
        assert!(out.contains("request_id=req-42"), "{}", out);
        assert!(out.contains("finish_reason=stop"), "{}", out);
    }

        #[test]
    fn describe_json_keeps_scalar_message() {
        let out = describe_json(r#"{"code":45000030,"message":"Service unavailable"}"#);
        assert!(out.contains("code=45000030"), "{}", out);
        assert!(out.contains("message=Service unavailable"), "{}", out);
    }

        #[test]
    fn describe_json_skips_text_fields() {
        let out = describe_json(r#"{"result":{"text":"Confidential recognized transcript"}}"#);
        assert!(!out.contains("Confidential"), "{}", out);
        assert!(out.contains("keys=[result]"), "{}", out);
    }

    #[test]
    fn describe_json_handles_non_json() {
        let out = describe_json("<html>502 Bad Gateway</html>");
        assert!(out.contains("non-JSON"), "{}", out);
    }
}
