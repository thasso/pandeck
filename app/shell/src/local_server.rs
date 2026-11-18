//! The bundled Pandeck server as a private child of this shell.
//!
//! Nothing here knows about Tauri: `local_mode` decides WHEN to launch and what
//! to do with the result, this module decides HOW, so the lifecycle can be
//! tested against a fake child and against the real bundled runtime without a
//! window.
//!
//! The rules the launch follows, each of which a test pins:
//!
//! - The child binds loopback itself, on the remembered port or one the OS
//!   picks, and proves it over a private pipe (fd 3): one JSON line naming a
//!   per-launch nonce, its own pid and the port it bound. A listener that merely
//!   answers `/api/health` is never adopted — any process on the Mac can do that.
//! - The proof is then checked against the socket: health answers and an
//!   unauthenticated API request is refused. Only after both does the caller
//!   trust the origin.
//! - No secret crosses argv, the environment the child passes on, or a log. The
//!   API token stays the server's own (`DATA_DIR/.assistant-token`); the nonce
//!   is scrubbed by the server before it spawns anything.
//! - The child gets a fixed allow-list of ambient variables, never the shell's
//!   whole environment, so a terminal's provider keys or gateway settings cannot
//!   silently change what the local server is.
//! - The shell holds the only write end of the child's stdin. If the shell dies
//!   without running its exit path, EOF tells the server to drain.
//! - Stopping is bounded: SIGTERM, a grace period, then SIGKILL for the child,
//!   its process group and every descendant seen while it ran.

use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The packaged Bun executable, and the entry it runs (`docs/deployment.md`).
pub const RUNTIME_EXECUTABLE: &str = "personal-assistant-server";
const RUNTIME_ENTRY: &str = "server.js";

/// What a usable runtime directory must hold before anything is spawned. The
/// server checks its own assets in depth at boot; this only turns a broken or
/// partial bundle into a message naming the missing file instead of a crash
/// log.
const REQUIRED_RUNTIME_FILES: &[&str] = &[
    RUNTIME_EXECUTABLE,
    RUNTIME_ENTRY,
    "config/app.json",
    "config/host-tools.json",
    "migrations.lock.json",
    "web/index.html",
];

/// The descriptor the child reports readiness on.
const READY_FD: RawFd = 3;

/// First boot applies every migration; give it room on a slow disk.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

/// How long the server may drain active turns once told to stop. Passed down as
/// `ASSISTANT_SHUTDOWN_GRACE_MS`; the production default (55 minutes) suits a
/// deploy, not a user quitting an app.
const SERVER_DRAIN: Duration = Duration::from_secs(5);

/// How long the shell waits for the child after SIGTERM before SIGKILL.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(8);

/// How long surviving descendants get between SIGTERM and SIGKILL.
const DESCENDANT_GRACE: Duration = Duration::from_secs(2);

/// Each readiness or verification request gets this long.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Rotate the log once it passes this size at launch.
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// Lines of this launch's log quoted in a failure.
const LOG_TAIL_LINES: usize = 20;

/// Ambient variables the child may inherit. Locale, home, temp, search path and
/// proxy/CA settings make it a normal process for this user; nothing else
/// (provider keys, `ASSISTANT_*`, gateway or relay settings) crosses.
const PASSED_THROUGH_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TZ",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
];

/// Everything a launch needs. `bundled` builds the real one; tests substitute
/// the program.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// `ASSISTANT_RUNTIME_DIR`, when launching the packaged server.
    pub runtime_dir: Option<PathBuf>,
    /// Private directory for this mode's state: the child's cwd, the log.
    pub state_dir: PathBuf,
    /// `DATA_DIR`. Durable, outside the app bundle, the same in every mode.
    pub data_dir: PathBuf,
    pub log_path: PathBuf,
    /// `ASSISTANT_CWD`: where agent sessions start by default.
    pub workspace: PathBuf,
    /// Last bound port, so the origin (and the page's storage) survives a
    /// relaunch. A preference only: if taken, the child binds another.
    pub preferred_port: Option<u16>,
    pub startup_timeout: Duration,
    /// Ambient variables, already filtered by `ambient_env`.
    pub ambient: Vec<(String, String)>,
}

