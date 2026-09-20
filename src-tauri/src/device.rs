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

/// Coordinates returned by `device_get_location`.
#[derive(Debug, Serialize)]
pub struct LocationInfo {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy: f64,
    pub at: String,
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

/// Read current coordinates via CoreLocation (macOS) or report unsupported.
#[tauri::command]
pub fn device_get_location() -> Result<LocationInfo, String> {
    #[cfg(target_os = "macos")]
    {
        return macos_get_location();
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("capability_unsupported: native location is only implemented on macOS".to_string())
    }
}

/// Register for Location Services once at launch when authorization is undetermined.
#[cfg(target_os = "macos")]
pub fn prepare_location_authorization() {
    unsafe extern "C" {
        fn hath_location_prepare();
    }
    unsafe { hath_location_prepare() };
}

#[cfg(target_os = "macos")]
fn macos_get_location() -> Result<LocationInfo, String> {
    unsafe extern "C" {
        fn hath_device_get_location(
            lat: *mut f64,
            lon: *mut f64,
            accuracy_m: *mut f64,
            at_out: *mut std::ffi::c_char,
            at_len: usize,
            err: *mut std::ffi::c_char,
            err_len: usize,
        ) -> i32;
    }
    let mut lat = 0.0_f64;
    let mut lon = 0.0_f64;
    let mut accuracy = 0.0_f64;
    let mut at_buf = vec![0u8; 64];
    let mut err = vec![0u8; 512];
    let rc = unsafe {
        hath_device_get_location(
            &mut lat,
            &mut lon,
            &mut accuracy,
            at_buf.as_mut_ptr() as *mut std::ffi::c_char,
            at_buf.len(),
            err.as_mut_ptr() as *mut std::ffi::c_char,
            err.len(),
        )
    };
    if rc == 0 {
        let at = unsafe { std::ffi::CStr::from_ptr(at_buf.as_ptr() as *const std::ffi::c_char) }
            .to_string_lossy()
            .into_owned();
        return Ok(LocationInfo {
            latitude: lat,
            longitude: lon,
            accuracy,
            at,
        });
    }
    let message = unsafe { std::ffi::CStr::from_ptr(err.as_ptr() as *const std::ffi::c_char) }
        .to_string_lossy()
        .into_owned();
    if message.is_empty() {
        Err("internal_error: location failed".to_string())
    } else {
        Err(message)
    }
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
