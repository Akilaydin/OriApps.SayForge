//!
use std::ops::Range;

use silero_vad_crs::{
    get_timestamps_from_probs_with_config, SileroVad, TimestampConfig,
};

const SPEECH_THRESHOLD: f32 = 0.3;
const MIN_SPEECH_MS: usize = 60;
const MIN_SILENCE_MS: usize = 450;
const SPEECH_PAD_MS: usize = 450;

///
pub fn detect_speech_span(
    samples: &[f32],
    sample_rate: usize,
) -> Result<Option<Range<usize>>, String> {
    if samples.is_empty() {
        return Ok(None);
    }

    let mut vad = SileroVad::with_sample_rate(sample_rate)
        .map_err(|e| format!("Failed to create Silero VAD: {e}"))?;
    let window_size_samples = vad.source_window_samples();
    let probabilities = vad
        .forward_audio(samples)
        .map_err(|e| format!("Silero VAD inference failed: {e}"))?;

    let segments = get_timestamps_from_probs_with_config(
        &probabilities,
        samples.len(),
        TimestampConfig {
            sampling_rate: sample_rate,
            threshold: SPEECH_THRESHOLD,
            min_speech_duration_ms: MIN_SPEECH_MS,
            min_silence_duration_ms: MIN_SILENCE_MS,
            speech_pad_ms: SPEECH_PAD_MS,
            window_size_samples,
            ..Default::default()
        },
    );

    let (Some(first), Some(last)) = (segments.first(), segments.last()) else {
        return Ok(None);
    };
    let start = first.start.min(samples.len());
    let end = last.end.min(samples.len());
    if start >= end {
        return Ok(None);
    }

    log::debug!(
        "Silero VAD: {:.2}s -> {:.2}s, speech_segments={}",
        samples.len() as f64 / sample_rate as f64,
        (end - start) as f64 / sample_rate as f64,
        segments.len(),
    );
    Ok(Some(start..end))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: usize = 16_000;

    fn read_test_speech() -> Vec<f32> {
        let bytes = include_bytes!("../../resources/test_en.wav");
        bytes[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect()
    }

    #[test]
    fn pure_silence_is_rejected() {
        let audio = vec![0.0; SR * 3];
        assert_eq!(detect_speech_span(&audio, SR).unwrap(), None);
    }

    #[test]
    fn steady_background_noise_is_rejected() {
        let mut state = 0x1234_5678u32;
        let audio: Vec<f32> = (0..SR * 3)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 8) as f32 / 16_777_215.0 - 0.5) * 0.02
            })
            .collect();
        assert_eq!(detect_speech_span(&audio, SR).unwrap(), None);
    }

    #[test]
    fn short_transient_noise_is_rejected() {
        let mut audio = vec![0.0; SR];
        for (i, sample) in audio[SR / 2..SR / 2 + 512].iter_mut().enumerate() {
            let t = i as f32 / SR as f32;
            *sample = 0.4 * (2.0 * std::f32::consts::PI * 1_500.0 * t).sin();
        }
        assert_eq!(detect_speech_span(&audio, SR).unwrap(), None);
    }

    #[test]
    fn bundled_speech_is_detected() {
        let speech = read_test_speech();
        assert!(
            detect_speech_span(&speech, SR).unwrap().is_some(),
            "真实中文语音不应被 VAD 拒绝",
        );
    }

    #[test]
    fn quiet_speech_is_detected() {
        let speech: Vec<f32> = read_test_speech().into_iter().map(|s| s * 0.2).collect();
        assert!(
            detect_speech_span(&speech, SR).unwrap().is_some(),
            "降低约 14dB 的轻声语音不应被 VAD 拒绝",
        );
    }

    #[test]
    fn internal_pause_is_preserved() {
        let speech = read_test_speech();
        let half = speech.len() / 2;
        let mut audio = vec![0.0; SR];
        audio.extend_from_slice(&speech[..half]);
        let pause_start = audio.len();
        audio.extend(std::iter::repeat(0.0).take(SR * 2));
        let pause_end = audio.len();
        audio.extend_from_slice(&speech[half..]);
        audio.extend(std::iter::repeat(0.0).take(SR));

        let span = detect_speech_span(&audio, SR)
            .unwrap()
            .expect("前后两段真实语音应被检测到");
        assert!(span.start < pause_start);
        assert!(span.end > pause_end);
        assert!(audio[span.clone()][pause_start - span.start..pause_end - span.start]
            .iter()
            .all(|sample| *sample == 0.0));
    }
}
