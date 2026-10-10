use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::borrow::Cow;
use tauri::State;
use crate::storage::Storage;

// ─── collect_settings ───

#[tauri::command]
pub fn collect_settings(storage: State<Storage>) -> Result<Value, String> {
    let keys = [
        "shortcutPTT", "shortcutPTTCombo", "shortcutHandsFree", "shortcutToggleAi",
        "aiEnabled", "aiMinDurationSec",
        "autoLaunch", "selectedMic", "hotwords", "builtinHotwordSets",
        "stats", "activePresetId", "audioRetentionDays",
        "serverUrl", "language",
    ];

    let mut settings = serde_json::Map::new();
    for key in &keys {
        let val = storage.get(key, None);
        settings.insert(key.to_string(), val);
    }

    Ok(Value::Object(settings))
}

// ─── Diagnostics Preview ───

fn log_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(crate::identity::APP_ID)
        .join("logs")
}

#[derive(Deserialize)]
struct PreviewRequest {
    #[allow(dead_code)]
    settings: Value,
    #[serde(rename = "issueOccurrence")]
    issue_occurrence: String,
}

#[derive(Serialize)]
struct DiagnosticsPreview {
    #[serde(rename = "generatedAt")]
    generated_at: String,
    #[serde(rename = "retentionDays")]
    retention_days: i32,
    #[serde(rename = "filesScanned")]
    files_scanned: usize,
    #[serde(rename = "totalRawEvents")]
    total_raw_events: usize,
    #[serde(rename = "totalTimelineEntries")]
    total_timeline_entries: usize,
    #[serde(rename = "issueWindowLabel")]
    issue_window_label: String,
    #[serde(rename = "rangeStart", skip_serializing_if = "Option::is_none")]
    range_start: Option<String>,
    #[serde(rename = "rangeEnd", skip_serializing_if = "Option::is_none")]
    range_end: Option<String>,
    #[serde(rename = "systemInfo")]
    system_info: SystemInfo,
    summary: Summary,
    timeline: Vec<TimelineEntry>,
}

#[derive(Serialize)]
struct SystemInfo {
    platform: String,
    #[serde(rename = "appVersion")]
    app_version: String,
    #[serde(rename = "webviewVersion")]
    webview_version: String,
}

#[derive(Serialize)]
struct Summary {
    errors: usize,
    warnings: usize,
    modules: Vec<ModuleCount>,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    last_error: Option<TimelineEntry>,
}

#[derive(Serialize, Clone)]
struct ModuleCount {
    module: String,
    count: usize,
}

#[derive(Serialize, Clone)]
struct TimelineEntry {
    ts: String,
    level: String,
    module: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(rename = "traceId", skip_serializing_if = "Option::is_none")]
    trace_id: Option<String>,
}

fn parse_log_line(line: &str) -> Option<TimelineEntry> {
    let line = line.trim();
    if !line.starts_with('[') {
        return None;
    }

    let ts_end = line.find(']')?;
    let ts = line[1..ts_end].trim_start_matches('[').trim();
    if ts.is_empty() || !ts.as_bytes()[0].is_ascii_digit() {
        return None;
    }

    let rest = line[ts_end + 1..].trim_start();
    if !rest.starts_with('[') {
        return None;
    }

    let level_end = rest.find(']')?;
    let level_raw = &rest[1..level_end];
    let level = level_raw.trim().to_lowercase();

    let rest2 = rest[level_end + 1..].trim_start();
    if !rest2.starts_with('[') {
        return Some(TimelineEntry {
            ts: ts.to_string(),
            level,
            module: "unknown".to_string(),
            title: rest2.to_string(),
            detail: None,
            trace_id: None,
        });
    }

    let mod_end = rest2.find(']')?;
    let module = rest2[1..mod_end].trim().to_string();
    let title = rest2[mod_end + 1..].trim().to_string();

    Some(TimelineEntry {
        ts: ts.to_string(),
        level,
        module,
        title,
        detail: None,
        trace_id: None,
    })
}

