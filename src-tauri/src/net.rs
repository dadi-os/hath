use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, State};

extern "C" {
    fn hathnet_start(
        control_url: *const c_char,
        auth_key: *const c_char,
        hostname: *const c_char,
        state_dir: *const c_char,
    ) -> c_int;
    fn hathnet_stop();
    fn hathnet_status() -> c_int;
    fn hathnet_last_error() -> *mut c_char;
    fn hathnet_free(p: *mut c_char);
}

/// Shared proxy port after a successful start (None when stopped).
pub struct NetState {
    pub port: Mutex<Option<u16>>,
}

impl Default for NetState {
    fn default() -> Self {
        Self {
            port: Mutex::new(None),
        }
    }
}

fn last_error_string() -> String {
    unsafe {
        let ptr = hathnet_last_error();
        if ptr.is_null() {
            return "unknown hathnet error".into();
        }
        let s = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        hathnet_free(ptr);
        s
    }
}

fn start_node(
    control_url: &str,
    auth_key: &str,
    hostname: &str,
    state_dir: &Path,
) -> Result<u16, String> {
    let control = CString::new(control_url).map_err(|e| e.to_string())?;
    let key = CString::new(auth_key).map_err(|e| e.to_string())?;
    let host = CString::new(hostname).map_err(|e| e.to_string())?;
    let dir = CString::new(state_dir.to_string_lossy().as_ref()).map_err(|e| e.to_string())?;

    let code = unsafe { hathnet_start(control.as_ptr(), key.as_ptr(), host.as_ptr(), dir.as_ptr()) };
    if code < 0 {
        return Err(last_error_string());
    }
    Ok(code as u16)
}

fn stop_node() {
    unsafe { hathnet_stop() };
}

fn node_status() -> u8 {
    unsafe { hathnet_status() as u8 }
}

fn tsnet_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = data.join("tsnet");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create tsnet dir: {e}"))?;
    Ok(dir)
}

fn auth_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&data).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(data.join("headscale-auth-key"))
}

fn load_or_create_hostname(state_dir: &Path) -> Result<String, String> {
    let path = state_dir.join("hostname");
    if path.exists() {
        let existing = std::fs::read_to_string(&path).map_err(|e| format!("read hostname: {e}"))?;
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let suffix = format!("{:x}", (nanos % 0xffff_ffff) as u32);
    let hostname = format!("hath-{}-{}", std::env::consts::OS, suffix);
    std::fs::write(&path, &hostname).map_err(|e| format!("write hostname: {e}"))?;
    Ok(hostname)
}

/// Bring up the embedded tsnet node and local proxy. Blocks until Up completes.
#[tauri::command]
pub async fn net_start(
    app: AppHandle,
    state: State<'_, NetState>,
    control_url: String,
    auth_key: String,
) -> Result<u16, String> {
    {
        let guard = state.port.lock().map_err(|e| e.to_string())?;
        if let Some(port) = *guard {
            return Ok(port);
        }
    }

    let state_dir = tsnet_dir(&app)?;
    let hostname = load_or_create_hostname(&state_dir)?;

    let port = tauri::async_runtime::spawn_blocking(move || {
        start_node(&control_url, &auth_key, &hostname, &state_dir)
    })
    .await
    .map_err(|e| format!("net_start join: {e}"))??;

    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = Some(port);
    Ok(port)
}

#[tauri::command]
pub async fn net_stop(state: State<'_, NetState>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(stop_node)
        .await
        .map_err(|e| format!("net_stop join: {e}"))?;
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn net_status() -> u8 {
    node_status()
}

#[tauri::command]
pub fn net_load_auth_key(app: AppHandle) -> Result<Option<String>, String> {
    let path = auth_key_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read auth key: {e}"))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed.to_string()))
}

#[tauri::command]
pub fn net_save_auth_key(app: AppHandle, auth_key: String) -> Result<(), String> {
    let path = auth_key_path(&app)?;
    let trimmed = auth_key.trim();
    if trimmed.is_empty() {
        return Err("auth key is empty".into());
    }
    std::fs::write(&path, trimmed).map_err(|e| format!("write auth key: {e}"))
}
