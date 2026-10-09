use tauri::Manager;

#[tauri::command]
pub async fn get_test_audio_b64(app_handle: tauri::AppHandle) -> Result<String, String> {
    let resource_path = app_handle.path()
        .resolve("resources/test_en.wav", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Could not locate test audio: {}", e))?;
    let wav_bytes = std::fs::read(&resource_path)
        .map_err(|e| format!("Failed to read test audio: {}", e))?;
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav_bytes))
}
