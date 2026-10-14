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
static OUTPUT_MUTE_STATE: Lazy<Mutex<OutputMuteState>> = Lazy::new(|| Mutex::new(OutputMuteState::default()));

#[cfg(any(windows, test))]
struct SavedOutputMute {
    endpoint_id: String,
    muted: bool,
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct OutputMuteState {
    saved: Option<SavedOutputMute>,
    exiting: bool,
}

#[cfg(any(windows, test))]
impl OutputMuteState {
    fn mute(&mut self, capture: impl FnOnce() -> Result<SavedOutputMute, String>,
        apply: impl FnOnce(&SavedOutputMute) -> Result<(), String>) -> Result<bool, String> {
        if self.exiting { return Ok(false); }
        if self.saved.is_none() { self.saved = Some(capture()?); }
        // Save before SetMute: a failed device call must still permit restoration.
        apply(self.saved.as_ref().unwrap())?;
        Ok(true)
    }

    fn restore(&mut self, apply: impl FnOnce(&SavedOutputMute) -> Result<(), String>) -> Result<bool, String> {
        match self.saved.as_ref() {
            Some(previous) => { apply(previous)?; self.saved = None; Ok(true) }
            None => Ok(false),
        }
    }

    fn prepare_exit(&mut self, apply: impl FnOnce(&SavedOutputMute) -> Result<(), String>) -> Result<(), String> {
        self.exiting = true;
        if let Err(error) = self.restore(apply) {
            self.exiting = false;
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(windows)]
unsafe fn with_endpoint_volume<F, R>(endpoint_id: Option<&str>, f: F) -> Result<R, String>
where
    F: FnOnce(&windows::Win32::Media::Audio::IMMDevice, &windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume) -> Result<R, String>,
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

        let device = if let Some(id) = endpoint_id {
            enumerator.GetDevice(&windows::core::HSTRING::from(id))
                .map_err(|e| format!("GetDevice(saved output): {}", e))?
        } else {
            enumerator.GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("GetDefaultAudioEndpoint: {}", e))?
        };

        let endpoint: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioEndpointVolume: {}", e))?;

