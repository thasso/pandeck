//! Local mode: this app runs its own bundled Pandeck server and points its
//! windows at it, instead of at a remote server.
//!
//! Which server the shell uses is the MODE (`config::ServerMode`), kept apart
//! from the remembered remote URL so switching to local and back finds the
//! remote choice intact, and apart from any credential gateway, which is a
//! different setting the server owns (`docs/desktop-local-mode.md`).
//!
//! One thread owns the child (`local_server::Launched`) for its whole life:
//! starts, stops and crash detection happen in order there, so a restart can
//! only begin after the previous process tree is gone and its data lock freed.
//! Everyone else reads a status snapshot or queues a request.
//!
//! The origin is trusted only once the child has proved readiness, and the
//! status flips to `ready` only after that trust exists, so neither the
//! bootstrap page nor a new window can reach the local origin early.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::config::{self, ServerMode};
use crate::local_server::{self, LaunchSpec, Launched, LocalPaths};
use crate::trace;

/// What the bootstrap page is told about the local server. Paths and failure
/// text are for the local bootstrap page only; no hosted page can call the
/// commands that return this (`capabilities/default.json`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LocalStatus {
    /// This build carries no bundled server.
    Unavailable,
    Stopped,
    Starting,
    #[serde(rename_all = "camelCase")]
    Ready {
        url: String,
    },
    Stopping,
    #[serde(rename_all = "camelCase")]
    Failed {
        detail: String,
        log_path: String,
    },
}

enum Request {
    /// Start unless already running; carries the stop generation it was
    /// queued under, so a stop queued after it cancels it.
    Start(u64),
    Stop(Option<mpsc::Sender<()>>),
}

pub struct LocalServer {
    runtime_dir: Option<PathBuf>,
    paths: Option<LocalPaths>,
    selected: Mutex<ServerMode>,
    status: Mutex<LocalStatus>,
    /// Bumped by every stop; a launch under an older value cancels itself.
    stops: AtomicU64,
    requests: Mutex<Option<mpsc::Sender<Request>>>,
}

/// Where the packaged server sits inside the app: `Contents/Resources/
/// pandeck-runtime` on macOS, resolved from Tauri's resource dir, never the
/// working directory or PATH. A debug build may point elsewhere.
fn runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("PA_SHELL_LOCAL_RUNTIME_DIR") {
        return Some(PathBuf::from(dir));
    }
    let dir = app.path().resource_dir().ok()?.join("pandeck-runtime");
    dir.join(local_server::RUNTIME_EXECUTABLE)
        .exists()
        .then_some(dir)
}

impl LocalServer {
    pub fn new(app: &AppHandle) -> Self {
        let runtime_dir = runtime_dir(app);
        let paths = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| local_server::local_paths(&dir));
        let available = runtime_dir.is_some() && paths.is_some();
        let selected = config::server_mode(app, available);
        trace!(
            "local server available={available} mode={selected:?} runtime={:?}",
            runtime_dir
        );
        Self {
            runtime_dir,
            paths,
            selected: Mutex::new(selected),
            status: Mutex::new(if available {
                LocalStatus::Stopped
            } else {
                LocalStatus::Unavailable
            }),
            stops: AtomicU64::new(0),
            requests: Mutex::new(None),
        }
    }

    pub fn available(&self) -> bool {
        self.runtime_dir.is_some() && self.paths.is_some()
    }

    pub fn mode(&self) -> ServerMode {
        self.selected
            .lock()
            .map(|mode| *mode)
            .unwrap_or(ServerMode::Remote)
    }

    fn set_mode(&self, mode: ServerMode) {
        if let Ok(mut selected) = self.selected.lock() {
            *selected = mode;
        }
    }

    pub fn status(&self) -> LocalStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or(LocalStatus::Unavailable)
    }

    fn set_status(&self, status: LocalStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }

    /// The origin to load while local mode is selected, once the child is
    /// ready and trusted.
    pub fn ready_url(&self) -> Option<String> {
        match self.status() {
            LocalStatus::Ready { url } => Some(url),
            _ => None,
        }
    }

    fn send(&self, app: &AppHandle, request: Request) {
        let Ok(mut requests) = self.requests.lock() else {
            return;
        };
        let sender = requests.get_or_insert_with(|| spawn_owner(app.clone()));
        let _ = sender.send(request);
    }

    /// Select local mode, persist it, and start the child unless it is already
    /// starting or ready. A failed start is retried only by asking again —
    /// never in a loop.
    pub fn select_and_start(&self, app: &AppHandle) -> Result<LocalStatus, String> {
        if !self.available() {
            return Err("This build of Pandeck has no bundled local server.".into());
        }
        config::set_server_mode(app, ServerMode::Local)?;
        self.set_mode(ServerMode::Local);
        self.start(app);
        Ok(self.status())
    }

    pub fn start(&self, app: &AppHandle) {
        if !self.available() {
            return;
        }
        if matches!(
            self.status(),
            LocalStatus::Starting | LocalStatus::Ready { .. }
        ) {
            return;
        }
        self.set_status(LocalStatus::Starting);
        self.send(app, Request::Start(self.stops.load(Ordering::SeqCst)));
    }

    /// Remote mode was chosen: stop the child in the background.
    pub fn deselect(&self, app: &AppHandle) {
        self.set_mode(ServerMode::Remote);
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.send(app, Request::Stop(None));
    }

    /// App exit: stop the child and wait, boundedly, for it to be gone.
    pub fn shutdown_blocking(&self, app: &AppHandle) {
        if !self.available() {
            return;
        }
        self.stops.fetch_add(1, Ordering::SeqCst);
        let never_started = self.requests.lock().map(|r| r.is_none()).unwrap_or(true);
        if never_started {
            return;
        }
        let (done, wait) = mpsc::channel();
        self.send(app, Request::Stop(Some(done)));
        let limit = local_server::SHUTDOWN_GRACE + Duration::from_secs(6);
        if wait.recv_timeout(limit).is_err() {
            log_line_local("local server did not confirm shutdown before exit");
        }
    }
}

