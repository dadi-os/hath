//! Local HTTP proxy that dials `*.dadi` via Tailscale MagicDNS (`100.100.100.100`).
//!
//! Hath's system `tailscaled` does not install an OS resolver, and macOS
//! `/etc/hosts` (Compose) maps those names to `127.0.0.1`. The frontend uses
//! `/@host/path` so the Host header stays the service name for Caddy.

#![cfg(not(target_os = "ios"))]

use std::io::{Read, Write};
use std::net::{
    Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::logutil;

const MAGIC_DNS: Ipv4Addr = Ipv4Addr::new(100, 100, 100, 100);
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

static RUNNING: AtomicBool = AtomicBool::new(false);
static PORT: Mutex<Option<u16>> = Mutex::new(None);

/// Bind `127.0.0.1:0` and proxy `/@host/path` through MagicDNS.
pub fn start() -> Result<u16, String> {
    if RUNNING.load(Ordering::SeqCst) {
        if let Ok(guard) = PORT.lock() {
            if let Some(port) = *guard {
                return Ok(port);
            }
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("mesh proxy bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("mesh proxy addr: {e}"))?
        .port();

    RUNNING.store(true, Ordering::SeqCst);
    if let Ok(mut guard) = PORT.lock() {
        *guard = Some(port);
    }

    thread::spawn(move || accept_loop(listener));
    logutil::emit("info", format!("mesh proxy listening 127.0.0.1:{port}"));
    Ok(port)
}

/// Stop accepting proxy connections.
pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
    let port = PORT.lock().ok().and_then(|g| *g);
    if let Some(port) = port {
        let _ = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(200),
        );
    }
    if let Ok(mut guard) = PORT.lock() {
        *guard = None;
    }
}

fn accept_loop(listener: TcpListener) {
    let _ = listener.set_nonblocking(false);
    for incoming in listener.incoming() {
        if !RUNNING.load(Ordering::SeqCst) {
            break;
        }
        match incoming {
            Ok(stream) => {
                thread::spawn(move || {
                    if let Err(err) = handle_client(stream) {
                        logutil::emit("error", format!("mesh proxy: {err}"));
                    }
                });
            }
            Err(_) => {
                if !RUNNING.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    }
}

fn handle_client(mut client: TcpStream) -> Result<(), String> {
    let mut upstream = match open_upstream(&mut client) {
        Ok(s) => s,
        Err(err) => {
            write_status(&mut client, 502, &err);
            return Err(err);
        }
    };

    let mut buf = [0u8; 8192];
    loop {
        let n = match upstream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return Err(format!("mesh proxy upstream read: {e}")),
        };
        if client.write_all(&buf[..n]).is_err() {
            break;
        }
    }
    let _ = client.shutdown(Shutdown::Both);
    Ok(())
}

fn open_upstream(client: &mut TcpStream) -> Result<TcpStream, String> {
    let (header_bytes, leftover) = read_until_double_crlf(client)?;
    let header = std::str::from_utf8(&header_bytes)
        .map_err(|_| "mesh proxy: request is not UTF-8".to_string())?;
    let (method, target, rest_headers) = parse_request_line(header)?;
    let (host, path) = split_mesh_target(target)?;

    let content_len = content_length(rest_headers);
    let mut body = leftover;
    if content_len > body.len() {
        let mut extra = vec![0u8; content_len - body.len()];
        client
            .read_exact(&mut extra)
            .map_err(|e| format!("mesh proxy read body: {e}"))?;
        body.extend_from_slice(&extra);
    } else {
        body.truncate(content_len);
    }

    let ip = magic_dns_a(&host)?;
    let addr = SocketAddr::V4(SocketAddrV4::new(ip, 80));
    let mut upstream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("mesh proxy dial {host} ({ip}): {e}"))?;

    let forwarded = rewrite_headers(rest_headers, &host);
    let req = format!("{method} {path} HTTP/1.1\r\n{forwarded}\r\n");
    upstream
        .write_all(req.as_bytes())
        .map_err(|e| format!("mesh proxy write: {e}"))?;
    if !body.is_empty() {
        upstream
            .write_all(&body)
            .map_err(|e| format!("mesh proxy write body: {e}"))?;
    }
    upstream
        .flush()
        .map_err(|e| format!("mesh proxy flush: {e}"))?;
    Ok(upstream)
}

fn write_status(client: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        502 => "Bad Gateway",
        _ => "Error",
    };
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = client.write_all(resp.as_bytes());
}

fn read_until_double_crlf(stream: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        let n = stream
            .read(&mut tmp)
            .map_err(|e| format!("mesh proxy read: {e}"))?;
        if n == 0 {
            return Err("mesh proxy: client closed before headers".into());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            let headers = buf[..pos + 4].to_vec();
            let rest = buf[pos + 4..].to_vec();
            return Ok((headers, rest));
        }
        if buf.len() > 64 * 1024 {
            return Err("mesh proxy: headers too large".into());
        }
    }
}

