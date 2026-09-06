use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub control_url: String,
    pub auth_key: String,
    pub node_name: String,
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

pub fn stop_node() {
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

fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&data).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(data.join("credentials.json"))
}

/// Bring up the embedded tsnet node and local proxy. Blocks until Up completes.
#[tauri::command]
pub async fn net_start(
    app: AppHandle,
    state: State<'_, NetState>,
    control_url: String,
    auth_key: String,
    node_name: String,
) -> Result<u16, String> {
    {
        let guard = state.port.lock().map_err(|e| e.to_string())?;
        if let Some(port) = *guard {
            return Ok(port);
        }
    }

    let trimmed_name = node_name.trim();
    if trimmed_name.is_empty() {
        return Err("node_name is empty".into());
    }

    let state_dir = tsnet_dir(&app)?;
    let hostname = trimmed_name.to_string();

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
pub fn net_load_credentials(app: AppHandle) -> Result<Option<Credentials>, String> {
    let path = credentials_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read credentials: {e}"))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let credentials: Credentials =
        serde_json::from_str(trimmed).map_err(|e| format!("parse credentials: {e}"))?;
    if credentials.control_url.trim().is_empty()
        || credentials.auth_key.trim().is_empty()
        || credentials.node_name.trim().is_empty()
    {
        return Ok(None);
    }
    Ok(Some(credentials))
}

#[tauri::command]
pub fn net_save_credentials(app: AppHandle, credentials: Credentials) -> Result<(), String> {
    if credentials.control_url.trim().is_empty()
        || credentials.auth_key.trim().is_empty()
        || credentials.node_name.trim().is_empty()
    {
        return Err("credentials are incomplete".into());
    }
    let path = credentials_path(&app)?;
    let json = serde_json::to_string_pretty(&credentials).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("write credentials: {e}"))
}
