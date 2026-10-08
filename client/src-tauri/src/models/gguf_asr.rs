//
//

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use transcribe_cpp::{
    Backend, DeviceType, Feature, Itn, Model, ModelOptions, Pnc, RunOptions, Session,
    SessionOptions,
};

use super::downloader::model_dir;

///
pub(crate) struct Loaded {
    model_id: String,
    accelerator: String,
        ///
            gpu_device: String,
        backend: String,
        ///
                        device: Option<String>,
        max_audio_ms: i64,
            supports_itn: bool,
    supports_pnc: bool,
                languages: Vec<String>,
    session: Session,
}

static CACHE: Mutex<Option<Loaded>> = Mutex::new(None);

///
///
static STATUS: Mutex<EngineStatus> = Mutex::new(EngineStatus {
    loading_model: None,
    backend: None,
    device: None,
});

struct EngineStatus {
        loading_model: Option<String>,
        backend: Option<String>,
        device: Option<String>,
}

fn mark_loading(model_id: &str) {
    if let Ok(mut status) = STATUS.lock() {
        status.loading_model = Some(model_id.to_string());
        status.backend = None;
        status.device = None;
    }
}

fn mark_loaded(backend: &str, device: Option<&str>) {
    if let Ok(mut status) = STATUS.lock() {
        status.backend = Some(backend.to_string());
        status.device = device.map(|d| d.to_string());
    }
}

fn mark_unloaded() {
    if let Ok(mut status) = STATUS.lock() {
        status.backend = None;
        status.device = None;
    }
}

struct LoadingGuard;

impl Drop for LoadingGuard {
    fn drop(&mut self) {
        if let Ok(mut status) = STATUS.lock() {
            status.loading_model = None;
        }
    }
}

static INIT: std::sync::Once = std::sync::Once::new();

///
///
///
pub fn init_backends() {
    INIT.call_once(|| {
        transcribe_cpp::init_logging();
        match transcribe_cpp::init_backends_default() {
            Ok(()) => log::info!("transcribe backends registered"),
            Err(e) => log::error!("transcribe backends init failed: {}", e),
        }

        let devices = transcribe_cpp::devices();
        log::info!(
            "transcribe compute devices ({}): [{}]",
            devices.len(),
            devices
                .iter()
                .map(|d| format!("{}:{}", d.kind, d.name))
                .collect::<Vec<_>>()
                .join(", ")
        );
    });
}

#[cfg(test)]
pub fn model_is_downloaded(model_id: &str) -> bool {
    find_gguf(&model_dir(model_id)).is_ok()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GgufDevice {
    /// "cpu" / "vulkan" / …
    pub kind: String,
    pub name: String,
        pub memory_mb: u64,
        ///
                pub id: String,
            pub index: usize,
            pub is_gpu: bool,
}

///
///
///
///
fn resolve_gpu_device(selected: &str, accelerator: &str) -> i32 {
    if selected.is_empty() || selected == "auto" {
        return 0;
    }
    pick_gpu_device_index(&describe_devices(), selected, accelerator)
}

fn pick_gpu_device_index(devices: &[GgufDevice], selected: &str, accelerator: &str) -> i32 {
    if selected.is_empty() || selected == "auto" {
        return 0;
    }
    if accelerator == "cpu" {
        log::warn!(
            "A specific GPU ({}) is selected but the compute backend is set to CPU; ignoring the GPU selection",
            selected
        );
        return 0;
    }
    let Some(dev) = devices.iter().find(|d| d.id == selected) else {
        log::warn!(
            "The selected GPU ({}) is not among the registered compute devices; falling back to automatic selection",
            selected
        );
        return 0;
    };
    if !dev.is_gpu {
        log::warn!(
            "The selected compute device ({}) is not a GPU; falling back to automatic selection",
            dev.name
        );
        return 0;
    }
    if dev.index == 0 {
        log::info!(
            "The selected GPU ({}) sits at registry index 0, which is the automatic sentinel; the library will pick it by probe order",
            dev.name
        );
        return 0;
    }
    log::info!("Requesting GPU device {} ({})", dev.index, dev.name);
    dev.index as i32
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GgufDiagnostics {
    pub devices: Vec<GgufDevice>,
    pub current_backend: Option<String>,
            pub current_device: Option<String>,
            pub loading_model: Option<String>,
    pub native_version: String,
            pub process_memory_mb: u64,
}

#[tauri::command]
pub async fn gguf_asr_diagnostics() -> Result<GgufDiagnostics, String> {
    tokio::task::spawn_blocking(|| GgufDiagnostics {
        devices: describe_devices(),
        current_backend: current_backend(),
        current_device: current_device(),
        loading_model: loading_model(),
        native_version: transcribe_cpp::version(),
        process_memory_mb: process_memory_mb(),
    })
    .await
    .map_err(|e| format!("Failed to read local engine state: {}", e))
}

pub fn process_memory_mb() -> u64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows::Win32::System::Threading::GetCurrentProcess;
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let ok = unsafe {
            GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut counters,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            )
        };
        if ok.is_ok() {
            return (counters.WorkingSetSize / (1024 * 1024)) as u64;
        }
        0
    }
    #[cfg(not(windows))]
    {
        0
    }
}

