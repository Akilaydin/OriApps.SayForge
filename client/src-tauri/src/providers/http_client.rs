//
//
pub const USER_AGENT: &str = concat!("SayForge/", env!("CARGO_PKG_VERSION"));

static SHARED: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

pub fn shared() -> &'static reqwest::Client {
    &SHARED
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrTimeout {
    max_audio_seconds: f64,
    base_response_ms: u64,
    response_ms_per_audio_second: f64,
    min_upload_bytes_per_second: f64,
    payload_overhead_bytes: f64,
    max_request_ms: u64,
}

static ASR_TIMEOUT: once_cell::sync::Lazy<AsrTimeout> = once_cell::sync::Lazy::new(|| {
    serde_json::from_str(include_str!("../../../src/services/transcription/asrTimeout.json"))
        .expect("bundled ASR timeout policy must be valid")
});

pub fn transcription_timeout(pcm_bytes: usize, sample_rate: u32) -> std::time::Duration {
    let policy = &*ASR_TIMEOUT;
    let bytes_per_second = sample_rate.max(1) as f64 * 2.0;
    let audio_sec = (pcm_bytes as f64 / bytes_per_second).min(policy.max_audio_seconds);
    // WAV/base64 is the conservative upload size for multipart and chat, including MP3.
    let upload_bytes = audio_sec * bytes_per_second * 4.0 / 3.0 + policy.payload_overhead_bytes;
    let upload_ms = (upload_bytes / policy.min_upload_bytes_per_second).ceil() * 1000.0;
    let request_ms = policy.base_response_ms as f64
        + (audio_sec * policy.response_ms_per_audio_second).ceil() + upload_ms;
    std::time::Duration::from_millis((request_ms as u64).min(policy.max_request_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_minute_audio_covers_slow_wav_chat_upload_and_response() {
        assert_eq!(transcription_timeout(16000 * 2 * 300, 16000).as_millis(), 1_202_000);
        assert!(transcription_timeout(16000 * 2, 16000).as_secs() > 120);
    }

    #[test]
    fn timeout_is_bounded_and_accounts_for_sample_rate() {
        assert_eq!(transcription_timeout(16000 * 2 * 600, 16000), transcription_timeout(16000 * 2 * 300, 16000));
        assert!(transcription_timeout(48000 * 2 * 300, 48000) > transcription_timeout(16000 * 2 * 300, 16000));
        assert!(transcription_timeout(usize::MAX, u32::MAX).as_millis() <= ASR_TIMEOUT.max_request_ms as u128);
        assert!(transcription_timeout(0, 0).as_secs() >= 120);
    }
}
