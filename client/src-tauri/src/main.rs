// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod error_protocol;
mod locale;
mod storage;
mod window;
mod keyboard;
mod context;
mod inject;
mod providers;
mod identity;
#[cfg(all(test, target_os = "windows"))]
mod ipc_benchmark;

use storage::Storage;
use window::WindowState;
use keyboard::KeyboardHookManager;
use context::ContextDetector;
use tauri::{Manager, Emitter};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use std::thread;

fn initialize_autostart(
    storage: &Storage,
    is_enabled: impl FnOnce() -> Result<bool, String>,
    register: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let migrated = storage.get("autoLaunchArgsMigrated", None);
    if migrated.as_str() != Some("true") && migrated.as_bool() != Some(true) {
        // Refresh arguments only for an existing enabled registration. Never disable it first.
        if is_enabled()? { register()?; }
        storage.set("autoLaunchArgsMigrated", &serde_json::json!("true")).map_err(|e| e.to_string())?;
    }
    let initialized = storage.get("autoLaunchInitialized", None);
    if initialized.is_null() || initialized.as_str() == Some("") {
        storage.set("autoLaunchInitialized", &serde_json::json!("true")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Environment-level WebView2 flags must be identical for every webview that shares
/// com.oriapps.sayforge/EBWebView. Keep them global; never copy them into a single window's
/// `additionalBrowserArgs` in tauri.conf.json (WebView2 rejects the second environment
/// with ERROR_INVALID_STATE when the option sets differ).
const WEBVIEW2_BROWSER_ARGS: &str =
    "--ignore-certificate-errors \
     --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
     --disable-background-timer-throttling";

#[cfg(target_os = "windows")]
fn media_permission_state(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_KIND,
) -> Option<webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    match kind {
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => Some(COREWEBVIEW2_PERMISSION_STATE_ALLOW),
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => Some(COREWEBVIEW2_PERMISSION_STATE_DENY),
        _ => None,
    }
}

fn browser_args_fingerprint(value: &str) -> String {
    // Stable FNV-1a fingerprint: enough to compare field reports without logging a
    // potentially sensitive inherited proxy argument verbatim.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Clean up expired audio files based on retention setting.
/// Clean up expired log files based on retention setting.
fn cleanup_expired_logs(storage: &Storage) {
    let retention_val = storage.get("logRetentionDays", Some(&serde_json::json!(30)));
    let retention_days = retention_val.as_i64().unwrap_or(30);
    if retention_days <= 0 {
        return;
    }

    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days);
    let cutoff_ts = cutoff.timestamp();

    let log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(identity::APP_ID)
        .join("logs");

    if !log_dir.exists() {
        return;
    }

    let mut deleted = 0u32;
    if let Ok(entries) = std::fs::read_dir(&log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.file_name().map(|n| n == identity::LOG_FILE).unwrap_or(false) {
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&path) {
                if let Ok(modified) = meta.modified() {
                    let mtime = modified
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64;
                    if mtime < cutoff_ts {
                        if std::fs::remove_file(&path).is_ok() {
                            deleted += 1;
                        }
                    }
                }
            }
        }
    }

    if deleted > 0 {
        log::info!("Log cleanup: deleted {} expired files", deleted);
    }
}

fn main() {
    // Mirror the Rust log facade to sayforge.log as well as stderr. This is essential on
    // Windows release builds (`windows_subsystem = "windows"`), where stderr is invisible.
    // It also captures tauri-runtime-wry errors such as the original WebView2 HRESULT.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format(|buf, record| {
            use std::io::Write;
            let line = format!(
                "[RUST-LOG] level={} target={} {}",
                record.level(),
                record.target(),
                record.args()
            );
            commands::system::write_log_line(&line);
            writeln!(buf, "{line}")
        })
        .init();

    {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            let thread = thread::current();
            let thread_name = thread.name().unwrap_or("<unnamed>");
            let location = panic_info.location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "<unknown>".to_string());
            let payload = panic_info.payload();
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            commands::system::write_log_line(&format!(
                "[PANIC] thread={} at={} msg={}",
                thread_name, location, msg,
            ));
            default_hook(panic_info);
        }));
    }

    log::info!(
        "{} starting version={} profile={} pid={}",
        identity::APP_NAME,
        env!("CARGO_PKG_VERSION"),
        if cfg!(debug_assertions) { "debug" } else { "release" },
        std::process::id(),
    );
    log::info!("Log file: {:?}", dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(identity::APP_ID)
        .join("logs")
        .join(identity::LOG_FILE));

    // Set shared WebView2 flags before creating any window.
    // Background capture and overlay timers retain the existing throttling policy.
    let (browser_args_source, browser_args) = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(value) => ("inherited", value),
        Err(_) => {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", WEBVIEW2_BROWSER_ARGS);
            ("app-default", WEBVIEW2_BROWSER_ARGS.to_string())
        }
    };
    log::info!(
        "WebView2 environment userDataDir={:?} argsSource={} argsLen={} argsFingerprint={}",
        dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join(identity::APP_ID)
            .join("EBWebView"),
        browser_args_source,
        browser_args.len(),
        browser_args_fingerprint(&browser_args),
    );

    let db_path = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(identity::APP_ID)
        .join(identity::DATABASE_FILE);

    let storage = Storage::new(db_path).expect("failed to initialize SQLite storage");

    // Deliberately do not automatically import databases from other distributions.
    // Users may migrate settings through Settings → Export/Import; the upstream
    // app and its audio/history files must remain untouched.


    // Clean up expired log files on startup
    cleanup_expired_logs(&storage);

    // Read PTT setting before moving storage into managed state
    let ptt_setting_val = storage.get("shortcutPTT", None);
    let ptt_str = ptt_setting_val.as_str().unwrap_or("ControlRight").to_string();
    let hf_setting_val = storage.get("shortcutHandsFree", None);
    let hf_str = hf_setting_val.as_str().unwrap_or("AltRight").to_string();
    let ai_toggle_setting_val = storage.get("shortcutToggleAi", None);
    let ai_toggle_str = ai_toggle_setting_val.as_str().unwrap_or("").to_string();
    log::info!("PTT setting from DB: raw={:?} parsed={:?}", ptt_setting_val, ptt_str);
    log::info!("HF setting from DB: raw={:?} parsed={:?}", hf_setting_val, hf_str);

    let window_state = WindowState::new();
    let keyboard_hook = KeyboardHookManager::new();
    let context_detector = ContextDetector::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
                if args.iter().any(|a| a == "--open-about") {
                    let _ = w.emit("open-about", ());
                }
            }
        }))
        .manage(storage)
        .manage(window_state)
        .manage(keyboard_hook)
        .manage(context_detector)
        .setup(move |app| {
            // SayForge's main window and lazy overlay share one WebView2 user-data directory.
            // Per-window browser arguments violate WebView2's environment compatibility
            // contract. Fail loudly during startup instead of leaving a half-working app
            // whose main window works but whose overlay can never be created.
            let unsafe_windows = app
                .config()
                .app
                .windows
                .iter()
                .filter_map(|window| {
                    window.additional_browser_args.as_ref().map(|args| {
                        format!("{}(argsLen={})", window.label, args.len())
                    })
                })
                .collect::<Vec<_>>();
            if !unsafe_windows.is_empty() {
                let message = format!(
                    "per-window additionalBrowserArgs is forbidden for shared WebView2 data: {}",
                    unsafe_windows.join(", ")
                );
                log::error!("WebView2 configuration invariant failed: {message}");
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, message).into());
            }

            let hook: tauri::State<KeyboardHookManager> = app.state();
            hook.start(app.handle(), &ptt_str, &hf_str, &ai_toggle_str);

            keyboard::spawn_health_watchdog();

            let launched_minimized = std::env::args().any(|arg| arg == "--minimized");
            let launched_open_about = std::env::args().any(|arg| arg == "--open-about");
            if let Some(main_window) = app.get_webview_window("main") {
                let ico_bytes = include_bytes!("../icons/icon.ico");
                if let Ok(icon) = tauri::image::Image::from_bytes(ico_bytes) {
                    let _ = main_window.set_icon(icon);
                }

                #[cfg(target_os = "windows")]
                {
                    let _ = main_window.with_webview(|webview| {
                        use webview2_com::PermissionRequestedEventHandler;
                        unsafe {
                            let controller = webview.controller();
                            if let Ok(core) = controller.CoreWebView2() {
                                let handler = PermissionRequestedEventHandler::create(Box::new(
                                    |_sender, args| {
                                        if let Some(args) = args {
                                            let mut kind = Default::default();
                                            args.PermissionKind(&mut kind)?;
                                            if let Some(state) = media_permission_state(kind) {
                                                args.SetState(state)?;
                                                log::info!(
                                                    "WebView2 media permission: kind={:?} state={:?}",
                                                    kind, state
                                                );
                                            }
                                        }
                                        Ok(())
                                    },
                                ));
                                let mut token = Default::default();
                                match core.add_PermissionRequested(&handler, &mut token) {
                                    Ok(_) => log::info!(
                                        "WebView2 PermissionRequested handler attached"
                                    ),
                                    Err(e) => log::error!(
                                        "failed to attach PermissionRequested handler: {e:?}"
                                    ),
                                }
                            }
                        }
                    });
                }

                if !launched_minimized {
                    let _ = main_window.show();
                    let _ = main_window.unminimize();
                    let _ = main_window.set_focus();
                    log::info!(
                        "Main window shown (minimized={:?} visible={:?})",
                        main_window.is_minimized().ok(),
                        main_window.is_visible().ok()
                    );
                } else {
                    log::info!("Launched with --minimized, staying hidden in tray");
                }
                if launched_open_about {
                    let _ = main_window.emit("open-about", ());
                }
            }

            {
                commands::tray::create_tray_menu_window(app.handle())?;

                let tray_scale = app
                    .get_webview_window("main")
                    .and_then(|window| window.scale_factor().ok())
                    .unwrap_or(1.0);
                let (tray_icon_bytes, tray_icon_size): (&[u8], u32) = if tray_scale >= 1.75 {
                    (include_bytes!("../icons/tray-32.png"), 32)
                } else if tray_scale >= 1.375 {
                    (include_bytes!("../icons/tray-24.png"), 24)
                } else if tray_scale >= 1.125 {
                    (include_bytes!("../icons/tray-20.png"), 20)
                } else {
                    (include_bytes!("../icons/tray-16.png"), 16)
                };
                log::info!(
                    "[tray] icon size={}px for scale factor {:.2}",
                    tray_icon_size,
                    tray_scale
                );
                let icon = tauri::image::Image::from_bytes(tray_icon_bytes)
                    .expect("failed to load tray icon");

                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip(identity::APP_NAME)
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click { button, button_state: MouseButtonState::Up, position, .. } = event {
                            match button {
                                MouseButton::Left => {
                                    commands::tray::hide_tray_menu(tray.app_handle().clone());
                                    if let Some(w) = tray.app_handle().get_webview_window("main") {
                                        let _ = w.show();
                                        let _ = w.unminimize();
                                        let _ = w.set_focus();
                                    }
                                }
                                MouseButton::Right => {
                                    commands::tray::show_tray_menu(tray.app_handle(), position);
                                }
                                _ => {}
                            }
                        }
                    })
                    .build(app)?;
            }

            // Start WinEvent hook for foreground window monitoring
            let detector: tauri::State<ContextDetector> = app.state();
            detector.start_winevent_hook(app.handle());

            // Register all global shortcuts (hands-free combo + preset-switch shortcuts).
            // Single keys are handled by the keyboard hook, not here.
            {
                let storage: tauri::State<Storage> = app.state();
                commands::shortcuts::register_all_global_shortcuts(app.handle(), storage.inner());
            }

            {
                let overlay_app = app.handle().clone();
                let _ = thread::Builder::new()
                    .name("overlay-prewarm".to_string())
                    .spawn(move || {
                        thread::sleep(std::time::Duration::from_millis(1_500));
                        let window_state = overlay_app.state::<WindowState>();
                        window_state.prewarm_overlay(&overlay_app);
                    });
            }

            {
                use tauri_plugin_autostart::ManagerExt;
                let storage: tauri::State<Storage> = app.state();
                let autostart = app.autolaunch();
                if let Err(error) = initialize_autostart(&storage,
                    || autostart.is_enabled().map_err(|e| e.to_string()),
                    || autostart.enable().map_err(|e| e.to_string())) {
                    log::warn!("Auto-launch initialization failed: {error}");
                }
            }

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            // Store
            commands::storage::store_get,
            commands::storage::store_get_settings,
            commands::storage::store_set,
            commands::storage::store_delete,
            // History
            commands::storage::history_list,
            commands::storage::history_count,
            commands::storage::history_add,
            commands::storage::history_update,
            commands::storage::history_delete,
            // Window
            commands::window::present_overlay,
            commands::window::show_overlay,
            commands::window::hide_overlay,
            commands::window::update_overlay_state,
            commands::window::overlay_ready,
            commands::window::overlay_render_ack,
            commands::window::get_overlay_health,
            commands::window::overlay_pong,
            // Paste / Context
            commands::paste::paste_text,
            commands::paste::get_probe_result,
            commands::paste::get_recording_context,
            commands::paste::get_active_app_context,
            commands::paste::copy_text,
            // System
            commands::system::get_client_runtime_info,
            commands::system::get_system_ui_language,
            commands::system::get_auto_launch,
            commands::system::set_auto_launch,
            commands::system::append_debug_log,
            commands::system::reveal_file_in_folder,
            commands::system::open_folder,
            // Tray
            commands::tray::set_tray_ai_enabled,
            commands::tray::get_tray_ai_enabled,
            commands::tray::toggle_tray_ai_enabled,
            commands::tray::show_main_from_tray,
            commands::tray::hide_tray_menu,
            commands::tray::quit_from_tray,
            // Audio
            commands::audio_mute::mute_system_output,
            commands::audio_mute::restore_system_output,
            commands::audio_mute::get_mic_mute_state,
            // Shortcuts
            commands::shortcuts::shortcuts_changed,
            commands::shortcuts::test_shortcut,
            commands::shortcuts::get_ptt_physical_key_states,
            commands::shortcuts::set_escape_action_mode,
            commands::shortcuts::set_card_hotkeys,
            commands::shortcuts::begin_shortcut_capture,
            commands::shortcuts::end_shortcut_capture,
            // Export
            commands::export::save_text_export,
            commands::backup::get_backup_directory,
            commands::backup::export_config,
            commands::backup::inspect_config_import,
            commands::backup::import_config,
            commands::backup::import_full,
            commands::backup::restart_app,
            // Diagnostics
            commands::diagnostics::collect_settings,
            commands::diagnostics::get_diagnostics_preview,
            commands::diagnostics::create_diagnostics_zip,
            commands::diagnostics::read_diagnostics_zip,
            commands::diagnostics::copy_diagnostics_zip,
            commands::diagnostics::read_log_file,
            commands::diagnostics::open_log_folder,
            // Providers (cloud ASR / AI)
            providers::registry::cloud_polish,
            providers::registry::cloud_transcribe,
            providers::registry::test_ai_connection,
            providers::registry::test_asr_connection,
            providers::capabilities::asr_hotword_capability,
            providers::capabilities::asr_hotword_capability_matrix,
            commands::test_audio::get_test_audio_b64,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Independent distribution: no upstream auto-installer on app exit.
        // Updates are published as manually installed releases on our GitHub.
        .run(|_, _| {});
}

