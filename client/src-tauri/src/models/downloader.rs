
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use tauri::{AppHandle, Emitter};

use crate::error_protocol;

fn download_error(code: &str, detail: impl AsRef<str>) -> String {
    error_protocol::encode(code, detail)
}

fn download_io_error(context: &str, error: std::io::Error) -> String {
    let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
        "download_permission"
    } else if matches!(error.raw_os_error(), Some(28 | 112)) {
        // ENOSPC on Unix and ERROR_DISK_FULL on Windows.
        "download_no_space"
    } else {
        "download_failed"
    };
    download_error(code, format!("{}: {}", context, error))
}

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const READ_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const PARALLEL_STATE_VERSION: u32 = 1;

#[derive(Default)]
struct DownloadActivity {
    model_paths: HashSet<PathBuf>,
    storage_mutating: bool,
}

static DOWNLOAD_ACTIVITY: Lazy<Mutex<DownloadActivity>> =
    Lazy::new(|| Mutex::new(DownloadActivity::default()));

pub struct ModelPathLease {
    path: PathBuf,
}

impl Drop for ModelPathLease {
    fn drop(&mut self) {
        let mut activity = DOWNLOAD_ACTIVITY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.model_paths.remove(&self.path);
    }
}

pub fn acquire_model_path(path: &Path) -> Result<ModelPathLease, String> {
    let key = path.to_path_buf();
    let mut activity = DOWNLOAD_ACTIVITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if activity.storage_mutating || !activity.model_paths.insert(key.clone()) {
        return Err(download_error(
            "download_busy",
            "The model is already being downloaded or the model directory is being changed",
        ));
    }
    Ok(ModelPathLease { path: key })
}

pub struct ModelStorageLease;

impl Drop for ModelStorageLease {
    fn drop(&mut self) {
        let mut activity = DOWNLOAD_ACTIVITY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.storage_mutating = false;
    }
}

pub fn acquire_model_storage() -> Result<ModelStorageLease, String> {
    let mut activity = DOWNLOAD_ACTIVITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if activity.storage_mutating || !activity.model_paths.is_empty() {
        return Err(download_error(
            "download_busy",
            "Wait for active model downloads to finish before changing the model directory",
        ));
    }
    activity.storage_mutating = true;
    Ok(ModelStorageLease)
}

fn is_checksum_error(err_msg: &str) -> bool {
    err_msg.starts_with("sayforge_error:download_checksum:")
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(download_io_error("Failed to remove temporary/corrupted file", e));
        }
    }
    Ok(())
}

fn verify_file_sha256(file_path: &Path, expected_sha256: &str) -> Result<(), String> {
    use std::io::Read;
    let mut file = std::fs::File::open(file_path)
        .map_err(|e| download_io_error("Failed to open file for SHA-256 verification", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| download_io_error("Failed to read file during SHA-256 verification", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    let actual_hash = format!("{:x}", hasher.finalize());
    let expected_lower = expected_sha256.to_ascii_lowercase();

    if actual_hash != expected_lower {
        return Err(download_error(
            "download_checksum",
            format!(
                "SHA-256 verification failed: expected {}, got {}",
                expected_lower, actual_hash
            ),
        ));
    }

    Ok(())
}

fn verify_temp_file_sha256(file_path: &Path, expected_sha256: &str) -> Result<(), String> {
    match verify_file_sha256(file_path, expected_sha256) {
        Ok(()) => Ok(()),
        Err(e) if is_checksum_error(&e) => {
            remove_file_if_exists(file_path)?;
            Err(e)
        }
        Err(e) => Err(e),
    }
}


#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub model_id: String,
    pub file_name: String,
        pub downloaded_bytes: u64,
        pub total_bytes: u64,
        pub percent: f64,
        pub file_index: u32,
        pub file_count: u32,
    pub status: String,
    pub error: Option<String>,
}

fn emit_progress(
    app: &AppHandle,
    model_id: &str,
    file_name: &str,
    downloaded: u64,
    total: u64,
    status: &str,
    error: Option<&str>,
    file_index: u32,
    file_count: u32,
) {
    let percent = if total > 0 {
        (downloaded as f64 / total as f64 * 100.0).min(100.0)
    } else {
        0.0
    };
    let _ = app.emit(
        "model-download-progress",
        DownloadProgress {
            model_id: model_id.into(),
            file_name: file_name.into(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            percent,
            file_index,
            file_count,
            status: status.into(),
            error: error.map(Into::into),
        },
    );
}

static CUSTOM_MODELS_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn default_models_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(crate::identity::APP_ID)
        .join("models")
}

pub fn set_custom_models_dir(dir: Option<PathBuf>) {
    if let Ok(mut guard) = CUSTOM_MODELS_DIR.write() {
        *guard = dir;
    }
}

pub fn models_dir() -> PathBuf {
    if let Ok(guard) = CUSTOM_MODELS_DIR.read() {
        if let Some(ref dir) = *guard {
            return dir.clone();
        }
    }
    default_models_dir()
}

pub fn model_dir(model_id: &str) -> PathBuf {
    models_dir().join(model_id)
}

use futures_util::stream::{FuturesUnordered, StreamExt};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Debug, Default, Clone)]
struct RemoteProbe {
    size: u64,
    supports_range: bool,
    strong_etag: Option<String>,
}

fn parse_content_range_header(value: &str) -> Option<(u64, u64, u64)> {
    let (bounds, total) = value.trim().strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = bounds.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

fn strong_etag(resp: &reqwest::Response) -> Option<String> {
    let value = resp
        .headers()
        .get(reqwest::header::ETAG)?
        .to_str()
        .ok()?
        .trim();
    if value.is_empty() || value.starts_with("W/") {
        None
    } else {
        Some(value.to_string())
    }
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("SayForge/1.0")
        .tcp_nodelay(true)
        .pool_max_idle_per_host(16)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_IDLE_TIMEOUT)
        .build()
        .map_err(|e| download_error("download_network", format!("Failed to create HTTP client: {}", e)))
}

fn full_request(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
}

fn resume_request(
    client: &reqwest::Client,
    url: &str,
    offset: u64,
    strong_etag: Option<&str>,
) -> reqwest::RequestBuilder {
    let request = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::RANGE, format!("bytes={}-", offset));
    if let Some(etag) = strong_etag {
        request.header(reqwest::header::IF_RANGE, etag)
    } else {
        request
    }
}

fn range_request(
    client: &reqwest::Client,
    url: &str,
    range: String,
    strong_etag: Option<&str>,
) -> reqwest::RequestBuilder {
    let request = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::RANGE, range);
    if let Some(etag) = strong_etag {
        request.header(reqwest::header::IF_MATCH, etag)
    } else {
        request
    }
}

async fn probe_url(client: &reqwest::Client, url: &str) -> RemoteProbe {
    let resp = match range_request(client, url, "bytes=0-0".to_string(), None)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(error) => {
            log::warn!("Range probe failed for {}: {}", url, error);
            return RemoteProbe::default();
        }
    };

    let etag = strong_etag(&resp);
    if resp.status().as_u16() == 206 {
        if let Some((0, 0, total)) = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_content_range_header)
        {
            if total > 0 {
                return RemoteProbe {
                    size: total,
                    supports_range: true,
                    strong_etag: etag,
                };
            }
        }
    }

    RemoteProbe {
        size: resp.content_length().unwrap_or(0),
        supports_range: false,
        strong_etag: etag,
    }
}

