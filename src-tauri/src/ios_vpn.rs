//! Network Extension helpers for dadiMesh (iOS + macOS).
//!
//! The Packet Tunnel Provider lives under `dadimesh-extension/`. These Rust
//! helpers write App Group credentials and drive NETunnelProviderManager via
//! Objective-C bridging when the real bridge is linked; otherwise the C stub
//! no-ops so desktop sysmesh still works without the extension target.

#![allow(dead_code)]

use crate::net::Credentials;

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
pub fn ensure_vpn_configuration() -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
pub fn start_tunnel(_port: u16) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
pub fn stop_tunnel() -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
pub fn write_shared_credentials(_credentials: &Credentials) -> Result<(), String> {
    Ok(())
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod apple {
    use super::*;
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

    pub fn ensure_vpn_configuration() -> Result<(), String> {
        let code = unsafe { dadimesh_vpn_ensure() };
        if code != 0 {
            // Stub returns 0; real bridge may fail if NE target missing — soft log only.
            return Err(format!("dadimesh vpn ensure failed ({code})"));
        }
        Ok(())
    }

    pub fn start_tunnel(port: u16) -> Result<(), String> {
        let code = unsafe { dadimesh_vpn_start(port as c_int) };
        if code != 0 {
            return Err(format!("dadimesh vpn start failed ({code})"));
        }
        Ok(())
    }

    pub fn stop_tunnel() -> Result<(), String> {
        let code = unsafe { dadimesh_vpn_stop() };
        if code != 0 {
            return Err(format!("dadimesh vpn stop failed ({code})"));
        }
        Ok(())
    }

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
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
pub use apple::*;
