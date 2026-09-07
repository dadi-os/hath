use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

static LOG_LOCK: Mutex<()> = Mutex::new(());

/// Emit a JSON log line (`time`, `level`, `service`, `msg`) to stdout.
/// When `HATH_LOG_FILE` is set, append the same line for Alloy to ship to Loki.
pub fn emit(level: &str, msg: impl AsRef<str>) {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_millis();
    let line = json!({
        "time": ms,
        "level": level,
        "service": "hath",
        "msg": msg.as_ref(),
    })
    .to_string();

    println!("{line}");

    if let Ok(path) = std::env::var("HATH_LOG_FILE") {
        let _guard = LOG_LOCK.lock().expect("hath log lock");
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap_or_else(|e| panic!("open HATH_LOG_FILE {path}: {e}"));
        writeln!(file, "{line}").unwrap_or_else(|e| panic!("write HATH_LOG_FILE {path}: {e}"));
    }
}
