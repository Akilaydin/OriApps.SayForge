//

use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio_util::io::ReaderStream;

use crate::commands::backup::{apply_full_backup, write_backup_archive, BackupScope};
use crate::providers::{diag, http_client};
use crate::storage::Storage;

const KEY_URL: &str = "webdav.url";
const KEY_USERNAME: &str = "webdav.username";
const KEY_PASSWORD: &str = "webdav.password";
const KEY_INCLUDE_HISTORY: &str = "webdav.includeHistory";
const KEY_INCLUDE_AUDIO: &str = "webdav.includeAudio";
const KEY_KEEP_COUNT: &str = "webdav.keepCount";
const KEY_LAST_RESULT: &str = "webdav.lastResult";

const BACKUP_PREFIX: &str = "sayforge-backup-";
const DEFAULT_KEEP_COUNT: u64 = 5;
const PROGRESS_EVENT: &str = "webdav-backup-progress";

const META_TIMEOUT: Duration = Duration::from_secs(30);


#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    pub password: String,
}

struct Target {
    dir_url: String,
    username: String,
    password: String,
}

impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Target")
            .field("dir_url", &self.dir_url)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .finish()
    }
}

///
///
fn normalize_dir_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("WEBDAV_URL_EMPTY".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") {
        return Err("WEBDAV_URL_INSECURE".to_string());
    }
    if !lower.starts_with("https://") {
        return Err("WEBDAV_URL_SCHEME".to_string());
    }
    let normalized = trimmed.trim_end_matches('/');
    if normalized.len() <= "https://".len() {
        return Err("WEBDAV_URL_EMPTY".to_string());
    }
    Ok(normalized.to_string())
}

impl Target {
    fn from_config(config: &WebDavConfig) -> Result<Self, String> {
        let dir_url = normalize_dir_url(&config.url)?;
        if config.username.trim().is_empty() || config.password.is_empty() {
            return Err("WEBDAV_CREDENTIALS_EMPTY".to_string());
        }
        Ok(Self {
            dir_url,
            username: config.username.trim().to_string(),
            password: config.password.clone(),
        })
    }

    fn from_settings(storage: &Storage) -> Result<Self, String> {
        Self::from_config(&WebDavConfig {
            url: setting_string(storage, KEY_URL),
            username: setting_string(storage, KEY_USERNAME),
            password: setting_string(storage, KEY_PASSWORD),
        })
    }

    fn child(&self, name: &str) -> String {
        format!("{}/{}", self.dir_url, name)
    }
}

fn setting_string(storage: &Storage, key: &str) -> String {
    storage
        .get(key, None)
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn setting_bool(storage: &Storage, key: &str) -> bool {
    storage.get(key, None).as_bool().unwrap_or(false)
}

///
///
fn scope_from_settings(storage: &Storage) -> BackupScope {
    BackupScope {
        include_history: setting_bool(storage, KEY_INCLUDE_HISTORY),
        include_audio: setting_bool(storage, KEY_INCLUDE_AUDIO),
    }
}

// ─── HTTP ───

fn dav_method(verb: &'static str) -> reqwest::Method {
    reqwest::Method::from_bytes(verb.as_bytes()).expect("WebDAV verb is static ASCII")
}

///
fn request(target: &Target, verb: &'static str, url: &str) -> reqwest::RequestBuilder {
    http_client::shared()
        .request(dav_method(verb), url)
        .basic_auth(&target.username, Some(&target.password))
}

///
async fn check_status(response: reqwest::Response, stage: &str) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        log::warn!("[webdav] {} rejected: http={}", stage, status.as_u16());
        return Err("WEBDAV_UNAUTHORIZED".to_string());
    }
    let body = response.text().await.unwrap_or_default();
    let detail = diag::truncate(&body, 200);
    log::warn!(
        "[webdav] {} failed: http={} body={}",
        stage,
        status.as_u16(),
        detail
    );
    Err(format!("{} failed (HTTP {}) {}", stage, status.as_u16(), detail))
}

async fn send(target: &Target, verb: &'static str, url: &str, stage: &str) -> Result<reqwest::Response, String> {
    let response = request(target, verb, url)
        .timeout(META_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("{} failed: {}", stage, diag::truncate(&e.to_string(), 200)))?;
    check_status(response, stage).await
}

