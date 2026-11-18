//! Which server the shell points at, and the little the shell remembers about
//! its own windows.
//!
//! The shell is deliberately dumb about the app itself — it loads a URL and gets
//! out of the way — so the URL is the one piece of state it owns. Keeping it in
//! the app config dir rather than compiled in is what lets a single build follow
//! production, a PR preview, or a laptop dev server without a rebuild, which is
//! the whole point of a remote-URL shell.
//!
//! Two more things live beside it, and both exist only because the page cannot
//! answer them in time. The window is created BEFORE any page has run, so the
//! theme it should be painted and the size it should open at have to be known
//! one launch early: the page reports them when it is ready and the shell reads
//! them back next time. Neither is authoritative — `assistant.prefs` on the
//! served origin still owns the theme — they are last-known values used to avoid
//! a flash and a jump.

use std::fs;
use std::path::PathBuf;
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
#[cfg(desktop)]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};

use crate::{
    origins::TrustedOrigins,
    server_url::{normalize_default_server, normalize_server},
    trace,
};

/// Where the shell points before anyone chooses otherwise.
pub const DEFAULT_SERVER_URL: &str = match option_env!("PA_SHELL_SERVER_URL") {
    Some(url) => url,
    None => "http://localhost:8787",
};

static TRUSTED_ORIGINS: OnceLock<Mutex<TrustedOrigins>> = OnceLock::new();

fn trusted_origins() -> &'static Mutex<TrustedOrigins> {
    TRUSTED_ORIGINS.get_or_init(|| Mutex::new(TrustedOrigins::new()))
}

/// Kept separate so the actual runtime template is checked by unit tests.
fn remote_capability(urls: &[String]) -> String {
    use tauri::utils::acl::capability::{Capability, CapabilityRemote};
    let mut capability: Capability =
        serde_json::from_str(include_str!("../capabilities/remote.json"))
            .expect("valid hosted-app capability template");
    capability.remote = Some(CapabilityRemote {
        urls: urls.to_vec(),
    });
    serde_json::to_string(&capability).expect("serializable hosted-app capability")
}

/// Register the same URLPatterns used by navigation before publishing a choice.
/// Tauri 2's runtime capabilities append, so prior choices live until restart.
/// Callers: startup's remote choice, a probed repoint, and a local child that
/// proved its readiness.
pub fn trust_server(app: &AppHandle, url: &str) -> Result<(), String> {
    let mut current = trusted_origins().lock().map_err(|err| err.to_string())?;
    let mut next = current.clone();
    if next.add_server(url)? {
        app.add_capability(remote_capability(next.urls()))
            .map_err(|err| err.to_string())?;
        *current = next;
    }
    Ok(())
}

/// Must run before the first hosted window is built.
pub fn initialize_trust(app: &AppHandle) -> Result<(), String> {
    trust_server(app, &server_url(app))
}

/// The page's theme when the shell has never been told otherwise. Matches the
/// fallback in `app/web/index.html`, which also assumes dark when it cannot read
/// `assistant.prefs` — so a first launch and a first paint agree.
pub const DEFAULT_THEME: &str = "dark";

/// How long geometry changes are collected before one write.
///
/// Geometry is desktop-only surface, not merely unused on iOS: there is one
/// window there and tao sizes it itself.
#[cfg(desktop)]
///
/// A drag or a resize delivers an event per frame; without this the shell would
/// rewrite `shell.json` a hundred times to record one gesture.
const GEOMETRY_DEBOUNCE: Duration = Duration::from_millis(500);

/// Smallest geometry worth restoring, in physical px. A stored size under this
/// is treated as corrupt rather than obeyed: a window a few px tall cannot be
/// resized back by hand, so the failure would be unrecoverable from the UI.
#[cfg(desktop)]
const GEOMETRY_MIN: u32 = 200;

/// The size and place a window should open at, in PHYSICAL px — the units both
/// `WindowEvent::Resized` and `WindowEvent::Moved` report, so nothing is
/// converted on the way in or out. `width`/`height` are the inner (client) area
/// and `x`/`y` the outer position, matching `set_size` and `set_position`.
#[cfg(desktop)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

#[cfg(desktop)]
impl WindowGeometry {
    /// Whether this is worth handing to a window at all.
    pub fn is_sane(&self) -> bool {
        self.width >= GEOMETRY_MIN && self.height >= GEOMETRY_MIN
    }
}

/// Which server app windows load: the bundled local one, or the remembered
/// remote URL. Kept apart from that URL so a round trip through local mode
/// keeps the remote choice, and apart from any credential gateway, which the
/// server itself configures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerMode {
    Local,
    Remote,
}

