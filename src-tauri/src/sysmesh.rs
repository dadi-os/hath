//! Desktop system mesh via Headscale-compatible `tailscaled` (TUN + MagicDNS).
//!
//! iOS keeps the in-process tsnet dialer; desktop joins the mesh the same way
//! the Nas host does (`tailscale up --login-server …`) so Terminal can reach
//! `os.dadi` and other MagicDNS names.
//!
//! On macOS, `tailscaled` runs as LaunchDaemon `com.dadi.hath.sysmesh` with
//! KeepAlive so it outlives Hath quits, osascript teardown, and Wi‑Fi flaps.
//! Leave mesh only runs `tailscale down` — the daemon stays loaded.

#![cfg(not(target_os = "ios"))]

use crate::logutil;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

const JOIN_TIMEOUT: Duration = Duration::from_secs(45);
const DAEMON_WAIT: Duration = Duration::from_secs(20);

#[cfg(target_os = "macos")]
const MAGIC_DNS_RESOLVER_INSTALL: &str = "/bin/mkdir -p /etc/resolver && /usr/bin/printf 'nameserver 100.100.100.100\\n' > /etc/resolver/dadi && /usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder 2>/dev/null; true";

#[cfg(target_os = "macos")]
const SYSMESH_LAUNCHD_LABEL: &str = "com.dadi.hath.sysmesh";

#[cfg(target_os = "macos")]
const SYSMESH_LAUNCHD_PLIST: &str = "/Library/LaunchDaemons/com.dadi.hath.sysmesh.plist";

struct Bins {
    tailscale: PathBuf,
    tailscaled: PathBuf,
}

/// Bring up system Tailscale against Headscale. Returns the local MagicDNS HTTP proxy port.
pub fn start(
    app: &AppHandle,
    control_url: &str,
    auth_key: &str,
    hostname: &str,
) -> Result<u16, String> {
    let state_dir = sysmesh_dir(app)?;
    let socket = local_api_path(&state_dir);
    let bins = resolve_bins(app)?;

    logutil::emit("info", format!("sysmesh start hostname={hostname} login-server={control_url}"));
    ensure_daemon(&bins, &state_dir, &socket)?;
    if backend_running(&bins, &socket) {
        logutil::emit("info", "sysmesh already Running; skipping tailscale up");
    } else {
        tailscale_up(&bins, &socket, control_url, auth_key, hostname)?;
        wait_until_running(&bins, &socket)?;
    }
    let port = crate::meshproxy::start()?;
    ensure_magic_dns_resolver()?;
    ensure_mesh_ca(app)?;

    logutil::emit(
        "info",
        format!("sysmesh up hostname={hostname} login-server={control_url} proxy=127.0.0.1:{port}"),
    );
    Ok(port)
}

/// Leave the mesh (`tailscale down`) and stop the local HTTP proxy.
///
/// Keeps `tailscaled` (LaunchDaemon on macOS) and `/etc/resolver/dadi` so the
/// next join does not re-prompt for administrator privileges.
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
    crate::meshproxy::stop();
    logutil::emit("info", "sysmesh down (daemon kept for rejoin)");
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