///
async fn propfind_dir(target: &Target, url: &str) -> Result<String, String> {
    let response = request(target, "PROPFIND", url)
        .header("Depth", "1")
        .header("Content-Type", "application/xml; charset=utf-8")
        .timeout(META_TIMEOUT)
        .body(
            r#"<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/><resourcetype/></prop></propfind>"#,
        )
        .send()
        .await
        .map_err(|e| format!("PROPFIND failed: {}", diag::truncate(&e.to_string(), 200)))?;
    let response = check_status(response, "PROPFIND").await?;
    response
        .text()
        .await
        .map_err(|e| format!("Failed to read the directory listing: {}", e))
}

enum MkcolOutcome {
    Done,
    ParentMissing,
}

async fn mkcol(target: &Target, url: &str) -> Result<MkcolOutcome, String> {
    let response = request(target, "MKCOL", url)
        .timeout(META_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("MKCOL failed: {}", diag::truncate(&e.to_string(), 200)))?;
    let status = response.status();
    if status.is_success() || status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
        return Ok(MkcolOutcome::Done);
    }
    if status == reqwest::StatusCode::CONFLICT {
        return Ok(MkcolOutcome::ParentMissing);
    }
    check_status(response, "MKCOL").await.map(|_| MkcolOutcome::Done)
}

///
fn ancestor_urls(url: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = url.to_string();
    for _ in 0..8 {
        let Some((parent, _)) = cursor.rsplit_once('/') else {
            break;
        };
        if parent.matches('/').count() <= 2 {
            break;
        }
        out.push(parent.to_string());
        cursor = parent.to_string();
    }
    out
}

///
async fn ensure_collection(target: &Target, url: &str) -> Result<(), String> {
    if let MkcolOutcome::Done = mkcol(target, url).await? {
        return Ok(());
    }
    for ancestor in ancestor_urls(url).iter().rev() {
        if let Err(error) = mkcol(target, ancestor).await {
            log::info!(
                "[webdav] could not create parent {}: {}",
                ancestor,
                diag::truncate(&error, 120)
            );
        }
    }
    match mkcol(target, url).await? {
        MkcolOutcome::Done => Ok(()),
        MkcolOutcome::ParentMissing => Err("WEBDAV_MKCOL_CONFLICT".to_string()),
    }
}


///
fn tag_name_end(xml: &str, at: usize, local: &str, closing: bool) -> Option<usize> {
    let rest = xml.get(at..)?;
    let mut cur = rest.strip_prefix('<')?;
    let mut consumed = 1;
    if closing {
        cur = cur.strip_prefix('/')?;
        consumed += 1;
    }
    let name_len = cur
        .find(|c: char| c == '>' || c == '/' || c.is_whitespace())
        .unwrap_or(cur.len());
    let name = &cur[..name_len];
    let local_name = name.rsplit(':').next().unwrap_or(name);
    if local_name.eq_ignore_ascii_case(local) {
        Some(at + consumed + name_len)
    } else {
        None
    }
}

///
fn extract_elements(xml: &str, local: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = xml[cursor..].find('<') {
        let open = cursor + rel;
        let Some(name_end) = tag_name_end(xml, open, local, false) else {
            cursor = open + 1;
            continue;
        };
        let Some(gt_rel) = xml[name_end..].find('>') else {
            break;
        };
        let tag_end = name_end + gt_rel;
        if xml[name_end..tag_end].trim_end().ends_with('/') {
            cursor = tag_end + 1;
            continue;
        }
        let content_start = tag_end + 1;
        let mut scan = content_start;
        let mut close = None;
        while let Some(r) = xml[scan..].find('<') {
            let candidate = scan + r;
            if tag_name_end(xml, candidate, local, true).is_some() {
                close = Some(candidate);
                break;
            }
            scan = candidate + 1;
        }
        let Some(close) = close else { break };
        out.push(xml[content_start..close].trim().to_string());
        cursor = close + 1;
    }
    out
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavEntry {
    pub name: String,
    pub size: u64,
}

///
fn parse_backup_entries(xml: &str) -> Vec<WebDavEntry> {
    let mut entries: Vec<WebDavEntry> = extract_elements(xml, "response")
        .iter()
        .filter_map(|block| {
            let href = extract_elements(block, "href").into_iter().next()?;
            let name = href
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string();
            if !name.starts_with(BACKUP_PREFIX) || !name.ends_with(".zip") {
                return None;
            }
            let size = extract_elements(block, "getcontentlength")
                .into_iter()
                .next()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(0);
            Some(WebDavEntry { name, size })
        })
        .collect();
    entries.sort_by(|a, b| b.name.cmp(&a.name));
    entries.dedup_by(|a, b| a.name == b.name);
    entries
}


#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebDavProgress {
    status: String,
    /// 'preparing' | 'packingData' | 'packingAudio' | 'finalizing' | 'uploading' | 'verifying' | 'completed' | 'failed'
    phase: String,
    file_name: String,
    current_file: Option<String>,
    processed_bytes: u64,
    total_bytes: u64,
    percent: f64,
    error: Option<String>,
}