fn log_line_local(message: &str) {
    crate::log_line(message);
}

/// The one thread that owns the child.
fn spawn_owner(app: AppHandle) -> mpsc::Sender<Request> {
    let (sender, requests) = mpsc::channel::<Request>();
    std::thread::spawn(move || {
        let mut running: Option<Launched> = None;
        loop {
            match requests.recv_timeout(Duration::from_millis(500)) {
                Ok(Request::Start(generation)) => {
                    if running.is_none() {
                        running = start_child(&app, generation);
                    }
                }
                Ok(Request::Stop(done)) => {
                    let server = app.state::<LocalServer>();
                    if let Some(launched) = running.take() {
                        server.set_status(LocalStatus::Stopping);
                        let report = launched.shutdown(local_server::SHUTDOWN_GRACE);
                        trace!("local server stopped: {report}");
                    }
                    if !matches!(
                        server.status(),
                        LocalStatus::Failed { .. } | LocalStatus::Unavailable
                    ) {
                        server.set_status(LocalStatus::Stopped);
                    }
                    if let Some(done) = done {
                        let _ = done.send(());
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let exited = running.as_mut().and_then(Launched::try_exited);
                    if let Some(status) = exited {
                        let launched = running.take().expect("checked above");
                        let report = launched.reap_after_exit();
                        trace!("local server exited unexpectedly: {status:?}; {report}");
                        failed(
                            &app,
                            format!("Pandeck on this Mac stopped unexpectedly ({status})."),
                        );
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if let Some(launched) = running.take() {
                        launched.shutdown(local_server::SHUTDOWN_GRACE);
                    }
                    return;
                }
            }
        }
    });
    sender
}

fn start_child(app: &AppHandle, generation: u64) -> Option<Launched> {
    let server = app.state::<LocalServer>();
    if server.stops.load(Ordering::SeqCst) != generation {
        // A stop was queued after this start; it wins.
        server.set_status(LocalStatus::Stopped);
        return None;
    }
    let (Some(runtime_dir), Some(paths)) = (server.runtime_dir.clone(), server.paths.clone())
    else {
        return None;
    };
    server.set_status(LocalStatus::Starting);
    let workspace = app
        .path()
        .home_dir()
        .unwrap_or_else(|_| paths.state_dir.clone());
    let spec = match LaunchSpec::bundled(
        &runtime_dir,
        &paths,
        &workspace,
        config::local_port(app),
        local_server::ambient_env(std::env::vars()),
    ) {
        Ok(spec) => spec,
        Err(error) => {
            failed(app, error.to_string());
            return None;
        }
    };
    match local_server::launch(&spec, &server.stops, generation) {
        Ok(launched) => {
            // Trust BEFORE anyone can learn the URL: the bootstrap page polls
            // for `ready`, and the window below loads it directly.
            if let Err(err) = config::trust_server(app, &launched.origin) {
                launched.shutdown(local_server::SHUTDOWN_GRACE);
                failed(app, format!("Could not trust the local server: {err}"));
                return None;
            }
            config::set_local_port(app, launched.port);
            let url = launched.origin.clone();
            server.set_status(LocalStatus::Ready { url });
            trace!(
                "local server ready pid={} port={}",
                launched.pid,
                launched.port
            );
            if app.webview_windows().is_empty() {
                // The ordinary way in: straight to the server, hidden until it
                // reports (`ready::watch`).
                if let Err(err) = crate::build_app_window(app, "main", None) {
                    trace!("main window failed: {err}");
                }
            }
            Some(launched)
        }
        Err(local_server::LaunchError::Cancelled) => {
            server.set_status(LocalStatus::Stopped);
            None
        }
        Err(error) => {
            failed(app, error.to_string());
            None
        }
    }
}

/// Record a failure and make sure the user can see it: the bootstrap page is
/// the recovery surface, so open one unless one is already showing.
fn failed(app: &AppHandle, detail: String) {
    let server = app.state::<LocalServer>();
    let log_path = server
        .paths
        .as_ref()
        .map(|paths| paths.log_path.display().to_string())
        .unwrap_or_default();
    server.set_status(LocalStatus::Failed { detail, log_path });
    let bootstrap_open = app.webview_windows().values().any(|window| {
        window
            .url()
            .map(|url| url.scheme() == "tauri")
            .unwrap_or(false)
    });
    if !bootstrap_open {
        crate::open_bootstrap_window(app, false);
    }
}