#[cfg(unix)]
fn state_owned_by_root(state_dir: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    state_dir
        .join("tailscaled.state")
        .metadata()
        .map(|m| m.uid() == 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn state_owned_by_root(_state_dir: &Path) -> bool {
    false
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
    std::mem::forget(child);
    Ok(())
}

/// Starts `tailscaled` under LaunchDaemon KeepAlive (survives Hath + shell exit).
#[cfg(target_os = "macos")]
fn start_daemon_macos(
    bins: &Bins,
    state_dir: &Path,
    socket: &Path,
    log_path: &Path,
) -> Result<(), String> {
    if try_reuse_running_daemon(state_dir, socket) {
        logutil::emit("info", "sysmesh reusing existing tailscaled");
        return Ok(());
    }
    if try_launchd_revive(socket) {
        logutil::emit("info", "sysmesh revived via launchd KeepAlive");
        return Ok(());
    }

    if !state_owned_by_root(state_dir) {
        if spawn_daemon_process(bins, state_dir, socket, log_path).is_ok() {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if socket_live(socket) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
    }

    install_macos_launchd_daemon(bins, state_dir, socket, log_path)
}

/// Wait for an already-installed LaunchDaemon to bring the socket back (no password).
#[cfg(target_os = "macos")]
fn try_launchd_revive(socket: &Path) -> bool {
    if !Path::new(SYSMESH_LAUNCHD_PLIST).is_file() {
        return false;
    }
    // KeepAlive restarts crashed jobs on its own; give it a moment.
    if wait_socket_live(socket, Duration::from_secs(6)) {
        return true;
    }
    let domain = format!("system/{SYSMESH_LAUNCHD_LABEL}");
    let _ = Command::new("launchctl")
        .args(["kickstart", "-k", &domain])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    wait_socket_live(socket, Duration::from_secs(8))
}

/// One-time (or repair) admin install: stable binary + LaunchDaemon + resolver.
#[cfg(target_os = "macos")]
fn install_macos_launchd_daemon(
    bins: &Bins,
    state_dir: &Path,
    socket: &Path,
    log_path: &Path,
) -> Result<(), String> {
    let daemon_bin = state_dir.join("bin").join("tailscaled");
    let staged = stage_sysmesh_launchd_plist(&daemon_bin, state_dir, socket, log_path)?;
    let resolver_bit = if macos_magic_dns_resolver_ok() {
        "true"
    } else {
        MAGIC_DNS_RESOLVER_INSTALL
    };

    logutil::emit(
        "info",
        "sysmesh requesting admin to install LaunchDaemon com.dadi.hath.sysmesh",
    );

    // Copy a stable binary under statedir, install the plist, bootstrap + kickstart.
    // launchd owns the process — not osascript — so Hath quit cannot SIGTERM it.
    let script = format!(
        "/bin/mkdir -p {bindir} && \
/bin/cp -f {src} {daemon} && /bin/chmod 755 {daemon} && \
/bin/cp -f {staged} {plist} && /bin/chmod 644 {plist} && \
/bin/launchctl bootout system/{label} 2>/dev/null; \
/bin/launchctl bootstrap system {plist} && \
/bin/launchctl enable system/{label} && \
/bin/launchctl kickstart -k system/{label}; \
/bin/sleep 1; /bin/chmod 666 {socket} 2>/dev/null; {resolver}; true",
        bindir = sh_single_quote(&state_dir.join("bin").to_string_lossy()),
        src = sh_single_quote(&bins.tailscaled.to_string_lossy()),
        daemon = sh_single_quote(&daemon_bin.to_string_lossy()),
        staged = sh_single_quote(&staged.to_string_lossy()),
        plist = sh_single_quote(SYSMESH_LAUNCHD_PLIST),
        label = SYSMESH_LAUNCHD_LABEL,
        socket = sh_single_quote(&socket.to_string_lossy()),
        resolver = resolver_bit,
    );

    let apple = format!(
        "do shell script \"{}\" with administrator privileges",
        apple_escape(&script)
    );

    let mut child = Command::new("osascript")
        .arg("-e")
        .arg(&apple)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("osascript (admin LaunchDaemon): {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if socket.exists() {
            let _ = Command::new("/bin/chmod")
                .args(["666", &socket.to_string_lossy()])
                .status();
            if socket_live(socket) {
                // Do not leave osascript hanging — wait briefly for a clean exit.
                let _ = child.try_wait();
                return Ok(());
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                let err = match child.stderr.take() {
                    Some(mut s) => {
                        let mut buf = String::new();
                        let _ = std::io::Read::read_to_string(&mut s, &mut buf);
                        buf
                    }
                    None => String::new(),
                };
                return Err(format!(
                    "admin approval required to install the dadiMesh LaunchDaemon: {err}"
                ));
            }
            Ok(Some(_)) => {
                if wait_socket_live(socket, Duration::from_secs(5)) {
                    return Ok(());
                }
                let log = fs::read_to_string(log_path).unwrap_or_default();
                return Err(format!(
                    "LaunchDaemon installed but tailscaled socket never came up — {}",
                    log.trim()
                ));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("osascript (admin LaunchDaemon): {e}")),
        }
        if Instant::now() >= deadline {
            return Err(
                "admin approval timed out. Approve the password prompt, then join again.".into(),
            );
        }
        thread::sleep(Duration::from_millis(200));
    }
}

/// Stage a KeepAlive LaunchDaemon plist in a user-writable temp path.
#[cfg(target_os = "macos")]
fn stage_sysmesh_launchd_plist(
    daemon_bin: &Path,
    state_dir: &Path,
    socket: &Path,
    log_path: &Path,
) -> Result<PathBuf, String> {
    let staged = std::env::temp_dir().join("com.dadi.hath.sysmesh.plist");
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{daemon}</string>
    <string>--statedir={statedir}</string>
    <string>--socket={socket}</string>
    <string>--verbose=1</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
  <key>ThrottleInterval</key>
  <integer>2</integer>
</dict>
</plist>
"#,
        label = SYSMESH_LAUNCHD_LABEL,
        daemon = xml_escape(&daemon_bin.to_string_lossy()),
        statedir = xml_escape(&state_dir.to_string_lossy()),
        socket = xml_escape(&socket.to_string_lossy()),
        log = xml_escape(&log_path.to_string_lossy()),
    );
    fs::write(&staged, xml).map_err(|e| format!("stage LaunchDaemon plist: {e}"))?;
    Ok(staged)
}

#[cfg(target_os = "macos")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(target_os = "macos")]
fn wait_socket_live(socket: &Path, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if socket.exists() {
            let _ = Command::new("/bin/chmod")
                .args(["666", &socket.to_string_lossy()])
                .status();
        }
        if socket_live(socket) {
            return true;
        }
        thread::sleep(Duration::from_millis(150));
    }
    false
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

    // nohup + redirect so the elevated shell exit cannot take the daemon with it.
    let script = format!(
        "mkdir -p {statedir} && rm -f {socket} && nohup {tailscaled} --statedir={statedir} --socket={socket} --verbose=1 >{log} 2>&1 </dev/null & echo $! >{pidfile}; sleep 1; chmod 666 {socket} 2>/dev/null; true",
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

/// Strip Windows `\\?\` / `\\?\UNC\` prefixes so `cmd` and PowerShell accept the path.
#[cfg(windows)]
fn win_shell_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

/// Starts elevated `tailscaled` on Windows (Wintun + named-pipe SDDL need admin).
///
/// Unelevated listen always fails with ERROR_INVALID_OWNER (`O:BA` pipe SDDL).
/// Elevates the exe via `RunAs` with WorkingDirectory set so `wintun.dll` loads;
/// paths are stripped of Rust's `\\?\` prefix (`cmd` cannot open those).
#[cfg(windows)]
fn start_daemon_windows(
    bins: &Bins,
    state_dir: &Path,
    socket: &Path,
    log_path: &Path,
) -> Result<(), String> {
    let bin_dir = bins.tailscaled.parent().ok_or_else(|| {
        format!(
            "tailscaled path has no parent directory: {}",
            bins.tailscaled.display()
        )
    })?;
    let exe = win_shell_path(&bins.tailscaled);
    let workdir = win_shell_path(bin_dir);
    let statedir = win_shell_path(state_dir);
    let sock = win_shell_path(socket);

    fs::write(
        log_path,
        format!(
            "elevating tailscaled exe={exe} workdir={workdir}\r\n\
             (elevated stdout is not captured under UAC RunAs; Tailscale also logs under %LocalAppData%\\Tailscale)\r\n"
        ),
    )
    .map_err(|e| format!("write tailscaled elevate log: {e}"))?;

    let elevate = format!(
        "Start-Process -FilePath {} -WorkingDirectory {} -ArgumentList {},{},{} -Verb RunAs -WindowStyle Hidden",
        ps_quote(&exe),
        ps_quote(&workdir),
        ps_quote(&format!("--statedir={statedir}")),
        ps_quote(&format!("--socket={sock}")),
        ps_quote("--verbose=1"),
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
    Err(windows_daemon_ready_timeout(log_path))
}

/// Builds the Windows daemon-ready timeout error.
///
/// Elevated stdout is not redirected under UAC `RunAs`, so this points at the
/// elevate header we wrote plus Tailscale's own LocalAppData logs.
#[cfg(windows)]
fn windows_daemon_ready_timeout(log_path: &Path) -> String {
    format!(
        "elevated tailscaled did not become ready within {}s — approve UAC if prompted; see {} and %LocalAppData%\\Tailscale (leftover C:\\ProgramData\\Tailscale can also block Wintun)",
        DAEMON_WAIT.as_secs(),
        log_path.display()
    )
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

fn ensure_magic_dns_resolver() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if macos_magic_dns_resolver_ok() {
            return Ok(());
        }
        logutil::emit("info", "sysmesh installing /etc/resolver/dadi for os.dadi");
        run_osascript_admin(MAGIC_DNS_RESOLVER_INSTALL)?;
        if !macos_magic_dns_resolver_ok() {
            return Err(
                "admin approval required to resolve os.dadi (install /etc/resolver/dadi)".into(),
            );
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Trust the mesh CA so Bitwarden can use https://chaavi.dadi.
///
/// Prefers `ca_pem` from saved credentials; otherwise fetches `GET /ca` from nas.dadi.
fn ensure_mesh_ca(app: &AppHandle) -> Result<(), String> {
    let pem = match load_ca_pem(app) {
        Some(p) if p.contains("BEGIN CERTIFICATE") => p,
        _ => match fetch_ca_pem_from_nas() {
            Ok(p) => p,
            Err(e) => {
                logutil::emit("warn", format!("sysmesh mesh CA unavailable: {e}"));
                return Ok(());
            }
        },
    };
    let ca_path = sysmesh_dir(app)?.join("mesh-ca.crt");
    fs::write(&ca_path, pem.as_bytes()).map_err(|e| format!("write mesh CA: {e}"))?;
    if let Err(e) = install_mesh_ca(&ca_path) {
        // Do not fail join — recover loops would re-prompt forever on cancel.
        logutil::emit("warn", format!("sysmesh mesh CA install deferred: {e}"));
    }
    Ok(())
}

fn load_ca_pem(app: &AppHandle) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join("credentials.json");
    let raw = fs::read_to_string(path).ok()?;
    let creds: crate::net::Credentials = serde_json::from_str(raw.trim()).ok()?;
    creds.ca_pem.filter(|p| p.contains("BEGIN CERTIFICATE"))
}

fn fetch_ca_pem_from_nas() -> Result<String, String> {
    // After MagicDNS resolver install, nas.dadi resolves on the mesh.
    let output = Command::new("curl")
        .args(["-fsS", "-m", "5", "http://nas.dadi/ca"])
        .output()
        .map_err(|e| format!("curl mesh CA: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "GET /ca failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let body = String::from_utf8(output.stdout).map_err(|e| format!("CA utf8: {e}"))?;
    if !body.contains("BEGIN CERTIFICATE") {
        return Err("GET /ca did not return a PEM certificate".into());
    }
    Ok(body)
}

fn install_mesh_ca(ca_path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if mesh_ca_install_recorded(ca_path) {
            return Ok(());
        }
        if macos_mesh_ca_trusted(ca_path) {
            let _ = record_mesh_ca_install(ca_path);
            return Ok(());
        }
        logutil::emit("info", "sysmesh installing mesh CA for https://chaavi.dadi");
        let path = ca_path.to_string_lossy().replace('\'', "'\\''");
        let script = format!(
            "/usr/bin/security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '{path}'"
        );
        run_osascript_admin(&script)?;
        // Keychain lookup can lag; stamp the PEM so recover/rejoin does not re-prompt.
        record_mesh_ca_install(ca_path)?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let dest = PathBuf::from("/usr/local/share/ca-certificates/dadi-mesh.crt");
        if dest.is_file() {
            if let (Ok(a), Ok(b)) = (fs::read(ca_path), fs::read(&dest)) {
                if a == b {
                    return Ok(());
                }
            }
        }
        let src = sh_single_quote(&ca_path.to_string_lossy());
        let script = format!(
            "mkdir -p /usr/local/share/ca-certificates && cp {src} /usr/local/share/ca-certificates/dadi-mesh.crt && update-ca-certificates"
        );
        let elevators = [
            ("pkexec", vec!["/bin/sh".into(), "-c".into(), script.clone()]),
            ("sudo", vec!["-n".into(), "/bin/sh".into(), "-c".into(), script]),
        ];
        let mut last = String::from("no pkexec/sudo");
        for (bin, args) in elevators {
            match Command::new(bin).args(&args).output() {
                Ok(o) if o.status.success() => return Ok(()),
                Ok(o) => {
                    last = format!(
                        "{bin}: {}",
                        String::from_utf8_lossy(&o.stderr).trim()
                    );
                }
                Err(e) => last = format!("{bin}: {e}"),
            }
        }
        Err(format!("admin approval required to trust mesh CA: {last}"))
    }
    #[cfg(target_os = "windows")]
    {
        let path = ca_path.to_string_lossy();
        let ps = format!("certutil -addstore -f Root {}", ps_quote(&path));
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .output()
            .map_err(|e| format!("certutil: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "admin approval required to trust mesh CA: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = ca_path;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn macos_mesh_ca_trusted(_ca_path: &Path) -> bool {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-certificate",
            "-c",
            "dadi mesh CA",
            "/Library/Keychains/System.keychain",
        ])
        .output();
    matches!(output, Ok(o) if o.status.success())
}

/// True when a prior successful install stamped this exact PEM under sysmesh/.
#[cfg(target_os = "macos")]
fn mesh_ca_install_recorded(ca_path: &Path) -> bool {
    let Some(stamp) = ca_path.parent().map(|p| p.join("mesh-ca.installed")) else {
        return false;
    };
    match (fs::read(&stamp), fs::read(ca_path)) {
        (Ok(a), Ok(b)) => !a.is_empty() && a == b,
        _ => false,
    }
}

/// Records the trusted PEM so later joins skip `osascript` even if keychain lookup lags.
#[cfg(target_os = "macos")]
fn record_mesh_ca_install(ca_path: &Path) -> Result<(), String> {
    let stamp = ca_path
        .parent()
        .ok_or_else(|| "mesh CA path has no parent".to_string())?
        .join("mesh-ca.installed");
    fs::copy(ca_path, &stamp).map_err(|e| format!("stamp mesh CA install: {e}"))?;
    Ok(())
}

/// Reattach to a still-running admin-started `tailscaled` without another password prompt.
#[cfg(target_os = "macos")]
fn try_reuse_running_daemon(state_dir: &Path, socket: &Path) -> bool {
    let pid_path = state_dir.join("tailscaled.pid");
    let Ok(raw) = fs::read_to_string(&pid_path) else {
        return false;
    };
    let Ok(pid) = raw.trim().parse::<i32>() else {
        return false;
    };
    let alive = Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !alive {
        return false;
    }
    if socket.exists() {
        let _ = Command::new("/bin/chmod")
            .args(["666", &socket.to_string_lossy()])
            .status();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if socket_live(socket) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

#[cfg(target_os = "macos")]
fn macos_magic_dns_resolver_ok() -> bool {
    fs::read_to_string("/etc/resolver/dadi")
        .map(|s| s.contains("100.100.100.100"))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn run_osascript_admin(script: &str) -> Result<(), String> {
    let apple = format!(
        "do shell script \"{}\" with administrator privileges",
        apple_escape(script)
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&apple)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "admin approval required for MagicDNS (os.dadi): {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
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
