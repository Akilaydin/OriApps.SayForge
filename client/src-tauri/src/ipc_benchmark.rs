// Isolated WebView2/Tauri benchmark. No app storage, microphone, network or API keys.
use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use tauri::{Manager, Runtime};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

struct FixtureAssets;
impl<R: Runtime> tauri::Assets<R> for FixtureAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        (key.as_ref() == "/index.html").then_some(Cow::Borrowed(b"<!doctype html><html><head><title>IPC fixture</title></head><body></body></html>"))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> { Box::new(std::iter::empty()) }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> { Box::new(std::iter::empty()) }
}

#[tauri::command]
fn benchmark_receive(request: tauri::ipc::Request<'_>) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let received_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
    let decode_start = std::time::Instant::now();
    let pcm = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Cow::Borrowed(bytes.as_slice()),
        tauri::ipc::InvokeBody::Json(json) => Cow::Owned(base64::engine::general_purpose::STANDARD
            .decode(json["request"]["audio_b64"].as_str().ok_or("Missing synthetic audio")?).map_err(|e| e.to_string())?),
    };
    let decode_ms = decode_start.elapsed().as_secs_f64() * 1000.0;
    let checksum: u64 = pcm.iter().map(|byte| *byte as u64).sum();
    Ok(serde_json::json!({"received_ms":received_ms,"bytes":pcm.len(),"checksum":checksum,"decode_ms":decode_ms}))
}

type Report = Arc<Mutex<Option<serde_json::Value>>>;
#[tauri::command]
fn benchmark_finish(report: serde_json::Value, state: tauri::State<Report>, app: tauri::AppHandle) {
    *state.lock().unwrap() = Some(report);
    app.exit(0);
}

#[test]
#[ignore = "launches an isolated hidden Windows WebView2; synthetic data only"]
fn benchmark_windows_audio_ipc() {
    let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.git/ipc-benchmark.json");
    let profile = output.parent().unwrap().join(format!("ipc-webview-{}", uuid::Uuid::new_v4()));
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", super::WEBVIEW2_BROWSER_ARGS);
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    context.config_mut().identifier = "com.oriapps.sayforge.ipc-benchmark".to_string();
    context.set_assets(Box::new(FixtureAssets));
    let report: Report = Arc::new(Mutex::new(None));
    let shared = report.clone();
    let encoder = include_str!("../../src/lib/encoding.ts").replace("export function", "function")
        .replace("bytes: Uint8Array", "bytes").replace("): string", ")");
    let modes = match std::env::var("SAYFORGE_IPC_BENCH_MODE").as_deref() {
        Ok("base64") => vec!["base64"], Ok("chunked") => vec!["chunked"], Ok("binary") => vec!["binary"],
        _ => vec!["base64", "chunked", "binary"],
    };
    let script = format!("const benchmarkModes = {};\n{encoder}\n{}", serde_json::to_string(&modes).unwrap(), include_str!("ipc_benchmark.js"));
    let app = tauri::Builder::default().any_thread().manage(shared)
        .invoke_handler(tauri::generate_handler![benchmark_receive, benchmark_finish])
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .visible(false).data_directory(profile).initialization_script(script).build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(45)); handle.exit(2); });
            Ok(())
        }).build(context).expect("isolated benchmark app");
    let exit = app.run_return(|_, _| {});
    let result = report.lock().unwrap().take().expect("WebView2 did not return a report");
    assert_eq!(exit, 0);
    assert!(result.get("error").is_none(), "{result}");
    std::fs::write(output, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
}
