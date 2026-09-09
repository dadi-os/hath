mod logutil;
mod net;
mod ios_vpn;

use net::MeshState;

/// hathnet is a raw-dylib on Windows; ensure its folder is on the DLL search path
/// before any FFI call (exe dir from build.rs copy, or bundled resources/).
#[cfg(windows)]
fn prepare_hathnet_dll_search_path() {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetDllDirectoryW(path: *const u16) -> i32;
    }

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    let candidates = [dir.to_path_buf(), dir.join("resources")];
    for candidate in candidates {
        if candidate.join("hathnet.dll").exists() {
            let wide: Vec<u16> = candidate
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            unsafe {
                SetDllDirectoryW(wide.as_ptr());
            }
            logutil::emit(
                "info",
                format!("dadimesh DLL search path → {}", candidate.display()),
            );
            return;
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    prepare_hathnet_dll_search_path();

    logutil::emit("info", "hath starting");
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .manage(MeshState::default())
        .invoke_handler(tauri::generate_handler![
            net::mesh_start,
            net::mesh_stop,
            net::mesh_status,
            net::mesh_port,
            net::mesh_load_credentials,
            net::mesh_save_credentials,
            net::net_start,
            net::net_stop,
            net::net_status,
            net::net_load_credentials,
            net::net_save_credentials,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                logutil::emit("info", "hath exiting");
                // Do not stop dadiMesh on desktop exit — tunnel lifetime is
                // explicit (power control). On process kill the node dies with us;
                // intentional leave uses mesh_stop.
            }
        });
}