fn parse_request_line(header: &str) -> Result<(&str, &str, &str), String> {
    let (line, rest) = header
        .split_once("\r\n")
        .ok_or_else(|| "mesh proxy: missing request line".to_string())?;
    let mut parts = line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "mesh proxy: missing method".to_string())?;
    let target = parts
        .next()
        .ok_or_else(|| "mesh proxy: missing target".to_string())?;
    Ok((method, target, rest))
}

/// Maps `/@dimaag.dadi/agents` (optional query) to host + path.
pub fn split_mesh_target(target: &str) -> Result<(String, String), String> {
    let (path, query) = target
        .split_once('?')
        .map(|(p, q)| (p, Some(q)))
        .unwrap_or((target, None));
    let rest = path
        .strip_prefix("/@")
        .ok_or_else(|| "mesh path must be /@host/...".to_string())?;
    let (host, rem) = match rest.split_once('/') {
        Some((h, r)) => (h, format!("/{r}")),
        None => (rest, "/".to_string()),
    };
    if host.is_empty() || !host.ends_with(".dadi") || host.contains(':') {
        return Err(format!("invalid mesh host {host}"));
    }
    let path = match query {
        Some(q) => format!("{rem}?{q}"),
        None => rem,
    };
    Ok((host.to_string(), path))
}

fn content_length(headers: &str) -> usize {
    for line in headers.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            return value.trim().parse().unwrap_or(0);
        }
    }
    0
}

fn rewrite_headers(headers: &str, host: &str) -> String {
    let mut out = format!("Host: {host}\r\nConnection: close\r\n");
    for line in headers.split("\r\n") {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("host")
            || name.eq_ignore_ascii_case("connection")
            || name.eq_ignore_ascii_case("proxy-connection")
            || name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("keep-alive")
        {
            continue;
        }
        out.push_str(name);
        out.push_str(": ");
        out.push_str(value.trim());
        out.push_str("\r\n");
    }
    out
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Resolve `name` with an A query to Tailscale MagicDNS. Loopback is rejected.
pub fn magic_dns_a(name: &str) -> Result<Ipv4Addr, String> {
    let qname = encode_qname(name)?;
    let id = 0x4d44u16;
    let mut query = Vec::with_capacity(12 + qname.len() + 4);
    query.extend_from_slice(&id.to_be_bytes());
    query.extend_from_slice(&0x0100u16.to_be_bytes());
    query.extend_from_slice(&1u16.to_be_bytes());
    query.extend_from_slice(&0u16.to_be_bytes());
    query.extend_from_slice(&0u16.to_be_bytes());
    query.extend_from_slice(&0u16.to_be_bytes());
    query.extend_from_slice(&qname);
    query.extend_from_slice(&1u16.to_be_bytes());
    query.extend_from_slice(&1u16.to_be_bytes());

    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("MagicDNS bind: {e}"))?;
    sock.set_read_timeout(Some(DNS_TIMEOUT))
        .map_err(|e| format!("MagicDNS timeout: {e}"))?;
    sock.send_to(&query, SocketAddr::from((MAGIC_DNS, 53)))
        .map_err(|e| format!("MagicDNS send {name}: {e}"))?;

    let mut buf = [0u8; 512];
    let (n, _) = sock
        .recv_from(&mut buf)
        .map_err(|e| format!("MagicDNS recv {name}: {e}"))?;
    parse_a_record(&buf[..n], id, name)
}

