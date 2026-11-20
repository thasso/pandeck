//! Local mode: the shell runs the packaged Pandeck server as its own child and
//! points its windows at it (`docs/desktop-local-mode.md`).
//!
//! The server is the same Bun package production runs. The shell only supplies
//! what a systemd unit would: the environment, a data directory, a log file and
//! a stop. It adds no protocol of its own. Readiness is the server's existing
//! `/api/health`, and stopping is SIGTERM. A shell that dies without stopping
//! it is noticed by the server, which watches its parent's pid
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
use std::process::{Child, Command, Stdio};
use std::sync::{Condvar, Mutex};
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

/// A server the shell has spawned. It is in [`RUNNING`] from the moment it
/// exists, so a stop never misses one that is still starting.
pub struct Running {
    child: Child,
    url: String,
    /// Answered `/api/health`; only then is its URL handed to a window.
    ready: bool,
}

/// The current server. Held only briefly, never across a wait.
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
/// Serializes starts, so only one server is ever being started.
static TRANSITION: Mutex<()> = Mutex::new(());
/// Servers taken out of [`RUNNING`] that have not exited yet. Counted inside
/// the same [`RUNNING`] lock that takes them, so no start can see the slot
/// empty while a stopped server still holds the data-directory lock and port.
static STOPPING: Mutex<usize> = Mutex::new(0);
static STOPPED: Condvar = Condvar::new();
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// The packaged server, if this build carries one.
pub fn runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join(RUNTIME_RESOURCE);
    dir.join("server.js").is_file().then_some(dir)
}

pub fn log_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok().map(|dir| dir.join("server.log"))
}

/// The ready server's URL. None while one is starting or none runs.
pub fn running_url() -> Option<String> {
    let mut running = RUNNING.lock().ok()?;
    let current = running.as_mut().filter(|current| current.ready)?;
    matches!(current.child.try_wait(), Ok(None)).then(|| current.url.clone())
}

/// Why the last start failed, for the recovery page.
pub fn last_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|error| error.clone())
}

/// Start the server unless it is already up, and wait until it answers.
/// Blocking: call it off the main thread.
pub fn ensure_running(app: &AppHandle) -> Result<String, String> {
    let _transition = TRANSITION.lock().map_err(|err| err.to_string())?;
    if let Some(url) = settle()? {
        return Ok(url);
    }
    let result = start(app);
    if let Ok(mut error) = LAST_ERROR.lock() {
        *error = result.as_ref().err().cloned();
    }
    result
}

/// Wait until no taken server is still exiting, then answer the ready
/// server's URL, or None when a new one may start. Clears an exited one.
/// With [`TRANSITION`] held nothing can be starting, and once [`RUNNING`] is
/// empty with nothing stopping, nothing can be taken before the start.
fn settle() -> Result<Option<String>, String> {
    loop {
        {
            let mut running = RUNNING.lock().map_err(|err| err.to_string())?;
            let stopping = *STOPPING.lock().map_err(|err| err.to_string())?;
            if stopping == 0 {
                if let Some(current) = running.as_mut() {
                    if current.ready && matches!(current.child.try_wait(), Ok(None)) {
                        return Ok(Some(current.url.clone()));
                    }
                    *running = None;
                }
                return Ok(None);
            }
        }
        let stopping = STOPPING.lock().map_err(|err| err.to_string())?;
        drop(
            STOPPED
                .wait_while(stopping, |count| *count > 0)
                .map_err(|err| err.to_string())?,
        );
    }
}

/// Detach the current server, ready or starting, so nothing else can reach
/// it, and count it as stopping until [`terminate`] has seen it exit.
pub fn take() -> Option<Running> {
    let mut running = RUNNING.lock().ok()?;
    let taken = running.take()?;
    if let Ok(mut stopping) = STOPPING.lock() {
        *stopping += 1;
    }
    Some(taken)
}

/// SIGTERM a taken server and wait for it, killing it past [`STOP_TIMEOUT`].
/// Blocking. A start waits in [`settle`] until this returns.
pub fn terminate(mut running: Running) {
    // SIGTERM is the server's ordinary stop. `kill` rather than a libc
    // binding keeps the shell free of a direct dependency for one signal.
    let _ = Command::new("kill")
        .args(["-TERM", &running.child.id().to_string()])
        .status();
    let deadline = Instant::now() + STOP_TIMEOUT;
    let mut exited = false;
    while Instant::now() < deadline {
        if running.child.try_wait().ok().flatten().is_some() {
            exited = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !exited {
        log_line("local server did not stop in time; killing it");
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    if let Ok(mut stopping) = STOPPING.lock() {
        *stopping = stopping.saturating_sub(1);
    }
    STOPPED.notify_all();
}

/// Quit: stop whatever runs, starting or ready. Blocking.
pub fn stop() {
    if let Some(running) = take() {
        terminate(running);
    }
}

/// Notice the server exiting without having been asked to, and open the
/// recovery page with the reason. A deliberate stop takes the server out of
/// [`RUNNING`] first, which ends this watch silently.
fn watch_for_exit(app: AppHandle, pid: u32) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let Ok(mut running) = RUNNING.lock() else { return };
        let Some(current) = running.as_mut().filter(|current| current.child.id() == pid) else {
            return;
        };
        let Ok(Some(status)) = current.child.try_wait() else { continue };
        *running = None;
        drop(running);
        let log = log_file(&app).map(|path| path.display().to_string()).unwrap_or_default();
        let message = format!("The local server stopped unexpectedly ({status}). Its log is {log}.");
        log_line(&message);
        if let Ok(mut error) = LAST_ERROR.lock() {
            *error = Some(message);
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::open_bootstrap_window(&handle, false);
        });
        return;
    });
}

