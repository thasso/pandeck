//! Native shell for the hosted assistant web app.
//!
//! This binary ships almost no UI. The window loads the app from the server over
//! HTTP or HTTPS, exactly as a browser would, so shipping a UI change means
//! deploying the server and nothing else — the shell is rebuilt only when it
//! grows a new NATIVE capability. What it does own is the handful of things a
//! browser tab cannot give us: a microphone grant that survives a relaunch, OS
//! notifications that open the thing they are about, a `pa://` URL scheme, a
//! menu bar, and window chrome the page can draw into.
//!
//! One codebase covers macOS and iOS. The iPhone is the reason the shell exists
//! at all: Safari there re-asks for the microphone on every single
//! `getUserMedia`, even in an installed Home Screen app, and a WKWebView whose
//! host app declares a purpose string does not. Everything platform-specific is
//! either a `cfg` here or lives in `ios.rs`; the page is the same build.
//!
//! A window points straight at the server and stays HIDDEN until its page reports
//! that it has painted, so opening one looks like a native window rather than
//! like a tab admitting it has nothing in it yet. The only bundled page is
//! `bootstrap/index.html`, and it is the RECOVERY surface rather than the way in:
//! a window that never becomes ready is sent back to it, and `Server…` in the
//! menu opens it deliberately. It exists because a pure remote-URL window that
//! cannot load, due to a network outage, server downtime or a wrong host, shows
//! a raw WebKit error with no way back.

mod buildinfo;
mod config;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(desktop)]
mod menu;
mod notify;
mod openurl;
mod openurl_pending;
mod origins;
mod panics;
mod port_forward;
mod ready;
mod server_url;
// The `UserNotifications` backend both Apple platforms share.
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod usernotify;

#[cfg(desktop)]
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::window::Color;
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

/// Leading space the traffic lights occupy, in CSS px.
///
/// The page does NOT get extra height for the title bar, deliberately: the whole
/// point is that the app's existing header row BECOMES the window chrome instead
/// of a second bar under it. So the only thing reserved is the horizontal room
/// the window controls need, and the header's own 36px is what they sit in.
#[cfg(target_os = "macos")]
const TITLEBAR_INSET_LEFT: u32 = 78;
#[cfg(not(target_os = "macos"))]
const TITLEBAR_INSET_LEFT: u32 = 0;

/// Where the traffic lights sit, so they centre in the app's own 36px header row
/// rather than in the standard title bar they no longer have.
///
/// These are NOT the resulting insets: the value is offset by about -10pt
/// vertically before it lands, so it is calibrated by measuring the buttons
/// (accessibility `AXPosition`) against the window, not by reading it as padding.
/// The buttons are 16pt, so centring them in a 36pt row means a 10pt top inset.
/// Re-measure after any change to the header's height.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_POSITION: (f64, f64) = (21.0, 20.0);

/// The page's own background, so the window frame behind a page that has not
/// painted yet is the app's colour rather than a white flash. The same two values
/// `app/web/index.html` sets inline and declares as its `theme-color`, and the
/// reason the shell stores a theme at all — the window exists before any page can
/// be asked which one is in force.
///
/// macOS takes this for the WINDOW layer only (the webview layer is unimplemented
/// there), which is exactly the layer that would otherwise flash. iOS ignores it
/// on both layers; nothing there is hidden long enough for it to matter.
const BACKGROUND_DARK: Color = Color(11, 12, 16, 255);
const BACKGROUND_LIGHT: Color = Color(247, 248, 250, 255);

/// Labels for popup windows. Tauri rejects a duplicate label, and a popup can be
/// opened, closed and opened again, so the counter never goes back down.
#[cfg(desktop)]
static POPUP_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Labels for app windows beyond the first. Same rule as popups — a label is
/// never reused — and the prefix is what `capabilities/` matches, so every
/// window of the app gets the same native surface as `main`.
#[cfg(desktop)]
static APP_WINDOW_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Runs before any page script on every navigation, including the remote app.
///
/// Four jobs, the first two of which must be true before the app's first paint:
/// mark the document so the web app can light up native-only affordances, reserve
/// the window controls' width as a CSS variable, report the load, and re-route
/// target=_blank clicks. Setting the inset INLINE on the root element is what lets
/// the page pick it up without the shell and the web app having to agree on a
/// stylesheet — an inline property beats any `:root` rule.
///
/// The load report belongs HERE rather than in the app bundle precisely because
/// this script is the shell's own: it runs on whatever build the server is
/// serving, so a window's fate never depends on the deployed page knowing about a
/// command the shell added later than it.
const INIT_SCRIPT: &str = r#"
(function () {
  var apply = function () {
    var root = document.documentElement;
    if (!root) return;
    root.setAttribute("data-native-shell", "__PLATFORM__");
    if (__TITLEBAR_INSET_LEFT__ > 0) {
      root.style.setProperty("--app-drag-inset-left", "__TITLEBAR_INSET_LEFT__px");
    }
  };
  apply();
  document.addEventListener("DOMContentLoaded", apply);

  // Reported at DOM-ready rather than at document start: the question this
  // answers is "did the server actually serve us a page", and a script running
  // before the document exists cannot yet say so. Failure is swallowed — a page
  // the shell did not grant this to is not a page whose window it is watching.
  var reportLoaded = function () {
    var bridge = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (bridge) { bridge("window_loaded").catch(function () {}); }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportLoaded);
  } else {
    reportLoaded();
  }

  __BLANK_LINKS__

  __SELF_TEST__
})();
"#;