/// Where the local mode keeps its files, all under the app's own support
/// directory and never inside the bundle. Independent of the selected mode, so
/// switching to a remote server and back finds the same data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalPaths {
    pub state_dir: PathBuf,
    pub data_dir: PathBuf,
    pub log_path: PathBuf,
}

pub fn local_paths(app_data_dir: &Path) -> LocalPaths {
    let state_dir = app_data_dir.join("local-server");
    LocalPaths {
        data_dir: state_dir.join("data"),
        log_path: state_dir.join("logs").join("server.log"),
        state_dir,
    }
}

/// The subset of `vars` a child may inherit.
pub fn ambient_env(vars: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    vars.into_iter()
        .filter(|(name, _)| PASSED_THROUGH_ENV.contains(&name.as_str()))
        .collect()
}

impl LaunchSpec {
    /// The packaged server in `runtime_dir`, refusing an incomplete bundle.
    pub fn bundled(
        runtime_dir: &Path,
        paths: &LocalPaths,
        workspace: &Path,
        preferred_port: Option<u16>,
        ambient: Vec<(String, String)>,
    ) -> Result<Self, LaunchError> {
        check_runtime(runtime_dir)?;
        Ok(Self {
            program: runtime_dir.join(RUNTIME_EXECUTABLE),
            args: vec![runtime_dir
                .join(RUNTIME_ENTRY)
                .to_string_lossy()
                .into_owned()],
            runtime_dir: Some(runtime_dir.to_path_buf()),
            state_dir: paths.state_dir.clone(),
            data_dir: paths.data_dir.clone(),
            log_path: paths.log_path.clone(),
            workspace: workspace.to_path_buf(),
            preferred_port,
            startup_timeout: STARTUP_TIMEOUT,
            ambient,
        })
    }
}

/// Whether `runtime_dir` holds a launchable server: every required file, and
/// an executable server binary.
pub fn check_runtime(runtime_dir: &Path) -> Result<(), LaunchError> {
    if !runtime_dir.is_absolute() {
        return Err(LaunchError::Layout(format!(
            "The bundled server path {} is not absolute.",
            runtime_dir.display()
        )));
    }
    for file in REQUIRED_RUNTIME_FILES {
        let path = runtime_dir.join(file);
        if !path.is_file() {
            return Err(LaunchError::Layout(format!(
                "The bundled server is incomplete: {} is missing. Reinstall Pandeck.",
                path.display()
            )));
        }
    }
    let executable = runtime_dir.join(RUNTIME_EXECUTABLE);
    let mode = fs::metadata(&executable)
        .map_err(|err| LaunchError::Layout(format!("{}: {err}", executable.display())))?
        .permissions()
        .mode();
    if mode & 0o111 == 0 {
        return Err(LaunchError::Layout(format!(
            "The bundled server {} is not executable. Reinstall Pandeck.",
            executable.display()
        )));
    }
    Ok(())
}

#[derive(Debug)]
pub enum LaunchError {
    /// The bundle is missing or broken.
    Layout(String),
    /// The shell could not prepare or spawn: directories, log, pipe, fork.
    Io(String),
    /// The child exited before it was ready. The log tail usually says why —
    /// missing host tools, a locked data directory.
    Exited {
        status: String,
        log_tail: String,
    },
    TimedOut {
        log_tail: String,
    },
    /// The child said something other than a valid readiness line.
    Readiness(String),
    /// The child claimed readiness but its listener did not behave like it.
    Unverified(String),
    /// A stop arrived before the child was ready.
    Cancelled,
}

