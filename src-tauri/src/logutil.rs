use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

static LOG_LOCK: Mutex<()> = Mutex::new(());

fn rfc3339_now() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch");
    let total_secs = duration.as_secs();
    let nanos = duration.subsec_nanos();
    let days = total_secs / 86_400;
    let day_secs = total_secs % 86_400;
    let hour = day_secs / 3600;
    let min = (day_secs % 3600) / 60;
    let sec = day_secs % 60;

    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{nanos:09}Z"
    )
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

/// Emit a JSON log line aligned with the nas contract
/// (`time` RFC3339, `level`, `service`, `msg`; optional `code`).
pub fn emit(level: &str, msg: impl AsRef<str>) {
    emit_with(level, msg.as_ref(), None);
}

/// Emit a structured log line with an optional stable error `code`.
pub fn emit_with(level: &str, msg: &str, code: Option<&str>) {
    let mut obj = Map::new();
    obj.insert("time".into(), Value::String(rfc3339_now()));
    obj.insert("level".into(), Value::String(level.to_string()));
    obj.insert("service".into(), Value::String("hath".into()));
    obj.insert("msg".into(), Value::String(msg.to_string()));
    if let Some(code) = code {
        obj.insert("code".into(), Value::String(code.to_string()));
    }
    let line = Value::Object(obj).to_string();

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
