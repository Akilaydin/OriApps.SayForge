
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrResult {
    pub text: String,
        pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResult {
    pub text: String,
        pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub elapsed_ms: u64,
        #[serde(default)]
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrProviderConfig {
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
        #[serde(default)]
    pub extra: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProviderConfig {
    pub provider: String,
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
        #[serde(default)]
    pub extra: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudTranscribeRequest {
        pub audio_b64: String,
    pub sample_rate: u32,
    pub asr_config: AsrProviderConfig,
        #[serde(default)]
    pub hotwords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPolishRequest {
    pub text: String,
    pub ai_config: AiProviderConfig,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub text_context: Option<TextContext>,
}

/// Ephemeral editor context. It is accepted only for this one AI request and is never persisted.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TextContext {
    #[serde(default)]
    pub source: String,
    #[serde(default, alias = "textBefore")]
    pub text_before: String,
    #[serde(default, alias = "selectedText")]
    pub selected_text: String,
    #[serde(default, alias = "textAfter")]
    pub text_after: String,
    #[serde(default, alias = "selectionTruncated")]
    pub selection_truncated: bool,
}