/// macOS: put a dropped `target=_blank` click back on a path the shell is asked
/// about.
///
/// WKWebView DROPS a target=_blank anchor click: unlike `window.open`, and unlike
/// a named target, it asks neither the navigation nor the new-window delegate, so
/// the native side never learns the link exists and the click does nothing at
/// all. The decision itself stays native, in the new-window handler.
#[cfg(not(target_os = "ios"))]
const BLANK_LINKS: &str = r#"
  // Bubble phase, and only when nothing else claimed the click: a page that
  // handles its own anchor has already done what the user wanted, and hijacking
  // it here would open a window over the top of that.
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    // The user asking for a background tab or a download is not this link.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    var node = path.length ? path[0] : event.target;
    var anchor = node && node.closest ? node.closest("a[href]") : null;
    if (!anchor || anchor.target !== "_blank") return;
    event.preventDefault();
    window.open(anchor.href, "_blank");
  });
"#;

/// iOS: the same click, resolved by NAVIGATING instead.
///
/// There is no second window to open on a phone, and wry implements
/// `createWebViewWithConfiguration` only on macOS, so `window.open` is dropped
/// here rather than merely unhelpful. Navigating in place is what puts the URL in
/// front of the navigation guard, which is where the interesting half of the
/// decision already lives: a foreign URL is handed to Safari and this page stays
/// exactly where it was (the guard cancels the navigation), and an assistant URL
/// simply opens — which is what a `_blank` link should do on a phone anyway.
///
/// `window.open` gets the same treatment for a FOREIGN url only. Same-origin
/// `window.open` is left returning null, as it already does: the app uses it for
/// OAuth popups that post their result back to the opener, and sending those to
/// Safari would lose the callback instead of merely not showing it.
#[cfg(target_os = "ios")]
const BLANK_LINKS: &str = r#"
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    var node = path.length ? path[0] : event.target;
    var anchor = node && node.closest ? node.closest("a[href]") : null;
    if (!anchor || anchor.target !== "_blank") return;
    event.preventDefault();
    location.href = anchor.href;
  });

  var nativeOpen = window.open;
  window.open = function (url, name, features) {
    try {
      if (url && new URL(url, location.href).origin !== location.origin) {
        location.href = new URL(url, location.href).toString();
        return null;
      }
    } catch (err) {
      /* not a URL we can reason about; fall through */
    }
    return nativeOpen.call(window, url, name, features);
  };
"#;

/// Debug-only: prove from INSIDE the loaded page that this origin really reached
/// the native side. Whether a remote origin gets IPC is a capability question
/// answered by config, and a wrong answer is invisible — the page simply behaves
/// like a browser — so the shell asserts it out loud rather than waiting for a
/// microphone to mysteriously prompt.
#[cfg(debug_assertions)]
const SELF_TEST: &str = r#"
  // Reported as a NAVIGATION rather than a console line or the title: the guard
  // traces every navigation and blocks this host, and unlike `document.title`
  // the app cannot overwrite it a moment later.
  var mark = function (text) { location.href = "https://shell-selftest.invalid/" + encodeURIComponent(text); };
  var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  var internals = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke) { mark("no-global-bridge internals=" + Boolean(internals)); return; }
  // The viewport the page actually got is reported alongside the IPC verdict. On
  // a phone that is the one thing a shell can get wrong invisibly: a window sized
  // for a desktop lays the app out wide and then shows a fraction of it, which
  // reads as "the app looks wrong" rather than as a window-size bug.
  // Capture is reported alongside it for the same reason: WebKit hides
  // `mediaDevices` entirely from a host app with no microphone purpose string, and
  // the app's answer to that is a disabled mic button — indistinguishable from a
  // denied permission unless the shell says which it is.
  var viewport = function () {
    return " viewport=" + innerWidth + "x" + innerHeight + "@" + devicePixelRatio +
      " screen=" + screen.width + "x" + screen.height +
      " capture=" + Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) +
      " worklet=" + (typeof AudioWorkletNode !== "undefined") +
      " secure=" + isSecureContext;
  };
  invoke("shell_info").then(function (info) {
    // Reaching native code is only half of it: on a platform with overlay window
    // chrome the PAGE has to opt into it. A deployment older than the shell
    // passes the IPC check and still leaves a window that cannot be dragged,
    // which is what this catches. Polled because the region is rendered by the
    // app, not present at load.
    if (!info || !info.titlebarInsetLeft) { mark("ok " + (info && info.platform) + viewport()); return; }
    var tries = 0;
    var check = function () {
      if (document.querySelector("[data-tauri-drag-region]")) { mark("ok drag-region" + viewport()); }
      else if (++tries > 15) { mark("ok NO-drag-region (page not deployed with shell support?)" + viewport()); }
      else { setTimeout(check, 200); }
    };
    check();
  }, function (err) { mark("refused " + err); });
"#;
#[cfg(not(debug_assertions))]
const SELF_TEST: &str = "";