// Older AI-provider logs included raw HTTP bodies and request URLs. Diagnostics exports
// must not reintroduce that data even after new logging paths have been fixed.
fn redact_ai_provider_log_line(line: &str) -> Cow<'_, str> {
    const TAG: &str = "[RUST] [provider] ";
    let Some((prefix, rest)) = line.split_once(TAG) else {
        return Cow::Borrowed(line);
    };
    let (scope, detail) = if let Some(detail) = rest.strip_prefix("ai/openai-compat-test ") {
        ("ai/openai-compat-test", detail)
    } else if let Some(detail) = rest.strip_prefix("ai/openai-compat ") {
        ("ai/openai-compat", detail)
    } else {
        return Cow::Borrowed(line);
    };

    // Whitelist only stage names from the application, never arbitrary provider prose.
    let stage = match detail.split_whitespace().next().unwrap_or("") {
        "start" => "start",
        "http_status" => "http_status",
        "parse_json" => "parse_json",
        "read_body" => "read_body",
        "http_send" => "http_send",
        "thinking_params_rejected" => "thinking_params_rejected",
        "no_content_fallback_to_input" => "no_content_fallback_to_input",
        "empty_after_strip_thinking" => "empty_after_strip_thinking",
        "ok" => "ok",
        _ => "event",
    };
    // The numeric status is useful for support, unlike response headers/body content.
    let http = if stage == "http_status" {
        [" http=", " returned error ", " returned "]
            .iter()
            .filter_map(|marker| detail.split_once(marker).map(|(_, tail)| tail))
            .filter_map(|tail| tail.get(..3).and_then(|n| n.parse::<u16>().ok()))
            .find(|code| (100..=599).contains(code))
            .map(|status| format!(" http={status}"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    Cow::Owned(format!("{prefix}{TAG}{scope} {stage}{http} [details redacted]"))
}

fn redact_ai_provider_logs(content: &str) -> String {
    content.lines()
        .map(|line| redact_ai_provider_log_line(line).into_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

fn issue_window_label(occurrence: &str) -> &'static str {
    match occurrence {
        "just_now" => "Just now",
        "within_1h" => "Within 1 hour",
        "today" => "Today",
        "yesterday" => "Yesterday",
        "older" => "Earlier",
        _ => "Unknown",
    }
}

fn occurrence_cutoff(occurrence: &str) -> Option<String> {
    let now = chrono::Local::now();
    let cutoff = match occurrence {
        "just_now" => now - chrono::Duration::minutes(10),
        "within_1h" => now - chrono::Duration::hours(1),
        "today" => now.date_naive().and_hms_opt(0, 0, 0)
            .map(|naive| naive.and_local_timezone(chrono::Local).unwrap())?,
        "yesterday" => (now.date_naive() - chrono::Duration::days(1))
            .and_hms_opt(0, 0, 0)
            .map(|naive| naive.and_local_timezone(chrono::Local).unwrap())?,
        _ => return None,
    };
    Some(cutoff.format("%Y-%m-%d %H:%M:%S").to_string())
}

fn filter_entries_by_occurrence(entries: &[TimelineEntry], occurrence: &str) -> Vec<TimelineEntry> {
    match occurrence_cutoff(occurrence) {
        Some(cutoff) => entries.iter()
            .filter(|e| e.ts.as_str() >= cutoff.as_str())
            .cloned()
            .collect(),
        None => entries.to_vec(),
    }
}

fn read_and_parse_logs() -> (Vec<TimelineEntry>, usize) {
    let dir = log_dir();
    let mut all_entries = Vec::new();
    let mut files_scanned = 0usize;

    let filenames = ["sayforge.log", "sayforge.1.log", "sayforge.2.log", "sayforge.3.log"];
    for filename in &filenames {
        let path = dir.join(filename);
        if !path.exists() {
            continue;
        }
        files_scanned += 1;
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                if let Some(entry) = parse_log_line(&redact_ai_provider_log_line(line)) {
                    all_entries.push(entry);
                }
            }
        }
    }

    all_entries.sort_by(|a, b| a.ts.cmp(&b.ts));

    (all_entries, files_scanned)
}

#[tauri::command]
pub fn get_diagnostics_preview(data: Value) -> Result<Value, String> {
    let req: PreviewRequest = serde_json::from_value(data).map_err(|e| e.to_string())?;

    let (all_entries, files_scanned) = read_and_parse_logs();
    let total_raw = all_entries.len();

    let entries = filter_entries_by_occurrence(&all_entries, &req.issue_occurrence);

    let errors = entries.iter().filter(|e| e.level == "error").count();
    let warnings = entries.iter().filter(|e| e.level == "warn" || e.level == "warning").count();

    let mut module_map = std::collections::HashMap::<String, usize>::new();
    for entry in &entries {
        *module_map.entry(entry.module.clone()).or_insert(0) += 1;
    }
    let mut modules: Vec<ModuleCount> = module_map
        .into_iter()
        .map(|(module, count)| ModuleCount { module, count })
        .collect();
    modules.sort_by(|a, b| b.count.cmp(&a.count));

    let last_error = entries.iter().rev().find(|e| e.level == "error").cloned();

    let timeline: Vec<TimelineEntry> = entries.iter().rev().take(200).rev().cloned().collect();
    let timeline_count = timeline.len();

    let range_start = entries.first().map(|e| e.ts.clone());
    let range_end = entries.last().map(|e| e.ts.clone());

    let preview = DiagnosticsPreview {
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        retention_days: 7,
        files_scanned,
        total_raw_events: total_raw,
        total_timeline_entries: timeline_count,
        issue_window_label: issue_window_label(&req.issue_occurrence).to_string(),
        range_start,
        range_end,
        system_info: SystemInfo {
            platform: "win32".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            webview_version: "WebView2".to_string(),
        },
        summary: Summary {
            errors,
            warnings,
            modules,
            last_error,
        },
        timeline,
    };

    serde_json::to_value(preview).map_err(|e| e.to_string())
}

// ─── Diagnostics ZIP ───

#[derive(Deserialize)]
struct DiagnosticsZipRequest {
    description: String,
                #[serde(rename = "issueType", default)]
    issue_type: String,
    settings: Value,
    #[serde(rename = "issueOccurrence")]
    issue_occurrence: String,
    images: Vec<DiagImage>,
}

#[derive(Deserialize)]
struct DiagImage {
    name: String,
    #[serde(rename = "type")]
    mime_type: String,
    #[allow(dead_code)]
    size: usize,
    data: Vec<u8>,
}

#[tauri::command]
pub fn create_diagnostics_zip(data: Value) -> Result<String, String> {
    let req: DiagnosticsZipRequest = serde_json::from_value(data).map_err(|e| e.to_string())?;

    let diag_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(crate::identity::APP_ID)
        .join("diagnostics");
    std::fs::create_dir_all(&diag_dir).map_err(|e| e.to_string())?;

    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let zip_path = diag_dir.join(format!("diagnostics-{}.zip", ts));

    let file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 1. manifest.json
    let manifest = serde_json::json!({
        "generatedAt": chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        "issueType": if req.issue_type.is_empty() { "unspecified" } else { req.issue_type.as_str() },
        "description": req.description,
        "issueOccurrence": req.issue_occurrence,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": "win32",
        "imageCount": req.images.len(),
    });
    zip.start_file("manifest.json", options).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&manifest).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    // 2. settings.json
    zip.start_file("settings.json", options).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&req.settings).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    let log_d = log_dir();
    for filename in &["sayforge.log", "sayforge.1.log", "sayforge.2.log", "sayforge.3.log"] {
        let path = log_d.join(filename);
        if path.exists() {
            if let Ok(content) = std::fs::read(&path) {
                let zip_name = format!("logs/{}", filename);
                zip.start_file(&zip_name, options).map_err(|e| e.to_string())?;
                let safe_logs = redact_ai_provider_logs(&String::from_utf8_lossy(&content));
                zip.write_all(safe_logs.as_bytes()).map_err(|e| e.to_string())?;
            }
        }
    }

    for (i, img) in req.images.iter().enumerate() {
        let ext = match img.mime_type.as_str() {
            "image/png" => "png",
            "image/jpeg" | "image/jpg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "bin",
        };
        let zip_name = if img.name.is_empty() {
            format!("images/screenshot-{}.{}", i + 1, ext)
        } else {
            format!("images/{}", img.name)
        };
        zip.start_file(&zip_name, options).map_err(|e| e.to_string())?;
        zip.write_all(&img.data).map_err(|e| e.to_string())?;
    }

    // 5. diagnostics preview (filtered by occurrence)
    let (entries, _) = read_and_parse_logs();
    let filtered = filter_entries_by_occurrence(&entries, &req.issue_occurrence);
    let timeline: Vec<&TimelineEntry> = filtered.iter().rev().take(500).collect();
    zip.start_file("timeline.json", options).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&timeline).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;

    Ok(zip_path.to_string_lossy().to_string())
}