impl fmt::Display for LaunchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Layout(message) | Self::Io(message) => f.write_str(message),
            Self::Exited { status, log_tail } => {
                write!(f, "The local server stopped during startup ({status}).")?;
                if !log_tail.is_empty() {
                    write!(f, "\n\n{log_tail}")?;
                }
                Ok(())
            }
            Self::TimedOut { log_tail } => {
                write!(f, "The local server did not become ready in time.")?;
                if !log_tail.is_empty() {
                    write!(f, "\n\n{log_tail}")?;
                }
                Ok(())
            }
            Self::Readiness(message) => {
                write!(f, "The local server reported an invalid start: {message}")
            }
            Self::Unverified(message) => {
                write!(f, "The local server did not answer as expected: {message}")
            }
            Self::Cancelled => f.write_str("The local server start was cancelled."),
        }
    }
}

/// A child that proved it is ready.
pub struct Launched {
    child: Child,
    /// Dropped to tell the child the shell is gone.
    lifeline: Option<ChildStdin>,
    log: Option<File>,
    pub pid: u32,
    pub port: u16,
    /// `http://127.0.0.1:<port>`: the one origin to trust.
    pub origin: String,
}

impl Launched {
    /// Some(status) once the child has exited on its own.
    pub fn try_exited(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Bounded stop. See [`stop_child`].
    pub fn shutdown(mut self, grace: Duration) -> StopReport {
        let report = stop_child(&mut self.child, self.lifeline.take(), grace);
        if let Some(log) = self.log.as_mut() {
            shell_line(log, &format!("local server stopped: {report}"));
        }
        report
    }

    /// After an unexpected exit: reap what is left of its process group.
    pub fn reap_after_exit(mut self) -> StopReport {
        let report = stop_child(&mut self.child, self.lifeline.take(), Duration::ZERO);
        if let Some(log) = self.log.as_mut() {
            shell_line(log, &format!("local server exited unexpectedly: {report}"));
        }
        report
    }
}

/// Start the child and wait until it has proved readiness, failed, timed out,
/// or `cancelled` moved past `generation`.
pub fn launch(
    spec: &LaunchSpec,
    cancelled: &AtomicU64,
    generation: u64,
) -> Result<Launched, LaunchError> {
    for dir in [
        &spec.state_dir,
        &spec.data_dir,
        spec.log_path.parent().unwrap_or(&spec.state_dir),
    ] {
        create_private_dir(dir)?;
    }
    let (mut log, log_start) = open_log(&spec.log_path)?;
    let nonce = random_hex(32)?;
    let (ready_read, ready_write) = cloexec_pipe()?;

    shell_line(
        &mut log,
        &format!(
            "starting local server: program {}, data {}, preferred port {}",
            spec.program.display(),
            spec.data_dir.display(),
            spec.preferred_port
                .map_or("none".into(), |port| port.to_string()),
        ),
    );

    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.state_dir)
        .env_clear()
        .envs(spec.ambient.iter().map(|(k, v)| (k, v)))
        .env("NODE_ENV", "production")
        .env("DATA_DIR", &spec.data_dir)
        .env("ASSISTANT_CWD", &spec.workspace)
        .env("ASSISTANT_HOST", "127.0.0.1")
        .env(
            "ASSISTANT_PORT",
            spec.preferred_port.unwrap_or(0).to_string(),
        )
        .env(
            "ASSISTANT_SHUTDOWN_GRACE_MS",
            SERVER_DRAIN.as_millis().to_string(),
        )
        .env("ASSISTANT_SUPERVISOR_READY_FD", READY_FD.to_string())
        .env("ASSISTANT_SUPERVISOR_NONCE", &nonce)
        .env("ASSISTANT_SUPERVISOR_LIFELINE", "stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log_clone(&log)?))
        .stderr(Stdio::from(log_clone(&log)?))
        // Its own group, so a stop can reach everything it did not detach.
        .process_group(0);
    if let Some(runtime_dir) = &spec.runtime_dir {
        command.env("ASSISTANT_RUNTIME_DIR", runtime_dir);
    }
    let write_fd = ready_write.as_raw_fd();
    // SAFETY: only async-signal-safe calls between fork and exec. `dup2` clears
    // close-on-exec on the duplicate; if the pipe already IS fd 3, clear it by
    // hand so exec keeps it.
    unsafe {
        command.pre_exec(move || {
            if write_fd == READY_FD {
                let flags = libc::fcntl(READY_FD, libc::F_GETFD);
                if flags < 0 || libc::fcntl(READY_FD, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(write_fd, READY_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|err| {
        LaunchError::Io(format!("Could not start {}: {err}", spec.program.display()))
    })?;
    // The child has its copy; ours would hold the pipe open past the child.
    drop(ready_write);
    let lifeline = child.stdin.take();

    let fail =
        |child: &mut Child, lifeline: Option<ChildStdin>, log: &mut File, error: LaunchError| {
            let report = stop_child(child, lifeline, SHUTDOWN_GRACE);
            shell_line(
                log,
                &format!(
                    "local server start failed ({}); {report}",
                    error_kind(&error)
                ),
            );
            error
        };

    let lines = read_first_line(ready_read);
    let deadline = Instant::now() + spec.startup_timeout;
    let line = loop {
        if cancelled.load(Ordering::SeqCst) != generation {
            return Err(fail(&mut child, lifeline, &mut log, LaunchError::Cancelled));
        }
        match lines.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(line)) => break line,
            Ok(Err(message)) => {
                // EOF or a read error. If the child is exiting, say so instead.
                let status = wait_briefly(&mut child, Duration::from_millis(500));
                let error = match status {
                    Some(status) => LaunchError::Exited {
                        status: describe_status(&status),
                        log_tail: log_tail(&spec.log_path, log_start),
                    },
                    None => LaunchError::Readiness(message),
                };
                return Err(fail(&mut child, lifeline, &mut log, error));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let error = LaunchError::Readiness("readiness reader stopped".into());
                return Err(fail(&mut child, lifeline, &mut log, error));
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            let error = LaunchError::Exited {
                status: describe_status(&status),
                log_tail: log_tail(&spec.log_path, log_start),
            };
            return Err(fail(&mut child, lifeline, &mut log, error));
        }
        if Instant::now() >= deadline {
            let error = LaunchError::TimedOut {
                log_tail: log_tail(&spec.log_path, log_start),
            };
            return Err(fail(&mut child, lifeline, &mut log, error));
        }
    };

    let port = match parse_readiness(&line, &nonce, child.id()) {
        Ok(port) => port,
        Err(error) => return Err(fail(&mut child, lifeline, &mut log, error)),
    };
    if let Err(error) = verify_listener(port) {
        return Err(fail(&mut child, lifeline, &mut log, error));
    }
    let pid = child.id();
    shell_line(
        &mut log,
        &format!("local server ready: pid {pid}, http://127.0.0.1:{port}"),
    );
    Ok(Launched {
        child,
        lifeline,
        log: Some(log),
        pid,
        port,
        origin: format!("http://127.0.0.1:{port}"),
    })
}

fn error_kind(error: &LaunchError) -> &'static str {
    match error {
        LaunchError::Layout(_) => "layout",
        LaunchError::Io(_) => "io",
        LaunchError::Exited { .. } => "exited",
        LaunchError::TimedOut { .. } => "timed out",
        LaunchError::Readiness(_) => "invalid readiness",
        LaunchError::Unverified(_) => "unverified listener",
        LaunchError::Cancelled => "cancelled",
    }
}

/// The port a readiness line proves, if it is ours: right shape, right nonce,
/// right pid. Never echoes the line back, which would carry the nonce.
pub fn parse_readiness(line: &str, nonce: &str, pid: u32) -> Result<u16, LaunchError> {
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|_| LaunchError::Readiness("not a JSON readiness line".into()))?;
    if value.get("type").and_then(|v| v.as_str()) != Some("pandeck-ready") {
        return Err(LaunchError::Readiness("unexpected message type".into()));
    }
    let claimed = value.get("nonce").and_then(|v| v.as_str()).unwrap_or("");
    if !constant_time_eq(claimed.as_bytes(), nonce.as_bytes()) {
        return Err(LaunchError::Readiness("nonce mismatch".into()));
    }
    if value.get("pid").and_then(|v| v.as_u64()) != Some(u64::from(pid)) {
        return Err(LaunchError::Readiness(
            "reported by a different process".into(),
        ));
    }
    match value.get("port").and_then(|v| v.as_u64()) {
        Some(port @ 1..=65535) => Ok(port as u16),
        _ => Err(LaunchError::Readiness("no valid port".into())),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The listener the child named must be a Pandeck server with its auth gate
/// up: health answers and an unauthenticated API request is refused.
pub fn verify_listener(port: u16) -> Result<(), LaunchError> {
    let (status, body) = http_get(port, "/api/health")
        .map_err(|err| LaunchError::Unverified(format!("health check failed: {err}")))?;
    if status != 200 || !body.contains("\"ok\":true") {
        return Err(LaunchError::Unverified(format!(
            "health answered HTTP {status}"
        )));
    }
    let (status, _) = http_get(port, "/api/shell-launch-probe")
        .map_err(|err| LaunchError::Unverified(format!("auth check failed: {err}")))?;
    if status != 401 {
        return Err(LaunchError::Unverified(format!(
            "an unauthenticated API request answered HTTP {status}, not 401"
        )));
    }
    Ok(())
}

/// One plain HTTP/1.1 GET to loopback. The status and as much body as fits.
pub fn http_get(port: u16, path: &str) -> Result<(u16, String), String> {
    http_request(port, path, &format!("127.0.0.1:{port}"), &[])
}

/// A GET naming `host` and any extra headers. Tests use it to play a hostile
/// page; the launch only ever names its own loopback origin.
pub fn http_request(
    port: u16,
    path: &str,
    host: &str,
    headers: &[(&str, &str)],
) -> Result<(u16, String), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream =
        TcpStream::connect_timeout(&address, PROBE_TIMEOUT).map_err(|err| err.to_string())?;
    stream
        .set_read_timeout(Some(PROBE_TIMEOUT))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(PROBE_TIMEOUT))
        .map_err(|err| err.to_string())?;
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|err| err.to_string())?;
    let mut raw = Vec::new();
    stream
        .take(64 * 1024)
        .read_to_end(&mut raw)
        .map_err(|err| err.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let status = text
        .strip_prefix("HTTP/1.1 ")
        .or_else(|| text.strip_prefix("HTTP/1.0 "))
        .and_then(|rest| rest.get(..3))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "not an HTTP response".to_string())?;
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or("");
    Ok((status, body.to_string()))
}

/// What a stop did, for the log and the tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopReport {
    /// The child exited without SIGKILL: on its own, or within the grace.
    pub graceful: bool,
    pub status: String,
    /// Descendants still alive after the child exited, which had to be
    /// signalled by pid.
    pub stray_descendants: usize,
    /// Descendants that survived even SIGKILL's wait.
    pub survivors: usize,
}

impl fmt::Display for StopReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} ({}), {} stray descendant(s), {} survivor(s)",
            if self.graceful { "graceful" } else { "forced" },
            self.status,
            self.stray_descendants,
            self.survivors
        )
    }
}