fn encode_qname(name: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(format!("bad DNS label in {name}"));
        }
        out.push(u8::try_from(label.len()).map_err(|_| format!("bad DNS label in {name}"))?);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    Ok(out)
}

fn parse_a_record(msg: &[u8], id: u16, name: &str) -> Result<Ipv4Addr, String> {
    if msg.len() < 12 {
        return Err(format!("MagicDNS short response for {name}"));
    }
    let got_id = u16::from_be_bytes([msg[0], msg[1]]);
    if got_id != id {
        return Err(format!("MagicDNS id mismatch for {name}"));
    }
    let flags = u16::from_be_bytes([msg[2], msg[3]]);
    let rcode = flags & 0x000f;
    if rcode != 0 {
        return Err(format!("MagicDNS rcode {rcode} for {name}"));
    }
    let qd = u16::from_be_bytes([msg[4], msg[5]]) as usize;
    let an = u16::from_be_bytes([msg[6], msg[7]]) as usize;
    let mut i = 12usize;
    for _ in 0..qd {
        i = skip_name(msg, i)?;
        i = i.checked_add(4).ok_or_else(|| format!("MagicDNS question overflow for {name}"))?;
        if i > msg.len() {
            return Err(format!("MagicDNS truncated question for {name}"));
        }
    }
    for _ in 0..an {
        i = skip_name(msg, i)?;
        if i + 10 > msg.len() {
            return Err(format!("MagicDNS truncated answer for {name}"));
        }
        let typ = u16::from_be_bytes([msg[i], msg[i + 1]]);
        let rdlen = u16::from_be_bytes([msg[i + 8], msg[i + 9]]) as usize;
        i += 10;
        if i + rdlen > msg.len() {
            return Err(format!("MagicDNS truncated rdata for {name}"));
        }
        if typ == 1 && rdlen == 4 {
            let ip = Ipv4Addr::new(msg[i], msg[i + 1], msg[i + 2], msg[i + 3]);
            if ip.is_loopback() {
                return Err(format!(
                    "MagicDNS returned loopback for {name} — extra_records are missing"
                ));
            }
            return Ok(ip);
        }
        i += rdlen;
    }
    Err(format!("MagicDNS has no A record for {name}"))
}

fn skip_name(msg: &[u8], mut i: usize) -> Result<usize, String> {
    let mut hops = 0;
    loop {
        if hops > 16 || i >= msg.len() {
            return Err("MagicDNS name overflow".into());
        }
        let len = msg[i];
        if len == 0 {
            return Ok(i + 1);
        }
        if len & 0xc0 == 0xc0 {
            if i + 1 >= msg.len() {
                return Err("MagicDNS truncated pointer".into());
            }
            return Ok(i + 2);
        }
        i += 1 + len as usize;
        hops += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::split_mesh_target;

    #[test]
    fn split_mesh_target_strips_at_prefix() {
        let (host, path) = split_mesh_target("/@dimaag.dadi/events").unwrap();
        assert_eq!(host, "dimaag.dadi");
        assert_eq!(path, "/events");
    }

    #[test]
    fn split_mesh_target_keeps_query() {
        let (host, path) = split_mesh_target("/@nas.dadi/status?full=1").unwrap();
        assert_eq!(host, "nas.dadi");
        assert_eq!(path, "/status?full=1");
    }

    #[test]
    fn split_mesh_target_rejects_non_dadi() {
        assert!(split_mesh_target("/@example.com/x").is_err());
        assert!(split_mesh_target("/health").is_err());
    }
}