///
///
pub fn describe_devices() -> Vec<GgufDevice> {
    init_backends();
    transcribe_cpp::devices()
        .into_iter()
        .enumerate()
        .map(|(i, d)| {
            let name = if d.description.is_empty() {
                d.name.clone()
            } else {
                d.description.clone()
            };
            GgufDevice {
                kind: d.kind.to_string(),
                index: d.index.unwrap_or(i),
                is_gpu: matches!(d.device_type, DeviceType::Gpu | DeviceType::Igpu),
                id: d
                    .device_id
                    .clone()
                    .unwrap_or_else(|| format!("{}:{}", d.kind, name)),
                name,
                memory_mb: d.memory_total / (1024 * 1024),
            }
        })
        .collect()
}

fn find_gguf(dir: &Path) -> Result<PathBuf, String> {
    if !dir.exists() {
        return Err("The model has not been downloaded".into());
    }
    let mut hits: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read model directory: {}", e))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("gguf"))
        })
        .collect();
    match hits.len() {
        0 => Err("The model directory contains no .gguf file".into()),
        1 => Ok(hits.remove(0)),
        _ => {
            hits.sort_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0));
            let pick = hits.pop().unwrap();
            log::warn!(
                "The model directory contains multiple .gguf files; selected the largest: {}",
                pick.file_name().unwrap_or_default().to_string_lossy()
            );
            Ok(pick)
        }
    }
}

fn resolve_backend(pref: &str) -> Backend {
    match pref {
        "cpu" => Backend::Cpu,
        "gpu" => {
            for b in [Backend::Cuda, Backend::Vulkan] {
                if transcribe_cpp::backend_available(b) {
                    return b;
                }
            }
            log::warn!("GPU was requested but no GPU backend is available; falling back to Auto");
            Backend::Auto
        }
        _ => Backend::Auto,
    }
}

