mod logutil;
mod net;
mod device;

#[cfg(target_os = "ios")]
mod ios_vpn;

#[cfg(not(target_os = "ios"))]
mod sysmesh;

use net::MeshState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logutil::emit("info", "hath starting");
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(MeshState::default())
        .invoke_handler(tauri::generate_handler![
            net::mesh_start,
            net::mesh_stop,
            net::mesh_status,
            net::mesh_port,
            net::mesh_load_credentials,
            net::mesh_save_credentials,
            net::mesh_clear_credentials,
            net::net_start,
            net::net_stop,
            net::net_status,
            net::net_load_credentials,
            net::net_save_credentials,
            device::device_get_battery,
            device::device_write_download,
        ]);

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                logutil::emit("info", "hath exiting");
            }
        });
}
