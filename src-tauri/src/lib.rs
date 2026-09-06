mod net;

use net::NetState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(NetState::default())
        .invoke_handler(tauri::generate_handler![
            net::net_start,
            net::net_stop,
            net::net_status,
            net::net_load_auth_key,
            net::net_save_auth_key,
        ])
        .setup(|app| {
            let target = std::env::var("HATH_TARGET").unwrap_or_else(|_| "desktop".into());
            if target == "kiosk" {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_decorations(false)?;
                    window.set_fullscreen(true)?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
