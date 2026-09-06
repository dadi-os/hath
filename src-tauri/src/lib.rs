use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
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