        f(&device, &endpoint)
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
        let mut state = OUTPUT_MUTE_STATE.lock().unwrap_or_else(|error| error.into_inner());
        state.mute(|| with_endpoint_volume(None, |device, ep| {
            let muted = ep.GetMute().map_err(|e| format!("GetMute: {}", e))?.as_bool();
            let id = device.GetId().map_err(|e| format!("GetId(output): {}", e))?;
            let endpoint_id = id.to_string().map_err(|e| format!("Output ID conversion: {}", e));
            windows::Win32::System::Com::CoTaskMemFree(Some(id.0.cast()));
            Ok(SavedOutputMute { endpoint_id: endpoint_id?, muted })
        }), |saved| set_output_mute(saved, true))
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
        let mut state = OUTPUT_MUTE_STATE.lock().unwrap_or_else(|error| error.into_inner());
        state.restore(|saved| set_output_mute(saved, saved.muted))
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[cfg(windows)]
unsafe fn set_output_mute(saved: &SavedOutputMute, muted: bool) -> Result<(), String> {
    with_endpoint_volume(Some(&saved.endpoint_id), |_, ep| {
        ep.SetMute(windows::Win32::Foundation::BOOL::from(muted), std::ptr::null())
            .map_err(|e| format!("SetMute(output): {}", e))?;
        log::info!("[audio_mute] output mute={}", muted);
        Ok(())
    })
}

pub fn prepare_system_output_for_exit() -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        let mut state = OUTPUT_MUTE_STATE.lock().unwrap_or_else(|error| error.into_inner());
        state.prepare_exit(|saved| set_output_mute(saved, saved.muted)).map_err(|error| {
            log::error!("[audio_mute] operation=restore_before_exit error={}", error);
            error
        })
    }
    #[cfg(not(windows))]
    { Ok(()) }
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

/// Prefer exact endpoint identity over a browser route prefix: a name such as
/// "USB: Studio Mic" may itself be the name of another physical endpoint.
/// Rank: 2 = exact, 1 = suffix after route separator, 0 = unrelated.
fn mic_label_match_rank(browser_label: &str, endpoint_label: &str) -> u8 {
    let browser = normalize_mic_label(browser_label);
    let endpoint = normalize_mic_label(endpoint_label);
    if endpoint.is_empty() { return 0; }
    if browser == endpoint { return 2; }
    if browser.strip_suffix(&endpoint).is_some_and(|prefix| {
        prefix.trim_end().chars().last()
            .is_some_and(|c| matches!(c, '-' | '–' | '—' | ':'))
    }) { 1 } else { 0 }
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
            let mut best_rank = 0;
            let mut ambiguous = false;

            for index in 0..count {
                let candidate = devices
                    .Item(index)
                    .map_err(|e| format!("IMMDeviceCollection.Item({}): {}", index, e))?;
                let friendly_name = match get_device_friendly_name(&candidate) {
                    Ok(name) => name,
                    Err(_) => continue,
                };
                let rank = mic_label_match_rank(target_label, &friendly_name);
                if rank == 0 || rank < best_rank {
                    continue;
                }
                if rank == best_rank {
                    ambiguous = true;
                } else {
                    matched = Some(candidate);
                    best_rank = rank;
                    ambiguous = false;
                }
            }

            match if ambiguous { None } else { matched } {
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
    use super::{mic_label_match_rank, normalize_mic_label};

    #[test]
    fn failed_output_restore_keeps_the_original_state_for_retry() {
        let mut state = super::OutputMuteState { saved: Some(synthetic_snapshot(false)), ..Default::default() };
        assert!(state.restore(|_| Err("synthetic endpoint failure".into())).is_err());
        assert_eq!(state.saved.as_ref().map(|saved| saved.muted), Some(false), "failure must retain the original unmuted state");
        let mut output_muted = true;
        assert!(state.restore(|previous| { output_muted = previous.muted; Ok(()) }).unwrap());
        assert!(!output_muted);
        assert!(state.saved.is_none());
    }

    fn synthetic_snapshot(muted: bool) -> super::SavedOutputMute {
        super::SavedOutputMute { endpoint_id: "synthetic-original-output".into(), muted }
    }

    #[test]
    fn exit_restores_original_muted_and_unmuted_output_and_rejects_late_mute() {
        for initial_mute in [false, true] {
            let mut state = super::OutputMuteState::default();
            let mut output_muted = initial_mute;
            state.mute(|| Ok(synthetic_snapshot(initial_mute)), |_| { output_muted = true; Ok(()) }).unwrap();
            assert!(output_muted);
            // Repeat requests must retain the first snapshot, even if default output changed.
            state.mute(|| panic!("must not capture a different default output"), |_| Ok(())).unwrap();
            state.prepare_exit(|previous| {
                assert_eq!(previous.endpoint_id, "synthetic-original-output");
                output_muted = previous.muted;
                Ok(())
            }).unwrap();
            assert_eq!(output_muted, initial_mute);
            assert!(state.saved.is_none());
            assert!(!state.mute(|| panic!("late mute must not access devices"), |_| panic!("late mute must not change sound")).unwrap());
            assert!(!state.restore(|_| panic!("duplicate stop/exit must not modify sound")).unwrap());
        }
    }

    #[test]
    fn failed_exit_can_be_retried_and_failed_mute_still_retains_the_original_snapshot() {
        let mut state = super::OutputMuteState::default();
        assert!(state.mute(|| Ok(synthetic_snapshot(false)), |_| Err("synthetic partial SetMute failure".into())).is_err());
        assert!(state.saved.is_some());
        assert!(state.prepare_exit(|_| Err("synthetic disconnected endpoint".into())).is_err());
        assert!(!state.exiting);
        assert!(!state.saved.as_ref().unwrap().muted);
        state.prepare_exit(|previous| { assert!(!previous.muted); Ok(()) }).unwrap();
        assert!(state.exiting);
        assert!(state.saved.is_none());
    }

    #[test]
    fn ordinary_stop_allows_a_new_recording_and_unused_mute_never_accesses_devices_on_exit() {
        let mut state = super::OutputMuteState::default();
        state.mute(|| Ok(synthetic_snapshot(false)), |_| Ok(())).unwrap();
        assert!(state.restore(|previous| { assert!(!previous.muted); Ok(()) }).unwrap());
        assert!(!state.exiting);
        state.mute(|| Ok(synthetic_snapshot(true)), |_| Ok(())).unwrap();
        assert!(state.restore(|previous| { assert!(previous.muted); Ok(()) }).unwrap());
        state.prepare_exit(|_| panic!("no saved state must not access audio")).unwrap();
    }

    #[test]
    fn exit_waits_for_in_flight_mute_then_restores_before_late_requests() {
        use std::sync::{Arc, Mutex, mpsc};
        let state = Arc::new(Mutex::new(super::OutputMuteState::default()));
        let muted = Arc::new(Mutex::new(false));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mute_state = state.clone();
        let mute_output = muted.clone();
        let mute = std::thread::spawn(move || {
            mute_state.lock().unwrap().mute(|| Ok(synthetic_snapshot(false)), |_| {
                *mute_output.lock().unwrap() = true;
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
                Ok(())
            }).unwrap();
        });
        started_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        let exit_state = state.clone();
        let exit_output = muted.clone();
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let exit = std::thread::spawn(move || {
            attempt_tx.send(()).unwrap();
            exit_state.lock().unwrap().prepare_exit(|previous| { *exit_output.lock().unwrap() = previous.muted; Ok(()) }).unwrap();
        });
        attempt_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        release_tx.send(()).unwrap();
        mute.join().unwrap();
        exit.join().unwrap();
        assert!(!*muted.lock().unwrap());
        assert!(!state.lock().unwrap().mute(|| panic!("exit already started"), |_| panic!("late mute")).unwrap());
    }

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
        assert_eq!(mic_label_match_rank("Par défaut - USB Microphone", "USB Microphone"), 1);
        assert_eq!(mic_label_match_rank("По умолчанию - USB Microphone", "USB Microphone"), 1);
        assert_eq!(mic_label_match_rank("Communications: Studio Mic", "Studio Mic"), 2);
        assert_eq!(mic_label_match_rank("Another Studio Mic", "Studio Mic"), 0);
        assert_eq!(mic_label_match_rank("USB Microphone", "Microphone"), 0);
        assert_eq!(mic_label_match_rank("USB Microphone", ""), 0);
    }

    #[test]
    fn exact_endpoint_outweighs_another_devices_suffix_match() {
        assert_eq!(mic_label_match_rank("USB: Studio Mic", "USB: Studio Mic"), 2);
        assert_eq!(mic_label_match_rank("USB: Studio Mic", "Studio Mic"), 1);
    }
}
