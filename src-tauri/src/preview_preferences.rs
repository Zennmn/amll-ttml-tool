use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewPreferenceKey {
    ShowTranslationLines,
    ShowRomanLines,
    HideObsceneWords,
    LyricWordFadeWidth,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum PreviewPreferenceValue {
    Toggle(bool),
    Width(f64),
}

impl PreviewPreferenceKey {
    fn file_name(self) -> &'static str {
        match self {
            Self::ShowTranslationLines => "showTranslationLines.json",
            Self::ShowRomanLines => "showRomanLines.json",
            Self::HideObsceneWords => "hideObsceneWords.json",
            Self::LyricWordFadeWidth => "lyricWordFadeWidth.json",
        }
    }

    fn validate(self, value: &PreviewPreferenceValue) -> Result<(), String> {
        match (self, value) {
            (Self::LyricWordFadeWidth, PreviewPreferenceValue::Width(width))
                if width.is_finite() =>
            {
                Ok(())
            }
            (
                Self::ShowTranslationLines | Self::ShowRomanLines | Self::HideObsceneWords,
                PreviewPreferenceValue::Toggle(_),
            ) => Ok(()),
            _ => Err("Invalid preview preference value".into()),
        }
    }
}

fn preference_path(
    app: &AppHandle,
    window: &WebviewWindow,
    key: PreviewPreferenceKey,
) -> Result<PathBuf, String> {
    if window.label() != "main" {
        return Err("Preview preferences are only available in the editor".into());
    }
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("preview-preferences")
        .join(key.file_name()))
}

#[tauri::command]
pub fn preview_preference_read(
    app: AppHandle,
    window: WebviewWindow,
    key: PreviewPreferenceKey,
) -> Result<Option<PreviewPreferenceValue>, String> {
    let path = preference_path(&app, &window, key)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    key.validate(&value)?;
    Ok(Some(value))
}

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Missing preference directory")
    })?;
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
pub fn preview_preference_write(
    app: AppHandle,
    window: WebviewWindow,
    key: PreviewPreferenceKey,
    value: PreviewPreferenceValue,
) -> Result<(), String> {
    key.validate(&value)?;
    let path = preference_path(&app, &window, key)?;
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    write_atomic(&path, &bytes).map_err(|error| error.to_string())
}
