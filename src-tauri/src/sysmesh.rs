//! Desktop system mesh via Headscale-compatible `tailscaled` (TUN + MagicDNS).
//!
//! iOS keeps the in-process tsnet dialer; desktop joins the mesh the same way
//! the Nas host does (`tailscale up --login-server …`) so Terminal can reach
//! `os.dadi` and other MagicDNS names.

#![cfg(not(target_os = "ios"))]

use crate::logutil;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// Returned from `mesh_start` when the OS TUN is up — frontend uses direct `*.dadi` URLs.
pub const SYSTEM_MESH_SENTINEL: u16 = 0;

const JOIN_TIMEOUT: Duration = Duration::from_secs(45);
const DAEMON_WAIT: Duration = Duration::from_secs(20);

static DAEMON_PID: Mutex<Option<u32>> = Mutex::new(None);

struct Bins {
    tailscale: PathBuf,
    tailscaled: PathBuf,
}

/// Bring up system Tailscale against Headscale. Returns [`SYSTEM_MESH_SENTINEL`].
pub fn start(
    app: &AppHandle,
    control_url: &str,
    auth_key: &str,
    hostname: &str,
) -> Result<u16, String> {
    let state_dir = sysmesh_dir(app)?;
    let socket = local_api_path(&state_dir);
    let bins = resolve_bins(app)?;

    ensure_daemon(&bins, &state_dir, &socket)?;
    tailscale_up(&bins, &socket, control_url, auth_key, hostname)?;
    wait_until_running(&bins, &socket)?;

    logutil::emit(
        "info",
        format!("sysmesh up hostname={hostname} login-server={control_url}"),
    );
    Ok(SYSTEM_MESH_SENTINEL)
}

/// Leave the mesh (`tailscale down`) and stop the managed daemon when we started it.
pub fn stop(app: &AppHandle) -> Result<(), String> {
    let state_dir = sysmesh_dir(app)?;
    let socket = local_api_path(&state_dir);
    if let Ok(bins) = resolve_bins(app) {
        let mut args = socket_cli_args(&socket);
        args.push("down".into());
        let _ = Command::new(&bins.tailscale)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    stop_daemon(&state_dir, &socket);
    logutil::emit("info", "sysmesh down");
    Ok(())
}

/// `2` connected / `0` disconnected (matches dadimesh_status shape).
pub fn status(app: &AppHandle) -> u8 {
    let Ok(state_dir) = sysmesh_dir(app) else {
        return 0;
    };
    let socket = local_api_path(&state_dir);
    let Ok(bins) = resolve_bins(app) else {
        return 0;
    };
    if backend_running(&bins, &socket) {
        2
    } else {
        0
    }
}

fn sysmesh_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = data.join("sysmesh");
    fs::create_dir_all(&dir).map_err(|e| format!("create sysmesh dir: {e}"))?;
    Ok(dir)
}

/// LocalAPI endpoint: Unix socket on Unix; named pipe on Windows.
fn local_api_path(state_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let _ = state_dir;
        PathBuf::from(r"\\.\pipe\dadi-sysmesh")
    }
    #[cfg(not(windows))]
    {
        state_dir.join("tailscaled.sock")
    }
}

fn platform_bin_dir() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-amd64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-amd64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-amd64"
    } else {
        "unsupported"
    }
}

fn resolve_bins(app: &AppHandle) -> Result<Bins, String> {
    let names = if cfg!(windows) {
        ("tailscale.exe", "tailscaled.exe")
    } else {
        ("tailscale", "tailscaled")
    };
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("bin").join(platform_bin_dir()));
        candidates.push(res.join(platform_bin_dir()));
        candidates.push(res.clone());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("bin").join(platform_bin_dir()));
            candidates.push(dir.join(platform_bin_dir()));
            candidates.push(dir.to_path_buf());
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join(platform_bin_dir()),
    );

    for dir in &candidates {
        let tailscale = dir.join(names.0);
        let tailscaled = dir.join(names.1);
        if !(tailscale.is_file() && tailscaled.is_file()) {
            continue;
        }
        #[cfg(windows)]
        {
            let wintun = dir.join("wintun.dll");
            if !wintun.is_file() {
                return Err(format!(
                    "wintun.dll missing next to {} — run `cd net && ./build-tailscale.sh windows-amd64`",
                    dir.display()
                ));
            }
        }
        return Ok(Bins {
            tailscale,
            tailscaled,
        });
    }

    Err(format!(
        "tailscale/tailscaled binaries not found (looked under resource/bin/{0}). Run `cd net && ./build-tailscale.sh {0}`.",
        platform_bin_dir()
    ))
}

fn socket_cli_args(socket: &Path) -> Vec<String> {
    vec!["--socket".into(), socket.to_string_lossy().into_owned()]
}

fn socket_live(socket: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::net::UnixStream;
        match UnixStream::connect(socket) {
            Ok(mut s) => {
                let _ = s.write_all(&[]);
                true
            }
            Err(_) => false,
        }
    }
    #[cfg(windows)]
    {
        // Named pipe readiness is probed via `tailscale status` in ensure_daemon.
        let _ = socket;
        false
    }
}

