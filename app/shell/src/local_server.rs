//! Local mode: the shell runs the packaged Pandeck server as its own child and
//! points its windows at it (`docs/desktop-local-mode.md`).
//!
//! The server is the same Bun package production runs. The shell only supplies
//! what a systemd unit would: the environment, a data directory, a log file and
//! a stop. It adds no protocol of its own. Readiness is the server's existing
//! `/api/health`. The child's stdin is a pipe the shell never writes to, so a
//! shell that dies for any reason closes it and the server stops itself
//! (`app/server/src/desktopShell.ts`).
//!
//! Data lives in the app data dir, outside the bundle, so replacing the app
//! keeps it. The port is chosen once and remembered, because the page's
//! `localStorage` belongs to its origin and a new port each launch would forget
//! the user's preferences.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::{config, log_line};

/// Where `tauri.local.json` puts the server package inside the bundle.
const RUNTIME_RESOURCE: &str = "pandeck-runtime";
/// A first launch runs every migration; later ones take a second or two.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a running turn may take to wind down on quit. The server's own
/// default drains for most of an hour, which is right for a deploy and wrong
/// for a laptop being shut.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
/// Past the grace, plus margin for the database to close, the child is killed.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// What a Finder launch is missing when the login shell cannot be asked.
const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

struct Running {
    child: Child,
    /// Held, never written: dropping it is the server's signal to stop.
    lifeline: Option<ChildStdin>,
    url: String,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// The packaged server, if this build carries one.
pub fn runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join(RUNTIME_RESOURCE);
    dir.join("server.js").is_file().then_some(dir)
}

pub fn log_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok().map(|dir| dir.join("server.log"))
}

/// Why the last start failed, for the recovery page.
pub fn last_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|error| error.clone())
}

/// Start the server unless it is already up, and wait until it answers.
/// Blocking: call it off the main thread.
pub fn ensure_running(app: &AppHandle) -> Result<String, String> {
    let mut running = RUNNING.lock().map_err(|err| err.to_string())?;
    if let Some(current) = running.as_mut() {
        if current.child.try_wait().ok().flatten().is_none() {
            return Ok(current.url.clone());
        }
        *running = None;
    }
    let result = start(app);
    if let Ok(mut error) = LAST_ERROR.lock() {
        *error = result.as_ref().err().cloned();
    }
    let started = result?;
    let url = started.url.clone();
    *running = Some(started);
    Ok(url)
}

/// Stop the server and wait for it, killing it past [`STOP_TIMEOUT`].
/// Blocking, and a no-op when nothing runs. A server still starting holds the
/// lock and is left alone: the shell's exit closes its stdin, which stops it.
pub fn stop() {
    let Some(mut running) = RUNNING.try_lock().ok().and_then(|mut running| running.take()) else {
        return;
    };
    drop(running.lifeline.take());
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if running.child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log_line("local server did not stop in time; killing it");
    let _ = running.child.kill();
    let _ = running.child.wait();
}

fn start(app: &AppHandle) -> Result<Running, String> {
    let runtime = runtime_dir(app).ok_or("This build does not include a local server.")?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("data");
    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    let log_path = log_file(app).ok_or("No log directory for the local server.")?;
    let log = open_log(&log_path)?;

    let port = choose_port(config::local_port(app));
    let url = config::use_local_port(app, port)?;

    let mut child = Command::new(runtime.join("personal-assistant-server"))
        .arg(runtime.join("server.js"))
        .current_dir(&data_dir)
        .env("NODE_ENV", "production")
        .env("ASSISTANT_RUNTIME_DIR", &runtime)
        .env("ASSISTANT_DESKTOP_SHELL", "1")
        .env("ASSISTANT_HOST", "127.0.0.1")
        .env("ASSISTANT_PORT", port.to_string())
        .env("ASSISTANT_SHUTDOWN_GRACE_MS", SHUTDOWN_GRACE.as_millis().to_string())
        .env("DATA_DIR", &data_dir)
        .env("PATH", login_path())
        .stdin(Stdio::piped())
        .stdout(log.try_clone().map_err(|err| err.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|err| format!("Could not start the local server: {err}"))?;
    let lifeline = child.stdin.take();
    log_line(&format!("local server pid {} on {url}", child.id()));

    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().map_err(|err| err.to_string())? {
            return Err(format!(
                "The local server exited ({status}). Its log is {}.",
                log_path.display()
            ));
        }
        if healthy(port) {
            return Ok(Running { child, lifeline, url });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "The local server did not become ready. Its log is {}.",
                log_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// One log per launch, the previous one kept beside it.
fn open_log(path: &Path) -> Result<File, String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    if path.exists() {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("Could not open {}: {err}", path.display()))
}

/// The remembered port while it is free, otherwise one the OS picks.
fn choose_port(remembered: Option<u16>) -> u16 {
    let bind = |port| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    if let Some(port) = remembered.filter(|port| *port != 0) {
        if bind(port).is_ok() {
            return port;
        }
    }
    bind(0)
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(0)
}

/// `GET /api/health` answered with 200. Plain HTTP over loopback, so std is
/// enough and the check needs no runtime.
fn healthy(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).is_ok() && head.starts_with(b"HTTP/1.1 200")
}

/// The user's login-shell PATH. A Finder launch inherits only the system
/// directories, which would hide Homebrew and every tool an agent expects.
fn login_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = Command::new(shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(out) if out.status.success() && !out.stdout.is_empty() => {
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
        _ => FALLBACK_PATH.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_free_remembered_port_and_replaces_a_taken_one() {
        let free = choose_port(None);
        assert_ne!(free, 0);
        assert_eq!(choose_port(Some(free)), free);

        let taken = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let taken_port = taken.local_addr().unwrap().port();
        let chosen = choose_port(Some(taken_port));
        assert_ne!(chosen, taken_port);
        assert_ne!(chosen, 0);
    }

    /// A one-request server answering `response`.
    fn serve_once(response: &'static [u8]) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0u8; 256];
            let _ = socket.read(&mut buf);
            let _ = socket.write_all(response);
        });
        (port, handle)
    }

    #[test]
    fn health_needs_a_200() {
        let (port, handle) = serve_once(b"HTTP/1.1 503 Service Unavailable\r\n\r\n");
        assert!(!healthy(port));
        handle.join().unwrap();

        let (port, handle) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{}");
        assert!(healthy(port));
        handle.join().unwrap();
    }
}
