use serde::Deserialize;
use std::fs;

#[derive(Deserialize)]
pub struct TextExportPayload {
    #[serde(rename = "defaultPath")]
    pub default_path: String,
    pub content: String,
    #[allow(dead_code)]
    pub filters: Option<Vec<ExportFilter>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct ExportFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[tauri::command]
pub fn save_text_export(payload: TextExportPayload) -> Result<Option<String>, String> {
    let path = std::path::PathBuf::from(&payload.default_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, &payload.content).map_err(|e| e.to_string())?;
    let abs = fs::canonicalize(&path).unwrap_or(path);
    let abs_str = abs.to_string_lossy().to_string();
    let clean = abs_str.strip_prefix(r"\\?\").unwrap_or(&abs_str).to_string();
    Ok(Some(clean))
}