// ─── Read helpers ───

#[tauri::command]
pub fn read_diagnostics_zip(path: String) -> Result<Option<Vec<u8>>, String> {
    let path = std::path::PathBuf::from(&path);
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(data))
}

#[tauri::command]
pub fn copy_diagnostics_zip(source: String, destination: String) -> Result<(), String> {
    let src = std::path::PathBuf::from(&source);
    if !src.exists() {
        return Err("The diagnostics file does not exist".to_string());
    }
    std::fs::copy(&src, &destination).map_err(|e| format!("Failed to copy diagnostics file: {}", e))?;
    let _ = std::fs::remove_file(&src);
    Ok(())
}

#[tauri::command]
pub fn read_log_file(log_type: String) -> Result<Option<String>, String> {
    let log_d = log_dir();

    let filename = match log_type.as_str() {
        "current" | "" | "frontend" => "sayforge.log",
        "ptt" => "sayforge.log",
        "1" => "sayforge.1.log",
        "2" => "sayforge.2.log",
        "3" => "sayforge.3.log",
        _ => "sayforge.log",
    };

    let path = log_d.join(filename);
    if !path.exists() {
        return Ok(None);
    }

    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let size = meta.len();
    const MAX_READ: u64 = 200 * 1024;

    if size <= MAX_READ {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    } else {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::End(-(MAX_READ as i64))).map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(MAX_READ as usize);
        f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        let mut content = String::from_utf8_lossy(&bytes).into_owned();
        if let Some(pos) = content.find('\n') {
            content = content[pos + 1..].to_string();
        }
        Ok(Some(format!("... (showing last ~200KB) ...\n{}", content)))
    }
}

