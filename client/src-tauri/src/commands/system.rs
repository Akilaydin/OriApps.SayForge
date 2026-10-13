use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use crate::storage::Storage;
use std::io::Write;
use std::sync::Mutex;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Persistent log file writer — opened once, reused across calls.
static LOG_FILE: std::sync::LazyLock<Mutex<Option<std::fs::File>>> =
    std::sync::LazyLock::new(|| {
        let file = open_log_file();
        Mutex::new(file)
    });

/// Max log file size before rotation (5 MB)
const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;
/// Number of rotated files to keep
const ROTATED_FILES_KEEP: usize = 3;
const MAX_LOG_LINE_BYTES: usize = 8192;

fn log_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(crate::identity::APP_ID)
        .join("logs")
}

fn open_log_file() -> Option<std::fs::File> {
    let dir = log_dir();
    open_log_file_in(&dir)
}

fn open_log_file_in(dir: &std::path::Path) -> Option<std::fs::File> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("[log] failed to create log dir {:?}: {}", dir, e);
        return None;
    }
    let path = dir.join(crate::identity::LOG_FILE);
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

fn rotate_if_needed(file: &mut Option<std::fs::File>, dir: &std::path::Path) {
    let path = dir.join(crate::identity::LOG_FILE);
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size < MAX_LOG_SIZE {
        return;
    }

    *file = None;

    // Rotate: sayforge.log -> sayforge.1.log, sayforge.1.log -> sayforge.2.log, etc.
    for i in (1..ROTATED_FILES_KEEP).rev() {
        let from = dir.join(format!("sayforge.{}.log", i));
        let to = dir.join(format!("sayforge.{}.log", i + 1));
        let _ = std::fs::rename(&from, &to);
    }
    let rotated = dir.join("sayforge.1.log");
    let _ = std::fs::rename(&path, &rotated);
    *file = open_log_file_in(dir);
}

pub fn write_log_line(line: &str) {
    let mut guard = LOG_FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    append_log_line(&mut guard, &log_dir(), line);
}

fn append_log_line(file: &mut Option<std::fs::File>, dir: &std::path::Path, line: &str) {
    // Rotate check — reopen file if needed
    rotate_if_needed(file, dir);
    if file.is_none() {
        *file = open_log_file_in(dir);
    }
    if let Some(ref mut f) = *file {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let mut end = line.len().min(MAX_LOG_LINE_BYTES);
        while !line.is_char_boundary(end) { end -= 1; }
        let line = line[..end].replace(['\r', '\n'], " ");
        let _ = writeln!(f, "[{}] {}", ts, line);
        let _ = f.flush();
    }
}

#[cfg(test)]
mod log_tests {
    use super::*;

    fn fixture_dir() -> std::path::PathBuf {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/log-tests");
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        assert!(dir.canonicalize().unwrap().starts_with(root.canonicalize().unwrap()));
        dir
    }