/// Stop `child` and everything below it, in bounded time.
///
/// Descendants are recorded BEFORE anything is signalled, because the moment
/// the child exits they are re-parented and can no longer be found through it.
/// Its process group catches whatever never left it; the recorded pids catch
/// what did (agents run in groups of their own). A pid can be reused, so only
/// pids recorded seconds earlier are touched, and only after the child is gone.
pub fn stop_child(child: &mut Child, lifeline: Option<ChildStdin>, grace: Duration) -> StopReport {
    let pid = child.id() as libc::pid_t;
    let mut tree: BTreeSet<libc::pid_t> = descendants(pid).into_iter().collect();
    drop(lifeline);
    let mut graceful = false;
    let status = match child.try_wait() {
        // Already gone on its own: nothing needed forcing.
        Ok(Some(status)) => {
            graceful = true;
            Some(status)
        }
        _ => {
            signal(pid, libc::SIGTERM);
            let deadline = Instant::now() + grace;
            let mut last_scan = Instant::now();
            loop {
                if let Ok(Some(status)) = child.try_wait() {
                    graceful = true;
                    break Some(status);
                }
                if Instant::now() >= deadline {
                    break None;
                }
                if last_scan.elapsed() >= Duration::from_millis(500) {
                    tree.extend(descendants(pid));
                    last_scan = Instant::now();
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    };
    let status = match status {
        Some(status) => status,
        None => {
            tree.extend(descendants(pid));
            signal(-pid, libc::SIGKILL);
            signal(pid, libc::SIGKILL);
            match child.wait() {
                Ok(status) => status,
                Err(_) => {
                    return finish_descendants(pid, tree, false, "unknown".into());
                }
            }
        }
    };
    finish_descendants(pid, tree, graceful, describe_status(&status))
}

fn finish_descendants(
    group: libc::pid_t,
    tree: BTreeSet<libc::pid_t>,
    graceful: bool,
    status: String,
) -> StopReport {
    // Group members first: one signal reaches all of them.
    if alive(-group) {
        signal(-group, libc::SIGTERM);
    }
    let strays: Vec<libc::pid_t> = tree.into_iter().filter(|pid| alive(*pid)).collect();
    for pid in &strays {
        signal(*pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + DESCENDANT_GRACE;
    while Instant::now() < deadline && (alive(-group) || strays.iter().any(|pid| alive(*pid))) {
        std::thread::sleep(Duration::from_millis(25));
    }
    signal(-group, libc::SIGKILL);
    for pid in &strays {
        if alive(*pid) {
            signal(*pid, libc::SIGKILL);
        }
    }
    let settle = Instant::now() + Duration::from_millis(500);
    while Instant::now() < settle && strays.iter().any(|pid| alive(*pid)) {
        std::thread::sleep(Duration::from_millis(25));
    }
    StopReport {
        graceful,
        status,
        stray_descendants: strays.len(),
        survivors: strays.iter().filter(|pid| alive(**pid)).count(),
    }
}

fn signal(target: libc::pid_t, signal: libc::c_int) {
    if target == 0 || target == -1 {
        return;
    }
    // SAFETY: plain syscall; ESRCH for an already-gone target is expected.
    unsafe {
        libc::kill(target, signal);
    }
}

/// Whether a pid (or, negative, a process group) can still be signalled. A
/// zombie counts until its new parent reaps it.
fn alive(target: libc::pid_t) -> bool {
    if target == 0 || target == -1 {
        return false;
    }
    // SAFETY: signal 0 only checks existence and permission.
    unsafe { libc::kill(target, 0) == 0 }
}

/// Every transitive child of `root` right now.
pub fn descendants(root: libc::pid_t) -> Vec<libc::pid_t> {
    let table = process_table();
    let mut found = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for &(pid, ppid) in &table {
            if ppid == parent && pid != root && !found.contains(&pid) {
                found.push(pid);
                frontier.push(pid);
            }
        }
    }
    found
}

/// (pid, ppid) for every process this user can see.
#[cfg(target_os = "linux")]
fn process_table() -> Vec<(libc::pid_t, libc::pid_t)> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid: libc::pid_t = entry.file_name().to_str()?.parse().ok()?;
            let stat = fs::read_to_string(entry.path().join("stat")).ok()?;
            // The command name is parenthesized and may hold spaces.
            let rest = &stat[stat.rfind(')')? + 2..];
            let ppid = rest.split_whitespace().nth(1)?.parse().ok()?;
            Some((pid, ppid))
        })
        .collect()
}

/// (pid, ppid) for every process, from the system `ps` by absolute path.
#[cfg(not(target_os = "linux"))]
fn process_table() -> Vec<(libc::pid_t, libc::pid_t)> {
    let Ok(output) = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .collect()
}

fn wait_briefly(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + limit;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn describe_status(status: &ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(code), _) => format!("exit code {code}"),
        (None, Some(signal)) => format!("signal {signal}"),
        _ => "unknown status".into(),
    }
}