fn ensure_daemon(bins: &Bins, state_dir: &Path, socket: &Path) -> Result<(), String> {
    if socket_live(socket) {
        return Ok(());
    }
    start_daemon(bins, state_dir, socket)?;
    let deadline = Instant::now() + DAEMON_WAIT;
    while Instant::now() < deadline {
        if socket_live(socket) || daemon_reports_via_cli(bins, socket) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "tailscaled did not open socket at {} within {}s — check sysmesh/tailscaled.log (macOS may prompt for admin to create the TUN).",
        socket.display(),
        DAEMON_WAIT.as_secs()
    ))
}

fn daemon_reports_via_cli(bins: &Bins, socket: &Path) -> bool {
    let mut args = socket_cli_args(socket);
    args.push("status".into());
    Command::new(&bins.tailscale)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn start_daemon(bins: &Bins, state_dir: &Path, socket: &Path) -> Result<(), String> {
    let log_path = state_dir.join("tailscaled.log");
    #[cfg(unix)]
    {
        let _ = fs::remove_file(socket);
    }

    #[cfg(target_os = "macos")]
    {
        return start_daemon_macos(bins, state_dir, socket, &log_path);
    }

    #[cfg(target_os = "linux")]
    {
        return start_daemon_linux(bins, state_dir, socket, &log_path);
    }

    #[cfg(windows)]
    {
        return start_daemon_windows(bins, state_dir, socket, &log_path);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        spawn_daemon_process(bins, state_dir, socket, &log_path)
    }
}

fn spawn_daemon_process(
    bins: &Bins,
    state_dir: &Path,
    socket: &Path,
    log_path: &Path,
) -> Result<(), String> {
    let log = fs::File::create(log_path).map_err(|e| format!("tailscaled log: {e}"))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("tailscaled log: {e}"))?;
    let child = Command::new(&bins.tailscaled)
        .arg("--statedir")
        .arg(state_dir)
        .arg("--socket")
        .arg(socket)
        .arg("--verbose=1")
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err)
        .spawn()
        .map_err(|e| {
            format!("failed to start tailscaled (TUN usually needs admin / CAP_NET_ADMIN): {e}")
        })?;
    if let Ok(mut guard) = DAEMON_PID.lock() {
        *guard = Some(child.id());
    }
    std::mem::forget(child);
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_daemon_macos(
    bins: &Bins,
    state_dir: &Path,
    socket: &Path,
    log_path: &Path,
) -> Result<(), String> {
    if spawn_daemon_process(bins, state_dir, socket, log_path).is_ok() {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if socket_live(socket) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    let script = format!(
        "/bin/mkdir -p {statedir} && /bin/rm -f {socket} && {tailscaled} --statedir={statedir} --socket={socket} --verbose=1 >{log} 2>&1 & echo $! >{pidfile}; sleep 1; /bin/chmod 666 {socket} 2>/dev/null; true",
        statedir = sh_single_quote(&state_dir.to_string_lossy()),
        socket = sh_single_quote(&socket.to_string_lossy()),
        tailscaled = sh_single_quote(&bins.tailscaled.to_string_lossy()),
        log = sh_single_quote(&log_path.to_string_lossy()),
        pidfile = sh_single_quote(&state_dir.join("tailscaled.pid").to_string_lossy()),
    );

    let apple = format!(
        "do shell script \"{}\" with administrator privileges",
        apple_escape(&script)
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&apple)
        .output()
        .map_err(|e| format!("osascript (admin TUN): {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "admin approval required to create the dadiMesh TUN: {err}"
        ));
    }

    let deadline = Instant::now() + DAEMON_WAIT;
    while Instant::now() < deadline {
        if socket.exists() {
            let _ = Command::new("/bin/chmod")
                .args(["666", &socket.to_string_lossy()])
                .status();
            if socket_live(socket) {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn start_daemon_linux(
    bins: &Bins,
    state_dir: &Path,
    socket: &Path,
    log_path: &Path,
) -> Result<(), String> {
    if spawn_daemon_process(bins, state_dir, socket, log_path).is_ok() {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if socket_live(socket) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    let script = format!(
        "mkdir -p {statedir} && rm -f {socket} && {tailscaled} --statedir={statedir} --socket={socket} --verbose=1 >{log} 2>&1 & echo $! >{pidfile}; sleep 1; chmod 666 {socket} 2>/dev/null; true",
        statedir = sh_single_quote(&state_dir.to_string_lossy()),
        socket = sh_single_quote(&socket.to_string_lossy()),
        tailscaled = sh_single_quote(&bins.tailscaled.to_string_lossy()),
        log = sh_single_quote(&log_path.to_string_lossy()),
        pidfile = sh_single_quote(&state_dir.join("tailscaled.pid").to_string_lossy()),
    );

    let elevators = [
        ("pkexec", vec!["/bin/sh".into(), "-c".into(), script.clone()]),
        ("sudo", vec!["-n".into(), "/bin/sh".into(), "-c".into(), script.clone()]),
    ];
    let mut last_err = String::from("no pkexec/sudo available");
    for (bin, args) in elevators {
        let output = Command::new(bin).args(&args).output();
        match output {
            Ok(o) if o.status.success() => {
                let deadline = Instant::now() + DAEMON_WAIT;
                while Instant::now() < deadline {
                    if socket_live(socket) {
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(200));
                }
                return Ok(());
            }
            Ok(o) => {
                last_err = format!(
                    "{bin}: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                );
            }
            Err(e) => last_err = format!("{bin}: {e}"),
        }
    }
    Err(format!(
        "admin / CAP_NET_ADMIN required to create the dadiMesh TUN ({last_err})"
    ))
}

#[cfg(windows)]
fn start_daemon_windows(
    bins: &Bins,
    state_dir: &Path,
    socket: &Path,
    log_path: &Path,
) -> Result<(), String> {
    if spawn_daemon_process(bins, state_dir, socket, log_path).is_ok() {
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if daemon_reports_via_cli(bins, socket) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    let cmd_line = format!(
        "\"{}\" --statedir=\"{}\" --socket=\"{}\" --verbose=1 >\"{}\" 2>&1",
        bins.tailscaled.display(),
        state_dir.display(),
        socket.display(),
        log_path.display(),
    );
    let elevate = format!(
        "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',{} -Verb RunAs -WindowStyle Hidden",
        ps_quote(&cmd_line)
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &elevate])
        .output()
        .map_err(|e| format!("elevated tailscaled (UAC): {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "admin approval required to create the dadiMesh TUN (Wintun): {err}"
        ));
    }

    let deadline = Instant::now() + DAEMON_WAIT;
    while Instant::now() < deadline {
        if daemon_reports_via_cli(bins, socket) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "elevated tailscaled did not become ready within {}s — check {} (Wintun/UAC)",
        DAEMON_WAIT.as_secs(),
        log_path.display()
    ))
}

fn stop_daemon(state_dir: &Path, socket: &Path) {
    if let Ok(mut guard) = DAEMON_PID.lock() {
        if let Some(pid) = guard.take() {
            let _ = Command::new(if cfg!(windows) { "taskkill" } else { "kill" })
                .args(if cfg!(windows) {
                    vec!["/PID".into(), pid.to_string(), "/F".into()]
                } else {
                    vec![pid.to_string()]
                })
                .status();
        }
    }
    #[cfg(unix)]
    {
        if let Ok(output) = Command::new("lsof")
            .args(["-t", &format!("--{}", socket.display())])
            .output()
        {
            for pid in String::from_utf8_lossy(&output.stdout).split_whitespace() {
                let _ = Command::new("kill").arg(pid).status();
            }
        }
        let pidfile = state_dir.join("tailscaled.pid");
        if let Ok(pid) = fs::read_to_string(&pidfile) {
            let _ = Command::new("kill").arg(pid.trim()).status();
        }
        let _ = fs::remove_file(socket);
    }
    #[cfg(windows)]
    {
        let _ = socket;
        let pidfile = state_dir.join("tailscaled.pid");
        if let Ok(pid) = fs::read_to_string(&pidfile) {
            let _ = Command::new("taskkill")
                .args(["/PID", pid.trim(), "/F"])
                .status();
        }
    }
}

fn tailscale_up(
    bins: &Bins,
    socket: &Path,
    control_url: &str,
    auth_key: &str,
    hostname: &str,
) -> Result<(), String> {
    let login = control_url.trim_end_matches('/');
    let mut args = socket_cli_args(socket);
    args.extend([
        "up".into(),
        format!("--login-server={login}"),
        format!("--authkey={auth_key}"),
        format!("--hostname={hostname}"),
        "--accept-dns=true".into(),
        "--reset".into(),
    ]);
    let output = Command::new(&bins.tailscale)
        .args(&args)
        .output()
        .map_err(|e| format!("tailscale up: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "tailscale up failed: {} {}",
            stderr.trim(),
            stdout.trim()
        ));
    }
    Ok(())
}

fn wait_until_running(bins: &Bins, socket: &Path) -> Result<(), String> {
    let deadline = Instant::now() + JOIN_TIMEOUT;
    while Instant::now() < deadline {
        if backend_running(bins, socket) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(400));
    }
    Err("dadiMesh join timed out. Check the setup code or network.".into())
}

fn backend_running(bins: &Bins, socket: &Path) -> bool {
    let mut args = socket_cli_args(socket);
    args.extend(["status".into(), "--json".into()]);
    let output = Command::new(&bins.tailscale).args(&args).output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let body = String::from_utf8_lossy(&output.stdout);
    body.contains("\"BackendState\":\"Running\"")
        || body.contains("\"BackendState\": \"Running\"")
}

fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(windows)]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg(target_os = "macos")]
fn apple_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}