    #[test]
    fn persistent_failures_survive_reopen_and_an_unavailable_sink_does_not_panic() {
        let dir = fixture_dir();
        let blocked = dir.join("not-a-directory");
        std::fs::write(&blocked, b"synthetic blocker").unwrap();
        let mut file = None;
        append_log_line(&mut file, &blocked, "[ERROR] [update] operation=check HTTP=504");
        assert!(file.is_none());
        append_log_line(&mut file, &dir, "[ERROR] [update] operation=check HTTP=504");
        drop(file.take());
        append_log_line(&mut file, &dir, "[WARN] [clipboard] operation=copy reason=unsupported_format");
        drop(file);
        let contents = std::fs::read_to_string(dir.join(crate::identity::LOG_FILE)).unwrap();
        assert!(contents.contains("operation=check HTTP=504"));
        assert!(contents.contains("operation=copy reason=unsupported_format"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn individual_entries_are_bounded_and_rotation_keeps_only_three_backups() {
        let dir = fixture_dir();
        let mut file = None;
        append_log_line(&mut file, &dir, &"Synthetic Ω line ".repeat(2000));
        assert!(file.as_ref().unwrap().metadata().unwrap().len() <= 8192 + 80);
        for _ in 0..5 {
            std::fs::OpenOptions::new().write(true).open(dir.join(crate::identity::LOG_FILE))
                .unwrap().set_len(MAX_LOG_SIZE).unwrap();
            append_log_line(&mut file, &dir, "[ERROR] [synthetic] operation=retry");
        }
        drop(file);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 4);
        assert!(std::fs::read_to_string(dir.join(crate::identity::LOG_FILE)).unwrap().contains("operation=retry"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

fn get_os_version() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cmd")
            .args(["/C", "ver"])
            .creation_flags(0x08000000)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s: String| s.trim().to_string())
            .unwrap_or_else(|| "Windows".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        whoami::distro()
    }
}

fn get_local_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn get_system_locale() -> String {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Globalization::GetUserDefaultLocaleName;
        // LOCALE_NAME_MAX_LENGTH = 85
        let mut buf = [0u16; 85];
        let len = unsafe { GetUserDefaultLocaleName(&mut buf) };
        if len > 1 {
            String::from_utf16_lossy(&buf[..(len as usize - 1)])
        } else {
            "unknown".to_string()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("LANG").unwrap_or_else(|_| "unknown".to_string())
    }
}

fn get_total_memory_mb() -> u64 {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if unsafe { GlobalMemoryStatusEx(&mut status) }.is_ok() {
            status.ullTotalPhys / (1024 * 1024)
        } else {
            0
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
}

#[derive(Serialize)]
pub struct ClientRuntimeInfo {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "userName")]
    pub user_name: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub hostname: String,
    #[serde(rename = "clientVersion")]
    pub client_version: String,
    pub platform: String,
    #[serde(rename = "osVersion")]
    pub os_version: String,
    #[serde(rename = "localIp")]
    pub local_ip: String,
    #[serde(rename = "systemLocale")]
    pub system_locale: String,
    #[serde(rename = "cpuCores")]
    pub cpu_cores: usize,
    #[serde(rename = "memoryMb")]
    pub memory_mb: u64,
}

#[tauri::command]
pub fn get_client_runtime_info(storage: State<Storage>) -> Result<ClientRuntimeInfo, String> {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let user_name = whoami::username();

    // Persist device_id so it stays stable across restarts
    let existing = storage.get("deviceId", None);
    let device_id = if let Some(id) = existing.as_str() {
        if !id.is_empty() {
            id.to_string()
        } else {
            let new_id = format!("sayforge-{}", uuid::Uuid::new_v4());
            let _ = storage.set("deviceId", &serde_json::json!(new_id));
            new_id
        }
    } else {
        let new_id = format!("sayforge-{}", uuid::Uuid::new_v4());
        let _ = storage.set("deviceId", &serde_json::json!(new_id));
        new_id
    };

    Ok(ClientRuntimeInfo {
        user_id: user_name.clone(),
        user_name,
        device_id,
        hostname,
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        os_version: get_os_version(),
        local_ip: get_local_ip(),
        system_locale: get_system_locale(),
        cpu_cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        memory_mb: get_total_memory_mb(),
    })
}

#[tauri::command]
pub fn get_auto_launch(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_auto_launch(app: AppHandle, _enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if _enable {
        autostart.enable().map_err(|e| e.to_string())
    } else {
        autostart.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn append_debug_log(payload: Value) -> Result<(), String> {
    // Format a compact single-line representation for the log file
    let line = match payload {
        Value::Object(ref map) => {
            let kind = map.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
            match kind {
                "runtime" => {
                    let level = map.get("level").and_then(|v| v.as_str()).unwrap_or("info");
                    let source = map.get("source").and_then(|v| v.as_str()).unwrap_or("");
                    let message = map.get("message").and_then(|v| v.as_str()).unwrap_or("");
                    let detail = map.get("detail");
                    if let Some(d) = detail {
                        format!("[{}] [{}] {} {}", level.to_uppercase(), source, message, d)
                    } else {
                        format!("[{}] [{}] {}", level.to_uppercase(), source, message)
                    }
                }
                "session_start" => {
                    let sid = map.get("sessionId").and_then(|v| v.as_str()).unwrap_or("?");
                    format!("[SESSION] start id={}", sid)
                }
                "session_end" => {
                    let sid = map.get("sessionId").and_then(|v| v.as_str()).unwrap_or("?");
                    let dur = map.get("durationMs").and_then(|v| v.as_i64()).unwrap_or(0);
                    let msgs = map.get("messageCount").and_then(|v| v.as_i64()).unwrap_or(0);
                    format!("[SESSION] end id={} duration={}ms messages={}", sid, dur, msgs)
                }
                "ws_message" => {
                    let dir = map.get("direction").and_then(|v| v.as_str()).unwrap_or("?");
                    let typ = map.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                    let data = map.get("data");
                    if let Some(d) = data {
                        format!("[WS] {} {} {}", dir, typ, d)
                    } else {
                        format!("[WS] {} {}", dir, typ)
                    }
                }
                _ => {
                    serde_json::to_string(&payload).unwrap_or_else(|_| format!("{:?}", payload))
                }
            }
        }
        _ => {
            serde_json::to_string(&payload).unwrap_or_else(|_| format!("{:?}", payload))
        }
    };

    write_log_line(&line);
    Ok(())
}

#[tauri::command]
pub fn reveal_file_in_folder(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let path = std::path::PathBuf::from(&file_path);
        let dir = path.parent().unwrap_or(&path);
        std::process::Command::new("xdg-open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_folder(folder_path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&folder_path);
    if !path.is_dir() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    Ok(())
}
