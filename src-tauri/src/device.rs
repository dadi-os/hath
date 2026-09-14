//! Local device primitives for Dimaag hath_* reverse-RPC tools.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct BatteryInfo {
    pub percent: f64,
    pub charging: bool,
}

/// Read battery percent and charging state from the host.
#[tauri::command]
pub fn device_get_battery() -> Result<BatteryInfo, String> {
    let manager = battery::Manager::new().map_err(|e| format!("capability_unsupported: {e}"))?;
    let battery = manager
        .batteries()
        .map_err(|e| format!("capability_unsupported: {e}"))?
        .next()
        .ok_or_else(|| "capability_unsupported: no battery present".to_string())?
        .map_err(|e| format!("capability_unsupported: {e}"))?;

    let ratio = battery
        .state_of_charge()
        .get::<battery::units::ratio::percent>();
    let charging = matches!(
        battery.state(),
        battery::State::Charging | battery::State::Full
    );
    Ok(BatteryInfo {
        percent: (ratio as f64).round(),
        charging,
    })
}

/// Write base64 file bytes into the OS Downloads folder and return the absolute path.
#[tauri::command]
pub fn device_write_download(filename: String, data: String) -> Result<String, String> {
    let name = sanitize_filename(&filename)?;
    let bytes = B64
        .decode(data.trim())
        .map_err(|e| format!("invalid_request: base64 decode failed: {e}"))?;
    let dir = downloads_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("internal_error: create downloads: {e}"))?;
    let path = unique_path(&dir, &name);
    fs::write(&path, bytes).map_err(|e| format!("internal_error: write download: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn downloads_dir() -> Result<PathBuf, String> {
    dirs::download_dir().ok_or_else(|| {
        "capability_unsupported: Downloads folder is not available on this platform".to_string()
    })
}

fn sanitize_filename(filename: &str) -> Result<String, String> {
    let trimmed = filename.trim();
    if trimmed.is_empty() {
        return Err("invalid_request: filename is required".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("invalid_request: filename must not contain path separators".to_string());
    }
    Ok(trimmed.to_string())
}

fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 1..10_000 {
        let next = dir.join(format!("{stem}-{i}{ext}"));
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{stem}-overflow{ext}"))
}