/// Trace to the dev console. A shell is debugged from the OUTSIDE — there is no
/// terminal inside the app and, on a device, no console at all — so the native
/// side narrates what it was asked to do. Compiled out of release builds.
/// Two definitions rather than a `#[cfg]` inside one body: an attribute on an
/// expression is still unstable, and this is used in expression position.
#[cfg(debug_assertions)]
macro_rules! trace {
    ($($arg:tt)*) => { crate::trace_line(&format!($($arg)*)) };
}
#[cfg(debug_assertions)]
pub(crate) use trace;
#[cfg(not(debug_assertions))]
macro_rules! trace {
    ($($arg:tt)*) => {{
        // Still REFERENCE the arguments, or every binding that exists only to be
        // traced warns as unused in release and nowhere else. Optimised away.
        if false {
            let _ = format_args!($($arg)*);
        }
    }};
}
#[cfg(not(debug_assertions))]
pub(crate) use trace;

/// Where a trace line goes.
///
/// An iOS process has no stderr anyone can read: neither `simctl launch
/// --console` nor `devicectl device process launch --console` relays it, and a
/// phone has no terminal. So the line goes to the unified log instead, which
/// `xcrun simctl spawn <device> log stream` shows for the simulator and
/// Console.app shows for a device (`log stream` takes no device, so there is no
/// CLI path for that half). Elsewhere stderr is what a developer already has in
/// front of them.
#[cfg(debug_assertions)]
pub(crate) fn trace_line(message: &str) {
    #[cfg(target_os = "ios")]
    log_line(message);
    #[cfg(not(target_os = "ios"))]
    eprintln!("[shell] {message}");
}

/// Where a line goes that must survive into a SHIPPED build — today, only what
/// `panics` reports.
///
/// `NSLog` rather than a raw `os_log` call because `os_log` is a macro over a
/// compile-time format buffer with no callable C entry point, while `NSLog` is
/// an ordinary variadic function. It reaches a terminal that ran the binary and
/// `xcrun simctl spawn <device> log stream` for the simulator; it does NOT reach
/// the unified log from this process, so Console.app is not a substitute and
/// `panics` keeps a file as well. The message is passed as an ARGUMENT to `%@`
/// and never as the format string itself: a session title or an error can
/// contain a `%`, and a format string built from one would read arguments that
/// were never pushed.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn log_line(message: &str) {
    use objc2_foundation::NSString;

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        fn NSLog(format: *const NSString, ...);
    }
    let format = NSString::from_str("[shell] %@");
    let message = NSString::from_str(message);
    // SAFETY: one `%@` in the format, one object argument for it.
    unsafe { NSLog(&*format, &*message) };
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) fn log_line(message: &str) {
    eprintln!("[shell] {message}");
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "desktop"
    }
}

fn init_script() -> String {
    INIT_SCRIPT
        .replace("__PLATFORM__", platform())
        .replace("__TITLEBAR_INSET_LEFT__", &TITLEBAR_INSET_LEFT.to_string())
        .replace("__BLANK_LINKS__", BLANK_LINKS)
        .replace("__SELF_TEST__", SELF_TEST)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    platform: &'static str,
    server_url: String,
    titlebar_inset_left: u32,
    /// Which build of the SHELL this is. The hosted page carries its own build
    /// identity and the server reports a third, and all three are installed and
    /// updated independently — so Settings shows them side by side rather than
    /// deriving one from another.
    build: buildinfo::BuildInfo,
}

/// What the shell is and where it points — the page's one call for everything it
/// might want to branch on.
#[tauri::command]
fn shell_info(app: AppHandle) -> ShellInfo {
    trace!("shell_info");
    ShellInfo {
        platform: platform(),
        server_url: config::server_url(&app),
        titlebar_inset_left: TITLEBAR_INSET_LEFT,
        build: buildinfo::current(&app),
    }
}

/// What the OS has granted this installation for alerts, and the APNs token if
/// there is one.
///
/// One call rather than two because the page needs both together to decide what
/// to do: register the token with the server, fall back to raising alerts over
/// the live socket, or tell the user the permission is off.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PushRegistration {
    /// Whether the OS lets this app post a notification at all. A real answer on
    /// both Apple platforms, which raise their alerts through
    /// `UserNotifications` and therefore both have a permission to be refused;
    /// always true elsewhere, where the plugin asks for nothing.
    allowed: bool,
    /// This launch's APNs device token, lowercase hex. iOS only, and absent until
    /// Apple has issued one — which is why the page also listens for
    /// `assistant://apns-token`.
    device_token: Option<String>,
    /// Which of Apple's two push hosts this token belongs to (`development` or
    /// `production`), taken from the `aps-environment` entitlement this build was
    /// signed with. Sent with the token so the server never has to guess: getting
    /// it wrong is reported by Apple only as `BadDeviceToken`.
    apns_environment: &'static str,
}

#[tauri::command]
fn push_registration() -> PushRegistration {
    #[cfg(target_os = "ios")]
    let registration = PushRegistration {
        allowed: usernotify::notifications_allowed(),
        device_token: ios::device_token(),
        apns_environment: env!("APNS_ENVIRONMENT"),
    };
    #[cfg(target_os = "macos")]
    let registration = PushRegistration {
        allowed: usernotify::notifications_allowed(),
        // No APNs route on macOS: alerts ride the app's own socket, so there is
        // no token for the page to register.
        device_token: None,
        apns_environment: env!("APNS_ENVIRONMENT"),
    };
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let registration = PushRegistration {
        allowed: true,
        device_token: None,
        apns_environment: env!("APNS_ENVIRONMENT"),
    };
    trace!(
        "push_registration allowed={} token={}",
        registration.allowed,
        registration.device_token.is_some()
    );
    registration
}