fn emit_progress(app: &AppHandle, progress: WebDavProgress) {
    let _ = app.emit(PROGRESS_EVENT, progress);
}

fn packing_percent(archive_percent: f64) -> f64 {
    (archive_percent * 0.5).clamp(0.0, 50.0)
}

fn upload_percent(sent: u64, total: u64) -> f64 {
    if total == 0 {
        return 90.0;
    }
    (50.0 + sent as f64 / total as f64 * 40.0).min(90.0)
}


#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavBackupResult {
    pub file_name: String,
    pub bytes: u64,
    pub include_history: bool,
    pub include_audio: bool,
    pub finished_at: i64,
    pub pruned: usize,
}

///
#[tauri::command]
pub async fn webdav_test(config: WebDavConfig) -> Result<u64, String> {
    let target = Target::from_config(&config)?;
    ensure_collection(&target, &target.dir_url).await?;
    let xml = propfind_dir(&target, &target.dir_url).await?;
    let count = parse_backup_entries(&xml).len() as u64;
    log::info!(
        "[webdav] connection test ok, existing backups={}",
        count
    );
    Ok(count)
}

#[tauri::command]
pub async fn webdav_list(storage: State<'_, Storage>) -> Result<Vec<WebDavEntry>, String> {
    let target = Target::from_settings(storage.inner())?;
    let xml = propfind_dir(&target, &target.dir_url).await?;
    Ok(parse_backup_entries(&xml))
}

#[tauri::command]
pub async fn webdav_backup_now(
    app: AppHandle,
    storage: State<'_, Storage>,
) -> Result<WebDavBackupResult, String> {
    let scope = scope_from_settings(storage.inner());
    let file_name = format!(
        "{}{}.zip",
        BACKUP_PREFIX,
        chrono::Local::now().format("%Y-%m-%d_%H-%M-%S-%3f")
    );
    let temp_path = std::env::temp_dir().join(&file_name);

    let outcome = run_backup(&app, storage.inner(), scope, &file_name, &temp_path).await;

    let _ = std::fs::remove_file(&temp_path);

    let finished_at = chrono::Utc::now().timestamp_millis();
    match &outcome {
        Ok(result) => {
            let _ = storage.set(
                KEY_LAST_RESULT,
                &json!({
                    "at": finished_at,
                    "ok": true,
                    "fileName": result.file_name,
                    "bytes": result.bytes,
                    "includeHistory": result.include_history,
                    "includeAudio": result.include_audio,
                    "error": Value::Null,
                }),
            );
            log::info!(
                "[webdav] backup ok name={} bytes={} history={} audio={} pruned={}",
                result.file_name,
                result.bytes,
                result.include_history,
                result.include_audio,
                result.pruned
            );
            emit_progress(
                &app,
                WebDavProgress {
                    status: "completed".to_string(),
                    phase: "completed".to_string(),
                    file_name: result.file_name.clone(),
                    current_file: None,
                    processed_bytes: result.bytes,
                    total_bytes: result.bytes,
                    percent: 100.0,
                    error: None,
                },
            );
        }
        Err(error) => {
            let _ = storage.set(
                KEY_LAST_RESULT,
                &json!({
                    "at": finished_at,
                    "ok": false,
                    "fileName": file_name,
                    "bytes": 0,
                    "includeHistory": scope.include_history,
                    "includeAudio": scope.include_audio,
                    "error": diag::truncate(error, 300),
                }),
            );
            log::warn!("[webdav] backup failed name={} error={}", file_name, diag::truncate(error, 300));
            emit_progress(
                &app,
                WebDavProgress {
                    status: "failed".to_string(),
                    phase: "failed".to_string(),
                    file_name: file_name.clone(),
                    current_file: None,
                    processed_bytes: 0,
                    total_bytes: 0,
                    percent: 0.0,
                    error: Some(error.clone()),
                },
            );
        }
    }

    outcome
}

