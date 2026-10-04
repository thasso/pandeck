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

use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

use crate::openurl_pending::PendingTargets;

use crate::trace;

/// The event the page listens on. Same shape as the deep-link plugin's own
/// `deep-link://new-url`, which this deliberately wraps rather than exposing:
/// a notification click is not a deep link, and both must arrive the same way.
pub const OPEN_URL_EVENT: &str = "assistant://open-url";

/// Keep every target until its addressed page acknowledges navigation. Events
/// only wake the drain, so a reload, slow listener registration or failed emit
/// cannot lose it. Each window has one slot, since only the newest is wanted.
static PENDING: OnceLock<Mutex<PendingTargets>> = OnceLock::new();

fn pending_targets() -> &'static Mutex<PendingTargets> {
    PENDING.get_or_init(|| Mutex::new(PendingTargets::default()))
}

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
    if let Ok(mut pending) = pending_targets().lock() {
        pending.park(window.as_ref().map(|window| window.label()), target.clone());
    }
    let Some(window) = window else {
        trace!("open {target} -> parked until a window exists");
        return;
    };
    let _ = window.set_focus();
    trace!("open {target} -> parked for {}", window.label());
    // Keep the string payload for hosted pages, but the current page treats it
    // as a wake-up and drains the slot rather than navigating twice.
    if let Err(error) = app.emit_to(
        EventTarget::webview_window(window.label()),
        OPEN_URL_EVENT,
        target,
    ) {
        trace!("open-url wake failed: {error}");
    }
}

/// A structured reply distinguishes acknowledged delivery from older shells'
/// destructive string-or-null take, whose live events carry the only target.
#[derive(Serialize)]
pub struct PendingOpenUrl {
    target: Option<String>,
}

/// Peek only the calling window, or acknowledge a target it already navigated
/// to. A page that disappears with a reply in flight leaves its target parked.
#[tauri::command]
pub fn take_pending_open_url(
    window: WebviewWindow,
    acknowledged_target: Option<String>,
) -> PendingOpenUrl {
    let target = pending_targets().lock().ok().and_then(|mut pending| {
        if let Some(target) = acknowledged_target {
            pending.acknowledge(window.label(), &target);
            return None;
        }
        pending.peek(window.label())
    });
    PendingOpenUrl { target }
}

#[cfg(desktop)]
pub fn forget_window(label: &str) {
    if let Ok(mut pending) = pending_targets().lock() {
        pending.forget(label);
    }
}