/// A document from the server reached DOM-ready in this window.
///
/// Raised by the shell's own initialization script, never by the app bundle, so
/// it is true of whatever build the server is serving. That is what makes it the
/// only signal allowed to decide whether the server is reachable — see
/// `ready`'s module comment.
#[tauri::command]
fn window_loaded(app: AppHandle, window: WebviewWindow) {
    ready::mark_loaded(&app, window.label());
}

/// The page in this window has painted the app.
///
/// Two jobs. It releases the window to be shown — which is the whole reason a
/// window can be created hidden — and it records the theme that page painted, so
/// the NEXT window can be built in the right colour before any page has run to
/// be asked. `config::set_theme` drops a value it does not recognise, so a page
/// from a future build cannot leave an unpaintable one behind.
///
/// Called again on every reload and remount; both halves are idempotent.
#[tauri::command]
fn window_ready(app: AppHandle, window: WebviewWindow, theme: Option<String>) {
    if let Some(theme) = theme.as_deref() {
        config::set_theme(&app, theme);
    }
    ready::mark_ready(&app, window.label());
}

/// Open another window on the app, optionally on a path of the page's choosing.
///
/// The page cannot build windows itself — `capabilities/remote.json` grants it no
/// window API — so this is the one door, and it validates the path rather than
/// taking it (`safe_path`). On iOS it hands back the single window that already
/// exists instead of pretending to have opened a second.
#[tauri::command]
fn open_window(app: AppHandle, path: Option<String>) {
    open_app_window(&app, path.as_deref());
}

/// Open one short-lived, token-free file grant in the OS default browser.
#[tauri::command]
fn open_served_file(app: AppHandle, url: String) -> Result<(), String> {
    let server = Url::parse(&config::server_url(&app))
        .map_err(|_| "The configured server URL is invalid.".to_string())?;
    let url = served_file_grant_url(&server, &url)?;
    trace!("open served file grant in browser");
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|err| format!("Could not open the served file: {err}"))
}

#[tauri::command]
fn get_server_url(app: AppHandle) -> String {
    let url = config::server_url(&app);
    trace!("get_server_url -> {url}");
    url
}

#[tauri::command]
fn set_server_url(
    app: AppHandle,
    forwards: State<'_, port_forward::PortForwardManager>,
    url: String,
) -> Result<String, String> {
    let normalized = config::set_server_url(&app, &url)?;
    forwards.stop_all();
    Ok(normalized)
}

#[tauri::command]
async fn start_port_forward(
    app: AppHandle,
    forwards: State<'_, port_forward::PortForwardManager>,
    grant: port_forward::PortForwardGrant,
) -> Result<port_forward::PortForwardStatus, port_forward::PortForwardStartError> {
    port_forward::start(app, forwards.inner().clone(), grant).await
}

/// Open one active loopback forward in the OS default browser. Validated in
/// `port_forward::open_url`: never a generic opener for the hosted page.
#[tauri::command]
fn open_port_forward_url(
    app: AppHandle,
    forwards: State<'_, port_forward::PortForwardManager>,
    url: String,
) -> Result<(), String> {
    trace!("open forwarded localhost URL in browser");
    port_forward::open_url(&app, forwards.inner(), &url)
}

#[tauri::command]
fn list_port_forwards(
    forwards: State<'_, port_forward::PortForwardManager>,
) -> Result<Vec<port_forward::PortForwardStatus>, String> {
    port_forward::list(forwards.inner())
}

#[tauri::command]
fn stop_port_forward(
    forwards: State<'_, port_forward::PortForwardManager>,
    port: u16,
) -> Result<port_forward::StoppedPortForward, String> {
    port_forward::stop(forwards.inner(), port)
}

/// Is there an assistant server answering at this URL?
///
/// Done in Rust rather than with `fetch` from the bootstrap page because
/// `/api/health` answers before the server's CORS/token gate and therefore sends
/// no `Access-Control-Allow-Origin` — the browser would block the read even
/// though the server replied. A native request has no such opinion.
#[tauri::command]
async fn probe_server(url: String) -> Result<bool, String> {
    let base = url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|err| err.to_string())?;
    let outcome = client.get(format!("{base}/api/health")).send().await;
    match &outcome {
        Ok(response) => trace!("probe_server {base} -> {}", response.status()),
        Err(err) => trace!("probe_server {base} -> {err}"),
    }
    Ok(outcome.map_err(|err| err.to_string())?.status().is_success())
}

fn background_color(app: &AppHandle) -> Color {
    if config::theme(app) == "light" {
        BACKGROUND_LIGHT
    } else {
        BACKGROUND_DARK
    }
}

/// A path the page asked a new window to open on, or nothing.
///
/// The page is the only caller today, but the shell already accepts targets from
/// anything on the machine through `pa://`, so a path is treated the way
/// `app/web/src/lib/openTarget.ts` treats its own input rather than trusted for
/// being close by: one leading slash (so it stays a path on this origin), no
/// protocol-relative `//`, and no backslashes.
fn safe_path(path: &str) -> Option<String> {
    let path = path.trim();
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        trace!("refusing window path {path}");
        return None;
    }
    Some(path.to_string())
}

