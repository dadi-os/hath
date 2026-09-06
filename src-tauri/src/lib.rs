mod net;

use net::NetState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .manage(NetState::default())
        .invoke_handler(tauri::generate_handler![
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
                net::stop_node();
            }
        });
}
