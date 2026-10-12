
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrResult {
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
pub struct CloudTranscribeRequest {
        pub audio_b64: String,
    pub sample_rate: u32,
    pub asr_config: AsrProviderConfig,
        #[serde(default)]
    pub hotwords: Vec<String>,
}