/// Validate the sole same-origin URL family exposed to the native opener.
fn served_file_grant_url(server: &Url, raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Not a valid file-grant URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.origin() != server.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("Not an allowed file-grant URL.".to_string());
    }
    let Some(rest) = url.path().strip_prefix("/api/file-grants/") else {
        return Err("Not an allowed file-grant URL.".to_string());
    };
    let Some((grant_id, document)) = rest.split_once('/') else {
        return Err("The file grant URL has no document path.".to_string());
    };
    if grant_id.is_empty()
        || !grant_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        || document.is_empty()
        || document.starts_with('/')
    {
        return Err("Not a valid file-grant URL.".to_string());
    }
    Ok(url)
}

#[cfg(test)]
mod served_file_grant_url_tests {
    use super::served_file_grant_url;
    use tauri::Url;

    #[test]
    fn accepts_only_same_origin_token_free_grants() {
        let server = Url::parse("https://pa.example").unwrap();
        // Open and Download share the narrow route shape; delivery is bound to
        // the opaque server-side grant rather than expressed in this URL.
        for grant in ["open_123", "download_123"] {
            assert!(served_file_grant_url(
                &server,
                &format!("https://pa.example/api/file-grants/{grant}/report.pdf")
            )
            .is_ok());
        }
        assert!(
            served_file_grant_url(&server, "/api/file-grants/abc/report.pdf").is_err()
        );
        assert!(served_file_grant_url(
            &server,
            "https://evil.example/api/file-grants/abc/report.pdf"
        )
        .is_err());
        assert!(served_file_grant_url(
            &server,
            "https://pa.example:8443/api/file-grants/abc/report.pdf"
        )
        .is_err());
        assert!(served_file_grant_url(
            &server,
            "https://pa.example/api/files/etc/passwd?token=secret"
        )
        .is_err());
        assert!(served_file_grant_url(
            &server,
            "https://pa.example/api/file-grants/abc/report.pdf?token=secret"
        )
        .is_err());
        // An older page cannot recover query-toggled download behavior through
        // the native opener; it must mint a mode-bound attachment grant.
        assert!(served_file_grant_url(
            &server,
            "https://pa.example/api/file-grants/abc/report.pdf?download=1"
        )
        .is_err());
    }
}

/// Where an app window starts: the configured server, plus a path if one was
/// asked for and survived [`safe_path`].
///
/// The joined result is re-checked against the allow-list, so the only way out of
/// this function is a URL the navigation guard would also admit — a window can
/// never be created on a page it would then refuse to load.
fn app_url(app: &AppHandle, path: Option<&str>) -> Url {
    let configured = config::server_url(app);
    let base = Url::parse(&configured)
        .or_else(|_| Url::parse(config::DEFAULT_SERVER_URL))
        .expect("the default server URL parses");
    let Some(path) = path.and_then(safe_path) else {
        return base;
    };
    match base.join(&path) {
        Ok(url) if config::is_allowed(&url) => url,
        _ => base,
    }
}

/// How far a new window is offset from the one that opened it, in physical px.
/// Without it a second window lands exactly on the first and looks like nothing
/// happened.
#[cfg(desktop)]
const WINDOW_CASCADE: i32 = 28;

/// The child window a page asked for with `window.open`, or nothing if it could
/// not be built. Only ever called for a URL `config::is_allowed` admits.
///
/// The child is built HERE rather than answered with `Allow`: allowing it lets
/// WebKit make a plain `WKWebView` from the opener's configuration, custom URL
/// scheme handlers and all, and the first `ipc://` request then reads ivars that
/// exist only on wry's subclass — an uninitialized-ivar panic that takes the
/// whole app down. Building it ourselves from the SAME configuration is what
/// makes the child a real wry webview.
#[cfg(desktop)]
fn open_child_window(
    app: &AppHandle,
    url: &Url,
    features: tauri::webview::NewWindowFeatures,
) -> Option<WebviewWindow> {
    let label = format!("popup{}", POPUP_COUNT.fetch_add(1, Ordering::Relaxed));
    trace!("new window {url} -> child window {label}");

    // Same configuration, but NOT the same user-content controller. WebKit hands
    // over a configuration that still carries the OPENER's controller, and that
    // controller already has wry's `ipc` script-message handler on it; wry then
    // registers its own for this webview and `WKUserContentController` raises
    // `NSInvalidArgumentException: Attempt to add script message handler with
    // name 'ipc' when one already exists`. wry catches that — but only where
    // Rust can unwind, and the release profile then set `panic = "abort"`, so in
    // a SHIPPED build the exception hit a nounwind frame and aborted. A
    // `cargo run` build unwound and survived, which is why this only ever showed
    // up in the installed app; the profile no longer does that, and this no
    // longer relies on it. A fresh controller is also the honest shape: a child
    // window is its own webview, not a second view on the opener's scripts.
    #[cfg(target_os = "macos")]
    let configuration = {
        use objc2_web_kit::WKUserContentController;

        let configuration = features.opener().target_configuration.clone();
        // The delegate call this runs inside is always on the main thread; if it
        // somehow is not, refusing beats risking the exception above.
        let mtm = objc2::MainThreadMarker::new()?;
        unsafe { configuration.setUserContentController(&WKUserContentController::new(mtm)) };
        configuration
    };

    #[allow(unused_mut)]
    let mut popup = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title(url.host_str().unwrap_or("Pandeck"))
        .window_features(features);
    #[cfg(target_os = "macos")]
    {
        popup = popup.with_webview_configuration(configuration);
    }

    let window = match popup.build() {
        Ok(window) => window,
        Err(err) => {
            trace!("child window {label} failed: {err}");
            return None;
        }
    };

    // `build` reports only what TAURI could do. A webview the RUNTIME failed to
    // create is still an `Ok` here — the runtime logs the failure and drops the
    // window on the floor — and answering `Create` with one of those unwraps a
    // `None` inside `tauri-runtime-wry` and aborts. Ask the window something
    // only a live one can answer instead of trusting `Ok`.
    if let Err(err) = window.url() {
        trace!("child window {label} did not survive creation: {err}");
        let _ = window.close();
        return None;
    }
    Some(window)
}