fn ensure_loaded(model_id: &str, accelerator: &str, gpu_device: &str) -> Result<(), String> {
    //
    init_backends();

    let mut cache = CACHE.lock().map_err(|e| format!("Failed to acquire model cache lock: {}", e))?;

    if let Some(ref c) = *cache {
        if c.model_id == model_id && c.accelerator == accelerator && c.gpu_device == gpu_device {
            touch_activity();
            return Ok(());
        }
    }

    mark_loading(model_id);
    let _loading_guard = LoadingGuard;

    *cache = None;

    let path = find_gguf(&model_dir(model_id))?;
    log::info!("Loading GGUF ASR model: {} ({})", model_id, path.display());
    let start = Instant::now();

    let options = ModelOptions {
        backend: resolve_backend(accelerator),
        gpu_device: resolve_gpu_device(gpu_device, accelerator),
    };
    let model = Model::load_with(&path, &options)
        .map_err(|e| format!("Failed to load model ({}): {}", model_id, e))?;

    let backend = model.backend();
    let device = match model.device() {
        Ok(d) => Some(if d.description.is_empty() {
            d.name
        } else {
            d.description
        }),
        Err(e) => {
            log::warn!("Could not read the bound compute device: {}", e);
            None
        }
    };
    let caps = model.capabilities();
    let arch = model.arch();
    let languages = caps.languages.clone();
    let n_langs = languages.len();
    let supports_itn = model.supports(Feature::Itn);
    let supports_pnc = model.supports(Feature::Pnc);
    let session = model
        .session_with(&SessionOptions::default())
        .map_err(|e| format!("Failed to create session ({}): {}", model_id, e))?;

    let max_audio_ms = session
        .limits()
        .map(|l| l.effective_max_audio_ms)
        .unwrap_or(caps.max_audio_ms);

    let mut entry = Loaded {
        model_id: model_id.to_string(),
        accelerator: accelerator.to_string(),
        gpu_device: gpu_device.to_string(),
        backend,
        device,
        max_audio_ms,
        supports_itn,
        supports_pnc,
        languages,
        session,
    };
    let load_ms = start.elapsed().as_millis();

    let warmup_ms = warmup(&mut entry);

    log::info!(
        "GGUF ASR ready in {}ms (load {}ms + warmup {}ms): {} arch={} backend={} device={} langs={} max_audio_ms={} itn={} pnc={}",
        start.elapsed().as_millis(),
        load_ms,
        warmup_ms,
        model_id,
        arch,
        entry.backend,
        entry.device.as_deref().unwrap_or("unknown"),
        n_langs,
        max_audio_ms,
        supports_itn,
        supports_pnc
    );

    mark_loaded(&entry.backend, entry.device.as_deref());
    *cache = Some(entry);
    touch_activity();
    Ok(())
}

const WARMUP_WAV: &[u8] = include_bytes!("../../resources/test_en.wav");
const WARMUP_SEC: usize = 2;

///
///
fn warmup(entry: &mut Loaded) -> u128 {
    let t0 = Instant::now();
    let pcm: Vec<f32> = WARMUP_WAV
        .get(44..)
        .unwrap_or(&[])
        .chunks_exact(2)
        .take(WARMUP_SEC * 16000)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();
    if pcm.is_empty() {
        return 0;
    }
    let opts = run_options(
        "auto",
        &entry.languages,
        entry.supports_itn,
        entry.supports_pnc,
    );
    if let Err(e) = entry.session.run(&pcm, &opts) {
        log::warn!("Warm-up inference failed; functionality is unaffected, but the first run will be slower: {}", e);
    }
    t0.elapsed().as_millis()
}

///
///
///
fn resolve_language(requested: &str, supported: &[String]) -> Option<String> {
    if matches!(requested, "" | "auto") {
        return None;
    }
    if supported.is_empty() {
        return Some(requested.to_string());
    }
    if let Some(hit) = supported.iter().find(|l| l.eq_ignore_ascii_case(requested)) {
        return Some(hit.clone());
    }
    let prefix = format!("{}-", requested.to_ascii_lowercase());
    if let Some(hit) = supported
        .iter()
        .find(|l| l.to_ascii_lowercase().starts_with(&prefix))
    {
        return Some(hit.clone());
    }
    None
}

///
fn run_options(
    language: &str,
    supported_languages: &[String],
    supports_itn: bool,
    supports_pnc: bool,
) -> RunOptions {
    RunOptions {
        language: resolve_language(language, supported_languages),
        itn: if supports_itn { Itn::On } else { Itn::Default },
        pnc: if supports_pnc { Pnc::On } else { Pnc::Default },
        ..Default::default()
    }
}

