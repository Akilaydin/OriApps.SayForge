
use super::types::*;
use super::{ai_openai_compat, asr_transcriptions, asr_openai_chat_audio, asr_openai_compat};
use crate::error_protocol;

#[tauri::command]
pub async fn cloud_polish(request: CloudPolishRequest) -> Result<AiResult, String> {
    let config = &request.ai_config;
    match config.provider.as_str() {
        //
        "openai_compat" | "groq" => {
            ai_openai_compat::polish(
                &request.text,
                config,
                request.system_prompt.as_deref(),
                request.text_context.as_ref(),
            )
            .await
        }
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("Unknown AI provider: {}", other),
        )),
    }
}

#[tauri::command]
pub async fn test_ai_connection(config: AiProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        "openai_compat" | "groq" => {
            Ok(ai_openai_compat::test_connection(&config).await)
        }
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("Unknown AI provider: {}", other),
        )),
    }
}

#[tauri::command]
pub async fn cloud_transcribe(request: CloudTranscribeRequest) -> Result<AsrResult, String> {
    let config = &request.asr_config;
    match config.provider.as_str() {
        "openai_compat_transcribe" => {
            asr_transcriptions::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "openai_compat" => {
            asr_openai_compat::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "openai_chat_audio" | "openai_chat_audio_standard" => {
            asr_openai_chat_audio::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("ASR provider \"{}\" is not implemented", other),
        )),
    }
}

///
///
///
///
///
///
#[cfg(test)]
pub fn dispatch_keys_for_test() -> Vec<&'static str> {
    let keys = match_arm_keys(fn_body(include_str!("registry.rs"), CLOUD_TRANSCRIBE_SIGNATURE));
    assert!(
        !keys.is_empty(),
        "Found only {} dispatch keys in cloud_transcribe; source parser may be stale: {:?}",
        keys.len(),
        keys,
    );
    keys
}

#[cfg(test)]
const CLOUD_TRANSCRIBE_SIGNATURE: &str = concat!("pub async fn ", "cloud_transcribe");

///
#[cfg(test)]
fn fn_body<'a>(source: &'a str, signature: &str) -> &'a str {
    let start = source
        .find(signature)
        .unwrap_or_else(|| panic!("Missing `{signature}` in source; check for a changed signature"));
    let rest = &source[start..];
    let end = rest.find("\n}").map(|at| at + 1).unwrap_or(rest.len());
    &rest[..end]
}

///
#[cfg(test)]
fn match_arm_keys<'a>(source: &'a str) -> Vec<&'a str> {
    let mut keys: Vec<&'a str> = Vec::new();
    let mut head: Vec<&'a str> = Vec::new();
    for raw in source.lines() {
        let line = match raw.find("//") {
            Some(at) => &raw[..at],
            None => raw,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !(line.starts_with('"') || line.starts_with('|')) {
            head.clear();
            continue;
        }
        let (fragment, complete) = match line.find("=>") {
            Some(at) => (&line[..at], true),
            None => (line, false),
        };
        head.push(fragment);
        if complete {
            for part in head.drain(..) {
                keys.extend(quoted_literals(part));
            }
        }
    }
    keys
}

#[cfg(test)]
fn quoted_literals<'a>(text: &'a str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('"') {
        rest = &rest[open + 1..];
        let Some(close) = rest.find('"') else { break };
        if close > 0 {
            out.push(&rest[..close]);
        }
        rest = &rest[close + 1..];
    }
    out
}

#[tauri::command]
pub async fn test_asr_connection(config: AsrProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        "openai_compat_transcribe" => {
            Ok(asr_transcriptions::test_connection(&config).await)
        }
        "openai_chat_audio" | "openai_chat_audio_standard" => {
            Ok(asr_openai_chat_audio::test_connection(&config).await)
        }
        "openai_compat" => Ok(asr_openai_compat::test_connection(&config).await),
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("ASR provider \"{}\" is not implemented", other),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

        ///
            const FAKE_DISPATCH: &str = r#"pub async fn fake_dispatch(x: &str) -> Result<(), String> {
    match x {
        "alpha" => Ok(()),
        // The word "ghost" in a comment must not count as a dispatch key
        "beta" | "gamma" => Ok(()),
        "delta"
        | "epsilon" => Ok(()),
        other => Err(encode(
            "connect_failed",
            format!("no {}", other),
        )),
    }
}
"#;

    fn fake_keys(source: &str) -> Vec<&str> {
        match_arm_keys(fn_body(source, "pub async fn fake_dispatch"))
    }

        #[test]
    fn the_scanner_handles_every_arm_shape_and_nothing_else() {
        assert_eq!(
            fake_keys(FAKE_DISPATCH),
            vec!["alpha", "beta", "gamma", "delta", "epsilon"],
        );
    }

        ///
                #[test]
    fn the_scanner_ignores_provider_names_inside_comments() {
        assert!(!fake_keys(FAKE_DISPATCH).contains(&"ghost"));
    }

        #[test]
    fn the_scanner_skips_the_fallback_arm_and_arm_bodies() {
        assert!(!fake_keys(FAKE_DISPATCH).contains(&"other"));
        assert!(!fake_keys(FAKE_DISPATCH).contains(&"connect_failed"));
    }

        ///
            #[test]
    fn removing_a_dispatch_branch_shrinks_the_reference_set() {
        let without = FAKE_DISPATCH.replace("        \"beta\" | \"gamma\" => Ok(()),\n", "");
        assert_ne!(without, FAKE_DISPATCH, "Replacement did not apply; the test fixture is invalid");

        let keys = fake_keys(&without);
        assert!(!keys.contains(&"beta"));
        assert!(!keys.contains(&"gamma"));
        assert_eq!(keys, vec!["alpha", "delta", "epsilon"]);
    }

        ///
            #[test]
    fn adding_a_dispatch_branch_grows_the_reference_set() {
        let with = FAKE_DISPATCH.replace(
            "        \"alpha\" => Ok(()),\n",
            "        \"alpha\" => Ok(()),\n        \"zeta\" => Ok(()),\n",
        );
        assert_ne!(with, FAKE_DISPATCH, "Replacement did not apply; the test fixture is invalid");
        assert!(fake_keys(&with).contains(&"zeta"));
    }

        ///
            #[test]
    fn the_real_dispatch_table_is_read_from_source() {
        let keys = dispatch_keys_for_test();
        assert!(
            keys.contains(&"openai_compat_transcribe"),
            "Incomplete multiline match-arm parsing: {keys:?}",
        );
        assert!(keys.contains(&"openai_compat"), "{keys:?}");
        assert!(!keys.contains(&"connect_failed"), "{keys:?}");
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(before, sorted.len(), "Duplicate dispatch keys: {keys:?}");
    }
}
