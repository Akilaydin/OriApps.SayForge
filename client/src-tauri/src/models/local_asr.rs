//
//

use serde::Serialize;
use std::time::Instant;

use super::downloader::{model_dir, models_dir};
use super::gguf_asr;

const SR: usize = 16000;

#[derive(Debug, Clone, Serialize)]
pub struct LocalAsrResult {
    pub text: String,
    pub elapsed_ms: u64,
}

fn decode_pcm(audio_b64: &str) -> Result<Vec<f32>, String> {
    let pcm_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        audio_b64,
    )
    .map_err(|e| format!("Failed to decode base64 audio: {}", e))?;

    if pcm_bytes.len() % 2 != 0 {
        return Err(format!(
            "PCM data length must be a multiple of a 16-bit sample; received {} bytes",
            pcm_bytes.len()
        ));
    }

    Ok(pcm_bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect())
}

#[tauri::command]
pub async fn local_transcribe(
    audio_b64: String,
    model_id: String,
    language: Option<String>,
    accelerator: Option<String>,
    gpu_device: Option<String>,
) -> Result<LocalAsrResult, String> {
    let samples = decode_pcm(&audio_b64).map_err(|e| {
        crate::providers::diag::fail("local/asr", "decode_pcm", e)
    })?;
    if samples.is_empty() {
        crate::providers::diag::empty_result("local/asr", "Input audio was empty; model inference was skipped");
        return Ok(LocalAsrResult { text: String::new(), elapsed_ms: 0 });
    }

    let accel = accelerator.unwrap_or_else(|| "auto".to_string());
    let gpu = gpu_device.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        use crate::providers::diag;
        let lang = language.as_deref().unwrap_or("auto");
        let start = Instant::now();
        let audio_sec = samples.len() as f64 / SR as f64;
        diag::log(
            "local/asr",
            "start",
            &format!(
                "model={} accel={} lang={} audio_sec={:.1}",
                model_id, accel, lang, audio_sec
            ),
        );
        let trimmed = match super::local_vad::detect_speech_span(&samples, SR) {
            Ok(Some(span)) => &samples[span],
            Ok(None) => {
                diag::empty_result(
                    "local/asr",
                    &format!("VAD detected no speech; model inference was skipped audio_sec={:.1}", audio_sec),
                );
                return Ok(LocalAsrResult {
                    text: String::new(),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                });
            }
            Err(e) => {
                return Err(diag::fail(
                    "local/asr",
                    "vad",
                    format!("Voice activity detection failed; recognition was canceled: {e}"),
                ));
            }
        };
        let text = gguf_asr::transcribe(&model_id, lang, &accel, &gpu, trimmed, SR)
            .map_err(|e| diag::fail("local/asr", "transcribe", e))?;
        let elapsed_ms = start.elapsed().as_millis() as u64;
        if text.trim().is_empty() {
            diag::empty_result(
                "local/asr",
                &format!(
                    "VAD detected speech but the model produced no output model={} accel={} audio_sec={:.1} elapsed={}ms",
                    model_id, accel, audio_sec, elapsed_ms
                ),
            );
        } else {
            diag::ok("local/asr", elapsed_ms, text.chars().count());
        }
        Ok(LocalAsrResult { text, elapsed_ms })
    })
    .await
    .map_err(|e| {
        crate::providers::diag::fail("local/asr", "join", format!("Inference task failed: {}", e))
    })?
}

#[tauri::command]
pub async fn preload_local_model(
    model_id: String,
    accelerator: Option<String>,
    gpu_device: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let start = Instant::now();
        let accel = accelerator.as_deref().unwrap_or("auto");
        let gpu = gpu_device.as_deref().unwrap_or("");
        gguf_asr::preload(&model_id, accel, gpu)?;
        Ok(format!("Model loaded ({}ms)", start.elapsed().as_millis()))
    })
    .await
    .map_err(|e| format!("Preload task failed: {}", e))?
}

#[tauri::command]
pub async fn unload_local_model() -> Result<(), String> {
    tokio::task::spawn_blocking(gguf_asr::unload)
        .await
        .map_err(|e| format!("Release task failed: {}", e))
}

#[tauri::command]
pub fn set_local_model_idle_unload(idle_minutes: u64) -> Result<(), String> {
    if !matches!(idle_minutes, 0 | 10 | 30 | 60) {
        return Err(format!("Unsupported model idle unload interval: {idle_minutes}"));
    }
    gguf_asr::set_idle_unload_minutes(idle_minutes);
    Ok(())
}


///
const LEGACY_MODEL_IDS: &[&str] = &[
    "whisper-tiny",
    "whisper-base",
    "whisper-small",
    "whisper-medium",
];

fn looks_like_legacy_onnx_model(dir: &std::path::Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let mut has_onnx = false;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        match entry
            .path()
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
        {
            Some(ext) if ext == "gguf" => return false,
            Some(ext) if ext == "onnx" => has_onnx = true,
            _ => {}
        }
    }
    has_onnx
}

