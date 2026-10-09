use tauri::{AppHandle, Emitter, State};
use crate::keyboard::KeyboardHookManager;
use crate::storage::Storage;

#[tauri::command]
pub fn set_escape_action_mode(mode: String, token: u64) -> Result<(), String> {
    crate::keyboard::set_escape_action_mode(&mode, token)
}

///
#[tauri::command]
pub fn set_card_hotkeys(actions: Vec<String>, token: u64) -> Result<(), String> {
    crate::keyboard::set_card_hotkeys(&actions, token)
}

#[tauri::command]
pub fn shortcuts_changed(
    app: AppHandle,
    storage: State<Storage>,
    hook: State<KeyboardHookManager>,
) {
    // Read settings
    let ptt_setting = storage.get("shortcutPTT", None);
    let ptt_str = ptt_setting.as_str().unwrap_or("ControlRight");
    let hf_val = storage.get("shortcutHandsFree", None);
    let hf_key = hf_val.as_str().unwrap_or("AltRight");
    let ai_toggle_val = storage.get("shortcutToggleAi", None);
    let ai_toggle_key = ai_toggle_val.as_str().unwrap_or("");

    // Reconfigure PTT + hands-free + AI cleanup single-key/mouse hook
    hook.reconfigure(&app, ptt_str, hf_key, ai_toggle_key);

    register_all_global_shortcuts(&app, storage.inner());
}

///
pub fn register_all_global_shortcuts(app: &AppHandle, storage: &Storage) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let hf_val = storage.get("shortcutHandsFree", None);
    let hf_key = hf_val.as_str().unwrap_or("AltRight").to_string();
    if !hf_key.is_empty() && hf_key.contains('+') {
        if let Err(e) = gs.on_shortcut(hf_key.as_str(), move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit(
                    "toggle-hands-free",
                    serde_json::json!({ "source": "globalShortcut" }),
                );
            }
        }) {
            log::warn!("Failed to register hands-free shortcut '{}': {}", hf_key, e);
        } else {
            log::info!("Registered hands-free shortcut: {}", hf_key);
        }
    }

    let ai_toggle = storage.get("shortcutToggleAi", None);
    let ai_toggle_key = ai_toggle.as_str().unwrap_or("").to_string();
    if !ai_toggle_key.is_empty() && ai_toggle_key.contains('+') {
        let ai_toggle_for_log = ai_toggle_key.clone();
        if let Err(e) = gs.on_shortcut(ai_toggle_key.as_str(), move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit("toggle-ai-cleanup", serde_json::json!({ "source": "globalShortcut" }));
            }
        }) {
            log::warn!("Failed to register AI cleanup shortcut '{}': {}", ai_toggle_for_log, e);
        } else {
            log::info!("Registered AI cleanup shortcut: {}", ai_toggle_for_log);
        }
    }

    let preset_map = storage.get("presetShortcuts", None);
    if let Some(obj) = preset_map.as_object() {
        for (preset_id, val) in obj {
            let accel = match val.as_str() {
                Some(s) if !s.is_empty() && s.contains('+') => s.to_string(),
                _ => continue,
            };
            let pid = preset_id.clone();
            let accel_for_log = accel.clone();
            if let Err(e) = gs.on_shortcut(accel.as_str(), move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = app.emit(
                        "switch-preset",
                        serde_json::json!({ "presetId": pid.clone() }),
                    );
                }
            }) {
                log::warn!(
                    "Failed to register preset shortcut '{}' for '{}': {}",
                    accel_for_log, preset_id, e
                );
            }
        }
    }
}

///
#[tauri::command]
pub fn get_ptt_physical_key_states(codes: Vec<String>) -> Vec<bool> {
    crate::keyboard::ptt_physical_key_states(&codes)
}

#[tauri::command]
pub fn test_shortcut(
    app: AppHandle,
    storage: State<Storage>,
    accelerator: String,
) -> Result<bool, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    if !accelerator.contains('+') {
        return Ok(true);
    }

    let gs = app.global_shortcut();

    let _ = gs.unregister_all();

    let available = match gs.register(accelerator.as_str()) {
        Ok(_) => {
            let _ = gs.unregister(accelerator.as_str());
            true
        }
        Err(e) => {
            log::info!("[shortcut] Failed to register '{}'; another app may already use it: {}", accelerator, e);
            false
        }
    };

    register_all_global_shortcuts(&app, storage.inner());

    Ok(available)
}

#[tauri::command]
pub fn begin_shortcut_capture(app: AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    crate::keyboard::set_shortcut_capture(true);
    let _ = app.global_shortcut().unregister_all();
}

#[tauri::command]
pub fn end_shortcut_capture(app: AppHandle, storage: State<Storage>) {
    crate::keyboard::set_shortcut_capture(false);
    register_all_global_shortcuts(&app, storage.inner());
}