/// Read one line from the readiness pipe on a thread of its own, so the caller
/// can keep watching the child and the clock. Bounded: a child that writes
/// without a newline cannot make the shell buffer forever.
fn read_first_line(read: OwnedFd) -> mpsc::Receiver<Result<String, String>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let file = File::from(read);
        let mut reader = BufReader::new(file.take(4096));
        let mut line = String::new();
        let result = match reader.read_line(&mut line) {
            Ok(0) => Err("the readiness pipe closed without a report".into()),
            Ok(_) if line.ends_with('\n') => Ok(line),
            Ok(_) => Err("the readiness report was truncated".into()),
            Err(err) => Err(format!("reading readiness failed: {err}")),
        };
        let _ = tx.send(result);
    });
    rx
}

fn cloexec_pipe() -> Result<(OwnedFd, OwnedFd), LaunchError> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: `fds` has room for both ends; both are owned immediately below.
    let created = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if created != 0 {
        return Err(LaunchError::Io(format!(
            "Could not create the readiness pipe: {}",
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: freshly created descriptors nobody else owns.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    for fd in [read.as_raw_fd(), write.as_raw_fd()] {
        // SAFETY: valid descriptors owned above.
        let ok = unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == 0;
        if !ok {
            return Err(LaunchError::Io(
                "Could not protect the readiness pipe.".into(),
            ));
        }
    }
    Ok((read, write))
}

/// Created owner-only, and tightened if it already existed looser.
fn create_private_dir(dir: &Path) -> Result<(), LaunchError> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|err| LaunchError::Io(format!("Could not create {}: {err}", dir.display())))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|err| LaunchError::Io(format!("Could not protect {}: {err}", dir.display())))
}