fn dir_size(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

///
pub fn reclaim_legacy_models() -> u64 {
    let root = models_dir();
    if !root.exists() {
        return 0;
    }

    let mut freed = 0u64;
    for id in LEGACY_MODEL_IDS {
        let dir = model_dir(id);
        if !looks_like_legacy_onnx_model(&dir) {
            continue;
        }
        let size = dir_size(&dir);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {
                freed += size;
                log::info!(
                    "Removed legacy engine model {} ({:.1} MB)",
                    id,
                    size as f64 / 1024.0 / 1024.0
                );
            }
            Err(e) => log::warn!("Failed to remove legacy engine model {}: {}", id, e),
        }
    }

    let vad = root.join("silero_vad.onnx");
    if vad.is_file() {
        let size = std::fs::metadata(&vad).map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&vad).is_ok() {
            freed += size;
            log::info!("Removed legacy VAD weights silero_vad.onnx");
        }
    }

    if freed > 0 {
        log::info!("Removed {:.1} MB of legacy engine models", freed as f64 / 1024.0 / 1024.0);
    }
    freed
}

#[tauri::command]
pub fn legacy_models_reclaimed_bytes() -> u64 {
    RECLAIMED.load(std::sync::atomic::Ordering::Relaxed)
}

static RECLAIMED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn spawn_legacy_reclaim() {
    std::thread::spawn(|| {
        let freed = reclaim_legacy_models();
        RECLAIMED.store(freed, std::sync::atomic::Ordering::Relaxed);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_detection_requires_onnx_and_rejects_gguf() {
        let tmp = std::env::temp_dir().join(format!("sayforge-legacy-test-{}", std::process::id()));
        let onnx_dir = tmp.join("old");
        let gguf_dir = tmp.join("new");
        let mixed_dir = tmp.join("mixed");
        for d in [&onnx_dir, &gguf_dir, &mixed_dir] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(onnx_dir.join("model.int8.onnx"), b"x").unwrap();
        std::fs::write(gguf_dir.join("m-Q8_0.gguf"), b"x").unwrap();
        std::fs::write(mixed_dir.join("model.int8.onnx"), b"x").unwrap();
        std::fs::write(mixed_dir.join("m-Q8_0.gguf"), b"x").unwrap();

        assert!(looks_like_legacy_onnx_model(&onnx_dir));
        assert!(!looks_like_legacy_onnx_model(&gguf_dir));
        assert!(!looks_like_legacy_onnx_model(&mixed_dir));
        assert!(!looks_like_legacy_onnx_model(&tmp.join("does-not-exist")));

        std::fs::remove_dir_all(&tmp).ok();
    }

    fn run_local_transcribe(audio_b64: String, model_id: &str) -> Result<LocalAsrResult, String> {
        super::super::gguf_asr::init_backends();
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("创建测试 runtime 失败")
            .block_on(local_transcribe(
                audio_b64,
                model_id.to_string(),
                Some("auto".to_string()),
                Some("auto".to_string()),
                None,
            ))
    }

        #[test]
    fn end_to_end_base64_to_text() {
        let model_id = "nemotron-asr-streaming-0.6b-gguf";
        if !super::super::gguf_asr::model_is_downloaded(model_id) {
            eprintln!("skip: {model_id} 未下载");
            return;
        }

        let wav = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/test_en.wav");
        let bytes = std::fs::read(&wav).unwrap();
        let speech = &bytes[44..];
        let silence = vec![0u8; SR * 2 * 2]; // 2s、16-bit PCM
        let mut pcm_bytes = Vec::new();
        pcm_bytes.extend_from_slice(&silence);
        pcm_bytes.extend_from_slice(speech);
        pcm_bytes.extend_from_slice(&silence);

        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &pcm_bytes,
        );
        let result = run_local_transcribe(b64, model_id).unwrap();
        assert!(
            !result.text.trim().is_empty(),
            "VAD 后仍应识别出内容，got {:?}",
            result.text
        );
        super::super::gguf_asr::unload();
    }

    #[test]
    fn silence_short_circuits_before_loading_model() {
        let pcm_bytes = vec![0u8; SR * 2 * 3];
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &pcm_bytes,
        );

        let result = run_local_transcribe(b64, "model-that-must-not-be-loaded").unwrap();
        assert!(result.text.is_empty());
    }

    #[test]
    fn decode_pcm_maps_i16_to_unit_range() {
        // i16 -32768 / 0 / 32767 → -1.0 / 0.0 / ~1.0
        let bytes: Vec<u8> = [i16::MIN, 0i16, i16::MAX]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        let pcm = decode_pcm(&b64).unwrap();
        assert_eq!(pcm.len(), 3);
        assert!((pcm[0] + 1.0).abs() < 1e-6);
        assert_eq!(pcm[1], 0.0);
        assert!((pcm[2] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn decode_pcm_rejects_incomplete_i16_sample() {
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            [0u8, 1, 2],
        );
        let err = decode_pcm(&b64).unwrap_err();
        assert!(err.contains("16-bit"), "unexpected error: {err}");
    }
}