fn resolve_download_size(expected_size: u64, remote_size: u64) -> Result<u64, String> {
    if expected_size > 0 && remote_size > 0 && expected_size != remote_size {
        return Err(download_error(
            "download_source_mismatch",
            format!(
                "Catalog size is {}, but the server reports {} bytes",
                expected_size, remote_size
            ),
        ));
    }
    Ok(if expected_size > 0 {
        expected_size
    } else {
        remote_size
    })
}

fn validate_range_response_parts(
    status: u16,
    content_range_str: Option<&str>,
    content_length: Option<u64>,
    expected_start: u64,
    expected_end: u64,
    expected_total: u64,
) -> Result<(), String> {
    if status != 206 {
        let code = if status == 412 {
            "download_source_changed"
        } else if status == 429 || status >= 500 {
            "download_network"
        } else {
            "download_range_invalid"
        };
        return Err(download_error(
            code,
            format!("Expected HTTP 206 for Range request, got HTTP {}", status),
        ));
    }

    let header = content_range_str.ok_or_else(|| {
        download_error(
            "download_range_invalid",
            "Missing Content-Range header in 206 response",
        )
    })?;
    let (start, end, total) = parse_content_range_header(header).ok_or_else(|| {
        download_error(
            "download_range_invalid",
            format!("Invalid Content-Range: {}", header),
        )
    })?;

    if start != expected_start || end != expected_end {
        return Err(download_error(
            "download_range_invalid",
            format!(
                "Content-Range mismatch: expected bytes {}-{}, got bytes {}-{}",
                expected_start, expected_end, start, end
            ),
        ));
    }
    if total != expected_total {
        return Err(download_error(
            "download_source_changed",
            format!(
                "Remote size changed during download: expected {}, got {}",
                expected_total, total
            ),
        ));
    }

    let expected_len = expected_end - expected_start + 1;
    if let Some(content_len) = content_length {
        if content_len != expected_len {
            return Err(download_error(
                "download_range_invalid",
                format!(
                    "Content-Length mismatch: expected {}, got {}",
                    expected_len, content_len
                ),
            ));
        }
    }

    Ok(())
}