/// What one readiness poll found about the server `pid`.
enum Poll {
    Starting,
    Exited(String),
    /// Taken by a stop, or replaced.
    Gone,
}

fn poll(pid: u32) -> Result<Poll, String> {
    let mut running = RUNNING.lock().map_err(|err| err.to_string())?;
    let Some(current) = running.as_mut().filter(|current| current.child.id() == pid) else {
        return Ok(Poll::Gone);
    };
    match current.child.try_wait().map_err(|err| err.to_string())? {
        Some(status) => {
            *running = None;
            Ok(Poll::Exited(status.to_string()))
        }
        None => Ok(Poll::Starting),
    }
}

/// Mark `pid` ready, unless it was taken meanwhile.
fn mark_ready(pid: u32) -> bool {
    let Ok(mut running) = RUNNING.lock() else { return false };
    match running.as_mut().filter(|current| current.child.id() == pid) {
        Some(current) => {
            current.ready = true;
            true
        }
        None => false,
    }
}

/// Stop `pid` if it is still the current server.
fn stop_pid(pid: u32) {
    let taken = RUNNING.lock().ok().and_then(|mut running| {
        running
            .as_ref()
            .is_some_and(|current| current.child.id() == pid)
            .then(|| running.take())
            .flatten()
    });
    if let Some(running) = taken {
        // Called with the transition held; `terminate` would wait on itself.
        let mut child = running.child;
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn start(app: &AppHandle) -> Result<String, String> {
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
    // Only the port: the mode is the user's choice, written where they make
    // it. Writing local here could undo a remote choice made since.
    let url = config::set_local_port(app, port)?;

    let child = Command::new(runtime.join("personal-assistant-server"))
        .arg(runtime.join("server.js"))
        .current_dir(&data_dir)
        .env("NODE_ENV", "production")
        .env("ASSISTANT_RUNTIME_DIR", &runtime)
        // The server watches this pid, not its parent: if the shell dies
        // before that watch begins, the server has already been reparented.
        .env("ASSISTANT_DESKTOP_SHELL", std::process::id().to_string())
        .env("ASSISTANT_HOST", "127.0.0.1")
        .env("ASSISTANT_PORT", port.to_string())
        .env("ASSISTANT_SHUTDOWN_GRACE_MS", SHUTDOWN_GRACE.as_millis().to_string())
        .env("DATA_DIR", &data_dir)
        .env("PATH", login_path())
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|err| err.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|err| format!("Could not start the local server: {err}"))?;
    let pid = child.id();
    log_line(&format!("local server pid {pid} on {url}"));
    *RUNNING.lock().map_err(|err| err.to_string())? = Some(Running {
        child,
        url: url.clone(),
        ready: false,
    });

    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        match poll(pid)? {
            Poll::Gone => return Err("The local server was stopped while starting.".into()),
            Poll::Exited(status) => {
                return Err(format!(
                    "The local server exited ({status}). Its log is {}.",
                    log_path.display()
                ))
            }
            Poll::Starting => {}
        }
        // Remote was chosen while this one started: it is not wanted. Checked
        // every poll, because a switch that took RUNNING just before this
        // child was registered could not have stopped it.
        if !config::local_mode(app) {
            stop_pid(pid);
            return Err("Switched to a remote server while the local one started.".into());
        }
        if healthy(port) {
            if !mark_ready(pid) {
                return Err("The local server was stopped while starting.".into());
            }
            watch_for_exit(app.clone(), pid);
            return Ok(url);
        }
        if Instant::now() >= deadline {
            stop_pid(pid);
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

    /// The lifecycle tests share this module's statics.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn register_sleeper(ready: bool) -> u32 {
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        *RUNNING.lock().unwrap() = Some(Running {
            child,
            url: "http://127.0.0.1:1".into(),
            ready,
        });
        pid
    }

    /// A stop must reach a server that has not answered yet, and the start
    /// waiting on it must then see it as gone rather than publish it.
    #[test]
    fn a_stop_takes_a_server_that_is_still_starting() {
        let _serial = SERIAL.lock().unwrap_or_else(|err| err.into_inner());
        let pid = register_sleeper(false);
        assert!(matches!(poll(pid).unwrap(), Poll::Starting));
        assert_eq!(running_url(), None);

        let taken = take().expect("a starting server is taken");
        assert!(matches!(poll(pid).unwrap(), Poll::Gone));
        assert!(!mark_ready(pid));
        terminate(taken);
        assert_eq!(*STOPPING.lock().unwrap(), 0);
    }

    /// A restart must not begin while a server taken by a stop still runs,
    /// however late the stopper gets to it: the old one holds the data
    /// directory's lock and the remembered port.
    #[test]
    fn a_start_waits_for_a_taken_server_to_exit() {
        let _serial = SERIAL.lock().unwrap_or_else(|err| err.into_inner());
        register_sleeper(true);
        assert_eq!(settle().unwrap().as_deref(), Some("http://127.0.0.1:1"));

        let taken = take().expect("the ready server is taken");
        let (sent, settled) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || sent.send(settle()).unwrap());
        assert!(
            settled.recv_timeout(Duration::from_millis(300)).is_err(),
            "a start went ahead while the taken server still ran"
        );
        terminate(taken);
        assert_eq!(settled.recv().unwrap().unwrap(), None);
        waiter.join().unwrap();
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
