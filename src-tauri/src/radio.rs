//! Bluetooth radio for Matter commissioning.
//! Ghar stays on the stationary server; this adapter is the air interface.

use serde::Serialize;

#[derive(Clone, Serialize)]
struct RadioBytes {
    address: String,
    value_b64: String,
}

#[derive(Clone, Serialize)]
struct RadioAddress {
    address: String,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desk {
    use super::{RadioAddress, RadioBytes};
    use crate::logutil;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use btleplug::api::{
        Central, CentralEvent, CharPropFlags, Manager as _, Peripheral as _, ScanFilter, WriteType,
    };
    use btleplug::platform::{Adapter, Manager as BleManager, Peripheral};
    use futures_util::StreamExt;
    use std::collections::HashMap;
    use tauri::{AppHandle, Emitter, Manager, State};
    use tokio::sync::{watch, Mutex};
    use uuid::{uuid, Uuid};

    const MATTER: Uuid = uuid!("0000fff6-0000-1000-8000-00805f9b34fb");
    const C1: Uuid = uuid!("18ee2ef5-263d-4559-959f-4f9c429f9d11");
    const C2: Uuid = uuid!("18ee2ef5-263d-4559-959f-4f9c429f9d12");

    struct RadioInner {
        adapter: Option<Adapter>,
        peripherals: HashMap<String, Peripheral>,
        stop_scan: Option<watch::Sender<bool>>,
        stop_notify: HashMap<String, watch::Sender<bool>>,
    }

    /// Local Bluetooth adapter used while this Hath is Ghar's radio.
    pub struct RadioState {
        inner: Mutex<RadioInner>,
    }

    impl Default for RadioState {
        fn default() -> Self {
            Self {
                inner: Mutex::new(RadioInner {
                    adapter: None,
                    peripherals: HashMap::new(),
                    stop_scan: None,
                    stop_notify: HashMap::new(),
                }),
            }
        }
    }

    /// Return the cached adapter, or the first adapter from the system manager.
    async fn ensure_adapter(state: &RadioState) -> Result<Adapter, String> {
        let mut inner = state.inner.lock().await;
        if let Some(adapter) = &inner.adapter {
            return Ok(adapter.clone());
        }
        let manager = BleManager::new()
            .await
            .map_err(|err| format!("radio_unavailable: {err}"))?;
        let adapters = manager
            .adapters()
            .await
            .map_err(|err| format!("radio_unavailable: {err}"))?;
        let adapter = adapters
            .into_iter()
            .next()
            .ok_or_else(|| "radio_unavailable: no bluetooth adapter".to_string())?;
        inner.adapter = Some(adapter.clone());
        Ok(adapter)
    }

    /// Matter service data, including the short UUID some stacks advertise.
    fn matter_payload(map: &HashMap<Uuid, Vec<u8>>) -> Option<Vec<u8>> {
        if let Some(bytes) = map.get(&MATTER) {
            return Some(bytes.clone());
        }
        map.iter()
            .find(|(id, _)| {
                let text = id.to_string();
                text.starts_with("0000fff6") || text.ends_with("fff6")
            })
            .map(|(_, bytes)| bytes.clone())
    }

    /// Log a webview emit that failed. The scan keeps running; the log is the failure.
    fn emit_fail(err: impl std::fmt::Display) {
        logutil::emit("error", &format!("radio event failed: {err}"));
    }

    /// Start reporting Matter advertisements.
    #[tauri::command]
    pub async fn radio_start_scan(app: AppHandle, state: State<'_, RadioState>) -> Result<(), String> {
        let adapter = ensure_adapter(&state).await?;
        let mut stop = {
            let mut inner = state.inner.lock().await;
            if inner.stop_scan.is_some() {
                return Ok(());
            }
            let (tx, rx) = watch::channel(false);
            inner.stop_scan = Some(tx);
            rx
        };
        if let Err(err) = adapter.start_scan(ScanFilter::default()).await {
            let mut inner = state.inner.lock().await;
            inner.stop_scan = None;
            return Err(format!("radio_unavailable: {err}"));
        }
        let adapter = adapter.clone();
        tokio::spawn(async move {
            let mut events = match adapter.events().await {
                Ok(events) => events,
                Err(err) => {
                    if let Err(emit_err) = app.emit("radio-error", err.to_string()) {
                        emit_fail(emit_err);
                    }
                    return;
                }
            };
            loop {
                tokio::select! {
                    changed = stop.changed() => {
                        if changed.is_err() || *stop.borrow() {
                            break;
                        }
                    }
                    event = events.next() => {
                        let Some(event) = event else { break };
                        note_event(&app, &adapter, event).await;
                    }
                }
            }
            if let Err(err) = adapter.stop_scan().await {
                logutil::emit("warn", &format!("radio stop scan: {err}"));
            }
        });
        Ok(())
    }

    async fn note_event(app: &AppHandle, adapter: &Adapter, event: CentralEvent) {
        match event {
            CentralEvent::ServiceDataAdvertisement { id, service_data } => {
                let Some(bytes) = matter_payload(&service_data) else {
                    return;
                };
                publish(app, adapter, id, bytes).await;
            }
            CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => {
                let peripheral = match adapter.peripheral(&id).await {
                    Ok(peripheral) => peripheral,
                    Err(err) => {
                        logutil::emit("warn", &format!("radio peripheral: {err}"));
                        return;
                    }
                };
                let props = match peripheral.properties().await {
                    Ok(Some(props)) => props,
                    Ok(None) => return,
                    Err(err) => {
                        logutil::emit("warn", &format!("radio advertisement: {err}"));
                        return;
                    }
                };
                let Some(bytes) = matter_payload(&props.service_data) else {
                    return;
                };
                publish(app, adapter, id, bytes).await;
            }
            CentralEvent::DeviceDisconnected(id) => {
                let payload = RadioAddress {
                    address: id.to_string(),
                };
                if let Err(err) = app.emit("radio-disconnected", payload) {
                    emit_fail(err);
                }
            }
            _ => {}
        }
    }

    async fn publish(app: &AppHandle, adapter: &Adapter, id: btleplug::platform::PeripheralId, bytes: Vec<u8>) {
        let address = id.to_string();
        match adapter.peripheral(&id).await {
            Ok(peripheral) => {
                let radio = app.state::<RadioState>();
                radio
                    .inner
                    .lock()
                    .await
                    .peripherals
                    .insert(address.clone(), peripheral);
            }
            Err(err) => {
                logutil::emit("warn", &format!("radio peripheral {address}: {err}"));
                return;
            }
        }
        let payload = RadioBytes {
            address,
            value_b64: STANDARD.encode(bytes),
        };
        if let Err(err) = app.emit("radio-advertisement", payload) {
            emit_fail(err);
        }
    }

    /// Stop reporting advertisements. Safe when a scan is not running.
    async fn halt_scan(state: &RadioState) -> Result<(), String> {
        let adapter = {
            let inner = state.inner.lock().await;
            inner.adapter.clone()
        };
        let stop = {
            let mut inner = state.inner.lock().await;
            inner.stop_scan.take()
        };
        if let Some(stop) = stop {
            if let Err(err) = stop.send(true) {
                logutil::emit("warn", &format!("radio scan already stopped: {err}"));
            }
        }
        if let Some(adapter) = adapter {
            adapter
                .stop_scan()
                .await
                .map_err(|err| format!("radio_unavailable: {err}"))?;
        }
        Ok(())
    }

    /// Stop reporting advertisements. Safe when a scan is not running.
    #[tauri::command]
    pub async fn radio_stop_scan(state: State<'_, RadioState>) -> Result<(), String> {
        halt_scan(&state).await
    }

    fn take_peripheral(inner: &RadioInner, address: &str) -> Result<Peripheral, String> {
        inner
            .peripherals
            .get(address)
            .cloned()
            .ok_or_else(|| format!("radio_unavailable: {address} is not in the scan"))
    }

    /// Connect and discover GATT. Stops scanning first so the adapter can connect.
    #[tauri::command]
    pub async fn radio_connect(state: State<'_, RadioState>, address: String) -> Result<(), String> {
        let peripheral = {
            let inner = state.inner.lock().await;
            take_peripheral(&inner, &address)?
        };
        halt_scan(&state).await?;
        peripheral
            .connect()
            .await
            .map_err(|err| format!("radio_unavailable: {err}"))?;
        peripheral
            .discover_services()
            .await
            .map_err(|err| format!("radio_unavailable: {err}"))?;
        Ok(())
    }

    fn characteristic(
        peripheral: &Peripheral,
        id: Uuid,
    ) -> Result<btleplug::api::Characteristic, String> {
        peripheral
            .characteristics()
            .into_iter()
            .find(|item| item.uuid == id)
            .ok_or_else(|| format!("radio_unavailable: missing characteristic {id}"))
    }

    /// Write one BTP fragment to the Matter C1 characteristic.
    #[tauri::command]
    pub async fn radio_write(
        state: State<'_, RadioState>,
        address: String,
        value_b64: String,
    ) -> Result<(), String> {
        let peripheral = {
            let inner = state.inner.lock().await;
            take_peripheral(&inner, &address)?
        };
        let bytes = STANDARD
            .decode(value_b64)
            .map_err(|err| format!("radio write: {err}"))?;
        let char = characteristic(&peripheral, C1)?;
        let write_type = if char.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) {
            WriteType::WithoutResponse
        } else if char.properties.contains(CharPropFlags::WRITE) {
            WriteType::WithResponse
        } else {
            return Err("radio_unavailable: C1 does not accept writes".to_string());
        };
        peripheral
            .write(&char, &bytes, write_type)
            .await
            .map_err(|err| format!("radio_unavailable: {err}"))
    }

