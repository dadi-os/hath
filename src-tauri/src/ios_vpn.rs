//! Network Extension helpers for dadiMesh on iOS.
//!
//! The Packet Tunnel Provider lives under `dadimesh-extension/`. These
//! helpers write App Group credentials and drive NETunnelProviderManager via
//! Objective-C when `DadiMeshBridge.m` is linked; cargo builds use the C stub.

use crate::net::Credentials;
use std::ffi::CString;
use std::os::raw::{c_char, c_int};

extern "C" {
    fn dadimesh_vpn_ensure() -> c_int;
    fn dadimesh_vpn_start(proxy_port: c_int) -> c_int;
    fn dadimesh_vpn_stop() -> c_int;
    fn dadimesh_vpn_write_credentials(
        control_url: *const c_char,
        auth_key: *const c_char,
        node_name: *const c_char,
    ) -> c_int;
}

/// Register the dadiMesh Packet Tunnel in iOS Settings → VPN.
pub fn ensure_vpn_configuration() -> Result<(), String> {
    let code = unsafe { dadimesh_vpn_ensure() };
    if code != 0 {
        return Err(format!("dadimesh vpn ensure failed ({code})"));
    }
    Ok(())
}

/// Start the iOS Packet Tunnel, passing the in-process dialer proxy port.
pub fn start_tunnel(port: u16) -> Result<(), String> {
    let code = unsafe { dadimesh_vpn_start(port as c_int) };
    if code != 0 {
        return Err(format!("dadimesh vpn start failed ({code})"));
    }
    Ok(())
}

/// Stop the iOS Packet Tunnel.
pub fn stop_tunnel() -> Result<(), String> {
    let code = unsafe { dadimesh_vpn_stop() };
    if code != 0 {
        return Err(format!("dadimesh vpn stop failed ({code})"));
    }
    Ok(())
}

/// Write mesh credentials into the App Group for the Packet Tunnel Provider.
pub fn write_shared_credentials(credentials: &Credentials) -> Result<(), String> {
    let control = CString::new(credentials.control_url.as_str()).map_err(|e| e.to_string())?;
    let key = CString::new(credentials.auth_key.as_str()).map_err(|e| e.to_string())?;
    let host = CString::new(credentials.node_name.as_str()).map_err(|e| e.to_string())?;
    let code = unsafe {
        dadimesh_vpn_write_credentials(control.as_ptr(), key.as_ptr(), host.as_ptr())
    };
    if code != 0 {
        return Err(format!("dadimesh vpn write credentials failed ({code})"));
    }
    Ok(())
}