/// Build one window of the shell — the hosted app or the bundled bootstrap page.
/// Every app window is a peer: same navigation policy, same chrome, same native
/// surface — a second window is another view of the assistant, not a lesser one.
/// On iOS there is exactly one, and this still builds it.
///
/// The label is what `capabilities/` matches, so a new label outside the patterns
/// listed there would load the app and then silently have no native surface at
/// all. Keep the two in step.
fn build_window(
    app: &AppHandle,
    label: &str,
    url: WebviewUrl,
    visible: bool,
) -> tauri::Result<WebviewWindow> {
    let navigate_handle = app.clone();
    let opener_handle = app.clone();
    #[cfg(desktop)]
    let popup_handle = app.clone();

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, label, url)
        .title("Pandeck")
        .initialization_script(init_script())
        .background_color(background_color(app))
        // Not a nicety: the default policy SUSPENDS a webview that is not in a
        // visible window, and an app window starts hidden waiting for its page to
        // report in — which that page cannot do while suspended. It also keeps a
        // minimized window's socket and stream alive, which the default would
        // have dropped after a few minutes. macOS 14+/iOS 17+; below that the
        // show deadline in `ready` is the safety net.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        // The window is for the assistant. Anything else the app links to
        // is someone else's page and belongs in a real browser, where the
        // user has their sessions, extensions, and a URL bar to check.
        //
        // Guarded because WebKit calls this through an `extern "C"` frame: a
        // panic here would abort the app rather than fail the decision, and the
        // input is a URL some page chose. Refusing is the safe answer — a
        // navigation that does not happen is recoverable, one this never
        // vetted is not.
        .on_navigation(move |url| {
            panics::guard("navigation guard", false, || {
                if config::is_allowed(url) {
                    trace!("navigate {url}");
                    return true;
                }
                #[cfg(debug_assertions)]
                if url.host_str() == Some("shell-selftest.invalid") {
                    trace!("SELF-TEST {}", url.path().trim_start_matches('/'));
                    return false;
                }
                trace!("navigate {url} -> handed to the browser");
                let _ = navigate_handle.opener().open_url(url.to_string(), None::<&str>);
                false
            })
        });

    // `window.open` asks for a NEW window rather than navigating, so it never
    // reaches the guard above; with no handler the request is dropped and the
    // call simply returns null. Same policy as above, one decision later: a
    // foreign page goes to the browser, and an assistant URL gets a real child
    // window, which is what an OAuth popup needs to keep its opener and post its
    // result back. Desktop only, because wry implements the underlying
    // `createWebViewWithConfiguration` delegate only there — on iOS the page's
    // own shim handles it (see `BLANK_LINKS`).
    #[cfg(desktop)]
    {
        use tauri::webview::NewWindowResponse;
        // Guarded for the same reason as the navigation handler, and with more
        // behind it: this one builds a whole window, so it runs a great deal of
        // code that has never heard of the `extern "C"` frame it is under.
        builder = builder.on_new_window(move |url, features| {
            panics::guard("new-window handler", NewWindowResponse::Deny, || {
                if !config::is_allowed(&url) {
                    trace!("new window {url} -> handed to the browser");
                    let _ = opener_handle.opener().open_url(url.to_string(), None::<&str>);
                    return NewWindowResponse::Deny;
                }
                match open_child_window(&popup_handle, &url, features) {
                    Some(window) => NewWindowResponse::Create { window },
                    // The click still has to go SOMEWHERE. A denied new-window
                    // request is silent in the page — `window.open` returns null
                    // and an anchor does nothing — so a child we could not build
                    // falls back to the browser rather than to nothing happening.
                    None => {
                        trace!("new window {url} -> handed to the browser after all");
                        let _ = opener_handle.opener().open_url(url.to_string(), None::<&str>);
                        NewWindowResponse::Deny
                    }
                }
            })
        });
    }
    #[cfg(not(desktop))]
    let _ = opener_handle;

    // A starting size, and a floor below which the three-pane layout stops
    // making sense. Desktop only, and NOT because they would merely be ignored on
    // iOS: tao sizes the `UIWindow` from `inner_size` there, so a desktop default
    // makes a 1280pt window on a 393pt screen — the page lays out the wide layout
    // and the phone shows the left third of it.
    #[cfg(desktop)]
    {
        builder = builder
            .visible(visible)
            .inner_size(1280.0, 860.0)
            .min_inner_size(680.0, 480.0);
    }
    #[cfg(not(desktop))]
    let _ = visible;

    // Let the page extend under the window controls instead of stacking a
    // title bar on top of the app's own header row.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(
                TRAFFIC_LIGHT_POSITION.0,
                TRAFFIC_LIGHT_POSITION.1,
            ));
    }

    let window = builder.build()?;
    #[cfg(desktop)]
    {
        restore_geometry(&window, config::window_geometry(app));
        track_window(&window);
    }
    #[cfg(target_os = "ios")]
    ios::cover_safe_area(&window);
    Ok(window)
}