    /// Subscribe to Matter C2 notifications and forward them to the webview.
    #[tauri::command]
    pub async fn radio_subscribe(app: AppHandle, state: State<'_, RadioState>, address: String) -> Result<(), String> {
        let peripheral = {
            let inner = state.inner.lock().await;
            take_peripheral(&inner, &address)?
        };
        let char = characteristic(&peripheral, C2)?;
        if !char.properties.contains(CharPropFlags::NOTIFY) {
            return Err("radio_unavailable: C2 does not notify".to_string());
        }
        peripheral
            .subscribe(&char)
            .await
            .map_err(|err| format!("radio_unavailable: {err}"))?;
        let mut notes = peripheral
            .notifications()
            .await
            .map_err(|err| format!("radio_unavailable: {err}"))?;
        let (tx, mut rx) = watch::channel(false);
        {
            let mut inner = state.inner.lock().await;
            if let Some(previous) = inner.stop_notify.insert(address.clone(), tx) {
                if let Err(err) = previous.send(true) {
                    logutil::emit("warn", &format!("radio notify already stopped: {err}"));
                }
            }
        }
        let target = address.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = rx.changed() => {
                        if changed.is_err() || *rx.borrow() {
                            break;
                        }
                    }
                    note = notes.next() => {
                        let Some(note) = note else { break };
                        if note.uuid != C2 {
                            continue;
                        }
                        let payload = RadioBytes {
                            address: target.clone(),
                            value_b64: STANDARD.encode(note.value),
                        };
                        if let Err(err) = app.emit("radio-notification", payload) {
                            emit_fail(err);
                        }
                    }
                }
            }
        });
        Ok(())
    }

    /// Drop the GATT connection. Already disconnected is success.
    #[tauri::command]
    pub async fn radio_disconnect(state: State<'_, RadioState>, address: String) -> Result<(), String> {
        let peripheral = {
            let mut inner = state.inner.lock().await;
            if let Some(stop) = inner.stop_notify.remove(&address) {
                if let Err(err) = stop.send(true) {
                    logutil::emit("warn", &format!("radio notify already stopped: {err}"));
                }
            }
            inner.peripherals.get(&address).cloned()
        };
        let Some(peripheral) = peripheral else {
            return Ok(());
        };
        if !peripheral
            .is_connected()
            .await
            .map_err(|err| format!("radio_unavailable: {err}"))?
        {
            return Ok(());
        }
        peripheral
            .disconnect()
            .await
            .map_err(|err| format!("radio_unavailable: {err}"))
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
mod desk {
    use tauri::AppHandle;
    use tauri::State;

    /// No Bluetooth bridge on this target.
    pub struct RadioState;

    impl Default for RadioState {
        fn default() -> Self {
            Self
        }
    }

    /// Reject a radio command on a target with no Bluetooth bridge.
    fn unavailable() -> Result<(), String> {
        Err("radio_unavailable: bluetooth commissioning runs on the desktop app".to_string())
    }

    /// Start reporting Matter advertisements.
    #[tauri::command]
    pub async fn radio_start_scan(_app: AppHandle, _state: State<'_, RadioState>) -> Result<(), String> {
        unavailable()
    }

    /// Stop reporting advertisements.
    #[tauri::command]
    pub async fn radio_stop_scan(_state: State<'_, RadioState>) -> Result<(), String> {
        unavailable()
    }

    /// Connect and discover GATT.
    #[tauri::command]
    pub async fn radio_connect(_state: State<'_, RadioState>, _address: String) -> Result<(), String> {
        unavailable()
    }

    /// Write one BTP fragment.
    #[tauri::command]
    pub async fn radio_write(
        _state: State<'_, RadioState>,
        _address: String,
        _value_b64: String,
    ) -> Result<(), String> {
        unavailable()
    }

    /// Subscribe to notifications.
    #[tauri::command]
    pub async fn radio_subscribe(
        _app: AppHandle,
        _state: State<'_, RadioState>,
        _address: String,
    ) -> Result<(), String> {
        unavailable()
    }

    /// Drop the GATT connection.
    #[tauri::command]
    pub async fn radio_disconnect(_state: State<'_, RadioState>, _address: String) -> Result<(), String> {
        unavailable()
    }
}

pub use desk::{
    __cmd__radio_connect, __cmd__radio_disconnect, __cmd__radio_start_scan, __cmd__radio_stop_scan,
    __cmd__radio_subscribe, __cmd__radio_write, __tauri_command_name_radio_connect,
    __tauri_command_name_radio_disconnect, __tauri_command_name_radio_start_scan,
    __tauri_command_name_radio_stop_scan, __tauri_command_name_radio_subscribe,
    __tauri_command_name_radio_write, radio_connect, radio_disconnect, radio_start_scan,
    radio_stop_scan, radio_subscribe, radio_write, RadioState,
};
