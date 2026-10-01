//! Getting the user to ONE place in the app, from outside the app.
//!
//! Three things ask for this and they are the same request wearing different
//! clothes: a clicked notification, a `pa://` link opened anywhere on the
//! machine, and a notification tapped on the phone and handed over by
//! `UNUserNotificationCenter`. Routing each of them separately is how they
//! drift, so they all land on [`open_target`] and the page sees one event.
//!
//! What travels is a STRING the shell does not interpret: either a `pa://` URI
//! or an app path beginning with `/`. Teaching the shell the app's route table
//! would mean redeploying the shell whenever a route moves, which is the one
//! thing a remote-URL shell exists to avoid — so the page does that half, and
//! the two forms are told apart by their first character.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, EventTarget, Manager};

use crate::trace;

/// The event the page listens on. Same shape as the deep-link plugin's own
/// `deep-link://new-url`, which this deliberately wraps rather than exposing:
/// a notification click is not a deep link, and both must arrive the same way.
pub const OPEN_URL_EVENT: &str = "assistant://open-url";

/// A target that arrived before any page could hear it.
///
/// Opening a `pa://` link while the app is closed LAUNCHES it, and the page then
/// takes seconds to load and subscribe — the event is long gone by then. So a
/// target that lands before the first page is ready waits here instead. One
/// slot, not a queue: these are navigations, and only the newest is wanted.
static PENDING: Mutex<Option<String>> = Mutex::new(None);

/// Set the first time a page collects the pending target, which is also the
/// moment we know a page is listening. Before that the live event reaches
/// nobody, so it has to be parked; after it, parking would navigate a window
/// that already went there.
static PAGE_READY: AtomicBool = AtomicBool::new(false);

/// Hand a target to the app: raise a window and tell THAT window where to go.
///
/// Addressed to one window rather than broadcast, because with several open the
/// broadcast would move every one of them to the same place — and the user
/// clicked a notification once.
pub fn open_target(app: &AppHandle, target: String) {
    let window = crate::menu_target(app)
        .or_else(|| app.webview_windows().into_values().next())
        // Launched by the link with nothing open yet, or every window closed
        // while the app kept running.
        .or_else(|| crate::open_app_window(app, None));
    let Some(window) = window else {
        trace!("open {target} -> no window to show it in");
        return;
    };
    let _ = window.set_focus();

    if PAGE_READY.load(Ordering::Relaxed) {
        trace!("open {target} -> {}", window.label());
        let _ = app.emit_to(EventTarget::webview_window(window.label()), OPEN_URL_EVENT, target);
        return;
    }
    trace!("open {target} -> parked until a page is ready");
    if let Ok(mut pending) = PENDING.lock() {
        *pending = Some(target);
    }
}

/// The target the page has not seen yet, if any. Called once per page load, and
/// taking it clears it, so a reload does not re-navigate somewhere the user has
/// since left.
#[tauri::command]
pub fn take_pending_open_url() -> Option<String> {
    PAGE_READY.store(true, Ordering::Relaxed);
    PENDING.lock().ok().and_then(|mut pending| pending.take())
}
