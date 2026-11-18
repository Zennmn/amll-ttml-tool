use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(serde::Serialize)]
pub struct StoredSetting {
    value: Value,
}

fn setting_path(app: &AppHandle, window: &WebviewWindow, key: &str) -> Result<PathBuf, String> {
    if window.label() != "main" {
        return Err("Settings are only available in the editor".into());
    }
    if key.is_empty()
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err("Invalid setting key".into());
    }
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("settings")
        .join(format!("{key}.json")))
}

#[tauri::command]
pub fn setting_storage_read(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
) -> Result<Option<StoredSetting>, String> {
    let path = setting_path(&app, &window, &key)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_slice(&bytes)
        .map(|value| Some(StoredSetting { value }))
        .map_err(|error| error.to_string())
}

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing settings directory"))?;
    fs::create_dir_all(parent)?;
    let sequence = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary =
        path.with_extension(format!("{}-{timestamp}-{sequence}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub fn setting_storage_write(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
    value: Value,
) -> Result<(), String> {
    let path = setting_path(&app, &window, &key)?;
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    write_atomic(&path, &bytes).map_err(|error| error.to_string())
}