async fn run_backup(
    app: &AppHandle,
    storage: &Storage,
    scope: BackupScope,
    file_name: &str,
    temp_path: &PathBuf,
) -> Result<WebDavBackupResult, String> {
    let target = Target::from_settings(storage)?;

    {
        let progress_app = app.clone();
        let progress_name = file_name.to_string();
        write_backup_archive(storage, scope, temp_path, &mut |progress| {
            emit_progress(
                &progress_app,
                WebDavProgress {
                    status: "running".to_string(),
                    phase: progress.phase.to_string(),
                    file_name: progress_name.clone(),
                    current_file: progress.current_file.map(ToString::to_string),
                    processed_bytes: progress.processed_bytes,
                    total_bytes: progress.total_bytes,
                    percent: packing_percent(progress.percent),
                    error: None,
                },
            );
        })?;
    }

    let local_size = std::fs::metadata(temp_path)
        .map_err(|e| format!("Failed to read the packaged backup: {}", e))?
        .len();

    ensure_collection(&target, &target.dir_url).await?;

    let temp_remote = target.child(&format!("{}.part", file_name));
    let final_remote = target.child(file_name);
    upload_file(app, &target, &temp_remote, temp_path, local_size, file_name).await?;
    move_file(&target, &temp_remote, &final_remote).await?;

    emit_progress(
        app,
        WebDavProgress {
            status: "running".to_string(),
            phase: "verifying".to_string(),
            file_name: file_name.to_string(),
            current_file: None,
            processed_bytes: local_size,
            total_bytes: local_size,
            percent: 95.0,
            error: None,
        },
    );

    let xml = propfind_dir(&target, &target.dir_url).await?;
    let entries = parse_backup_entries(&xml);
    let uploaded = entries
        .iter()
        .find(|entry| entry.name == file_name)
        .ok_or_else(|| "WEBDAV_VERIFY_MISSING".to_string())?;
    if uploaded.size != 0 && uploaded.size != local_size {
        log::warn!(
            "[webdav] size mismatch name={} local={} remote={}",
            file_name,
            local_size,
            uploaded.size
        );
        return Err("WEBDAV_VERIFY_SIZE".to_string());
    }

    let pruned = prune_old_backups(&target, storage, &entries, file_name).await;

    Ok(WebDavBackupResult {
        file_name: file_name.to_string(),
        bytes: local_size,
        include_history: scope.include_history,
        include_audio: scope.include_audio,
        finished_at: chrono::Utc::now().timestamp_millis(),
        pruned,
    })
}

async fn upload_file(
    app: &AppHandle,
    target: &Target,
    url: &str,
    path: &PathBuf,
    total: u64,
    file_name: &str,
) -> Result<(), String> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open the packaged backup: {}", e))?;

    let progress_app = app.clone();
    let progress_name = file_name.to_string();
    let mut sent = 0u64;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let stream = ReaderStream::with_capacity(file, 256 * 1024).map_ok(move |chunk| {
        sent += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            emit_progress(
                &progress_app,
                WebDavProgress {
                    status: "running".to_string(),
                    phase: "uploading".to_string(),
                    file_name: progress_name.clone(),
                    current_file: None,
                    processed_bytes: sent,
                    total_bytes: total,
                    percent: upload_percent(sent, total),
                    error: None,
                },
            );
            last_emit = Instant::now();
        }
        chunk
    });

    let response = request(target, "PUT", url)
        .header("Content-Type", "application/zip")
        .header(reqwest::header::CONTENT_LENGTH, total)
        .timeout(Duration::from_secs(120 + total / 50_000))
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|e| format!("Upload failed: {}", diag::truncate(&e.to_string(), 200)))?;
    check_status(response, "PUT").await.map(|_| ())
}

async fn move_file(target: &Target, from: &str, to: &str) -> Result<(), String> {
    let response = request(target, "MOVE", from)
        .header("Destination", to)
        .header("Overwrite", "T")
        .timeout(META_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("MOVE failed: {}", diag::truncate(&e.to_string(), 200)))?;
    check_status(response, "MOVE").await.map(|_| ())
}