fn transcribe_with_cache(
    samples: &[f32],
    sample_rate: usize,
    language: &str,
) -> Result<String, String> {
    let mut cache = CACHE.lock().map_err(|e| format!("Failed to acquire model cache lock: {}", e))?;
    let entry = cache.as_mut().ok_or("Model is not loaded")?;
    let _activity_guard = ActivityGuard;
    touch_activity();
    let opts = run_options(
        language,
        &entry.languages,
        entry.supports_itn,
        entry.supports_pnc,
    );

    let limit = if entry.max_audio_ms > 0 {
        (entry.max_audio_ms as usize / 1000) * sample_rate
    } else {
        usize::MAX
    };

    if samples.len() <= limit {
        return entry
            .session
            .run(samples, &opts)
            .map(|t| t.text.trim().to_string())
            .map_err(|e| format!("Inference failed: {}", e));
    }

    log::warn!(
        "Audio length {:.1}s exceeds the model limit {:.1}s; decoding in segments",
        samples.len() as f64 / sample_rate as f64,
        limit as f64 / sample_rate as f64
    );
    let mut out = String::new();
    for chunk in samples.chunks(limit) {
        let text = entry
            .session
            .run(chunk, &opts)
            .map_err(|e| format!("Inference failed: {}", e))?;
        let t = text.text.trim();
        if t.is_empty() {
            continue;
        }
        if !out.is_empty() && !out.ends_with(|c: char| "，。！？、,.!?".contains(c)) {
            out.push(' ');
        }
        out.push_str(t);
    }
    Ok(out)
}


pub fn preload(model_id: &str, accelerator: &str, gpu_device: &str) -> Result<(), String> {
    ensure_loaded(model_id, accelerator, gpu_device)
}

pub fn unload() {
    if let Ok(mut cache) = CACHE.lock() {
        if let Some(entry) = cache.take() {
            log::info!("Unloading GGUF ASR model: {}", entry.model_id);
        }
    }
    mark_unloaded();
}

pub fn current_backend() -> Option<String> {
    STATUS.lock().ok().and_then(|s| s.backend.clone())
}

pub fn current_device() -> Option<String> {
    STATUS.lock().ok().and_then(|s| s.device.clone())
}

pub fn loading_model() -> Option<String> {
    STATUS.lock().ok().and_then(|s| s.loading_model.clone())
}

pub fn transcribe(
    model_id: &str,
    language: &str,
    accelerator: &str,
    gpu_device: &str,
    samples: &[f32],
    sample_rate: usize,
) -> Result<String, String> {
    ensure_loaded(model_id, accelerator, gpu_device)?;
    transcribe_with_cache(samples, sample_rate, language)
}


static LAST_USE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn touch_activity() {
    LAST_USE_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
}

struct ActivityGuard;

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        touch_activity();
    }
}

static IDLE_UNLOAD_MINUTES: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
static IDLE_UNLOADER_STARTED: std::sync::Once = std::sync::Once::new();

pub fn set_idle_unload_minutes(idle_minutes: u64) {
    IDLE_UNLOAD_MINUTES.store(idle_minutes, std::sync::atomic::Ordering::SeqCst);
    if idle_minutes == 0 {
        log::info!("Local model idle unload is disabled; the model will remain in memory");
    } else {
        log::info!("Local model idle unload interval set to {} minutes", idle_minutes);
    }
}

