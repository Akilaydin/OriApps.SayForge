//! Local GGUF speech recognition model catalog.
//!
//! SayForge offers NVIDIA Parakeet for English and NVIDIA Nemotron for
//! multilingual dictation, including Russian. Chinese-origin model families
//! were intentionally removed from this distribution.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadSource {
    pub source: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub url: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model_type: String,
    pub total_size_bytes: u64,
    pub languages: Vec<String>,
    pub sources: Vec<DownloadSource>,
    #[serde(default)]
    pub archive_url: Option<String>,
    #[serde(default)]
    pub speed: f32,
    #[serde(default)]
    pub accuracy: f32,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub memory_mb: u64,
    #[serde(default)]
    pub languages_label: String,
    #[serde(default)]
    pub quant: String,
    #[serde(default)]
    pub featured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModelInfo {
    pub id: String,
    pub name: String,
    pub model_type: String,
    pub total_size_bytes: u64,
    pub path: String,
    pub complete: bool,
}

struct GgufWeight {
    repo: &'static str,
    file: &'static str,
    size: u64,
    sha256: &'static str,
}

impl GgufWeight {
    fn sources(&self) -> Vec<DownloadSource> {
        vec![DownloadSource {
            source: "HuggingFace".into(),
            files: vec![ModelFile {
                name: self.file.into(),
                url: format!("https://huggingface.co/{}/resolve/main/{}", self.repo, self.file),
                size_bytes: self.size,
                sha256: Some(self.sha256.into()),
            }],
        }]
    }
}

// Download directly from the original transcribe.cpp-compatible GGUF conversion
// repositories. Their Q4_K_M files match the existing pinned SHA-256 checksums.
const PARAKEET_UNIFIED_EN_Q4: GgufWeight = GgufWeight {
    repo: "handy-computer/parakeet-unified-en-0.6b-gguf",
    file: "parakeet-unified-en-0.6b-Q4_K_M.gguf",
    size: 477_274_496,
    sha256: "a8bf3de2b393bd14ead5a858c3748d5e3b07a20fdeabdd3b498fba4f463fa929",
};

const NEMOTRON_STREAMING_Q4: GgufWeight = GgufWeight {
    repo: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
    file: "nemotron-3.5-asr-streaming-0.6b-Q4_K_M.gguf",
    size: 495_831_520,
    sha256: "41c99fa5fb6f3d35f68e79adc3e755eca2232a8d921178bd647b71194792b8fd",
};

pub fn get_available_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "parakeet-unified-en-0.6b-gguf".into(),
            name: "Parakeet Unified EN".into(),
            description: "Fast and accurate English-only dictation".into(),
            model_type: "parakeet-gguf".into(),
            total_size_bytes: PARAKEET_UNIFIED_EN_Q4.size,
            speed: 9.0,
            accuracy: 9.0,
            recommended: false,
            memory_mb: 900,
            featured: true,
            languages_label: "English".into(),
            quant: "Q4_K_M".into(),
            languages: vec!["en".into()],
            sources: PARAKEET_UNIFIED_EN_Q4.sources(),
            archive_url: None,
        },
        ModelInfo {
            id: "nemotron-asr-streaming-0.6b-gguf".into(),
            name: "Nemotron 3.5 ASR".into(),
            description: "Multilingual dictation including Russian".into(),
            model_type: "parakeet-gguf".into(),
            total_size_bytes: NEMOTRON_STREAMING_Q4.size,
            speed: 8.0,
            accuracy: 7.5,
            recommended: true,
            memory_mb: 1050,
            featured: true,
            languages_label: "Multilingual".into(),
            quant: "Q4_K_M".into(),
            languages: vec![
                "en", "es", "fr", "de", "it", "pt", "ru", "ja", "ko",
            ].into_iter().map(str::to_string).collect(),
            sources: NEMOTRON_STREAMING_Q4.sources(),
            archive_url: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_contains_only_the_two_supported_nvidia_models() {
        let models = get_available_models();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["parakeet-unified-en-0.6b-gguf", "nemotron-asr-streaming-0.6b-gguf"],
        );
        assert_eq!(models.iter().filter(|m| m.recommended).count(), 1);
        assert_eq!(models.iter().filter(|m| m.featured).count(), 2);
        assert!(models[1].languages.iter().any(|language| language == "ru"));
    }

    #[test]
    fn all_weights_have_valid_size_checksum_and_download_source() {
        let mut ids = std::collections::HashSet::new();
        for model in get_available_models() {
            assert!(ids.insert(model.id.clone()));
            assert!(model.memory_mb > 0);
            assert!(!model.languages_label.is_empty());
            assert!(model.id.ends_with("-gguf"));
            assert_eq!(model.sources.len(), 1);
            let source = &model.sources[0];
            assert_eq!(source.source, "HuggingFace");
            assert_eq!(source.files.len(), 1);
            let file = &source.files[0];
            assert_eq!(file.size_bytes, model.total_size_bytes);
            assert!(file.url.ends_with(&file.name));
            assert_eq!(file.sha256.as_ref().map(String::len), Some(64));
        }
    }

    #[test]
    fn models_are_listed_in_descending_order_of_speed() {
        let models = get_available_models();
        assert!(models.windows(2).all(|pair| pair[0].speed >= pair[1].speed));
    }
}