/// Open a window on the hosted app, hidden until its page says it is worth
/// looking at.
///
/// The window goes STRAIGHT to the server rather than by way of the bootstrap
/// page. That page used to probe the server and then `location.replace` into it,
/// which cost every window an HTTP round trip and a second full document load
/// before the app could even start — and, because a failed probe refused to
/// navigate at all, it also denied the app the one situation its service worker
/// and cached shell exist for. `ready::watch` owns what the probe used to: a page
/// that never arrives is sent back to the bootstrap page.
fn build_app_window(
    app: &AppHandle,
    label: &str,
    path: Option<&str>,
) -> tauri::Result<WebviewWindow> {
    let url = app_url(app, path);
    trace!("app window {label} -> {url}");
    let window = build_window(app, label, WebviewUrl::External(url), false)?;
    ready::watch(app, label);
    Ok(window)
}

/// Put a new window back where the last one was.
///
/// Applied after the build rather than through the builder because the stored
/// values are PHYSICAL — the units `WindowEvent` reports — while `inner_size` is
/// logical, and converting would need the scale factor of a window that does not
/// exist yet. The window is still hidden here, so there is nothing to see jump.
#[cfg(desktop)]
fn restore_geometry(window: &WebviewWindow, geometry: Option<config::WindowGeometry>) {
    let Some(geometry) = geometry else { return };
    let _ = window.set_size(tauri::PhysicalSize::new(geometry.width, geometry.height));
    // Only where it can still be seen. A position saved while an external display
    // was attached would otherwise put the window somewhere the user has no way
    // to fetch it back from.
    let on_screen = window
        .monitor_from_point(geometry.x as f64, geometry.y as f64)
        .unwrap_or(None)
        .is_some();
    if on_screen {
        let _ = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
    }
}

/// Follow this window through the two things the shell remembers about it: where
/// it ends up, so the next one opens there, and when it goes, so its label stops
/// being remembered as ready.
///
/// The window is looked up by label inside the handler rather than captured:
/// holding a `WebviewWindow` in a closure the window itself owns is a cycle, and
/// the lookup costs a map read on an event that is already debounced downstream.
///
/// A fullscreen, maximized or minimized window is NOT recorded. Those are states
/// the user put one window into, not the size they want the next one to be, and
/// storing them means every new window opens wrong until someone resizes by hand.
#[cfg(desktop)]
fn track_window(window: &WebviewWindow) {
    let handle = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
            let Some(window) = handle.get_webview_window(&label) else { return };
            if window.is_fullscreen().unwrap_or(false)
                || window.is_maximized().unwrap_or(false)
                || window.is_minimized().unwrap_or(false)
            {
                return;
            }
            // Both read off the window rather than taken from the one value the
            // event carries: dragging the top-left corner resizes AND moves, and
            // each of the two events knows only its own half.
            let Ok(size) = window.inner_size() else { return };
            let Ok(position) = window.outer_position() else { return };
            config::remember_geometry(
                &handle,
                config::WindowGeometry {
                    width: size.width,
                    height: size.height,
                    x: position.x,
                    y: position.y,
                },
            );
        }
        // Labels are never reused, so the readiness list would otherwise grow for
        // the life of the process.
        tauri::WindowEvent::Destroyed => {
            ready::forget(&label);
            openurl::forget_window(&label);
        }
        _ => {}
    });
}

/// A label no window has worn yet. Never reused: Tauri rejects a duplicate, and
/// a window can be opened, closed and opened again.
#[cfg(desktop)]
pub(crate) fn next_window_label() -> String {
    format!("window{}", APP_WINDOW_COUNT.fetch_add(1, Ordering::Relaxed) + 1)
}

/// Open the bundled bootstrap page in a window of its own.
///
/// The deliberate way to reach the only UI the shell itself owns: pick a server,
/// see why one cannot be reached. Visible from the start, because it has nothing
/// to wait for and is usually the answer to a window that is already not working.
/// It is also the only window granted the server-repointing commands, which is
/// `capabilities/default.json`'s doing rather than this function's.
#[cfg(desktop)]
pub(crate) fn open_bootstrap_window(app: &AppHandle) -> Option<WebviewWindow> {
    let label = next_window_label();
    trace!("new bootstrap window {label}");
    match build_window(app, &label, WebviewUrl::App("index.html".into()), true) {
        Ok(window) => {
            let _ = window.set_focus();
            Some(window)
        }
        Err(err) => {
            trace!("bootstrap window {label} failed: {err}");
            None
        }
    }
}