impl ServerMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    /// The remembered REMOTE server. Kept while local mode is selected.
    pub server_url: Option<String>,
    /// `"local"` or `"remote"`. A string rather than the enum so a value from
    /// a newer build cannot make the whole file unreadable.
    pub mode: Option<String>,
    /// The port the local server last bound, offered to it as a preference
    /// so the page's origin — and its storage — survives a relaunch.
    pub local_port: Option<u16>,
    /// `"dark"` or `"light"`, as last reported by a page through `window_ready`.
    pub theme: Option<String>,
    #[cfg(desktop)]
    pub window: Option<WindowGeometry>,
}

/// The newest geometry seen while a debounce window is open, and whether a
/// writer is already waiting to flush it. Kept here rather than per window
/// because only one geometry is stored: whichever window moved last wins, which
/// is also the one the user was just handling.
#[cfg(desktop)]
static PENDING_GEOMETRY: Mutex<Option<WindowGeometry>> = Mutex::new(None);
#[cfg(desktop)]
static GEOMETRY_FLUSH_SCHEDULED: AtomicBool = AtomicBool::new(false);

/// A file the shell may keep of its own, beside `shell.json`. The one place the
/// app config dir is resolved, so a second file cannot end up in a different one.
pub fn app_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    Ok(dir.join(name))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_file(app, "shell.json")
}

/// Everything the shell has stored. A corrupt or unreadable file is treated as
/// absent: the shell must always come up, and every reader below has a default.
fn load(app: &AppHandle) -> ShellConfig {
    config_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<ShellConfig>(&raw).ok())
        .unwrap_or_default()
}

/// Write the whole config back. Every setter goes load → change → store rather
/// than writing its own field alone: three unrelated things share this file now,
/// and a setter that serialized only what it knew about would silently drop the
/// other two.
fn store(app: &AppHandle, config: &ShellConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let body = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    fs::write(&path, body).map_err(|err| err.to_string())
}

/// The user's persisted choice wins over the build-time default. Invalid stored
/// values are ignored; choosing another host never requires rebuilding.
pub fn server_url(app: &AppHandle) -> String {
    load(app)
        .server_url
        .as_deref()
        .and_then(|url| normalize_server(url).ok())
        .unwrap_or_else(|| {
            normalize_default_server(DEFAULT_SERVER_URL).expect("validated build-time server URL")
        })
}

/// Bootstrap-only: validate and grant a user's explicit server choice before
/// persisting it. Navigation and IPC use identical patterns. Choosing a remote
/// server is also choosing remote mode, in the same write.
pub fn set_server_url(app: &AppHandle, url: &str) -> Result<String, String> {
    let normalized = normalize_server(url)?;
    trust_server(app, &normalized)?;
    let mut config = load(app);
    config.server_url = Some(normalized.clone());
    config.mode = Some(ServerMode::Remote.as_str().to_string());
    store(app, &config)?;
    Ok(normalized)
}

/// The mode a launch starts in. See [`effective_mode`].
pub fn server_mode(app: &AppHandle, local_available: bool) -> ServerMode {
    effective_mode(&load(app), local_available)
}

/// A stored choice wins while it is possible. With none, an install that has
/// never been pointed at a remote server and carries a bundled one starts
/// local; one that already remembers a server keeps using it, so an upgrade
/// never moves an existing user. Local mode in a build without the bundled
/// server falls back to remote WITHOUT forgetting the choice.
pub fn effective_mode(config: &ShellConfig, local_available: bool) -> ServerMode {
    if !local_available {
        return ServerMode::Remote;
    }
    match config.mode.as_deref() {
        Some("local") => ServerMode::Local,
        Some("remote") => ServerMode::Remote,
        _ if config.server_url.is_some() => ServerMode::Remote,
        _ => ServerMode::Local,
    }
}

/// Bootstrap-only: persist the mode, leaving the remote URL alone.
pub fn set_server_mode(app: &AppHandle, mode: ServerMode) -> Result<(), String> {
    let mut config = load(app);
    config.mode = Some(mode.as_str().to_string());
    store(app, &config)
}

/// The port the local server bound last time, if any.
pub fn local_port(app: &AppHandle) -> Option<u16> {
    load(app).local_port.filter(|port| *port != 0)
}

pub fn set_local_port(app: &AppHandle, port: u16) {
    let mut config = load(app);
    if config.local_port == Some(port) {
        return;
    }
    config.local_port = Some(port);
    if let Err(err) = store(app, &config) {
        trace!("set_local_port failed: {err}");
    }
}

/// The theme the next window should be painted before its page can say.
pub fn theme(app: &AppHandle) -> String {
    match load(app).theme {
        Some(theme) if theme == "dark" || theme == "light" => theme,
        _ => DEFAULT_THEME.to_string(),
    }
}

/// Remember the theme a ready page reported. Only the two known values are
/// stored, so a page from a future build cannot leave an unpaintable value
/// behind; anything else is dropped and the last good answer stands.
pub fn set_theme(app: &AppHandle, theme: &str) {
    if theme != "dark" && theme != "light" {
        return;
    }
    let mut config = load(app);
    if config.theme.as_deref() == Some(theme) {
        return;
    }
    config.theme = Some(theme.to_string());
    if let Err(err) = store(app, &config) {
        trace!("set_theme {theme} failed: {err}");
    }
}