///
pub fn spawn_idle_unloader(initial_idle_minutes: u64) {
    set_idle_unload_minutes(initial_idle_minutes);
    IDLE_UNLOADER_STARTED.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            if IDLE_UNLOAD_MINUTES.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                continue;
            }

            let mut cache = match CACHE.lock() {
                Ok(cache) => cache,
                Err(error) => {
                    log::warn!("Failed to acquire lock during local model idle check: {}", error);
                    continue;
                }
            };
            let idle_minutes =
                IDLE_UNLOAD_MINUTES.load(std::sync::atomic::Ordering::SeqCst);
            if idle_minutes == 0 {
                continue;
            }
            let idle_ms = idle_minutes.saturating_mul(60).saturating_mul(1000);
            if cache.is_none() {
                continue;
            }

            let last = LAST_USE_MS.load(std::sync::atomic::Ordering::Relaxed);
            if last == 0 || now_ms().saturating_sub(last) < idle_ms {
                continue;
            }

            if let Some(entry) = cache.take() {
                log::info!(
                    "Local model was idle for {} minutes; unloaded to free memory: {}",
                    idle_minutes,
                    entry.model_id
                );
                mark_unloaded();
            }
        });
    });
}


#[cfg(test)]
mod tests {
    use super::*;

    const SR_U: usize = 16000;

