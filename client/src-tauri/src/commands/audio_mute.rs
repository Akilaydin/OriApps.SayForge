//!
//!
use serde::Serialize;

#[cfg(windows)]
use once_cell::sync::Lazy;
#[cfg(windows)]
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct MicMuteState {
    pub matched: bool,
    pub muted: bool,
}

#[cfg(windows)]
static SAVED_MUTE_STATE: Lazy<Mutex<Option<bool>>> = Lazy::new(|| Mutex::new(None));

#[cfg(windows)]
unsafe fn with_endpoint_volume<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume) -> Result<R, String>,
{
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let result = (|| -> Result<R, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance MMDeviceEnumerator: {}", e))?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("GetDefaultAudioEndpoint: {}", e))?;

        let endpoint: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioEndpointVolume: {}", e))?;

        f(&endpoint)
    })();

    if need_co_uninit {
        CoUninitialize();
    }

    result
}

#[tauri::command]
pub fn mute_system_output() -> Result<bool, String> {
    #[cfg(windows)]
    unsafe {
        with_endpoint_volume(|ep| {
            let was_muted = ep
                .GetMute()
                .map_err(|e| format!("GetMute: {}", e))?
                .as_bool();

            {
                let mut saved = SAVED_MUTE_STATE.lock().unwrap();
                if saved.is_none() {
                    *saved = Some(was_muted);
                }
            }

            if !was_muted {
                ep.SetMute(true, std::ptr::null())
                    .map_err(|e| format!("SetMute(true): {}", e))?;
            }

            crate::commands::system::write_log_line(&format!(
                "[RUST] [audio_mute] muted output (prev_muted={})",
                was_muted
            ));
            Ok(true)
        })
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn restore_system_output() -> Result<bool, String> {
    #[cfg(windows)]
    unsafe {
        let saved = {
            let mut s = SAVED_MUTE_STATE.lock().unwrap();
            s.take()
        };

        match saved {
            Some(prev) => with_endpoint_volume(|ep| {
                ep.SetMute(windows::Win32::Foundation::BOOL::from(prev), std::ptr::null())
                    .map_err(|e| format!("SetMute restore: {}", e))?;
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [audio_mute] restored output (mute={})",
                    prev
                ));
                Ok(true)
            }),
            None => Ok(false),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────

fn normalize_mic_label(label: &str) -> String {
    let trimmed = label.trim();
    let lower = trimmed.to_lowercase();
    let without_route_prefix = ["default", "communications"]
        .iter()
        .find_map(|prefix| {
            let prefix_lower = prefix.to_lowercase();
            lower.starts_with(&prefix_lower).then(|| {
                trimmed[prefix.len()..].trim_start_matches(|c: char| {
                    c.is_whitespace() || matches!(c, '-' | '–' | '—' | ':')
                })
            })
        })
        .unwrap_or(trimmed);

    without_route_prefix
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Chromium may prefix a device name with the localized default/communications
/// route. Match the unmodified endpoint name after a separator without keeping
/// a per-language list of browser strings.
fn mic_labels_match(browser_label: &str, endpoint_label: &str) -> bool {
    let browser = normalize_mic_label(browser_label);
    let endpoint = normalize_mic_label(endpoint_label);
    if endpoint.is_empty() { return false; }
    if browser == endpoint { return true; }
    browser.strip_suffix(&endpoint).is_some_and(|prefix| {
        prefix.trim_end().chars().last()
            .is_some_and(|c| matches!(c, '-' | '–' | '—' | ':' | '：'))
    })
}

#[cfg(windows)]
unsafe fn get_device_friendly_name(
    device: &windows::Win32::Media::Audio::IMMDevice,
) -> Result<String, String> {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc,
    };
    use windows::Win32::System::Com::{CoTaskMemFree, STGM_READ};

    let store = device
        .OpenPropertyStore(STGM_READ)
        .map_err(|e| format!("OpenPropertyStore: {}", e))?;
    let mut value = store
        .GetValue(&PKEY_Device_FriendlyName)
        .map_err(|e| format!("GetValue(PKEY_Device_FriendlyName): {}", e))?;

    let name_result = (|| -> Result<String, String> {
        let ptr = PropVariantToStringAlloc(&value)
            .map_err(|e| format!("PropVariantToStringAlloc: {}", e))?;
        let text = ptr
            .to_string()
            .map_err(|e| format!("FriendlyName to_string: {}", e));
        CoTaskMemFree(Some(ptr.0.cast()));
        text
    })();
    let clear_result = PropVariantClear(&mut value)
        .map_err(|e| format!("PropVariantClear: {}", e));
    clear_result?;
    name_result
}

///
#[cfg(windows)]
unsafe fn query_mic_mute(label: Option<&str>) -> Result<MicMuteState, String> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let result = (|| -> Result<MicMuteState, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance MMDeviceEnumerator: {}", e))?;

        let device: IMMDevice = if let Some(target_label) =
            label.map(str::trim).filter(|s| !s.is_empty())
        {
            let devices = enumerator
                .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
                .map_err(|e| format!("EnumAudioEndpoints(eCapture): {}", e))?;
            let count = devices
                .GetCount()
                .map_err(|e| format!("IMMDeviceCollection.GetCount: {}", e))?;
            let mut matched: Option<IMMDevice> = None;

            for index in 0..count {
                let candidate = devices
                    .Item(index)
                    .map_err(|e| format!("IMMDeviceCollection.Item({}): {}", index, e))?;
                let friendly_name = match get_device_friendly_name(&candidate) {
                    Ok(name) => name,
                    Err(_) => continue,
                };
                if !mic_labels_match(target_label, &friendly_name) {
                    continue;
                }
                if matched.is_some() {
                    return Ok(MicMuteState {
                        matched: false,
                        muted: false,
                    });
                }
                matched = Some(candidate);
            }

            match matched {
                Some(device) => device,
                None => {
                    return Ok(MicMuteState {
                        matched: false,
                        muted: false,
                    })
                }
            }
        } else {
            enumerator
                .GetDefaultAudioEndpoint(eCapture, eConsole)
                .map_err(|e| format!("GetDefaultAudioEndpoint(eCapture): {}", e))?
        };

        let endpoint: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioEndpointVolume: {}", e))?;
        let muted = endpoint
            .GetMute()
            .map_err(|e| format!("GetMute: {}", e))?
            .as_bool();
        Ok(MicMuteState { matched: true, muted })
    })();

    if need_co_uninit {
        CoUninitialize();
    }

    result
}

#[tauri::command]
pub fn get_mic_mute_state(device_label: Option<String>) -> MicMuteState {
    #[cfg(windows)]
    unsafe {
        match query_mic_mute(device_label.as_deref()) {
            Ok(state) => state,
            Err(e) => {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [audio_mute] get_mic_mute_state failed: {}",
                    e
                ));
                MicMuteState { matched: false, muted: false }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = device_label;
        MicMuteState { matched: false, muted: false }
    }
}

#[cfg(test)]
mod tests {
    use super::{mic_labels_match, normalize_mic_label};

    #[test]
    fn browser_route_prefix_does_not_change_endpoint_identity() {
        assert_eq!(
            normalize_mic_label("Default - Headset Microphone (Plantronics Blackwire 5220 Series)"),
            normalize_mic_label("Headset Microphone (Plantronics Blackwire 5220 Series)")
        );
        assert_eq!(
            normalize_mic_label("Communications: USB Microphone"),
            "usb microphone"
        );
    }

    #[test]
    fn ordinary_device_name_is_preserved_for_matching() {
        assert_eq!(normalize_mic_label("  Studio   Mic  "), "studio mic");
    }

    #[test]
    fn localized_browser_route_prefixes_do_not_require_ui_translations() {
        assert!(mic_labels_match("默认值 - USB 麦克风", "USB 麦克风"));
        assert!(mic_labels_match("По умолчанию - USB Microphone", "USB Microphone"));
        assert!(mic_labels_match("Communications: Studio Mic", "Studio Mic"));
        assert!(!mic_labels_match("Another Studio Mic", "Studio Mic"));
        assert!(!mic_labels_match("USB Microphone", "Microphone"));
        assert!(!mic_labels_match("USB Microphone", ""));
    }
}