/// Open another window on the app, stepped clear of any window already standing
/// where it landed.
#[cfg(desktop)]
pub(crate) fn open_app_window(app: &AppHandle, path: Option<&str>) -> Option<WebviewWindow> {
    let label = next_window_label();
    trace!("new app window {label}");
    match build_app_window(app, &label, path) {
        Ok(window) => {
            cascade_clear_of_others(&window);
            let _ = window.set_focus();
            Some(window)
        }
        Err(err) => {
            trace!("app window {label} failed: {err}");
            None
        }
    }
}

/// Nudge a new window off any window standing exactly where it landed, stepping
/// until the spot is free.
///
/// Something has to do this because `restore_geometry` puts EVERY window at the
/// one remembered place, so a second window would otherwise hide the first
/// completely and look like nothing happened.
///
/// Stepping until the spot is clear rather than offsetting from whichever window
/// has focus is what makes it correct now that a new window is hidden and
/// unfocused until its page reports: two `Cmd-N`s in quick succession see the
/// SAME focused window, so a focus-relative offset would put both new windows in
/// one place.
#[cfg(desktop)]
fn cascade_clear_of_others(window: &WebviewWindow) {
    let Ok(mut position) = window.outer_position() else { return };
    let others: Vec<tauri::PhysicalPosition<i32>> = window
        .app_handle()
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label != window.label())
        .filter_map(|(_, other)| other.outer_position().ok())
        .collect();
    // Bounded rather than `while`: a stack this deep is already more windows than
    // anyone has open, and a runaway loop here would be a hang instead of a
    // misplaced window.
    for _ in 0..16 {
        if !others.iter().any(|other| *other == position) {
            break;
        }
        position = tauri::PhysicalPosition::new(
            position.x + WINDOW_CASCADE,
            position.y + WINDOW_CASCADE,
        );
    }
    let _ = window.set_position(position);
}

/// Mobile has one window, built at launch, and no way to ask for a second — so
/// the answer is whichever one exists. Kept as a function of the same name so
/// `openurl` has one fallback chain rather than a `cfg` in the middle of it. The
/// path is ignored for the same reason: there is no new window to open on it, and
/// a page that wants to go somewhere can navigate itself.
#[cfg(not(desktop))]
pub(crate) fn open_app_window(app: &AppHandle, path: Option<&str>) -> Option<WebviewWindow> {
    let _ = path;
    app.webview_windows().into_values().next()
}

/// The window a menu command or an outside open request acts on. macOS hangs ONE
/// menu bar off the application rather than off each window, so a menu event
/// names no window and the focused one is the only sensible target; with none
/// focused (every window closed, the app still running) there is nothing to
/// reload.
///
/// Found by asking each window rather than through `get_focused_window`, which
/// is behind Tauri's `unstable` feature — not a dependency worth taking on for
/// one lookup. On iOS a backgrounded app reports no focused window, which is
/// exactly the state a notification tap arrives in, so callers must have a
/// fallback.
pub(crate) fn menu_target(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, so nothing a launch does afterwards can die without saying why.
    panics::install();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(port_forward::PortForwardManager::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init());

    // Alerts are hand-rolled on both Apple platforms (see `notify.rs`), so the
    // plugin is only here for the desktops that still take the small version.
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_notification::init());
    }

    #[cfg(desktop)]
    {
        builder = builder.menu(menu::build).on_menu_event(menu::handle);
    }

    builder
        .invoke_handler(tauri::generate_handler![
            shell_info,
            window_loaded,
            window_ready,
            open_window,
            open_served_file,
            get_server_url,
            set_server_url,
            start_port_forward,
            list_port_forwards,
            stop_port_forward,
            open_port_forward_url,
            probe_server,
            push_registration,
            notify::notify,
            openurl::take_pending_open_url
        ])
        .setup(|app| {
            // The first moment the app can say where its own config dir is,
            // which is the only place a panic report survives a Finder launch.
            match config::app_file(app.handle(), "panic.log") {
                Ok(path) => panics::report_to(path),
                // Reported rather than swallowed, since swallowing a failure is
                // the exact thing this file exists to stop.
                Err(err) => log_line(&format!("no panic report file: {err}")),
            }

            // `pa://task/42` opened anywhere on the machine, or a `pa://` link
            // tapped on the phone. The plugin only reports it — where it goes is
            // the page's business, so it joins the notification click at the same
            // door. The scheme is registered from the bundle's
            // `CFBundleURLTypes`, never at runtime, so this works in an installed
            // build and not under `cargo tauri dev`.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    openurl::open_target(&handle, url.to_string());
                }
            });
            // Before the window, so a notification tap that LAUNCHED the app is
            // still reported: the delegate has to exist before launch finishes.
            #[cfg(target_os = "ios")]
            ios::setup(app.handle());
            // macOS has no push route to unlock, so a grant unlocks nothing: the
            // alerts it shows all arrive over the app's own socket.
            #[cfg(target_os = "macos")]
            usernotify::setup(app.handle(), || {});
            config::initialize_trust(app.handle())?;
            build_app_window(app.handle(), "main", None)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the assistant shell")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                app.state::<port_forward::PortForwardManager>().stop_all();
            }
        });
}
