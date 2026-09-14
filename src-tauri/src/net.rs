#[cfg(target_os = "ios")]
use crate::logutil;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "ios")]
use std::ffi::{CStr, CString};
#[cfg(target_os = "ios")]
use std::os::raw::{c_char, c_int};
#[cfg(target_os = "ios")]
use std::path::Path;
#[cfg(target_os = "ios")]
use std::time::Duration;

/// Bound for in-process dialer Up (iOS).
#[cfg(target_os = "ios")]
const MESH_START_TIMEOUT: Duration = Duration::from_secs(45);

#[cfg(target_os = "ios")]
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

/// Shared dialer port after a successful start.
/// Desktop system mesh stores [`crate::sysmesh::SYSTEM_MESH_SENTINEL`] (0).
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

#[cfg(target_os = "ios")]
fn mesh_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = data.join("dadimesh");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dadimesh dir: {e}"))?;
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

#[cfg(target_os = "ios")]
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

/// Bring up dadiMesh. Desktop: system `tailscaled` TUN. iOS: in-process tsnet + NE.
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

    #[cfg(not(target_os = "ios"))]
    {
        let app2 = app.clone();
        let hostname = trimmed_name.to_string();
        let port = tauri::async_runtime::spawn_blocking(move || {
            crate::sysmesh::start(&app2, &control_url, &auth_key, &hostname)
        })
        .await
        .map_err(|e| format!("mesh_start join: {e}"))??;

        let mut guard = state.port.lock().map_err(|e| e.to_string())?;
        *guard = Some(port);
        return Ok(port);
    }

    #[cfg(target_os = "ios")]
    {
        let state_dir = mesh_dir(&app)?;
        let hostname = trimmed_name.to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(start_node_ios(
                &control_url,
                &auth_key,
                &hostname,
                &state_dir,
            ));
        });

        let port = match rx.recv_timeout(MESH_START_TIMEOUT) {
            Ok(Ok(port)) => port,
            Ok(Err(err)) => return Err(err),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                logutil::emit("error", "dadimesh start timed out");
                stop_node_ios();
                return Err(
                    "dadiMesh join timed out. Check the setup code or network.".into(),
                );
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("mesh_start worker ended unexpectedly".into());
            }
        };

        crate::ios_vpn::ensure_vpn_configuration().map_err(|e| {
            stop_node_ios();
            e
        })?;
        crate::ios_vpn::start_tunnel(port).map_err(|e| {
            stop_node_ios();
            e
        })?;

        let mut guard = state.port.lock().map_err(|e| e.to_string())?;
        *guard = Some(port);
        Ok(port)
    }
}

#[tauri::command]
pub async fn mesh_stop(app: AppHandle, state: State<'_, MeshState>) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        crate::ios_vpn::stop_tunnel()?;
    }

    #[cfg(not(target_os = "ios"))]
    {
        let app2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || crate::sysmesh::stop(&app2))
            .await
            .map_err(|e| format!("mesh_stop join: {e}"))??;
    }

    #[cfg(target_os = "ios")]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(stop_node_ios)
            .await
            .map_err(|e| format!("mesh_stop join: {e}"))?;
    }

    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn mesh_status(app: AppHandle) -> u8 {
    #[cfg(not(target_os = "ios"))]
    {
        return crate::sysmesh::status(&app);
    }
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        unsafe { dadimesh_status() as u8 }
    }
}

#[tauri::command]
pub fn mesh_port(state: State<'_, MeshState>) -> Result<Option<u16>, String> {
    let guard = state.port.lock().map_err(|e| e.to_string())?;
    Ok(*guard)
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

/// Delete persisted mesh credentials (forces onboarding on next prepare).
#[tauri::command]
pub fn mesh_clear_credentials(app: AppHandle) -> Result<(), String> {
    let path = credentials_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("clear credentials: {e}"))?;
    }
    Ok(())
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
        crate::ios_vpn::write_shared_credentials(&credentials)?;
    }
    Ok(())
}

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
pub async fn net_stop(app: AppHandle, state: State<'_, MeshState>) -> Result<(), String> {
    mesh_stop(app, state).await
}

#[tauri::command]
pub fn net_status(app: AppHandle) -> u8 {
    mesh_status(app)
}

#[tauri::command]
pub fn net_load_credentials(app: AppHandle) -> Result<Option<Credentials>, String> {
    mesh_load_credentials(app)
}

#[tauri::command]
pub fn net_save_credentials(app: AppHandle, credentials: Credentials) -> Result<(), String> {
    mesh_save_credentials(app, credentials)
}

#[cfg(target_os = "ios")]
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

#[cfg(target_os = "ios")]
fn start_node_ios(
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

#[cfg(target_os = "ios")]
fn stop_node_ios() {
    logutil::emit("info", "dadimesh stopping");
    unsafe { dadimesh_stop() };
}