        fn read_wav(name: &str) -> Vec<f32> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(name);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("resources/{name}: {e}"));
        assert_eq!(&bytes[0..4], b"RIFF");
        bytes[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect()
    }

    fn read_test_wav() -> Vec<f32> {
        read_wav("test_en.wav")
    }

                fn read_test_en_wav() -> Vec<f32> {
        read_wav("test_en.wav")
    }

        fn model_present(model_id: &str) -> bool {
        find_gguf(&model_dir(model_id)).is_ok()
    }

    fn run(model_id: &str, repeats: usize) -> String {
        run_with(model_id, repeats, read_test_wav(), "auto")
    }

            fn run_with(model_id: &str, repeats: usize, base: Vec<f32>, language: &str) -> String {
        init_backends();
        assert!(
            !transcribe_cpp::devices().is_empty(),
            "没有注册到任何计算设备：DLL 没放到 exe 旁边？"
        );
        let mut pcm = Vec::with_capacity(base.len() * repeats);
        for _ in 0..repeats {
            pcm.extend_from_slice(&base);
        }
        transcribe(model_id, language, "auto", "", &pcm, SR_U).expect("转写失败")
    }

            ///
            #[test]
    fn parakeet_en_gguf_is_punctuated_and_capitalized() {
        let id = "parakeet-unified-en-0.6b-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        let text = run_with(id, 1, read_test_en_wav(), "en");
        eprintln!("[text] {id}: {text}");
        assert!(!text.trim().is_empty(), "{id} 输出为空");
        assert!(!text.contains("<|") && !text.contains('<'), "残留特殊标签: {text:?}");
        assert!(
            text.contains('.') || text.contains(','),
            "{id} 英文输出没有标点: {text:?}"
        );
        assert!(
            text.chars().any(|c| c.is_ascii_uppercase()),
            "{id} 输出没有大写字母，capitalization 失效？: {text:?}"
        );
        unload();
    }

        ///
                    #[test]
    fn nemotron_gguf_accepts_a_bare_language_code() {
        let id = "nemotron-asr-streaming-0.6b-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        let text = run_with(id, 1, read_test_en_wav(), "en");
        eprintln!("[text] {id} (language=en): {text}");
        assert!(
            !text.trim().is_empty(),
            "{id} 在 language=en 下输出为空 —— locale 映射可能失效了"
        );
        assert!(!text.contains('<') && !text.contains('>'), "残留语种标签: {text:?}");
        unload();
    }

            #[test]
    fn itn_is_only_requested_when_the_family_supports_it() {
        let supported = run_options("auto", &[], true, false);
        assert_eq!(supported.itn, Itn::On);
        assert_eq!(supported.pnc, Pnc::Default);

        let unsupported = run_options("auto", &[], false, false);
        assert_eq!(unsupported.itn, Itn::Default);
        assert_eq!(unsupported.pnc, Pnc::Default);
    }

        fn bare_codes() -> Vec<String> {
        ["zh", "yue", "en", "ja", "ko"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

            fn nemotron_locales() -> Vec<String> {
        ["en-US", "en-GB", "de-DE", "ja-JP", "ko-KR", "zh-CN"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn auto_language_means_autodetect() {
        let langs = bare_codes();
        assert!(run_options("auto", &langs, false, false).language.is_none());
        assert!(run_options("", &langs, false, false).language.is_none());
        assert_eq!(
            run_options("zh", &langs, false, false).language.as_deref(),
            Some("zh")
        );
    }

            #[test]
    fn bare_language_codes_pass_through_unchanged() {
        let langs = bare_codes();
        for code in ["zh", "en", "ja", "ko", "yue"] {
            assert_eq!(
                resolve_language(code, &langs).as_deref(),
                Some(code),
                "{code} 在裸码族上不该被改写"
            );
        }
    }

                #[test]
    fn bare_code_maps_to_the_models_regional_locale() {
        let langs = nemotron_locales();
        assert_eq!(resolve_language("en", &langs).as_deref(), Some("en-US"));
        assert_eq!(resolve_language("zh", &langs).as_deref(), Some("zh-CN"));
        assert_eq!(resolve_language("ja", &langs).as_deref(), Some("ja-JP"));
        assert_eq!(resolve_language("ko", &langs).as_deref(), Some("ko-KR"));
        assert_eq!(resolve_language("EN", &langs).as_deref(), Some("en-US"));
    }

            #[test]
    fn unsupported_language_falls_back_to_autodetect() {
        let english_only = vec!["en".to_string()];
        assert_eq!(resolve_language("en", &english_only).as_deref(), Some("en"));
        assert!(resolve_language("zh", &english_only).is_none());
        assert!(resolve_language("ko", &english_only).is_none());
    }

        #[test]
    fn empty_language_list_passes_the_request_through() {
        assert_eq!(resolve_language("zh", &[]).as_deref(), Some("zh"));
        assert!(resolve_language("auto", &[]).is_none());
    }

    //

        fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

                #[test]
    fn startup_path_does_not_register_compute_backends() {
        let main_rs = strip_line_comments(include_str!("../main.rs"));
        assert!(
            !main_rs.contains("init_backends"),
            "main.rs 又在启动路径上注册计算后端了。这会 dlopen ggml-vulkan.dll 并建出\n\
             Vulkan 上下文，云 API / 服务器模式的用户白付显存与启动时间。\n\
             注册应当只发生在 gguf_asr 的懒路径（ensure_loaded / describe_devices）。"
        );
    }

            #[test]
    fn lazy_entry_points_register_compute_backends() {
        let source = strip_line_comments(include_str!("gguf_asr.rs"));
        for (entry, signature) in [
            (
                "ensure_loaded",
                "fn ensure_loaded(model_id: &str, accelerator: &str, gpu_device: &str)",
            ),
            ("describe_devices", "pub fn describe_devices()"),
        ] {
            let body_start = source
                .find(signature)
                .unwrap_or_else(|| panic!("{entry} 的签名变了，请同步更新这条测试"));
            let head = &source[body_start..(body_start + 700).min(source.len())];
            assert!(
                head.contains("init_backends()"),
                "{entry} 没有先调用 init_backends()。启动路径上已经不注册了，\n\
                 这里少一步就会让本地模式报 TRANSCRIBE_ERR_BACKEND / 设备列表空白。"
            );
        }
    }

            fn fake_devices() -> Vec<GgufDevice> {
        vec![
            GgufDevice {
                kind: "vulkan".into(),
                name: "Integrated Graphics".into(),
                memory_mb: 2048,
                id: "PCI:0000:00:02.0".into(),
                index: 0,
                is_gpu: true,
            },
            GgufDevice {
                kind: "vulkan".into(),
                name: "Discrete GPU".into(),
                memory_mb: 8192,
                id: "PCI:0000:01:00.0".into(),
                index: 1,
                is_gpu: true,
            },
            GgufDevice {
                kind: "cpu".into(),
                name: "CPU".into(),
                memory_mb: 32768,
                id: "cpu:CPU".into(),
                index: 2,
                is_gpu: false,
            },
        ]
    }

            #[test]
    fn selecting_a_secondary_gpu_yields_its_registry_index() {
        assert_eq!(
            pick_gpu_device_index(&fake_devices(), "PCI:0000:01:00.0", "auto"),
            1
        );
        assert_eq!(
            pick_gpu_device_index(&fake_devices(), "PCI:0000:01:00.0", "gpu"),
            1
        );
    }

                #[test]
    fn invalid_or_unavailable_selections_fall_back_to_automatic() {
        let devs = fake_devices();
        assert_eq!(pick_gpu_device_index(&devs, "", "auto"), 0);
        assert_eq!(pick_gpu_device_index(&devs, "auto", "auto"), 0);
        assert_eq!(pick_gpu_device_index(&devs, "PCI:0000:09:00.0", "auto"), 0);
        assert_eq!(pick_gpu_device_index(&devs, "cpu:CPU", "auto"), 0);
        assert_eq!(pick_gpu_device_index(&devs, "PCI:0000:01:00.0", "cpu"), 0);
    }

                    #[test]
    fn registry_index_zero_is_the_automatic_sentinel() {
        assert_eq!(
            pick_gpu_device_index(&fake_devices(), "PCI:0000:00:02.0", "auto"),
            0
        );
    }

            #[test]
    fn warmup_wav_yields_usable_pcm() {
        let n = WARMUP_WAV
            .get(44..)
            .unwrap_or(&[])
            .chunks_exact(2)
            .take(WARMUP_SEC * 16000)
            .count();
        assert!(
            n >= 16000,
            "预热音频只解析出 {n} 个样本（不足 1 秒），include_bytes! 路径或资源文件有问题"
        );
    }

            #[test]
    fn first_transcribe_after_load_is_not_slower_than_the_second() {
        let id = "nemotron-asr-streaming-0.6b-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        unload();
        let base = read_test_wav();

        let t_load = std::time::Instant::now();
        let _ = transcribe(id, "auto", "auto", "", &base, SR_U).expect("转写失败");
        let load_and_first = t_load.elapsed().as_secs_f64();

        let t1 = std::time::Instant::now();
        let _ = transcribe(id, "auto", "auto", "", &base, SR_U).expect("转写失败");
        let first = t1.elapsed().as_secs_f64();

        let t2 = std::time::Instant::now();
        let _ = transcribe(id, "auto", "auto", "", &base, SR_U).expect("转写失败");
        let second = t2.elapsed().as_secs_f64();

        eprintln!(
            "[perf] {id}: load+warmup+run={load_and_first:.3}s then {first:.3}s / {second:.3}s"
        );
        assert!(
            first < second * 3.0 + 0.3,
            "加载后的第一次解码 {first:.3}s 远慢于第二次 {second:.3}s，预热没生效？"
        );
        unload();
    }

        ///
                #[test]
    fn report_backend_and_rtf() {
        let ids = ALL_MODELS;
        let base = read_test_wav();
        let repeats = 3;
        let audio_sec = (base.len() * repeats) as f64 / SR_U as f64;

        for id in ids {
            if !model_present(id) {
                eprintln!("skip: {id} 未下载");
                continue;
            }
            let _ = run(id, repeats);
            let t0 = std::time::Instant::now();
            let text = run(id, repeats);
            let secs = t0.elapsed().as_secs_f64();
            let rtf = secs / audio_sec;
            eprintln!(
                "[perf] {id}: backend={} {:.3}s rtf={:.3} audio={:.2}s text_len={}",
                current_backend().unwrap_or_else(|| "?".into()),
                secs,
                rtf,
                audio_sec,
                text.chars().count()
            );
            assert!(
                rtf < 2.0,
                "{id} 的 RTF {rtf:.3} 异常高（backend={:?}）",
                current_backend()
            );
            unload();
        }
    }

        ///
            #[test]
    fn forcing_cpu_binds_cpu_even_when_a_gpu_exists() {
        let id = "nemotron-asr-streaming-0.6b-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        init_backends();
        let has_gpu = transcribe_cpp::devices().iter().any(|d| d.kind != "cpu");
        eprintln!("[info] GPU 设备存在: {has_gpu}");

        let base = read_test_wav();
        let text = transcribe(id, "auto", "cpu", "", &base, SR_U).expect("转写失败");
        assert!(!text.trim().is_empty(), "强制 CPU 后输出为空");
        let backend = current_backend().unwrap_or_default();
        assert!(
            backend.to_lowercase().contains("cpu"),
            "设置要求 CPU，实际绑定到了 {backend:?}"
        );
        unload();
    }

    //
    //
    //   cargo test --release footprint_report -- --ignored --nocapture --test-threads=1
    //   cargo test --release decode_knobs_report -- --ignored --nocapture --test-threads=1

    const ALL_MODELS: [&str; 2] = [
        "parakeet-unified-en-0.6b-gguf",
        "nemotron-asr-streaming-0.6b-gguf",
    ];

            #[test]
    #[ignore]
    fn footprint_report() {
        init_backends();
        let base = read_test_wav();
        for id in ALL_MODELS {
            if !model_present(id) {
                eprintln!("skip: {id} 未下载");
                continue;
            }
            unload();
            std::thread::sleep(std::time::Duration::from_secs(2));
            let before = process_memory_mb();
            transcribe(id, "auto", "auto", "", &base, SR_U).expect("转写失败");
            let after = process_memory_mb();
            let limits = CACHE
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|e| e.session.limits().ok());
            eprintln!(
                "[mem] {id}: {before} MB -> {after} MB (delta {} MB) limits={:?}",
                after.saturating_sub(before),
                limits
            );
        }
        unload();
    }

        ///
                    #[test]
    #[ignore]
    fn new_family_probe() {
        init_backends();
        let base = read_test_wav();
        let mut pcm = Vec::new();
        for _ in 0..3 {
            pcm.extend_from_slice(&base);
        }
        let audio_sec = pcm.len() as f64 / SR_U as f64;

        for dir in ["nemotron-asr-streaming-0.6b-gguf"] {
            let path = match find_gguf(&model_dir(dir)) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("skip: {dir} ({e})");
                    continue;
                }
            };
            let t_load = std::time::Instant::now();
            let model = Model::load_with(
                &path,
                &ModelOptions {
                    backend: Backend::Auto,
                    gpu_device: 0,
                },
            )
            .expect("加载失败");
            let load_ms = t_load.elapsed().as_millis();
            let caps = model.capabilities();
            eprintln!(
                "[probe] {dir}: arch={} variant={} backend={} load={load_ms}ms itn={} pnc={} \
                 lang_detect={} n_langs={} max_ts={:?} max_audio={:.1}min",
                model.arch(),
                model.variant(),
                model.backend(),
                model.supports(Feature::Itn),
                model.supports(Feature::Pnc),
                caps.supports_language_detect,
                caps.languages.len(),
                caps.max_timestamp_kind,
                caps.max_audio_ms as f64 / 60_000.0,
            );

            let mut s = model.session().expect("session 失败");
            for lang in [None, Some("ru")] {
                let opts = RunOptions {
                    language: lang.map(str::to_string),
                    ..Default::default()
                };
                let _ = s.run(&pcm, &opts);
                let mem = process_memory_mb();
                let t = std::time::Instant::now();
                match s.run(&pcm, &opts) {
                    Ok(tr) => eprintln!(
                        "[probe] {dir} lang={lang:?}: rtf={:.3} mem={mem}MB detected={:?} text={}",
                        t.elapsed().as_secs_f64() / audio_sec,
                        tr.language,
                        tr.text.trim()
                    ),
                    Err(e) => eprintln!("[probe] {dir} lang={lang:?}: 失败 {e}"),
                }
            }
        }
    }


}
