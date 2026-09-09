use crate::logutil;

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
#[link(name = "hathnet", kind = "raw-dylib")]
extern "C" {
    fn dadimesh_start(
        control_url: *const c_char,
        auth_key: *const c_char,
        hostname: *const c_char,
        state_dir: *const c_char,
    ) -> c_int;
    fn dadimesh_stop();
    fn dadimesh_status() -> c_int;
    fn dadimesh_port() -> c_int;
    fn dadimesh_last_error() -> *mut c_char;
    fn dadimesh_free(p: *mut c_char);
}

#[cfg(not(windows))]
extern "C" {
    fn dadimesh_start(
        control_url: *const c_char,
        auth_key: *const c_char,
        hostname: *const c_char,
        state_dir: *const c_char,
    ) -> c_int;
    fn dadimesh_stop();
    fn dadimesh_status() -> c_int;
    fn dadimesh_port() -> c_int;
    fn dadimesh_last_error() -> *mut c_char;
    fn dadimesh_free(p: *mut c_char);
}

/// Shared dialer port after a successful start (None when stopped).
pub struct MeshState {
    pub port: Mutex<Option<u16>>,
}

impl Default for MeshState {
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
        let ptr = dadimesh_last_error();
        if ptr.is_null() {
            return "unknown dadimesh error".into();
        }
        let s = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        dadimesh_free(ptr);
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

    let code =
        unsafe { dadimesh_start(control.as_ptr(), key.as_ptr(), host.as_ptr(), dir.as_ptr()) };
    if code < 0 {
        let err = last_error_string();
        logutil::emit("error", format!("dadimesh start failed: {err}"));
        return Err(err);
    }
    logutil::emit("info", format!("dadimesh connected dialer_port={code}"));
    Ok(code as u16)
}

pub fn stop_node() {
    logutil::emit("info", "dadimesh stopping");
    unsafe { dadimesh_stop() };
}

fn node_status() -> u8 {
    unsafe { dadimesh_status() as u8 }
}

fn node_port() -> Option<u16> {
    let p = unsafe { dadimesh_port() };
    if p > 0 {
        Some(p as u16)
    } else {
        None
    }
}

fn mesh_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = data.join("dadimesh");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dadimesh dir: {e}"))?;
    // Migrate legacy tsnet state directory if present and new dir is empty.
    let legacy = data.join("tsnet");
    if legacy.is_dir()
        && std::fs::read_dir(&dir)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false)
    {
        let _ = copy_dir_recursive(&legacy, &dir);
    }
    Ok(dir)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&data).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(data.join("credentials.json"))
}

/// Bring up dadiMesh (tsnet + local forward proxy). Blocks until Up completes.
#[tauri::command]
pub async fn mesh_start(
    app: AppHandle,
    state: State<'_, MeshState>,
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

    let state_dir = mesh_dir(&app)?;
    let hostname = trimmed_name.to_string();

    let port = tauri::async_runtime::spawn_blocking(move || {
        start_node(&control_url, &auth_key, &hostname, &state_dir)
    })
    .await
    .map_err(|e| format!("mesh_start join: {e}"))??;

    #[cfg(target_os = "ios")]
    {
        let _ = crate::ios_vpn::ensure_vpn_configuration();
        let _ = crate::ios_vpn::start_tunnel(port);
    }

    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = Some(port);
    Ok(port)
}

#[tauri::command]
pub async fn mesh_stop(state: State<'_, MeshState>) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let _ = crate::ios_vpn::stop_tunnel();
    }
    tauri::async_runtime::spawn_blocking(stop_node)
        .await
        .map_err(|e| format!("mesh_stop join: {e}"))?;
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn mesh_status() -> u8 {
    node_status()
}

#[tauri::command]
pub fn mesh_port(state: State<'_, MeshState>) -> Result<Option<u16>, String> {
    let guard = state.port.lock().map_err(|e| e.to_string())?;
    if let Some(port) = *guard {
        return Ok(Some(port));
    }
    Ok(node_port())
}

#[tauri::command]
pub fn mesh_load_credentials(app: AppHandle) -> Result<Option<Credentials>, String> {
    let path = credentials_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let credentials: Credentials = match serde_json::from_str(trimmed) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    if credentials.control_url.trim().is_empty()
        || credentials.auth_key.trim().is_empty()
        || credentials.node_name.trim().is_empty()
    {
        return Ok(None);
    }
    Ok(Some(credentials))
}

#[tauri::command]
pub fn mesh_save_credentials(app: AppHandle, credentials: Credentials) -> Result<(), String> {
    if credentials.control_url.trim().is_empty()
        || credentials.auth_key.trim().is_empty()
        || credentials.node_name.trim().is_empty()
    {
        return Err("credentials are incomplete".into());
    }
    let path = credentials_path(&app)?;
    let json = serde_json::to_string_pretty(&credentials).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("write credentials: {e}"))?;

    #[cfg(target_os = "ios")]
    {
        let _ = crate::ios_vpn::write_shared_credentials(&credentials);
    }
    Ok(())
}

// Back-compat command names used by older frontend builds during migration.
#[tauri::command]
pub async fn net_start(
    app: AppHandle,
    state: State<'_, MeshState>,
    control_url: String,
    auth_key: String,
    node_name: String,
) -> Result<u16, String> {
    mesh_start(app, state, control_url, auth_key, node_name).await
}

#[tauri::command]
pub async fn net_stop(state: State<'_, MeshState>) -> Result<(), String> {
    mesh_stop(state).await
}

#[tauri::command]
pub fn net_status() -> u8 {
    mesh_status()
}

#[tauri::command]
pub fn net_load_credentials(app: AppHandle) -> Result<Option<Credentials>, String> {
    mesh_load_credentials(app)
}

#[tauri::command]
pub fn net_save_credentials(app: AppHandle, credentials: Credentials) -> Result<(), String> {
    mesh_save_credentials(app, credentials)
}