/// The geometry a new window should open at, if one was stored and is sane.
#[cfg(desktop)]
pub fn window_geometry(app: &AppHandle) -> Option<WindowGeometry> {
    load(app).window.filter(WindowGeometry::is_sane)
}

/// Record where a window now is, coalescing a whole drag or resize into one
/// write.
///
/// The flag is claimed BEFORE the thread is spawned, so a burst of events during
/// the wait updates the pending value and schedules nothing further. The writer
/// reads the newest value at the end of the wait rather than the one that
/// scheduled it, which is why the gesture's last frame is what lands.
#[cfg(desktop)]
pub fn remember_geometry(app: &AppHandle, geometry: WindowGeometry) {
    if !geometry.is_sane() {
        return;
    }
    if let Ok(mut pending) = PENDING_GEOMETRY.lock() {
        *pending = Some(geometry);
    } else {
        return;
    }
    if GEOMETRY_FLUSH_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(GEOMETRY_DEBOUNCE);
        GEOMETRY_FLUSH_SCHEDULED.store(false, Ordering::SeqCst);
        let latest = PENDING_GEOMETRY
            .lock()
            .ok()
            .and_then(|mut pending| pending.take());
        let Some(latest) = latest else { return };
        let mut config = load(&app);
        config.window = Some(latest);
        if let Err(err) = store(&app, &config) {
            trace!("remember_geometry failed: {err}");
        }
    });
}

/// Origins the window may navigate to.
///
/// Remote IPC and navigation test the same URLPatterns. Merely visiting a host
/// cannot grant it trust; only initialize_trust and set_server_url can do that.
pub fn is_allowed(url: &Url) -> bool {
    match url.scheme() {
        // The bundled bootstrap page and Tauri's own IPC origin.
        "tauri" | "asset" => true,
        "http" | "https" => trusted_origins()
            .lock()
            .map(|trust| trust.is_allowed(url))
            .unwrap_or(false),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::acl::capability::Capability;

    fn parse(raw: &str) -> ShellConfig {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn mode_defaults_keep_existing_remote_users_remote() {
        assert_eq!(effective_mode(&parse("{}"), true), ServerMode::Local);
        assert_eq!(effective_mode(&parse("{}"), false), ServerMode::Remote);
        let remote_user = parse(r#"{"serverUrl":"https://pa.example"}"#);
        assert_eq!(effective_mode(&remote_user, true), ServerMode::Remote);
        // An unknown value from a newer build neither breaks the file nor
        // decides anything.
        let future = parse(r#"{"serverUrl":"https://pa.example","mode":"gateway"}"#);
        assert_eq!(future.server_url.as_deref(), Some("https://pa.example"));
        assert_eq!(effective_mode(&future, true), ServerMode::Remote);
        // Local chosen, then the bundled server went away: remote for now,
        // the stored choice intact.
        let local = parse(r#"{"serverUrl":"https://pa.example","mode":"local"}"#);
        assert_eq!(effective_mode(&local, false), ServerMode::Remote);
        assert_eq!(local.mode.as_deref(), Some("local"));
    }

    #[test]
    fn a_mode_round_trip_preserves_the_remote_url_and_everything_else() {
        let mut config =
            parse(r#"{"serverUrl":"https://pa.example:8443","theme":"light","localPort":49152}"#);
        for mode in [ServerMode::Local, ServerMode::Remote, ServerMode::Local] {
            config.mode = Some(mode.as_str().to_string());
            config = parse(&serde_json::to_string(&config).unwrap());
            assert_eq!(effective_mode(&config, true), mode);
            assert_eq!(
                config.server_url.as_deref(),
                Some("https://pa.example:8443")
            );
            assert_eq!(config.theme.as_deref(), Some("light"));
            assert_eq!(config.local_port, Some(49152));
        }
    }

    #[test]
    fn runtime_template_grants_only_hosted_app_permissions() {
        let mut trust = TrustedOrigins::new();
        trust.add_server("https://assistant.example:8443").unwrap();
        let capability: Capability =
            serde_json::from_str(&remote_capability(trust.urls())).unwrap();
        assert!(!capability.local);
        assert_eq!(capability.windows, ["main", "window*"]);
        assert_eq!(capability.remote.unwrap().urls, trust.urls());
        for permission in [
            "allow-set-server-url",
            "allow-get-server-url",
            "allow-probe-server",
            "allow-get-server-choice",
            "allow-use-local-server",
            "allow-local-server-status",
        ] {
            assert!(
                !capability
                    .permissions
                    .iter()
                    .any(|entry| entry.identifier().as_ref() == permission),
                "granted {permission}"
            );
        }
    }
}
