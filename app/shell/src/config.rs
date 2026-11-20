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
fn trust_server(app: &AppHandle, url: &str) -> Result<(), String> {
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    pub server_url: Option<String>,
    /// `"local"` runs the bundled server (`local_server.rs`); `"remote"` uses
    /// `server_url`. Unset means local when the build carries a server.
    #[cfg(desktop)]
    pub mode: Option<String>,
    /// The bundled server's port, kept so its origin (and the page's storage)
    /// is the same every launch.
    #[cfg(desktop)]
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

/// Held across every load → change → store, so two writers on different
/// threads (geometry, a server choice, the local port) cannot each write back
/// a copy that lacks the other's change.
static CONFIG_WRITE: Mutex<()> = Mutex::new(());

/// Change the stored config. Every setter goes through here rather than
/// writing its own field alone: unrelated things share this file, and a setter
/// that serialized only what it knew about would silently drop the others.
fn update(app: &AppHandle, change: impl FnOnce(&mut ShellConfig)) -> Result<(), String> {
    let _write = CONFIG_WRITE.lock().map_err(|err| err.to_string())?;
    let mut config = load(app);
    change(&mut config);
    let body = serde_json::to_string_pretty(&config).map_err(|err| err.to_string())?;
    write_atomic(&config_path(app)?, &body)
}

/// Replace `path` whole, so a reader without the write lock sees the old file
/// or the new one, never a truncated one it would take for defaults.
fn write_atomic(path: &std::path::Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, body).map_err(|err| err.to_string())?;
    fs::rename(&temporary, path).map_err(|err| err.to_string())
}

/// The user's persisted choice wins over the build-time default. Invalid stored
/// values are ignored; choosing another host never requires rebuilding.
pub fn server_url(app: &AppHandle) -> String {
    let config = load(app);
    #[cfg(desktop)]
    if is_local(app, &config) {
        if let Some(port) = config.local_port {
            return local_url(port);
        }
    }
    config
        .server_url
        .as_deref()
        .and_then(|url| normalize_server(url).ok())
        .unwrap_or_else(|| {
            normalize_default_server(DEFAULT_SERVER_URL).expect("validated build-time server URL")
        })
}

/// Bootstrap-only: validate and grant a user's explicit server choice before
/// persisting it. Navigation and IPC use identical patterns.
pub fn set_server_url(app: &AppHandle, url: &str) -> Result<String, String> {
    let normalized = normalize_server(url)?;
    trust_server(app, &normalized)?;
    update(app, |config| {
        config.server_url = Some(normalized.clone());
        #[cfg(desktop)]
        {
            config.mode = Some("remote".into());
        }
    })?;
    Ok(normalized)
}

#[cfg(desktop)]
fn local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[cfg(desktop)]
fn is_local(app: &AppHandle, config: &ShellConfig) -> bool {
    match config.mode.as_deref() {
        Some("local") => true,
        Some(_) => false,
        None => crate::local_server::runtime_dir(app).is_some(),
    }
}

/// Whether windows should open on the bundled server.
#[cfg(desktop)]
pub fn local_mode(app: &AppHandle) -> bool {
    is_local(app, &load(app))
}

/// The stored remote choice, whatever the current mode.
#[cfg(desktop)]
pub fn remote_server_url(app: &AppHandle) -> Option<String> {
    load(app).server_url
}

#[cfg(desktop)]
pub fn local_port(app: &AppHandle) -> Option<u16> {
    load(app).local_port
}

/// Trust the bundled server's origin and make it the shell's choice. Called
/// with the port the server is about to bind, before any window loads it.
#[cfg(desktop)]
pub fn use_local_port(app: &AppHandle, port: u16) -> Result<String, String> {
    let url = local_url(port);
    trust_server(app, &url)?;
    update(app, |config| {
        config.mode = Some("local".into());
        config.local_port = Some(port);
    })?;
    Ok(url)
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
    if load(app).theme.as_deref() == Some(theme) {
        return;
    }
    if let Err(err) = update(app, |config| config.theme = Some(theme.to_string())) {
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
        if let Err(err) = update(&app, |config| config.window = Some(latest)) {
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

    #[test]
    fn atomic_write_replaces_the_file_and_leaves_no_temporary() {
        let dir = std::env::temp_dir().join(format!("pa-shell-config-{}", std::process::id()));
        let path = dir.join("shell.json");
        write_atomic(&path, "{\"theme\":\"dark\"}").unwrap();
        write_atomic(&path, "{\"theme\":\"light\"}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"theme\":\"light\"}");
        assert!(!path.with_extension("json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    use tauri::utils::acl::capability::Capability;

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