fn open_log(path: &Path) -> Result<(File, u64), LaunchError> {
    if fs::metadata(path)
        .map(|meta| meta.len() > LOG_ROTATE_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .map_err(|err| LaunchError::Io(format!("Could not open {}: {err}", path.display())))?;
    let start = file.seek(SeekFrom::End(0)).unwrap_or(0);
    Ok((file, start))
}

fn log_clone(log: &File) -> Result<File, LaunchError> {
    log.try_clone()
        .map_err(|err| LaunchError::Io(format!("Could not share the server log: {err}")))
}

/// A line of the shell's own in the server log, so one file tells the story.
fn shell_line(log: &mut File, message: &str) {
    let _ = writeln!(log, "[shell] {message}");
}

/// The last lines this launch wrote, for a failure message.
fn log_tail(path: &Path, start: u64) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut raw = Vec::new();
    if file.take(256 * 1024).read_to_end(&mut raw).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.starts_with("[shell]") && !line.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(LOG_TAIL_LINES)..]
        .iter()
        .map(|line| line.chars().take(300).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn random_hex(bytes: usize) -> Result<String, LaunchError> {
    let mut buffer = vec![0u8; bytes];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut buffer))
        .map_err(|err| LaunchError::Io(format!("No randomness for the launch nonce: {err}")))?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests;