fn validate_chunk_response(
    resp: &reqwest::Response,
    expected_start: u64,
    expected_end: u64,
    expected_total: u64,
    expected_etag: Option<&str>,
) -> Result<(), String> {
    let content_range = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok());
    validate_range_response_parts(
        resp.status().as_u16(),
        content_range,
        resp.content_length(),
        expected_start,
        expected_end,
        expected_total,
    )?;

    if let (Some(expected), Some(actual)) = (
        expected_etag,
        resp.headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok()),
    ) {
        if actual.trim() != expected {
            return Err(download_error(
                "download_source_changed",
                format!("Remote ETag changed from {} to {}", expected, actual.trim()),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ChunkSpec {
    index: usize,
    start: u64,
    end: u64,
}

impl ChunkSpec {
    fn len(&self) -> u64 {
        self.end - self.start + 1
    }
}

async fn download_chunk(
    client: reqwest::Client,
    url: String,
    chunk_path: PathBuf,
    chunk: ChunkSpec,
    total_file_size: u64,
    expected_etag: Option<String>,
    downloaded_total: Arc<AtomicU64>,
) -> Result<usize, String> {
    let chunk_total = chunk.len();
    let mut downloaded_in_chunk = match std::fs::metadata(&chunk_path) {
        Ok(metadata) if metadata.len() <= chunk_total => metadata.len(),
        Ok(_) => {
            remove_file_if_exists(&chunk_path)?;
            0
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(download_io_error("Failed to inspect chunk file", error)),
    };
    if downloaded_in_chunk == chunk_total {
        return Ok(chunk.index);
    }

    let max_attempts = 3;
    for attempt in 1..=max_attempts {
        let current_start = chunk.start + downloaded_in_chunk;
        let response = match range_request(
            &client,
            &url,
            format!("bytes={}-{}", current_start, chunk.end),
            expected_etag.as_deref(),
        )
        .send()
        .await
        {
            Ok(response) => response,
            Err(error) => {
                if attempt == max_attempts {
                    return Err(download_error(
                        "download_network",
                        format!(
                            "Chunk {} failed after {} attempts: {}",
                            chunk.index, max_attempts, error
                        ),
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
                continue;
            }
        };

        if let Err(error) = validate_chunk_response(
            &response,
            current_start,
            chunk.end,
            total_file_size,
            expected_etag.as_deref(),
        ) {
            if !error.starts_with("sayforge_error:download_network:") || attempt == max_attempts {
                return Err(error);
            }
            tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
            continue;
        }

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&chunk_path)
            .map_err(|error| download_io_error("Failed to open resumable chunk file", error))?;
        let mut stream = response.bytes_stream();
        let mut interrupted = false;

        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
                    let len = bytes.len() as u64;
                    if downloaded_in_chunk + len > chunk_total {
                        return Err(download_error(
                            "download_range_invalid",
                            format!("Chunk {} exceeded its requested range", chunk.index),
                        ));
                    }
                    file.write_all(&bytes)
                        .map_err(|error| download_io_error("Failed to write chunk data", error))?;
                    downloaded_in_chunk += len;
                    downloaded_total.fetch_add(len, Ordering::Relaxed);
                }
                Err(error) => {
                    log::warn!(
                        "Chunk {} stream interrupted on attempt {}: {}",
                        chunk.index,
                        attempt,
                        error
                    );
                    interrupted = true;
                    break;
                }
            }
        }
        file.flush()
            .map_err(|error| download_io_error("Failed to flush chunk data", error))?;
        drop(file);

        if !interrupted && downloaded_in_chunk == chunk_total {
            return Ok(chunk.index);
        }
        if attempt < max_attempts {
            tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
        }
    }

    Err(download_error(
        "download_network",
        format!(
            "Chunk {} incomplete: received {}/{} bytes",
            chunk.index, downloaded_in_chunk, chunk_total
        ),
    ))
}

fn calculate_chunks(total_size: u64) -> Vec<ChunkSpec> {
    if total_size == 0 {
        return vec![];
    }
    let num_chunks = (total_size / (32 * 1024 * 1024)).clamp(4, 16) as usize;
    let chunk_size = (total_size + num_chunks as u64 - 1) / (num_chunks as u64);

    let mut chunks = Vec::with_capacity(num_chunks);
    for i in 0..num_chunks {
        let start = i as u64 * chunk_size;
        if start >= total_size {
            break;
        }
        let end = ((i as u64 + 1) * chunk_size - 1).min(total_size - 1);
        chunks.push(ChunkSpec { index: i, start, end });
    }
    chunks
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ParallelPhase {
    Downloading,
    Assembling,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ParallelDownloadState {
    version: u32,
    total_size: u64,
    expected_sha256: Option<String>,
    source_url: String,
    strong_etag: Option<String>,
    chunks: Vec<ChunkSpec>,
    phase: ParallelPhase,
    assembled_chunks: usize,
}

fn sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    path.with_file_name(format!("{}{}", name, suffix))
}

fn parallel_state_path(temp_path: &Path) -> PathBuf {
    sibling_path(temp_path, ".json")
}

fn parallel_chunk_path(temp_path: &Path, index: usize) -> PathBuf {
    sibling_path(temp_path, &format!(".chunk-{:02}", index))
}

fn persist_parallel_state(path: &Path, state: &ParallelDownloadState) -> Result<(), String> {
    let bytes = serde_json::to_vec(state)
        .map_err(|error| download_error("download_failed", format!("Failed to serialize download state: {}", error)))?;
    std::fs::write(path, bytes)
        .map_err(|error| download_io_error("Failed to persist parallel download state", error))
}

fn cleanup_parallel_artifacts(
    temp_path: &Path,
    state_path: &Path,
    chunks: &[ChunkSpec],
) -> Result<(), String> {
    remove_file_if_exists(temp_path)?;
    remove_file_if_exists(state_path)?;
    for chunk in chunks {
        remove_file_if_exists(&parallel_chunk_path(temp_path, chunk.index))?;
    }
    Ok(())
}

fn cleanup_parallel_artifacts_best_effort(
    temp_path: &Path,
    state_path: &Path,
    chunks: &[ChunkSpec],
) {
    if let Err(error) = cleanup_parallel_artifacts(temp_path, state_path, chunks) {
        log::warn!("Failed to clean parallel download artifacts: {}", error);
    }
}

fn parallel_state_matches(
    state: &ParallelDownloadState,
    total_size: u64,
    expected_sha256: Option<&str>,
    source_url: &str,
    strong_etag: Option<&str>,
    chunks: &[ChunkSpec],
) -> bool {
    state.version == PARALLEL_STATE_VERSION
        && state.total_size == total_size
        && state.expected_sha256.as_deref() == expected_sha256
        && state.source_url == source_url
        && state.strong_etag.as_deref() == strong_etag
        && state.chunks == chunks
        && state.assembled_chunks <= chunks.len()
}

fn load_or_create_parallel_state(
    temp_path: &Path,
    total_size: u64,
    expected_sha256: Option<&str>,
    source_url: &str,
    strong_etag: Option<&str>,
    chunks: &[ChunkSpec],
) -> Result<ParallelDownloadState, String> {
    let state_path = parallel_state_path(temp_path);
    match std::fs::read(&state_path) {
        Ok(bytes) => match serde_json::from_slice::<ParallelDownloadState>(&bytes) {
            Ok(state)
                if parallel_state_matches(
                    &state,
                    total_size,
                    expected_sha256,
                    source_url,
                    strong_etag,
                    chunks,
                ) =>
            {
                return Ok(state);
            }
            Ok(old_state) => {
                cleanup_parallel_artifacts(temp_path, &state_path, &old_state.chunks)?;
                for chunk in chunks {
                    remove_file_if_exists(&parallel_chunk_path(temp_path, chunk.index))?;
                }
            }
            Err(_) => {
                cleanup_parallel_artifacts(temp_path, &state_path, chunks)?;
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            cleanup_parallel_artifacts(temp_path, &state_path, chunks)?;
        }
        Err(error) => return Err(download_io_error("Failed to read parallel download state", error)),
    }

    let state = ParallelDownloadState {
        version: PARALLEL_STATE_VERSION,
        total_size,
        expected_sha256: expected_sha256.map(str::to_string),
        source_url: source_url.to_string(),
        strong_etag: strong_etag.map(str::to_string),
        chunks: chunks.to_vec(),
        phase: ParallelPhase::Downloading,
        assembled_chunks: 0,
    };
    persist_parallel_state(&state_path, &state)?;
    Ok(state)
}

fn chunk_file_len(path: &Path, maximum: u64) -> Result<u64, String> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.len() <= maximum => Ok(metadata.len()),
        Ok(_) => {
            remove_file_if_exists(path)?;
            Ok(0)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(download_io_error("Failed to inspect chunk file", error)),
    }
}

fn prepare_assembly_file(
    temp_path: &Path,
    chunks: &[ChunkSpec],
    assembled_chunks: usize,
) -> Result<(), String> {
    let expected_len: u64 = chunks
        .iter()
        .take(assembled_chunks)
        .map(ChunkSpec::len)
        .sum();
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(temp_path)
        .map_err(|error| download_io_error("Failed to open assembly file", error))?;
    let actual_len = file
        .metadata()
        .map_err(|error| download_io_error("Failed to inspect assembly file", error))?
        .len();
    if actual_len < expected_len {
        return Err(download_error(
            "download_parallel_verify_failed",
            format!(
                "Assembly file is shorter than its persisted state: {}/{} bytes",
                actual_len, expected_len
            ),
        ));
    }
    if actual_len != expected_len {
        file.set_len(expected_len)
            .map_err(|error| download_io_error("Failed to repair assembly file length", error))?;
    }
    Ok(())
}

async fn download_file_parallel(
    app: &AppHandle,
    model_id: &str,
    file_name: &str,
    url: &str,
    total_size: u64,
    expected_sha256: Option<&str>,
    strong_etag: Option<&str>,
    temp_path: &Path,
    dest_path: &Path,
    file_index: u32,
    file_count: u32,
) -> Result<(), String> {
    let chunks = calculate_chunks(total_size);
    let state_path = parallel_state_path(temp_path);
    let mut state = load_or_create_parallel_state(
        temp_path,
        total_size,
        expected_sha256,
        url,
        strong_etag,
        &chunks,
    )?;

    if state.phase == ParallelPhase::Downloading {
        let mut initial_downloaded = 0u64;
        for chunk in &chunks {
            initial_downloaded += chunk_file_len(
                &parallel_chunk_path(temp_path, chunk.index),
                chunk.len(),
            )?;
        }
        let downloaded_total = Arc::new(AtomicU64::new(initial_downloaded));
        let client = build_http_client()?;
        let mut futures = FuturesUnordered::new();

        for chunk in chunks.iter().cloned() {
            let path = parallel_chunk_path(temp_path, chunk.index);
            if chunk_file_len(&path, chunk.len())? == chunk.len() {
                continue;
            }
            futures.push(download_chunk(
                client.clone(),
                url.to_string(),
                path,
                chunk,
                total_size,
                strong_etag.map(str::to_string),
                Arc::clone(&downloaded_total),
            ));
        }

        emit_progress(
            app,
            model_id,
            file_name,
            initial_downloaded,
            total_size,
            "downloading",
            None,
            file_index,
            file_count,
        );
        let mut progress_interval = tokio::time::interval(std::time::Duration::from_millis(150));
        let mut worker_error = None;
        while !futures.is_empty() {
            tokio::select! {
                _ = progress_interval.tick() => {
                    emit_progress(
                        app,
                        model_id,
                        file_name,
                        downloaded_total.load(Ordering::Relaxed),
                        total_size,
                        "downloading",
                        None,
                        file_index,
                        file_count,
                    );
                }
                result = futures.next() => {
                    if let Some(Err(error)) = result {
                        worker_error = Some(error);
                        break;
                    }
                }
            }
        }
        drop(futures);
        if let Some(error) = worker_error {
            if error.starts_with("sayforge_error:download_range_invalid:")
                || error.starts_with("sayforge_error:download_source_changed:")
            {
                cleanup_parallel_artifacts(temp_path, &state_path, &chunks)?;
            }
            return Err(error);
        }

        for chunk in &chunks {
            let path = parallel_chunk_path(temp_path, chunk.index);
            let actual = chunk_file_len(&path, chunk.len())?;
            if actual != chunk.len() {
                return Err(download_error(
                    "download_parallel_verify_failed",
                    format!(
                        "Chunk {} is incomplete after workers finished: {}/{} bytes",
                        chunk.index,
                        actual,
                        chunk.len()
                    ),
                ));
            }
        }

        state.phase = ParallelPhase::Assembling;
        state.assembled_chunks = 0;
        persist_parallel_state(&state_path, &state)?;
        remove_file_if_exists(temp_path)?;
    }

    if let Err(error) = prepare_assembly_file(temp_path, &chunks, state.assembled_chunks) {
        cleanup_parallel_artifacts(temp_path, &state_path, &chunks)?;
        return Err(error);
    }

    for index in 0..state.assembled_chunks {
        remove_file_if_exists(&parallel_chunk_path(temp_path, index))?;
    }

    let mut assembled = std::fs::OpenOptions::new()
        .append(true)
        .open(temp_path)
        .map_err(|error| download_io_error("Failed to open assembly file for append", error))?;
    for chunk in chunks.iter().skip(state.assembled_chunks) {
        let chunk_path = parallel_chunk_path(temp_path, chunk.index);
        let actual = chunk_file_len(&chunk_path, chunk.len())?;
        if actual != chunk.len() {
            return Err(download_error(
                "download_parallel_verify_failed",
                format!("Chunk {} disappeared before assembly", chunk.index),
            ));
        }
        let mut source = std::fs::File::open(&chunk_path)
            .map_err(|error| download_io_error("Failed to open completed chunk", error))?;
        let copied = std::io::copy(&mut source, &mut assembled)
            .map_err(|error| download_io_error("Failed to assemble chunk", error))?;
        if copied != chunk.len() {
            return Err(download_error(
                "download_parallel_verify_failed",
                format!(
                    "Chunk {} changed during assembly: copied {}/{} bytes",
                    chunk.index,
                    copied,
                    chunk.len()
                ),
            ));
        }
        assembled
            .flush()
            .map_err(|error| download_io_error("Failed to flush assembly file", error))?;
        assembled
            .sync_data()
            .map_err(|error| download_io_error("Failed to persist assembled chunk", error))?;
        state.assembled_chunks = chunk.index + 1;
        persist_parallel_state(&state_path, &state)?;
        remove_file_if_exists(&chunk_path)?;
    }
    drop(assembled);

    let assembled_size = std::fs::metadata(temp_path)
        .map_err(|error| download_io_error("Failed to inspect assembled file", error))?
        .len();
    if assembled_size != total_size {
        cleanup_parallel_artifacts(temp_path, &state_path, &chunks)?;
        return Err(download_error(
            "download_parallel_verify_failed",
            format!("Assembled file has size {}/{}", assembled_size, total_size),
        ));
    }
    if let Some(expected_hash) = expected_sha256 {
        if let Err(error) = verify_temp_file_sha256(temp_path, expected_hash) {
            cleanup_parallel_artifacts_best_effort(temp_path, &state_path, &chunks);
            emit_progress(
                app,
                model_id,
                file_name,
                assembled_size,
                total_size,
                "failed",
                Some(&error),
                file_index,
                file_count,
            );
            return Err(error);
        }
    }

    std::fs::rename(temp_path, dest_path)
        .map_err(|error| download_io_error("Failed to finalize downloaded file", error))?;
    cleanup_parallel_artifacts_best_effort(temp_path, &state_path, &chunks);
    emit_progress(
        app,
        model_id,
        file_name,
        total_size,
        total_size,
        "completed",
        None,
        file_index,
        file_count,
    );
    log::info!(
        "Parallel download resumed, verified and completed: {} ({} bytes)",
        file_name,
        total_size
    );
    Ok(())
}

fn should_fallback_to_single_stream(err_msg: &str) -> bool {
    err_msg.starts_with("sayforge_error:download_range_invalid:")
        || err_msg.starts_with("sayforge_error:download_source_changed:")
        || err_msg.starts_with("sayforge_error:download_parallel_verify_failed:")
        || is_checksum_error(err_msg)
}

fn is_valid_resume_content_range(
    content_range_opt: Option<&str>,
    content_length_opt: Option<u64>,
    expected_downloaded: u64,
    expected_total: u64,
) -> bool {
    let Some((start, end, total)) = content_range_opt.and_then(parse_content_range_header) else {
        return false;
    };
    if total == 0 || start != expected_downloaded || end < start || end != total - 1 {
        return false;
    }
    if expected_total > 0 && total != expected_total {
        return false;
    }
    content_length_opt.map_or(true, |length| length == end - start + 1)
}

fn parse_unsatisfied_range_total(content_range: Option<&str>) -> Option<u64> {
    content_range?
        .trim()
        .strip_prefix("bytes */")?
        .parse()
        .ok()
}

#[derive(Debug, PartialEq, Eq)]
enum ResumeDecision {
        Finalize,
        Restart,
        Resume(u64),
}

fn inspect_resume_state(
    current_bytes: u64,
    total_size: u64,
    sha_verify_result: Option<Result<(), String>>,
) -> Result<ResumeDecision, String> {
    if total_size == 0 || current_bytes < total_size {
        return Ok(ResumeDecision::Resume(current_bytes));
    }
    if current_bytes > total_size {
        return Ok(ResumeDecision::Restart);
    }

    match sha_verify_result {
        Some(Err(e)) if is_checksum_error(&e) => Ok(ResumeDecision::Restart),
        Some(Err(e)) => Err(e),
        Some(Ok(())) | None => Ok(ResumeDecision::Finalize),
    }
}

async fn send_full_response(
    client: &reqwest::Client,
    url: &str,
) -> Result<reqwest::Response, String> {
    let response = full_request(client, url)
        .send()
        .await
        .map_err(|error| download_error("download_network", format!("Full download request failed: {}", error)))?;
    if response.status().as_u16() != 200 {
        return Err(download_error(
            "download_network",
            format!("Full download failed with HTTP {}", response.status()),
        ));
    }
    Ok(response)
}

async fn download_file_single_stream(
    app: &AppHandle,
    model_id: &str,
    file_name: &str,
    url: &str,
    total_size: u64,
    expected_sha256: Option<&str>,
    strong_etag: Option<&str>,
    temp_path: &Path,
    dest_path: &Path,
    file_index: u32,
    file_count: u32,
) -> Result<(), String> {
    let raw_initial = match std::fs::metadata(temp_path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(download_io_error(
                "Failed to read partial download metadata",
                error,
            ));
        }
    };

    let sha_result = if total_size > 0 && raw_initial == total_size {
        expected_sha256.map(|hash| verify_file_sha256(temp_path, hash))
    } else {
        None
    };
    let downloaded_initial = match inspect_resume_state(raw_initial, total_size, sha_result)? {
        ResumeDecision::Finalize => {
            std::fs::rename(temp_path, dest_path)
                .map_err(|error| download_io_error("Failed to finalize completed partial download", error))?;
            emit_progress(
                app,
                model_id,
                file_name,
                total_size,
                total_size,
                "completed",
                None,
                file_index,
                file_count,
            );
            return Ok(());
        }
        ResumeDecision::Restart => {
            remove_file_if_exists(temp_path)?;
            0
        }
        ResumeDecision::Resume(offset) => offset,
    };

    let client = build_http_client()?;
    let (response, mut downloaded, is_resume) = if downloaded_initial > 0 {
        emit_progress(
            app,
            model_id,
            file_name,
            downloaded_initial,
            total_size,
            "downloading",
            None,
            file_index,
            file_count,
        );
        let response = resume_request(&client, url, downloaded_initial, strong_etag)
            .send()
            .await
            .map_err(|error| download_error("download_network", format!("Resume request failed: {}", error)))?;
        match response.status().as_u16() {
            206 => {
                let content_range = response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok());
                if is_valid_resume_content_range(
                    content_range,
                    response.content_length(),
                    downloaded_initial,
                    total_size,
                ) {
                    (response, downloaded_initial, true)
                } else {
                    log::warn!("Invalid resume Content-Range; restarting {} from zero", file_name);
                    drop(response);
                    remove_file_if_exists(temp_path)?;
                    (send_full_response(&client, url).await?, 0, false)
                }
            }
            200 => {
                (response, 0, false)
            }
            416 => {
                let remote_total = parse_unsatisfied_range_total(
                    response
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok()),
                );
                drop(response);
                if let Some(remote_total) = remote_total {
                    if total_size > 0 && remote_total != total_size {
                        return Err(download_error(
                            "download_source_mismatch",
                            format!(
                                "Catalog size is {}, but the server reports {} bytes",
                                total_size, remote_total
                            ),
                        ));
                    }
                    if remote_total == downloaded_initial {
                        let verified = match expected_sha256 {
                            Some(hash) => verify_file_sha256(temp_path, hash),
                            None => Ok(()),
                        };
                        match verified {
                            Ok(()) => {
                                std::fs::rename(temp_path, dest_path).map_err(|error| {
                                    download_io_error("Failed to finalize complete partial download", error)
                                })?;
                                emit_progress(
                                    app,
                                    model_id,
                                    file_name,
                                    remote_total,
                                    remote_total,
                                    "completed",
                                    None,
                                    file_index,
                                    file_count,
                                );
                                return Ok(());
                            }
                            Err(error) if is_checksum_error(&error) => {
                                remove_file_if_exists(temp_path)?;
                            }
                            Err(error) => return Err(error),
                        }
                    } else {
                        remove_file_if_exists(temp_path)?;
                    }
                } else {
                    remove_file_if_exists(temp_path)?;
                }
                (send_full_response(&client, url).await?, 0, false)
            }
            status => {
                return Err(download_error(
                    "download_network",
                    format!("Resume request failed with HTTP {}", status),
                ));
            }
        }
    } else {
        emit_progress(
            app,
            model_id,
            file_name,
            0,
            total_size,
            "downloading",
            None,
            file_index,
            file_count,
        );
        (send_full_response(&client, url).await?, 0, false)
    };

    let content_len = response.content_length().unwrap_or(0);
    if !is_resume && total_size > 0 && content_len > 0 && content_len != total_size {
        return Err(download_error(
            "download_source_mismatch",
            format!(
                "Catalog size is {}, but the full response contains {} bytes",
                total_size, content_len
            ),
        ));
    }
    let final_total = if total_size > 0 {
        total_size
    } else {
        downloaded + content_len
    };
    let mut file = if is_resume {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(temp_path)
            .map_err(|error| download_io_error("Failed to open partial download for append", error))?
    } else {
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(temp_path)
            .map_err(|error| download_io_error("Failed to restart partial download", error))?
    };

    let mut stream = response.bytes_stream();
    let mut last_emit = std::time::Instant::now();
    while let Some(item) = stream.next().await {
        let bytes = item.map_err(|error| {
            download_error("download_network", format!("Download interrupted: {}", error))
        })?;
        if final_total > 0 && downloaded + bytes.len() as u64 > final_total {
            return Err(download_error(
                "download_source_mismatch",
                format!("Server sent more than the expected {} bytes", final_total),
            ));
        }
        file.write_all(&bytes)
            .map_err(|error| download_io_error("Failed to write partial download", error))?;
        downloaded += bytes.len() as u64;
        if last_emit.elapsed().as_millis() >= 200 {
            emit_progress(
                app,
                model_id,
                file_name,
                downloaded,
                final_total,
                "downloading",
                None,
                file_index,
                file_count,
            );
            last_emit = std::time::Instant::now();
        }
    }
    file.flush()
        .map_err(|error| download_io_error("Failed to flush partial download", error))?;
    drop(file);

    if final_total > 0 && downloaded != final_total {
        let error = download_error(
            "download_failed",
            format!(
                "Single-stream download incomplete for {}: received {}/{} bytes",
                file_name, downloaded, final_total
            ),
        );
        emit_progress(
            app,
            model_id,
            file_name,
            downloaded,
            final_total,
            "failed",
            Some(&error),
            file_index,
            file_count,
        );
        return Err(error);
    }
    if let Some(expected_hash) = expected_sha256 {
        if let Err(error) = verify_temp_file_sha256(temp_path, expected_hash) {
            emit_progress(
                app,
                model_id,
                file_name,
                downloaded,
                final_total,
                "failed",
                Some(&error),
                file_index,
                file_count,
            );
            return Err(error);
        }
    }
    std::fs::rename(temp_path, dest_path)
        .map_err(|error| download_io_error("Failed to finalize downloaded file", error))?;
    emit_progress(
        app,
        model_id,
        file_name,
        downloaded,
        final_total,
        "completed",
        None,
        file_index,
        file_count,
    );
    Ok(())
}

pub async fn download_file(
    app: AppHandle,
    model_id: &str,
    file_name: &str,
    url: &str,
    expected_size: u64,
    expected_sha256: Option<&str>,
    dest_dir: &Path,
    file_index: u32,
    file_count: u32,
) -> Result<(), String> {
    let dest_path = dest_dir.join(file_name);
    let stream_temp = dest_dir.join(format!("{}.part", file_name));
    let parallel_temp = dest_dir.join(format!("{}.par.part", file_name));

    std::fs::create_dir_all(dest_dir)
        .map_err(|error| download_io_error("Failed to create model directory", error))?;
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| download_io_error("Failed to create model subdirectory", error))?;
    }

    match std::fs::metadata(&dest_path) {
        Ok(metadata) => {
            let size = metadata.len();
            let size_ok = size > 0 && (expected_size == 0 || size == expected_size);
            let hash_ok = if size_ok {
                match expected_sha256 {
                    Some(hash) => match verify_file_sha256(&dest_path, hash) {
                        Ok(()) => true,
                        Err(error) if is_checksum_error(&error) => false,
                        Err(error) => return Err(error),
                    },
                    None => true,
                }
            } else {
                false
            };
            if size_ok && hash_ok {
                if let Err(error) = remove_file_if_exists(&stream_temp) {
                    log::warn!("Failed to remove stale single-stream partial: {}", error);
                }
                if expected_size > 0 {
                    let chunks = calculate_chunks(expected_size);
                    cleanup_parallel_artifacts_best_effort(
                        &parallel_temp,
                        &parallel_state_path(&parallel_temp),
                        &chunks,
                    );
                }
                emit_progress(
                    &app,
                    model_id,
                    file_name,
                    size,
                    size,
                    "completed",
                    None,
                    file_index,
                    file_count,
                );
                return Ok(());
            }
            log::warn!(
                "Existing model file {} failed size or SHA-256 validation; redownloading",
                file_name
            );
            remove_file_if_exists(&dest_path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(download_io_error(
                "Failed to read existing model metadata",
                error,
            ));
        }
    }

    let client = build_http_client()?;
    let probe = probe_url(&client, url).await;
    let total_size = match resolve_download_size(expected_size, probe.size) {
        Ok(size) => size,
        Err(error) => {
            emit_progress(
                &app,
                model_id,
                file_name,
                0,
                expected_size,
                "failed",
                Some(&error),
                file_index,
                file_count,
            );
            return Err(error);
        }
    };

    let stream_partial_exists = std::fs::metadata(&stream_temp)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false);
    let parallel_state_exists = std::fs::metadata(parallel_state_path(&parallel_temp)).is_ok();
    let can_parallel = probe.supports_range
        && total_size >= 16 * 1024 * 1024
        && (expected_sha256.is_some() || probe.strong_etag.is_some());

    if can_parallel && (!stream_partial_exists || parallel_state_exists) {
        let result = download_file_parallel(
            &app,
            model_id,
            file_name,
            url,
            total_size,
            expected_sha256,
            probe.strong_etag.as_deref(),
            &parallel_temp,
            &dest_path,
            file_index,
            file_count,
        )
        .await;
        match result {
            Ok(()) => {
                if let Err(error) = remove_file_if_exists(&stream_temp) {
                    log::warn!("Failed to remove stale single-stream partial: {}", error);
                }
                Ok(())
            }
            Err(error) if should_fallback_to_single_stream(&error) => {
                log::warn!(
                    "Parallel protocol failed for {}; falling back to a full single stream: {}",
                    file_name,
                    error
                );
                let chunks = calculate_chunks(total_size);
                cleanup_parallel_artifacts_best_effort(
                    &parallel_temp,
                    &parallel_state_path(&parallel_temp),
                    &chunks,
                );
                download_file_single_stream(
                    &app,
                    model_id,
                    file_name,
                    url,
                    total_size,
                    expected_sha256,
                    probe.strong_etag.as_deref(),
                    &stream_temp,
                    &dest_path,
                    file_index,
                    file_count,
                )
                .await
            }
            Err(error) => {
                emit_progress(
                    &app,
                    model_id,
                    file_name,
                    0,
                    total_size,
                    "failed",
                    Some(&error),
                    file_index,
                    file_count,
                );
                Err(error)
            }
        }
    } else {
        let result = download_file_single_stream(
            &app,
            model_id,
            file_name,
            url,
            total_size,
            expected_sha256,
            probe.strong_etag.as_deref(),
            &stream_temp,
            &dest_path,
            file_index,
            file_count,
        )
        .await;
        if result.is_ok() && total_size > 0 {
            let chunks = calculate_chunks(total_size);
            cleanup_parallel_artifacts_best_effort(
                &parallel_temp,
                &parallel_state_path(&parallel_temp),
                &chunks,
            );
        }
        result
    }
}