async fn prune_old_backups(
    target: &Target,
    storage: &Storage,
    entries: &[WebDavEntry],
    just_uploaded: &str,
) -> usize {
    let keep = storage
        .get(KEY_KEEP_COUNT, None)
        .as_u64()
        .filter(|value| *value >= 1)
        .unwrap_or(DEFAULT_KEEP_COUNT) as usize;

    let mut names: Vec<String> = entries.iter().map(|entry| entry.name.clone()).collect();
    if !names.iter().any(|name| name == just_uploaded) {
        names.push(just_uploaded.to_string());
    }
    names.sort_by(|a, b| b.cmp(a));
    names.dedup();

    let mut pruned = 0usize;
    for name in names.into_iter().skip(keep) {
        match send(target, "DELETE", &target.child(&name), "DELETE").await {
            Ok(_) => {
                pruned += 1;
                log::info!("[webdav] pruned old backup {}", name);
            }
            Err(error) => {
                log::warn!("[webdav] failed to prune {}: {}", name, diag::truncate(&error, 200));
            }
        }
    }
    pruned
}

#[tauri::command]
pub async fn webdav_restore(name: String, storage: State<'_, Storage>) -> Result<(), String> {
    if !name.starts_with(BACKUP_PREFIX)
        || !name.ends_with(".zip")
        || name.contains('/')
        || name.contains('\\')
    {
        return Err("WEBDAV_BAD_NAME".to_string());
    }
    let target = Target::from_settings(storage.inner())?;

    let listing = propfind_dir(&target, &target.dir_url).await?;
    let expected = parse_backup_entries(&listing)
        .into_iter()
        .find(|entry| entry.name == name)
        .ok_or_else(|| "WEBDAV_VERIFY_MISSING".to_string())?;

    let temp_path = std::env::temp_dir().join(&name);
    let written = download_to_file(&target, &target.child(&name), &temp_path, expected.size).await;
    let written = match written {
        Ok(written) => written,
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(error);
        }
    };

    let result = apply_full_backup(storage.inner(), &temp_path.to_string_lossy());
    let _ = std::fs::remove_file(&temp_path);
    match &result {
        Ok(()) => log::info!("[webdav] restored from {} ({} bytes)", name, written),
        Err(error) => log::warn!("[webdav] restore failed {}: {}", name, diag::truncate(error, 300)),
    }
    result
}

async fn download_to_file(
    target: &Target,
    url: &str,
    dest: &std::path::Path,
    expected_size: u64,
) -> Result<u64, String> {
    let response = request(target, "GET", url)
        .timeout(Duration::from_secs(120 + expected_size / 50_000))
        .send()
        .await
        .map_err(|e| format!("GET failed: {}", diag::truncate(&e.to_string(), 200)))?;
    let mut response = check_status(response, "GET").await?;

    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("Failed to write the downloaded backup: {}", e))?;
    let mut written = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Download interrupted: {}", diag::truncate(&e.to_string(), 200)))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write the downloaded backup: {}", e))?;
        written += chunk.len() as u64;
    }
    file.flush()
        .map_err(|e| format!("Failed to write the downloaded backup: {}", e))?;

    if written == 0 {
        return Err("WEBDAV_EMPTY_DOWNLOAD".to_string());
    }
    if expected_size != 0 && written != expected_size {
        return Err(format!(
            "Download incomplete: got {} of {} bytes",
            written, expected_size
        ));
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_plain_http_and_other_schemes() {
        assert_eq!(
            normalize_dir_url("http://dav.jianguoyun.com/dav/SayIt").unwrap_err(),
            "WEBDAV_URL_INSECURE"
        );
        assert_eq!(
            normalize_dir_url("dav.jianguoyun.com/dav").unwrap_err(),
            "WEBDAV_URL_SCHEME"
        );
        assert_eq!(normalize_dir_url("   ").unwrap_err(), "WEBDAV_URL_EMPTY");
        assert_eq!(normalize_dir_url("https://").unwrap_err(), "WEBDAV_URL_EMPTY");
    }

    #[test]
    fn strips_trailing_slashes_so_children_do_not_double_up() {
        let url = normalize_dir_url("https://dav.jianguoyun.com/dav/SayIt/").unwrap();
        assert_eq!(url, "https://dav.jianguoyun.com/dav/SayIt");
        let target = Target {
            dir_url: url,
            username: "u".into(),
            password: "p".into(),
        };
        assert_eq!(
            target.child("sayforge-backup-x.zip"),
            "https://dav.jianguoyun.com/dav/SayIt/sayforge-backup-x.zip"
        );
    }

    #[test]
    fn credentials_must_not_be_blank() {
        let err = Target::from_config(&WebDavConfig {
            url: "https://dav.jianguoyun.com/dav/SayIt".into(),
            username: "  ".into(),
            password: "p".into(),
        })
        .unwrap_err();
        assert_eq!(err, "WEBDAV_CREDENTIALS_EMPTY");
    }

        #[test]
    fn parses_listing_with_namespace_prefix() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/SayIt/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/SayIt/sayforge-backup-2026-08-26_10-00-00-000.zip</d:href>
    <d:propstat><d:prop><d:getcontentlength>4096</d:getcontentlength></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/SayIt/sayforge-backup-2026-08-25_10-00-00-000.zip</d:href>
    <d:propstat><d:prop><d:getcontentlength>2048</d:getcontentlength></d:prop></d:propstat>
  </d:response>
</d:multistatus>"#;
        let entries = parse_backup_entries(xml);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "sayforge-backup-2026-08-26_10-00-00-000.zip");
        assert_eq!(entries[0].size, 4096);
        assert_eq!(entries[1].size, 2048);
    }

            #[test]
    fn parses_listing_regardless_of_prefix_case_or_absence() {
        let xml = r#"<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/dav/SayIt/sayforge-backup-a.zip</D:href>
    <D:propstat><D:prop><lp1:getcontentlength>11</lp1:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>"#;
        let entries = parse_backup_entries(xml);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].size, 11);

        let no_prefix = r#"<multistatus xmlns="DAV:">
  <response><href>/dav/SayIt/sayforge-backup-b.zip</href>
    <propstat><prop><getcontentlength>22</getcontentlength></prop></propstat>
  </response>