#[tauri::command]
pub fn open_log_folder() -> Result<(), String> {
    let dir = log_dir();
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    #[test]
    fn diagnostics_zip_redacts_old_ai_responses_but_keeps_http_status() {
        let legacy_log = concat!(
            "[2026-10-10 09:01:00] [RUST] [provider] ai/openai-compat http_status FAILED ",
            "API returned error 401 [http=401]: {\"message\":\"sk-synthetic-secret private transcript\"}\n",
            "[2026-10-10 09:01:01] [RUST] [provider] ai/openai-compat parse_json FAILED ",
            "Response excerpt: private-editor-context\n",
            "[2026-10-10 09:01:02] [RUST] [provider] ai/openai-compat-test http_status FAILED ",
            "API returned 403: sk-synthetic-secret\n",
            "[2026-10-10 09:01:03] [RUST] [provider] openai-compat/asr start safe\n",
        );
        let safe_logs = redact_ai_provider_logs(legacy_log);
        assert!(safe_logs.contains("ai/openai-compat http_status http=401"));
        assert!(safe_logs.contains("ai/openai-compat-test http_status http=403"));
        assert!(safe_logs.contains("openai-compat/asr start safe"));
        assert!(!safe_logs.contains("synthetic-secret"));
        assert!(!safe_logs.contains("private transcript"));
        assert!(!safe_logs.contains("private-editor-context"));

        // Uses the same sanitizer as the production logs/ ZIP entry.
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("logs/sayforge.log", zip::write::FileOptions::default()).unwrap();
        zip.write_all(safe_logs.as_bytes()).unwrap();
        let zip_bytes = zip.finish().unwrap().into_inner();
        let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes)).unwrap();
        let mut archived_log = String::new();
        archive.by_name("logs/sayforge.log").unwrap().read_to_string(&mut archived_log).unwrap();
        assert_eq!(archived_log, safe_logs);

        let preview_entry = parse_log_line(&redact_ai_provider_log_line(legacy_log.lines().next().unwrap())).unwrap();
        assert!(preview_entry.title.contains("http=401"));
        assert!(!preview_entry.title.contains("synthetic-secret"));
    }
}