fn build_archive_candidates(url: &str) -> Vec<String> {
    if url.starts_with("https://github.com/") {
        vec![
            format!("https://gh-proxy.com/{}", url),
            format!("https://ghfast.top/{}", url),
            url.to_string(),
        ]
    } else {
        vec![url.to_string()]
    }
}

async fn download_archive_once(
    app: &AppHandle,
    model_id: &str,
    url: &str,
    temp_path: &Path,
) -> Result<(), String> {
    let mut downloaded: u64 = if temp_path.exists() {
        std::fs::metadata(temp_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let client = build_http_client()?;
    let mut request = client.get(url);
    if downloaded > 0 {
        request = request.header("Range", format!("bytes={}-", downloaded));
        log::info!("Resuming archive download from {} bytes ({})", downloaded, url);
    }

    emit_progress(app, model_id, "archive", downloaded, 0, "downloading", None, 1, 1);

    let resp = request
        .send()
        .await
        .map_err(|e| download_error("download_network", format!("Download request failed: {}", e)))?;

    if !resp.status().is_success() && resp.status().as_u16() != 206 {
        return Err(download_error("download_network", format!("Download failed with HTTP {}", resp.status())));
    }

    let content_length = resp.content_length().unwrap_or(0);
    let total = downloaded + content_length;

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(temp_path)
        .map_err(|e| download_io_error("Failed to open partial archive", e))?;

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| download_error("download_network", format!("Download interrupted: {}", e)))?;
        file.write_all(&chunk).map_err(|e| download_io_error("Failed to write partial archive", e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= 300 {
            emit_progress(app, model_id, "archive", downloaded, total, "downloading", None, 1, 1);
            last_emit = std::time::Instant::now();
        }
    }

    file.flush().map_err(|e| download_io_error("Failed to flush partial archive", e))?;
    drop(file);
    Ok(())
}

pub async fn download_and_extract_tar_bz2(
    app: AppHandle,
    model_id: &str,
    url: &str,
) -> Result<(), String> {
    let dest_dir = model_dir(model_id);
    let archive_path = dest_dir.with_extension("tar.bz2");
    let temp_path = dest_dir.with_extension("tar.bz2.part");

    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| download_io_error("Failed to create model directory", e))?;

    // funasr-nano: encoder_adaptor.int8.onnx / paraformer: model.int8.onnx / qwen3-asr: encoder.int8.onnx
    if dest_dir.join("encoder_adaptor.int8.onnx").exists()
        || dest_dir.join("model.int8.onnx").exists()
        || dest_dir.join("encoder.int8.onnx").exists()
    {
        emit_progress(&app, model_id, "archive", 1, 1, "completed", None, 1, 1);
        return Ok(());
    }

    let candidates = build_archive_candidates(url);
    let mut last_err = download_error("download_network", "No download source is available");
    let mut ok = false;
    for (idx, cand) in candidates.iter().enumerate() {
        match download_archive_once(&app, model_id, cand, &temp_path).await {
            Ok(()) => { ok = true; break; }
            Err(e) => {
                log::warn!("Archive source {}/{} failed: {}", idx + 1, candidates.len(), e);
                last_err = e;
            }
        }
    }
    if !ok {
        emit_progress(&app, model_id, "archive", 0, 0, "failed", Some(&last_err), 1, 1);
        return Err(last_err);
    }

    std::fs::rename(&temp_path, &archive_path)
        .map_err(|e| download_io_error("Failed to finalize downloaded archive", e))?;

    log::info!("Archive downloaded: {}", model_id);
    emit_progress(&app, model_id, "extracting", 0, 0, "downloading", None, 1, 1);

    let archive_file = std::fs::File::open(&archive_path)
        .map_err(|e| download_io_error("Failed to open downloaded archive", e))?;
    let bz_decoder = bzip2::read::BzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(bz_decoder);

    for entry in archive.entries().map_err(|e| download_error("download_failed", format!("Failed to read archive: {}", e)))? {
        let mut entry = entry.map_err(|e| download_error("download_failed", format!("Failed to read archive entry: {}", e)))?;
        let path = entry.path().map_err(|e| download_error("download_failed", format!("Failed to read archive path: {}", e)))?;
        let path_str = path.to_string_lossy().to_string();

        if path_str.contains("test_wavs/") || path_str.ends_with("README.md") {
            continue;
        }

        let components: Vec<_> = path.components().collect();
        if components.len() <= 1 {
            continue;
        }
        let relative: std::path::PathBuf = components[1..].iter().collect();
        let dest = dest_dir.join(&relative);

        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&dest).ok();
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| download_io_error(&format!("Failed to create extracted file {:?}", relative), e))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| download_io_error(&format!("Failed to extract file {:?}", relative), e))?;
        }
    }

    std::fs::remove_file(&archive_path).ok();

    emit_progress(&app, model_id, "archive", 1, 1, "completed", None, 1, 1);
    log::info!("Archive extracted: {}", model_id);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn unique_test_path(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "sayforge_downloader_{}_{}_{}",
            label,
            std::process::id(),
            nonce
        ))
    }

    fn spawn_http_server(
        responses: Vec<Vec<u8>>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(String::from_utf8_lossy(&request).to_string());
                stream.write_all(&response).unwrap();
                stream.flush().unwrap();
            }
            requests
        });
        (format!("http://{}/model", address), handle)
    }

    fn partial_response(
        start: u64,
        end: u64,
        total: u64,
        etag: &str,
        body: &[u8],
    ) -> Vec<u8> {
        let headers = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: {}\r\nConnection: close\r\n\r\n",
            start,
            end,
            total,
            body.len(),
            etag
        );
        [headers.as_bytes(), body].concat()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn probe_requires_exact_range_and_captures_strong_etag() {
        let (url, server) = spawn_http_server(vec![partial_response(
            0,
            0,
            6,
            "\"model-v1\"",
            b"a",
        )]);
        let probe = probe_url(&build_http_client().unwrap(), &url).await;
        assert!(probe.supports_range);
        assert_eq!(probe.size, 6);
        assert_eq!(probe.strong_etag.as_deref(), Some("\"model-v1\""));

        let requests = server.join().unwrap();
        let request = requests[0].to_ascii_lowercase();
        assert!(request.contains("range: bytes=0-0"));
        assert!(request.contains("accept-encoding: identity"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chunk_resumes_existing_file_and_uses_if_match() {
        let chunk_path = unique_test_path("chunk_resume");
        std::fs::write(&chunk_path, b"ab").unwrap();
        let (url, server) = spawn_http_server(vec![partial_response(
            2,
            5,
            6,
            "\"model-v1\"",
            b"cdef",
        )]);
        let downloaded = Arc::new(AtomicU64::new(2));
        let result = download_chunk(
            build_http_client().unwrap(),
            url,
            chunk_path.clone(),
            ChunkSpec {
                index: 0,
                start: 0,
                end: 5,
            },
            6,
            Some("\"model-v1\"".to_string()),
            Arc::clone(&downloaded),
        )
        .await;
        assert_eq!(result.unwrap(), 0);
        assert_eq!(std::fs::read(&chunk_path).unwrap(), b"abcdef");
        assert_eq!(downloaded.load(Ordering::Relaxed), 6);

        let request = server.join().unwrap()[0].to_ascii_lowercase();
        assert!(request.contains("range: bytes=2-5"));
        assert!(request.contains("if-match: \"model-v1\""));
        std::fs::remove_file(chunk_path).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chunk_rejects_a_changed_response_etag_before_writing() {
        let chunk_path = unique_test_path("chunk_etag_change");
        let (url, server) = spawn_http_server(vec![partial_response(
            0,
            3,
            4,
            "\"model-v2\"",
            b"data",
        )]);
        let error = download_chunk(
            build_http_client().unwrap(),
            url,
            chunk_path.clone(),
            ChunkSpec {
                index: 0,
                start: 0,
                end: 3,
            },
            4,
            Some("\"model-v1\"".to_string()),
            Arc::new(AtomicU64::new(0)),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("sayforge_error:download_source_changed:"));
        assert!(!chunk_path.exists());
        let request = server.join().unwrap()[0].to_ascii_lowercase();
        assert!(request.contains("if-match: \"model-v1\""));
    }

    #[test]
    fn assembly_rewinds_bytes_written_after_the_last_persisted_boundary() {
        let temp_path = unique_test_path("assembly_rewind");
        std::fs::write(&temp_path, b"abcdefEXTRA").unwrap();
        let chunks = vec![
            ChunkSpec {
                index: 0,
                start: 0,
                end: 1,
            },
            ChunkSpec {
                index: 1,
                start: 2,
                end: 3,
            },
            ChunkSpec {
                index: 2,
                start: 4,
                end: 5,
            },
            ChunkSpec {
                index: 3,
                start: 6,
                end: 7,
            },
        ];
        prepare_assembly_file(&temp_path, &chunks, 3).unwrap();
        assert_eq!(std::fs::read(&temp_path).unwrap(), b"abcdef");
        std::fs::remove_file(temp_path).unwrap();
    }

    #[test]
    fn model_path_and_storage_leases_are_mutually_exclusive() {
        let path = unique_test_path("lease");
        let lease = acquire_model_path(&path).unwrap();
        assert!(acquire_model_path(&path).is_err());
        assert!(acquire_model_storage().is_err());
        drop(lease);

        let storage = acquire_model_storage().unwrap();
        assert!(acquire_model_path(&path).is_err());
        drop(storage);
        assert!(acquire_model_path(&path).is_ok());
    }

    #[test]
    fn parallel_state_is_reused_only_for_the_same_representation() {
        let temp_path = unique_test_path("parallel_state");
        let chunks = calculate_chunks(100);
        let state = load_or_create_parallel_state(
            &temp_path,
            100,
            Some("abc"),
            "https://example.test/model",
            Some("\"v1\""),
            &chunks,
        )
        .unwrap();
        assert_eq!(state.phase, ParallelPhase::Downloading);
        let first_chunk = parallel_chunk_path(&temp_path, 0);
        std::fs::write(&first_chunk, b"partial").unwrap();

        let reused = load_or_create_parallel_state(
            &temp_path,
            100,
            Some("abc"),
            "https://example.test/model",
            Some("\"v1\""),
            &chunks,
        )
        .unwrap();
        assert_eq!(reused.strong_etag.as_deref(), Some("\"v1\""));
        assert!(first_chunk.exists());

        let reset = load_or_create_parallel_state(
            &temp_path,
            100,
            Some("abc"),
            "https://example.test/model",
            Some("\"v2\""),
            &chunks,
        )
        .unwrap();
        assert_eq!(reset.strong_etag.as_deref(), Some("\"v2\""));
        assert!(!first_chunk.exists());
        cleanup_parallel_artifacts(
            &temp_path,
            &parallel_state_path(&temp_path),
            &chunks,
        )
        .unwrap();
    }

    #[test]
    fn rejects_catalog_and_remote_size_mismatch_before_downloading() {
        assert_eq!(resolve_download_size(100, 100).unwrap(), 100);
        assert_eq!(resolve_download_size(0, 100).unwrap(), 100);
        assert_eq!(resolve_download_size(100, 0).unwrap(), 100);
        let error = resolve_download_size(100, 99).unwrap_err();
        assert!(error.starts_with("sayforge_error:download_source_mismatch:"));
    }

    #[test]
    fn parses_only_valid_unsatisfied_range_totals() {
        assert_eq!(parse_unsatisfied_range_total(Some("bytes */123")), Some(123));
        assert_eq!(parse_unsatisfied_range_total(Some("bytes 1-2/123")), None);
        assert_eq!(parse_unsatisfied_range_total(Some("bytes */*")), None);
        assert_eq!(parse_unsatisfied_range_total(None), None);
    }

    #[test]
    fn test_calculate_chunks_edge_cases() {
        assert!(calculate_chunks(0).is_empty());

        let chunks = calculate_chunks(100);
        assert!(!chunks.is_empty());
        assert_eq!(chunks.first().unwrap().start, 0);
        assert_eq!(chunks.last().unwrap().end, 99);

        for i in 1..chunks.len() {
            assert_eq!(chunks[i].start, chunks[i - 1].end + 1);
        }
    }

    #[test]
    fn test_calculate_chunks_large_model() {
        let total_size = 500 * 1024 * 1024;
        let chunks = calculate_chunks(total_size);
        assert!(chunks.len() >= 4 && chunks.len() <= 16);
        assert_eq!(chunks.first().unwrap().start, 0);
        assert_eq!(chunks.last().unwrap().end, total_size - 1);

        let mut sum_bytes = 0u64;
        for i in 0..chunks.len() {
            if i > 0 {
                assert_eq!(chunks[i].start, chunks[i - 1].end + 1);
            }
            sum_bytes += chunks[i].end - chunks[i].start + 1;
        }
        assert_eq!(sum_bytes, total_size);
    }

    #[test]
    fn test_validate_range_response_parts_cases() {
        assert!(validate_range_response_parts(
            206,
            Some("bytes 0-99/1000"),
            Some(100),
            0,
            99,
            1000
        ).is_ok());

        assert!(validate_range_response_parts(
            200,
            Some("bytes 0-99/1000"),
            Some(100),
            0,
            99,
            1000
        ).is_err());

        for header in ["bytes 0-99/*", "bytes 0-99/garbage", "bytes 0-99/999"] {
            assert!(validate_range_response_parts(206, Some(header), Some(100), 0, 99, 1000).is_err());
        }

        assert!(validate_range_response_parts(
            206,
            None,
            Some(100),
            0,
            99,
            1000
        ).is_err());

        assert!(validate_range_response_parts(
            206,
            Some("bytes 10-99/1000"),
            Some(90),
            0,
            99,
            1000
        ).is_err());

        assert!(validate_range_response_parts(
            206,
            Some("bytes 0-199/1000"),
            Some(200),
            0,
            99,
            1000
        ).is_err());

        assert!(validate_range_response_parts(
            206,
            Some("bytes 0-99/1000"),
            Some(99),
            0,
            99,
            1000
        ).is_err());
    }

    #[test]
    fn test_is_valid_resume_content_range_rfc9110() {
        assert!(is_valid_resume_content_range(
            Some("bytes 100-999/1000"),
            Some(900),
            100,
            1000
        ));

        assert!(!is_valid_resume_content_range(
            Some("bytes 100-199/1000"),
            Some(100),
            100,
            1000
        ));

        assert!(!is_valid_resume_content_range(None, Some(900), 100, 1000));
        assert!(!is_valid_resume_content_range(Some("invalid-header"), Some(900), 100, 1000));
        assert!(!is_valid_resume_content_range(Some("bytes 100-garbage/1000"), Some(900), 100, 1000));
        assert!(!is_valid_resume_content_range(Some("bytes 100-999/garbage"), Some(900), 100, 1000));

        assert!(!is_valid_resume_content_range(Some("bytes 100-999/*"), Some(900), 100, 0));

        assert!(!is_valid_resume_content_range(Some("bytes 0-999/1000"), Some(1000), 100, 1000));
        assert!(!is_valid_resume_content_range(Some("bytes 50-999/1000"), Some(950), 100, 1000));

        assert!(!is_valid_resume_content_range(
            Some("bytes 100-999/1000"),
            Some(899),
            100,
            1000
        ));
    }

    #[test]
    fn test_single_stream_fallback_classification() {
        assert!(should_fallback_to_single_stream(
            "sayforge_error:download_range_invalid: bad Content-Range"
        ));
        assert!(should_fallback_to_single_stream(
            "sayforge_error:download_source_changed: ETag changed"
        ));
        assert!(should_fallback_to_single_stream(
            "sayforge_error:download_parallel_verify_failed: bytes mismatch"
        ));
        assert!(should_fallback_to_single_stream(
            "sayforge_error:download_checksum: SHA-256 mismatch"
        ));

        assert!(!should_fallback_to_single_stream(
            "sayforge_error:download_network: connection reset"
        ));
        assert!(!should_fallback_to_single_stream(
            "sayforge_error:download_no_space: No space on disk"
        ));
        assert!(!should_fallback_to_single_stream(
            "sayforge_error:download_permission: Access denied"
        ));
    }

    #[test]
    fn test_verify_file_sha256() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("sayforge_test_sha256.tmp");

        std::fs::write(&test_file, b"hello world\n").unwrap();

        assert!(verify_file_sha256(&test_file, "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447").is_ok());
        assert!(verify_file_sha256(&test_file, "A948904F2F0F479B8F8197694B30184B0D2ED1C1CD2A1EC0FB85D299A192A447").is_ok());

        let mismatch_err = verify_file_sha256(&test_file, "0000000000000000000000000000000000000000000000000000000000000000").unwrap_err();
        assert!(is_checksum_error(&mismatch_err));

        let wrapped_err = format!("other_wrapper: {}", mismatch_err);
        assert!(!is_checksum_error(&wrapped_err));

        let mismatch_err = verify_temp_file_sha256(&test_file, "0").unwrap_err();
        assert!(is_checksum_error(&mismatch_err));
        assert!(!test_file.exists());
    }

    #[test]
    fn test_verify_temp_file_sha256_preserves_io_error() {
        let test_dir = std::env::temp_dir().join(format!("sayforge_sha256_dir_{}", std::process::id()));
        std::fs::create_dir(&test_dir).unwrap();

        let err = verify_temp_file_sha256(&test_dir, "0").unwrap_err();
        assert!(!is_checksum_error(&err));
        assert!(test_dir.is_dir());

        std::fs::remove_dir(test_dir).unwrap();
    }

    #[test]
    fn test_inspect_resume_state() {
        let ok_res = Ok(());
        let hash_err = Err("sayforge_error:download_checksum: bad hash".to_string());
        let io_err = Err("sayforge_error:download_permission: Access denied".to_string());

        assert_eq!(inspect_resume_state(1000, 1000, Some(ok_res)).unwrap(), ResumeDecision::Finalize);
        assert_eq!(inspect_resume_state(1000, 1000, None).unwrap(), ResumeDecision::Finalize);

        assert_eq!(inspect_resume_state(1000, 1000, Some(hash_err)).unwrap(), ResumeDecision::Restart);

        assert_eq!(inspect_resume_state(1000, 1000, Some(io_err)).unwrap_err(), "sayforge_error:download_permission: Access denied");

        assert_eq!(inspect_resume_state(1200, 1000, None).unwrap(), ResumeDecision::Restart);

        assert_eq!(inspect_resume_state(500, 1000, None).unwrap(), ResumeDecision::Resume(500));

        assert_eq!(inspect_resume_state(0, 1000, None).unwrap(), ResumeDecision::Resume(0));
    }
}
