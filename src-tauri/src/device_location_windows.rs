//! WinRT geolocation for `device_get_location` (coords + coarse civic address).

use crate::device::LocationInfo;
use windows::Devices::Geolocation::{
    CivicAddress, GeolocationAccessStatus, Geolocator, PositionAccuracy,
};
use windows::Foundation::TimeSpan;

/// Read position via WinRT Geolocator; address from CivicAddress when present.
pub fn get_location() -> Result<LocationInfo, String> {
    let access = Geolocator::RequestAccessAsync()
        .map_err(|e| format!("capability_unsupported: location API unavailable: {e}"))?
        .get()
        .map_err(|e| format!("capability_unsupported: location access request failed: {e}"))?;

    match access {
        GeolocationAccessStatus::Allowed => {}
        GeolocationAccessStatus::Denied => {
            return Err(
                "permission_denied: enable Location for Hath in Windows Settings".into(),
            );
        }
        GeolocationAccessStatus::Unspecified => {
            return Err("permission_denied: location permission was not decided".into());
        }
        _ => {
            return Err("permission_denied: location access denied".into());
        }
    }

    let locator = Geolocator::new()
        .map_err(|e| format!("capability_unsupported: create Geolocator: {e}"))?;
    locator
        .SetDesiredAccuracy(PositionAccuracy::Default)
        .map_err(|e| format!("internal_error: set accuracy: {e}"))?;

    // 20s timeout (TimeSpan is 100ns units).
    let timeout = TimeSpan {
        Duration: 20i64 * 10_000_000,
    };
    let position = locator
        .GetGeopositionAsyncWithAgeAndTimeout(TimeSpan { Duration: 0 }, timeout)
        .map_err(|e| format!("internal_error: get position: {e}"))?
        .get()
        .map_err(|e| format!("internal_error: get position: {e}"))?;

    let coord = position
        .Coordinate()
        .map_err(|e| format!("internal_error: coordinate: {e}"))?;
    let point = coord
        .Point()
        .map_err(|e| format!("internal_error: point: {e}"))?;
    let basic = point
        .Position()
        .map_err(|e| format!("internal_error: position: {e}"))?;

    let accuracy = coord
        .Accuracy()
        .map_err(|e| format!("internal_error: accuracy: {e}"))?;

    let at = match coord.Timestamp() {
        Ok(ts) => windows_datetime_to_rfc3339(ts).ok_or_else(|| {
            "internal_error: location timestamp unavailable".to_string()
        })?,
        Err(e) => {
            return Err(format!("internal_error: timestamp: {e}"));
        }
    };

    let address = position
        .CivicAddress()
        .ok()
        .and_then(|civic| format_civic(&civic));

    Ok(LocationInfo {
        latitude: basic.Latitude,
        longitude: basic.Longitude,
        accuracy,
        at,
        address,
    })
}

/// Join non-empty civic fields into a coarse address string.
fn format_civic(civic: &CivicAddress) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    push_hstring(&mut parts, civic.City());
    push_hstring(&mut parts, civic.State());
    push_hstring(&mut parts, civic.PostalCode());
    push_hstring(&mut parts, civic.Country());
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

/// Append a trimmed HSTRING when the WinRT getter succeeds with non-empty text.
fn push_hstring(
    parts: &mut Vec<String>,
    value: windows::core::Result<windows::core::HSTRING>,
) {
    if let Ok(value) = value {
        let trimmed = value.to_string();
        let trimmed = trimmed.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }
}

/// Convert a WinRT DateTime (100ns since 1601-01-01 UTC) to RFC3339.
fn windows_datetime_to_rfc3339(ts: windows::Foundation::DateTime) -> Option<String> {
    const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;
    let unix_100ns = ts.UniversalTime.checked_sub(EPOCH_DIFF_100NS)?;
    let secs = unix_100ns / 10_000_000;
    let nanos = ((unix_100ns % 10_000_000) * 100) as u32;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(secs) * 1_000_000_000 + i128::from(nanos),
    )
    .ok()?;
    dt.format(&time::format_description::well_known::Rfc3339)
        .ok()
}
