use serde_json::Value;
use tauri::State;
use crate::storage::Storage;

#[tauri::command]
pub fn store_get(key: String, storage: State<Storage>) -> Result<Value, String> {
    read_setting(&storage, &key)
}

fn read_setting(storage: &Storage, key: &str) -> Result<Value, String> {
    storage.try_get(key, None).map_err(|error| storage_error("store_get", error))
}

fn storage_error(operation: &str, error: rusqlite::Error) -> String {
    use rusqlite::{Error, ErrorCode};
    let (code, detail) = match &error {
        Error::SqliteFailure(failure, message) => {
            let code = match failure.code {
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => "storage_locked",
                ErrorCode::PermissionDenied | ErrorCode::ReadOnly => "storage_readonly",
                ErrorCode::DiskFull => "storage_no_space",
                ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => "storage_invalid_data",
                _ if message.as_deref().is_some_and(|message| message.starts_with("no such table") || message.starts_with("no such column")) => "storage_invalid_data",
                _ => "storage_failed",
            };
            (code, format!("sqlite_code={:?} extended_code={}", failure.code, failure.extended_code))
        }
        Error::FromSqlConversionFailure(_, _, cause) => {
            let detail = cause.downcast_ref::<serde_json::Error>()
                .map(|error| format!("kind=invalid_json line={} column={}", error.line(), error.column()))
                .unwrap_or_else(|| "kind=conversion_failure".to_string());
            ("storage_invalid_data", detail)
        }
        _ => ("storage_failed", "kind=local_storage_failure".to_string()),
    };
    // Never include setting keys/values, transcripts, SQL parameters or exception payloads.
    log::error!("[storage] operation={} code={} {}", operation, code, detail);
    crate::error_protocol::encode(code, detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_setting_read_is_not_treated_as_a_missing_setting() {
        let storage = Storage { db: std::sync::Mutex::new(rusqlite::Connection::open_in_memory().unwrap()) };
        assert!(read_setting(&storage, "synthetic-key").is_err());
    }

    #[test]
    fn missing_settings_keep_defaults_and_corrupt_values_report_without_their_contents() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER)").unwrap();
        let storage = Storage { db: std::sync::Mutex::new(db) };
        assert_eq!(read_setting(&storage, "missing").unwrap(), Value::Null);
        assert_eq!(read_setting(&storage, "shortcutPTT").unwrap(), serde_json::json!("ControlRight"));
        storage.db.lock().unwrap().execute("INSERT INTO app_settings VALUES ('synthetic-key', 'SYNTHETIC_PRIVATE_VALUE', 0)", []).unwrap();
        let error = read_setting(&storage, "synthetic-key").unwrap_err();
        assert_eq!(crate::error_protocol::code(&error), Some("storage_invalid_data"));
        assert!(!error.contains("SYNTHETIC_PRIVATE_VALUE"));
        assert!(!error.contains("synthetic-key"));
    }

    #[test]
    fn history_query_failures_and_readonly_writes_return_actionable_codes() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER); PRAGMA query_only=ON;").unwrap();
        let storage = Storage { db: std::sync::Mutex::new(db) };
        assert!(storage.try_history_list(None, false, None, None).is_err());
        assert!(storage.try_history_count(None, false).is_err());
        let error = storage_error("store_set", storage.set("synthetic-key", &serde_json::json!("SYNTHETIC_PRIVATE_VALUE")).unwrap_err());
        assert_eq!(crate::error_protocol::code(&error), Some("storage_readonly"));
        assert!(!error.contains("SYNTHETIC_PRIVATE_VALUE"));
    }
}

#[tauri::command]
pub fn store_get_settings(keys: Vec<String>, storage: State<Storage>) -> Result<Value, String> {
    storage.get_settings(&keys).map_err(|error| storage_error("store_get_settings", error))
}

#[tauri::command]
pub fn store_set(key: String, value: Value, storage: State<Storage>) -> Result<(), String> {
    storage.set(&key, &value).map_err(|error| storage_error("store_set", error))
}

#[tauri::command]
pub fn store_delete(key: String, storage: State<Storage>) -> Result<(), String> {
    storage.delete(&key).map_err(|error| storage_error("store_delete", error))
}

#[tauri::command]
pub fn history_list(query: Option<Value>, storage: State<Storage>) -> Result<Vec<Value>, String> {
    let (keyword, favorite_only, limit, offset) = parse_history_query(&query);
    storage.try_history_list(keyword.as_deref(), favorite_only, limit, offset)
        .map_err(|error| storage_error("history_list", error))
}

#[tauri::command]
pub fn history_count(query: Option<Value>, storage: State<Storage>) -> Result<i64, String> {
    let (keyword, favorite_only, _, _) = parse_history_query(&query);
    storage.try_history_count(keyword.as_deref(), favorite_only)
        .map_err(|error| storage_error("history_count", error))
}

#[tauri::command]
pub fn history_add(record: Value, storage: State<Storage>) -> Result<(), String> {
    storage.history_add(&record).map_err(|error| storage_error("history_add", error))
}

#[tauri::command]
pub fn history_update(id: String, patch: Value, storage: State<Storage>) -> Result<(), String> {
    storage.history_update(&id, &patch).map_err(|error| storage_error("history_update", error))
}

#[tauri::command]
pub fn history_delete(id: String, storage: State<Storage>) -> Result<(), String> {
    storage.history_delete(&id).map_err(|error| storage_error("history_delete", error))
}

fn parse_history_query(query: &Option<Value>) -> (Option<String>, bool, Option<i64>, Option<i64>) {
    match query {
        Some(v) => {
            let keyword = v.get("keyword").and_then(|k| k.as_str()).map(|s| s.to_string());
            let favorite_only = v.get("favoriteOnly").and_then(|f| f.as_bool()).unwrap_or(false);
            let limit = v.get("limit").and_then(|l| l.as_i64());
            let offset = v.get("offset").and_then(|o| o.as_i64());
            (keyword, favorite_only, limit, offset)
        }
        None => (None, false, None, None),
    }
}