#[cfg(test)]
mod config_tests {
    use serde_json::Value;

    #[test]
    fn autostart_initialization_preserves_opt_in_and_retries_only_incomplete_migration() {
        use super::Storage;
        use serde_json::json;
        use std::cell::Cell;
        let dir = std::env::temp_dir().join(format!("sayforge-autostart-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for (index, initialized, migrated, enabled, calls) in [
            (0, Value::Null, Value::Null, false, 0),
            (1, json!("true"), Value::Null, true, 1),
            (2, json!("true"), Value::Null, false, 0),
            (3, json!(true), json!(true), true, 0),
        ] {
            let storage = Storage::new(dir.join(format!("{index}.db"))).unwrap();
            storage.set("autoLaunchInitialized", &initialized).unwrap();
            storage.set("autoLaunchArgsMigrated", &migrated).unwrap();
            if enabled { storage.set("autoLaunch", &json!(true)).unwrap(); }
            let registrations = Cell::new(0);
            super::initialize_autostart(&storage, || Ok(enabled), || { registrations.set(registrations.get()+1); Ok(()) }).unwrap();
            assert_eq!(registrations.get(), calls);
            assert_eq!(storage.get("autoLaunch", None), json!(enabled));
            super::initialize_autostart(&storage, || panic!("completed migration must not reread OS"), || panic!("must not re-register")).unwrap();
        }
        let storage = Storage::new(dir.join("failure.db")).unwrap();
        for read_failure in [true, false] {
            assert!(super::initialize_autostart(&storage,
                || if read_failure { Err("synthetic read failure".into()) } else { Ok(true) },
                || Err("synthetic registration failure".into())).is_err());
            assert_eq!(storage.get("autoLaunchArgsMigrated", None), Value::Null);
            assert_eq!(storage.get("autoLaunchInitialized", None), Value::Null);
        }
        drop(storage);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn media_permissions_allow_microphone_and_deny_camera() {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        assert_eq!(super::media_permission_state(COREWEBVIEW2_PERMISSION_KIND_MICROPHONE), Some(COREWEBVIEW2_PERMISSION_STATE_ALLOW));
        assert_eq!(super::media_permission_state(COREWEBVIEW2_PERMISSION_KIND_CAMERA), Some(COREWEBVIEW2_PERMISSION_STATE_DENY));
        assert_eq!(super::media_permission_state(COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION), None);
    }

    #[test]
    fn csp_allows_required_local_resources_without_remote_api_access() {
        let source = include_str!("../tauri.conf.json");
        let _: tauri::Config = serde_json::from_str(source).expect("valid Tauri config");
        let config: Value = serde_json::from_str(source).unwrap();
        for name in ["csp", "devCsp"] {
            let policy = &config["app"]["security"][name];
            assert!(policy.is_object());
            assert_eq!(policy["default-src"], "'self'");
            assert_eq!(policy["object-src"], "'none'");
            assert_eq!(policy["frame-src"], "'none'");
            let scripts = policy["script-src"].as_str().unwrap();
            assert!(scripts.contains("blob:") && scripts.contains("data:"));
            assert!(!scripts.contains("unsafe-eval"));
            let connections = policy["connect-src"].as_str().unwrap();
            assert!(connections.contains("http://ipc.localhost"));
            assert!(!connections.contains('*') && !connections.contains("https:"));
        }
        assert!(!config["app"]["security"]["csp"]["script-src"].as_str().unwrap().contains("unsafe-inline"));
        assert!(!config["app"]["security"]["csp"]["connect-src"].as_str().unwrap().contains("ws:"));
        assert!(config["app"]["security"]["devCsp"]["connect-src"].as_str().unwrap().contains("ws://localhost:1420"));
        assert_eq!(super::WEBVIEW2_BROWSER_ARGS.split_whitespace().collect::<Vec<_>>(), vec![
            "--ignore-certificate-errors", "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
        ]);
    }

    #[test]
    fn configured_windows_do_not_override_webview2_browser_args() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must be valid JSON");
        let windows = config
            .pointer("/app/windows")
            .and_then(Value::as_array)
            .expect("tauri.conf.json must define app.windows");

        let offenders = windows
            .iter()
            .filter_map(|window| {
                window
                    .get("additionalBrowserArgs")
                    .filter(|value| !value.is_null())
                    .map(|_| {
                        window
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or("<unknown>")
                    })
            })
            .collect::<Vec<_>>();

        assert!(
            offenders.is_empty(),
            "WebView2 args must be global; per-window overrides found on: {offenders:?}"
        );
    }
}
