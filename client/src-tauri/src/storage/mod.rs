use rusqlite::{params, Connection, Result as SqlResult};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Default settings values (mirrors electron-app/electron/store.ts)
const DEFAULT_SETTINGS: &[(&str, &str)] = &[
    ("shortcutPTT", r#""ControlRight""#),
    ("shortcutPTTCombo", r#""Alt+Q""#),
    ("shortcutHandsFree", r#""AltRight""#),
    ("shortcutToggleAi", r#""""#),
    ("autoLaunch", "true"),
    ("selectedMic", r#""""#),
    ("hotwords", "[]"),
    ("builtinHotwordSets", r#"{"ai":false}"#),
    ("stats", r#"{"totalDurationSec":0,"totalChars":0}"#),
    ("activePresetId", r#""intent""#),
];

/// Collection keys that map to dedicated tables instead of app_settings
const COLLECTION_KEYS: &[&str] = &[
    "history",
    "manualCorrections",
    "feedbackQueue",
    "promptPresets",
    "appPromptRules",
];

fn is_collection_key(key: &str) -> bool {
    COLLECTION_KEYS.contains(&key)
}

fn collection_table(key: &str) -> Option<&'static str> {
    match key {
        "history" => Some("history_records"),
        "manualCorrections" => Some("manual_corrections"),
        "feedbackQueue" => Some("feedback_queue"),
        "promptPresets" => Some("prompt_presets"),
        "appPromptRules" => Some("app_prompt_rules"),
        _ => None,
    }
}

pub struct Storage {
    pub db: Mutex<Connection>,
}

impl Storage {
    pub fn new(db_path: PathBuf) -> SqlResult<Self> {
        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;

        let storage = Self { db: Mutex::new(conn) };
        storage.apply_migrations()?;
        storage.seed_defaults()?;
        Ok(storage)
    }

    fn apply_migrations(&self) -> SqlResult<()> {
        let db = self.db.lock().unwrap();

        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            )"
        )?;

        // Migration 1: init
        if !Self::migration_exists(&db, 1)? {
            db.execute_batch(include_str!("migration_001.sql"))?;
            db.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![1, "init-sqlite-storage", chrono::Utc::now().timestamp_millis()],
            )?;
        }

        // Migration 2: add audio_file_path
        if !Self::migration_exists(&db, 2)? {
            db.execute_batch("ALTER TABLE history_records ADD COLUMN audio_file_path TEXT;")?;
            db.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![2, "add-audio-file-path", chrono::Utc::now().timestamp_millis()],
            )?;
        }

        Ok(())
    }

    fn migration_exists(db: &Connection, version: i64) -> SqlResult<bool> {
        let count: i64 = db.query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
            params![version],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    fn seed_defaults(&self) -> SqlResult<()> {
        let db = self.db.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();

        for &(key, value_json) in DEFAULT_SETTINGS {
            let exists: bool = db.query_row(
                "SELECT COUNT(*) > 0 FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )?;
            if !exists {
                db.execute(
                    "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
                    params![key, value_json, now],
                )?;
            }
        }
        Ok(())
    }

    // ─── Get / Set / Delete ───

    pub fn get(&self, key: &str, fallback: Option<&Value>) -> Value {
        if is_collection_key(key) {
            return self.read_collection(key).unwrap_or(Value::Array(vec![]));
        }

        let db = self.db.lock().unwrap();
        let result: Option<String> = db
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok();

        match result {
            Some(json_str) => serde_json::from_str(&json_str).unwrap_or_else(|_| {
                fallback.cloned().unwrap_or(Value::Null)
            }),
            None => {
                // Check defaults
                for &(k, v) in DEFAULT_SETTINGS {
                    if k == key {
                        return serde_json::from_str(v).unwrap_or(Value::Null);
                    }
                }
                fallback.cloned().unwrap_or(Value::Null)
            }
        }
    }

    pub fn set(&self, key: &str, value: &Value) -> SqlResult<()> {
        if is_collection_key(key) {
            let items = match value {
                Value::Array(arr) => arr.clone(),
                _ => vec![],
            };
            return self.replace_collection(key, &items);
        }

        let db = self.db.lock().unwrap();
        let json_str = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
        let now = chrono::Utc::now().timestamp_millis();

        db.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, json_str, now],
        )?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> SqlResult<()> {
        let db = self.db.lock().unwrap();
        if let Some(table) = collection_table(key) {
            db.execute(&format!("DELETE FROM {}", table), [])?;
        } else {
            db.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
        }
        Ok(())
    }

    // ─── History ───

    pub fn history_list(&self, keyword: Option<&str>, favorite_only: bool, limit: Option<i64>, offset: Option<i64>) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let mut where_clauses = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if favorite_only {
            where_clauses.push("favorite = 1".to_string());
        }
        if let Some(kw) = keyword {
            let trimmed = kw.trim().to_lowercase();
            if !trimmed.is_empty() {
                where_clauses.push(format!("LOWER(raw_json) LIKE ?{}", param_values.len() + 1));
                param_values.push(Box::new(format!("%{}%", trimmed)));
            }
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let limit_sql = match limit {
            Some(l) if l > 0 => {
                let off = offset.unwrap_or(0).max(0);
                format!(" LIMIT {} OFFSET {}", l, off)
            }
            _ => String::new(),
        };

        let sql = format!(
            "SELECT raw_json FROM history_records {} ORDER BY list_order ASC{}",
            where_sql, limit_sql
        );

        let params_ref: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let mut stmt = db.prepare(&sql).unwrap();
        let rows = stmt
            .query_map(params_ref.as_slice(), |row| {
                let json_str: String = row.get(0)?;
                Ok(json_str)
            })
            .unwrap();

        rows.filter_map(|r| r.ok())
            .filter_map(|s| serde_json::from_str(&s).ok())
            .collect()
    }

    pub fn history_count(&self, keyword: Option<&str>, favorite_only: bool) -> i64 {
        let db = self.db.lock().unwrap();
        let mut where_clauses = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if favorite_only {
            where_clauses.push("favorite = 1".to_string());
        }
        if let Some(kw) = keyword {
            let trimmed = kw.trim().to_lowercase();
            if !trimmed.is_empty() {
                where_clauses.push(format!("LOWER(raw_json) LIKE ?{}", param_values.len() + 1));
                param_values.push(Box::new(format!("%{}%", trimmed)));
            }
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let sql = format!("SELECT COUNT(*) FROM history_records {}", where_sql);
        let params_ref: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();

        db.query_row(&sql, params_ref.as_slice(), |row| row.get(0)).unwrap_or(0)
    }

    pub fn history_add(&self, record: &Value) -> SqlResult<()> {
        let db = self.db.lock().unwrap();

        db.execute("UPDATE history_records SET list_order = list_order + 1", [])?;

        let obj = record.as_object().cloned().unwrap_or_default();
        let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("unknown");
        let timestamp = obj.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        let favorite = obj.get("favorite").and_then(|v| v.as_bool()).unwrap_or(false);
        let char_count = obj.get("charCount").and_then(|v| v.as_i64()).unwrap_or(0);
        let duration_sec = obj.get("durationSec").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let is_empty = obj.get("isEmpty").and_then(|v| v.as_bool()).unwrap_or(false);
        let app_id = obj.get("appId").and_then(|v| v.as_str());
        let app_name = obj.get("appName").and_then(|v| v.as_str());
        let audio_file_path = obj.get("audioFilePath").and_then(|v| v.as_str());
        let raw_json = serde_json::to_string(record).unwrap_or_else(|_| "{}".to_string());

        db.execute(
            "INSERT INTO history_records (id, list_order, timestamp, favorite, char_count, duration_sec, is_empty, app_id, app_name, audio_file_path, raw_json)
             VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, timestamp, favorite as i32, char_count, duration_sec, is_empty as i32, app_id, app_name, audio_file_path, raw_json],
        )?;

        Ok(())
    }

    pub fn history_update(&self, id: &str, patch: &Value) -> SqlResult<()> {
        let db = self.db.lock().unwrap();

        let row: Option<(i64, String)> = db.query_row(
            "SELECT list_order, raw_json FROM history_records WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).ok();

        let (_list_order, raw_json) = match row {
            Some(r) => r,
            None => return Ok(()),
        };

        let mut prev: serde_json::Map<String, Value> = serde_json::from_str(&raw_json).unwrap_or_default();

        if let Some(patch_obj) = patch.as_object() {
            for (k, v) in patch_obj {
                prev.insert(k.clone(), v.clone());
            }
        }

        let next = Value::Object(prev.clone());
        let timestamp = prev.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        let favorite = prev.get("favorite").and_then(|v| v.as_bool()).unwrap_or(false);
        let char_count = prev.get("charCount").and_then(|v| v.as_i64()).unwrap_or(0);
        let duration_sec = prev.get("durationSec").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let is_empty = prev.get("isEmpty").and_then(|v| v.as_bool()).unwrap_or(false);
        let app_id = prev.get("appId").and_then(|v| v.as_str()).map(|s| s.to_string());
        let app_name = prev.get("appName").and_then(|v| v.as_str()).map(|s| s.to_string());
        let audio_file_path = prev.get("audioFilePath").and_then(|v| v.as_str()).map(|s| s.to_string());
        let new_json = serde_json::to_string(&next).unwrap_or_else(|_| "{}".to_string());

        db.execute(
            "UPDATE history_records SET timestamp=?1, favorite=?2, char_count=?3, duration_sec=?4, is_empty=?5, app_id=?6, app_name=?7, audio_file_path=?8, raw_json=?9 WHERE id=?10",
            params![timestamp, favorite as i32, char_count, duration_sec, is_empty as i32, app_id, app_name, audio_file_path, new_json, id],
        )?;

        Ok(())
    }

    pub fn history_delete(&self, id: &str) -> SqlResult<()> {
        let db = self.db.lock().unwrap();

        let row: Option<(i64, String)> = db.query_row(
            "SELECT list_order, raw_json FROM history_records WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).ok();

        let (list_order, _) = match row {
            Some(r) => r,
            None => return Ok(()),
        };


        db.execute("DELETE FROM history_records WHERE id = ?1", params![id])?;
        db.execute("UPDATE history_records SET list_order = list_order - 1 WHERE list_order > ?1", params![list_order])?;

        Ok(())
    }

    // ─── Collections ───

    fn read_collection(&self, key: &str) -> SqlResult<Value> {
        let table = collection_table(key).ok_or(rusqlite::Error::InvalidParameterName("unknown collection".into()))?;
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare(&format!("SELECT raw_json FROM {} ORDER BY list_order ASC", table))?;
        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(s)
        })?;

        let items: Vec<Value> = rows
            .filter_map(|r| r.ok())
            .filter_map(|s| serde_json::from_str(&s).ok())
            .collect();

        Ok(Value::Array(items))
    }

    fn replace_collection_on(db: &Connection, key: &str, items: &[Value]) -> SqlResult<()> {
        let table = collection_table(key).ok_or(rusqlite::Error::InvalidParameterName(
            "unknown collection".into(),
        ))?;

        db.execute(&format!("DELETE FROM {}", table), [])?;

        for (index, item) in items.iter().enumerate() {
            let obj = item.as_object();
            let id = obj
                .and_then(|o| o.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let raw_json = serde_json::to_string(item).unwrap_or_else(|_| "{}".to_string());

            match key {
                "history" => {
                    let timestamp = obj
                        .and_then(|o| o.get("timestamp"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let favorite = obj
                        .and_then(|o| o.get("favorite"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let char_count = obj
                        .and_then(|o| o.get("charCount"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let duration_sec = obj
                        .and_then(|o| o.get("durationSec"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let is_empty = obj
                        .and_then(|o| o.get("isEmpty"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let app_id = obj
                        .and_then(|o| o.get("appId"))
                        .and_then(|v| v.as_str());
                    let app_name = obj
                        .and_then(|o| o.get("appName"))
                        .and_then(|v| v.as_str());
                    db.execute(
                        "INSERT INTO history_records (id, list_order, timestamp, favorite, char_count, duration_sec, is_empty, app_id, app_name, raw_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                        params![id, index as i64, timestamp, favorite as i32, char_count, duration_sec, is_empty as i32, app_id, app_name, raw_json],
                    )?;
                }
                _ => {
                    // Generic collection insert (manual_corrections, feedback_queue, prompt_presets, app_prompt_rules)
                    let name = obj
                        .and_then(|o| o.get("name"))
                        .and_then(|v| v.as_str());
                    match table {
                        "manual_corrections" => {
                            let created_at = obj
                                .and_then(|o| o.get("createdAt"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            let history_id = obj
                                .and_then(|o| o.get("historyId"))
                                .and_then(|v| v.as_str());
                            db.execute(
                                "INSERT INTO manual_corrections (id, list_order, created_at, history_id, raw_json) VALUES (?1,?2,?3,?4,?5)",
                                params![id, index as i64, created_at, history_id, raw_json],
                            )?;
                        }
                        "feedback_queue" => {
                            let created_at = obj
                                .and_then(|o| o.get("createdAt"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            let history_id = obj
                                .and_then(|o| o.get("historyId"))
                                .and_then(|v| v.as_str());
                            let status = obj
                                .and_then(|o| o.get("status"))
                                .and_then(|v| v.as_str());
                            db.execute(
                                "INSERT INTO feedback_queue (id, list_order, created_at, history_id, status, raw_json) VALUES (?1,?2,?3,?4,?5,?6)",
                                params![id, index as i64, created_at, history_id, status, raw_json],
                            )?;
                        }
                        "prompt_presets" => {
                            db.execute(
                                "INSERT INTO prompt_presets (id, list_order, name, raw_json) VALUES (?1,?2,?3,?4)",
                                params![id, index as i64, name, raw_json],
                            )?;
                        }
                        "app_prompt_rules" => {
                            let app_id = obj
                                .and_then(|o| o.get("appId"))
                                .and_then(|v| v.as_str());
                            let enabled = obj
                                .and_then(|o| o.get("enabled"))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);
                            let priority = obj
                                .and_then(|o| o.get("priority"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            db.execute(
                                "INSERT INTO app_prompt_rules (id, list_order, app_id, name, enabled, priority, raw_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                                params![id, index as i64, app_id, name, enabled as i32, priority, raw_json],
                            )?;
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    }

    fn replace_collection(&self, key: &str, items: &[Value]) -> SqlResult<()> {
        let db = self.db.lock().unwrap();
        Self::replace_collection_on(&db, key, items)
    }

}

impl Storage {
        pub fn export_app_settings(&self, exclude: &[&str]) -> Value {
        let db = self.db.lock().unwrap();
        let mut map = serde_json::Map::new();
        if let Ok(mut stmt) = db.prepare("SELECT key, value_json FROM app_settings") {
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            });
            if let Ok(rows) = rows {
                for row in rows.flatten() {
                    let (key, value_json) = row;
                    if exclude.contains(&key.as_str()) {
                        continue;
                    }
                    let val: Value = serde_json::from_str(&value_json).unwrap_or(Value::Null);
                    map.insert(key, val);
                }
            }
        }
        Value::Object(map)
    }

        pub fn apply_config_transaction(
        &self,
        app_settings: &serde_json::Map<String, Value>,
        exclude: &[&str],
        prompt_presets: Option<&[Value]>,
        app_prompt_rules: Option<&[Value]>,
    ) -> SqlResult<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let now = chrono::Utc::now().timestamp_millis();

        for (key, value) in app_settings {
            if exclude.contains(&key.as_str()) {
                continue;
            }
            let json_str = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
            tx.execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params![key, json_str, now],
            )?;
        }

        if let Some(items) = prompt_presets {
            Self::replace_collection_on(&tx, "promptPresets", items)?;
        }
        if let Some(items) = app_prompt_rules {
            Self::replace_collection_on(&tx, "appPromptRules", items)?;
        }

        tx.commit()
    }
}
