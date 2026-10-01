//! Raising an OS alert, and getting the user to the thing it was about.
//!
//! The page cannot do this for itself anywhere the shell runs: a WKWebView
//! implements neither `Notification` nor `PushManager`, so the browser's path — a
//! Declarative Web Push subscription, which is what Settings offers — can never
//! even be created here, and nothing the server pushes over it arrives. The web
//! app instead forwards the SAME server-authored payload it would have received
//! as a push (the `appNotification` protocol message) to [`notify`], so the shell
//! and the browser say the same thing, `navigatePath` included.
//!
//! The Apple backend is hand-rolled rather than taken from
//! `tauri-plugin-notification`, for one reason on both platforms: the plugin
//! cannot report where a tap should GO. Its desktop path shows the notification
//! and drops the response handle, so a click is never observed; its iOS path
//! strips a notification's `userInfo` out of the event it reports, so the target
//! the alert was built with cannot be read back. Showing an alert nobody can act
//! on is the half that does not matter.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::trace;

/// How long an identical alert is treated as the same one.
const NOTIFY_DEDUPE: Duration = Duration::from_secs(3);

/// The last alert shown, so N open windows produce ONE notification.
static LAST_NOTIFICATION: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// Raise an OS notification, optionally carrying somewhere to go when clicked.
///
/// The server broadcasts `appNotification` to every connected client, and each
/// window of this app is one — so the duplicate collapse happens HERE, at the one
/// point all the windows meet, rather than by electing a window in the page
/// (which would have to survive that window being closed mid-alert). The cost is
/// losing a genuine repeat of the very same text within a few seconds, which the
/// server does not produce.
#[tauri::command]
pub fn notify(
    app: AppHandle,
    title: String,
    body: String,
    target: Option<String>,
) -> Result<(), String> {
    let key = format!("{title}\u{0}{body}");
    if let Ok(mut last) = LAST_NOTIFICATION.lock() {
        let now = Instant::now();
        if let Some((previous, at)) = last.as_ref() {
            if *previous == key && now.duration_since(*at) < NOTIFY_DEDUPE {
                trace!("notify {title} -> duplicate, dropped");
                return Ok(());
            }
        }
        *last = Some((key, now));
    }
    trace!("notify {title} -> {}", target.as_deref().unwrap_or("(no target)"));
    show(app, title, body, target)
}

/// Both Apple platforms: a local `UNNotificationRequest`, with the target in its
/// `userInfo` so the shared notification delegate can act on a click or a tap.
///
/// One arm rather than two because `UserNotifications` is the same framework on
/// both, down to the delegate method that reports where a tap should go — see
/// [`crate::usernotify`], which also records what the macOS half used to be and
/// why polling `NSUserNotification` had to go.
///
/// On iOS this is the route for a shell whose server has no APNs credentials, or
/// whose device token has not been accepted yet. Once push delivery IS live the
/// page stops calling this at all (see `microphoneGrantPersists`' neighbours in
/// `lib/nativeShell.ts`), because the same alert would otherwise arrive twice —
/// once from Apple and once from the socket.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn show(
    _app: AppHandle,
    title: String,
    body: String,
    target: Option<String>,
) -> Result<(), String> {
    crate::usernotify::show(&title, &body, target.as_deref())
}

/// Everywhere else: the plugin, and no click. Nothing here has a user yet, so it
/// stays the small version rather than growing a second hand-rolled backend.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn show(
    app: AppHandle,
    title: String,
    body: String,
    _target: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|err| err.to_string())
}
