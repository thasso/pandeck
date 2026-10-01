//! When a window may be shown, and what to do when it never becomes showable.
//!
//! An app window is created pointing straight at the server and starts out
//! HIDDEN, because the alternative is what this replaces: a window that appears
//! instantly and then spends a round trip admitting it has nothing in it. The
//! window appears once there is something in it — which is the whole difference
//! between a native window and a browser tab opening.
//!
//! Hiding a window means owning the case where nothing ever loads, and the
//! signals that answer it come from two very different places. That split is the
//! important part of this module:
//!
//! - `window_loaded` is raised by the SHELL'S OWN initialization script, so it is
//!   true of whatever build the server happens to be serving. It means a real
//!   document from that origin reached DOM-ready and is running our JS.
//! - `window_ready` is raised by the APP, and means the page has painted
//!   something worth looking at rather than its boot screen.
//!
//! Only the first may decide recovery. The shell and the hosted app are deployed
//! independently — that is the entire point of a remote-URL shell, and why
//! Settings → About reports three build identities — so a shell that treated "the
//! page did not call our newest command" as "the server is unreachable" would
//! throw away a perfectly good session every few seconds against any deployment
//! older than itself. It did exactly that once; hence this comment.
//!
//! Note what these mean once the service worker is in play: with the server
//! unreachable the cached shell still loads, still runs the init script and still
//! reports ready, so the app opens read-only on cached state and recovery
//! correctly never fires. That is the intended offline behaviour, not a hole.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};

use crate::trace;

/// The local bootstrap page, as Tauri itself would resolve
/// `WebviewUrl::App("index.html")` on both Apple platforms (`tauri_protocol_url`
/// — Windows and Android are the ones that get an `http(s)://tauri.localhost`
/// instead, and neither is a target here). Spelled out because a window is
/// navigated BACK to it after starting somewhere else, and the builder's
/// resolution is not reachable at that point. `config::is_allowed` admits the
/// `tauri` scheme, so the navigation guard lets this through.
const BOOTSTRAP_URL: &str = "tauri://localhost";

/// How long after the document is ready the shell waits for the app to say it
/// has painted, before showing the window anyway.
///
/// This is the gap that makes the window work against an older deployment. A
/// current build calls `window_ready` within a few tens of ms of DOM-ready — it
/// hydrates from `localStorage` synchronously — and wins the race; a build that
/// has never heard of the command costs the user this much and no more.
const SHOW_GRACE: Duration = Duration::from_millis(350);

/// Absolute backstop for a page that never even reaches DOM-ready. Past this the
/// user gets the window regardless: an empty window in the app's own colour is a
/// slow app, and no window at all is a broken one.
const SHOW_DEADLINE: Duration = Duration::from_millis(1200);

/// How long before the shell concludes the server is not answering and offers the
/// bootstrap page instead. Deliberately longer than the 5s `probe_server` timeout
/// that page allows, so nothing that used to load in time is pulled out from
/// under itself.
const RECOVER_DEADLINE: Duration = Duration::from_secs(6);

#[derive(Default)]
struct WindowState {
    /// A document from the server reached DOM-ready here.
    loaded: bool,
    /// The window has been revealed; revealing twice would re-focus it.
    shown: bool,
}

/// One entry per live window. A `Vec` rather than a map because a shell has a
/// handful of windows at most and `Vec::new()` is const, so this needs no lazy
/// initialization.
static WINDOWS: Mutex<Vec<(String, WindowState)>> = Mutex::new(Vec::new());

fn with_state<T>(label: &str, act: impl FnOnce(&mut WindowState) -> T) -> Option<T> {
    let mut windows = WINDOWS.lock().ok()?;
    if !windows.iter().any(|(entry, _)| entry == label) {
        windows.push((label.to_string(), WindowState::default()));
    }
    let state = windows
        .iter_mut()
        .find(|(entry, _)| entry == label)
        .map(|(_, state)| state)?;
    Some(act(state))
}

fn has_loaded(label: &str) -> bool {
    with_state(label, |state| state.loaded).unwrap_or(false)
}

/// Show the window, once. Returns without touching it if someone got there
/// first, so a later signal — or a reload raising the same ones again — cannot
/// raise a window over whatever the user is now looking at.
fn reveal(app: &AppHandle, label: &str) {
    if !with_state(label, |state| std::mem::replace(&mut state.shown, true) == false)
        .unwrap_or(false)
    {
        return;
    }
    let Some(window) = app.get_webview_window(label) else {
        trace!("reveal {label} -> no such window");
        return;
    };
    trace!("reveal {label}");
    let _ = window.show();
    let _ = window.set_focus();
}

/// The shell's init script reporting that a document from the server is running
/// here. This is what proves the server answered, and therefore the only thing
/// that cancels recovery.
pub fn mark_loaded(app: &AppHandle, label: &str) {
    let first = with_state(label, |state| {
        std::mem::replace(&mut state.loaded, true) == false
    })
    .unwrap_or(false);
    if !first {
        return;
    }
    trace!("window_loaded {label}");
    // Give the app its chance to say it has painted before showing a page that
    // is still drawing its boot screen.
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_GRACE);
        reveal(&app, &label);
    });
}

/// The app reporting that it has painted. The nicer of the two reveals, and the
/// one that carries the theme (see the `window_ready` command), but never the one
/// that decides whether the server is reachable.
pub fn mark_ready(app: &AppHandle, label: &str) {
    reveal(app, label);
}

/// A window has gone for good; stop tracking it. Labels are never reused, so
/// without this the list would grow for the life of the process. Desktop only,
/// because that is where a window can outlive its page — on iOS the one window
/// goes when the app does.
#[cfg(desktop)]
pub fn forget(label: &str) {
    if let Ok(mut windows) = WINDOWS.lock() {
        windows.retain(|(entry, _)| entry != label);
    }
}

/// Arm both deadlines for a freshly built app window.
///
/// One thread covers both: the second wait is what is left of the long deadline
/// after the short one, so a window that loads during either gap simply finds
/// nothing left to do. Threads rather than a Tauri timer because this is the
/// pattern the crate already uses for a deferred window action (see
/// `menu::handle`'s force reload), and window methods dispatch to the main thread
/// themselves.
pub fn watch(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_DEADLINE);
        if !has_loaded(&label) {
            trace!("window {label} slow to load -> showing it anyway");
            reveal(&app, &label);
        }
        std::thread::sleep(RECOVER_DEADLINE.saturating_sub(SHOW_DEADLINE));
        if has_loaded(&label) {
            return;
        }
        recover(&app, &label);
    });
}

/// Nothing ever loaded: put the bootstrap page in this window so the user can see
/// why and point the shell somewhere else.
///
/// A navigation rather than a new window, so the recovery lands where the user
/// was already looking and nothing has to be closed underneath them. If the
/// navigation itself fails, desktop falls back to a real bootstrap window — built
/// BEFORE the dead one is closed, since closing the last window would take the
/// app with it.
fn recover(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    trace!("window {label} never loaded -> bootstrap");
    reveal(app, label);
    let navigated = Url::parse(BOOTSTRAP_URL)
        .ok()
        .map(|url| window.navigate(url).is_ok())
        .unwrap_or(false);
    if navigated {
        return;
    }
    trace!("window {label} could not be sent back to the bootstrap page");
    #[cfg(desktop)]
    {
        if crate::open_bootstrap_window(app).is_some() {
            let _ = window.close();
        }
    }
}