</multistatus>"#;
        let entries = parse_backup_entries(no_prefix);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "sayforge-backup-b.zip");
        assert_eq!(entries[0].size, 22);
    }

    #[test]
    fn ignores_directories_and_foreign_files() {
        let xml = r#"<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/SayIt/</d:href></d:response>
  <d:response><d:href>/dav/SayIt/notes.txt</d:href></d:response>
  <d:response><d:href>/dav/SayIt/sayit-config-2026.json</d:href></d:response>
  <d:response><d:href>/dav/SayIt/sayforge-backup-x.zip.part</d:href></d:response>
</d:multistatus>"#;
        assert!(parse_backup_entries(xml).is_empty());
    }

        #[test]
    fn progress_phases_do_not_overlap() {
        assert_eq!(packing_percent(2.0), 1.0);
        assert_eq!(packing_percent(98.0), 49.0);
        assert!(packing_percent(200.0) <= 50.0);
        assert_eq!(upload_percent(0, 1000), 50.0);
        assert_eq!(upload_percent(1000, 1000), 90.0);
        assert_eq!(upload_percent(0, 0), 90.0);
    }

        ///
                #[test]
    fn scope_defaults_to_config_only_when_unset() {
        let dir = std::env::temp_dir().join(format!("sayit-webdav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::new(dir.join("test.db")).unwrap();

        let scope = scope_from_settings(&storage);
        assert!(!scope.include_history);
        assert!(!scope.include_audio);

        storage.set(KEY_INCLUDE_AUDIO, &Value::Bool(true)).unwrap();
        assert!(scope_from_settings(&storage).include_audio);
        assert!(!scope_from_settings(&storage).include_history);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ancestors_stop_at_the_host() {
        assert_eq!(
            ancestor_urls("https://host.com/dav/a/b"),
            vec!["https://host.com/dav/a", "https://host.com/dav"]
        );
        assert!(ancestor_urls("https://host.com/dav").is_empty());
    }

        #[test]
    fn restore_rejects_names_with_separators() {
        for bad in [
            "../../etc/passwd",
            "sayforge-backup-../x.zip",
            "sayforge-backup-a.zip/..",
            "other.zip",
            "sayforge-backup-a.txt",
        ] {
            let ok = bad.starts_with(BACKUP_PREFIX)
                && bad.ends_with(".zip")
                && !bad.contains('/')
                && !bad.contains('\\');
            assert!(!ok, "should have been rejected: {}", bad);
        }
        assert!("sayforge-backup-2026-08-26_10-00-00-000.zip".starts_with(BACKUP_PREFIX));
    }
}
