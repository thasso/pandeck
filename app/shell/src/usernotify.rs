//! The `UserNotifications` backend both Apple platforms share.
//!
//! One delegate, one local-notification builder and one authorization request
//! serve macOS and iOS, because what either platform needs from a notification is
//! the same: show it, and report where a tap should GO. Only what a GRANT unlocks
//! differs — an APNs registration on iOS, nothing on macOS — so that is the one
//! thing [`setup`] takes from its caller.
//!
//! macOS used to raise its banners through `mac-notification-sys` and the
//! deprecated `NSUserNotification`, which reports a click but has no auto-dismiss
//! callback. The crate compensated by POLLING `deliveredNotifications` from a
//! repeating main-run-loop timer, one per notification, and blocking a thread
//! until that poll resolved. A notification the user neither clicks nor clears
//! stays in Notification Center indefinitely, so the poll never resolved: every
//! ignored alert leaked its thread AND its timer, and each surviving timer became
//! a permanent 2 Hz SYNCHRONOUS XPC round-trip that re-serialised the entire
//! delivered list. Measured on a day-old session: 51 leaked threads, a main
//! thread blocked 99% of the time, ~50% of a CPU split between this process and
//! `usernoted`, and getting worse quadratically as the list grew.
//! `didReceiveNotificationResponse:` is a callback, so none of that exists here.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

use crate::trace;

/// Where a tap should take the user, in the notification's payload.
///
/// The SAME key in a local notification's `userInfo` and at the top level of the
/// server's APNs payload, which is what makes the tap handler one function
/// instead of two. `aps` is Apple's half of that dictionary; every other key is
/// ours to choose, and `userInfo` for a remote notification is the whole JSON
/// body — so the server writing `paTarget` next to `aps` lands it in the same
/// place `setUserInfo` does. Keep it in step with the server's APNs payload
/// builder (`app/server/src/apns.ts`).
pub const TARGET_KEY: &str = "paTarget";

/// Where the user turns an alert back on, for the one error this module returns.
#[cfg(target_os = "ios")]
const SETTINGS_APP: &str = "iOS Settings";
#[cfg(not(target_os = "ios"))]
const SETTINGS_APP: &str = "System Settings";

/// The app, for the callbacks that reach native code from the OS and therefore
/// have no handle of their own. Set once, during [`setup`].
static SHELL: OnceLock<AppHandle> = OnceLock::new();

/// Whether the OS lets this app post a notification at all. False until the
/// authorization request answers, which is also the honest answer: before then
/// there is no permission.
static NOTIFICATIONS_ALLOWED: AtomicBool = AtomicBool::new(false);

/// Identifiers for local notifications. A repeated identifier REPLACES the
/// notification already showing, and two sessions finishing are two alerts — so
/// the counter is qualified by the process id when it is used. It restarts at
/// zero every launch, and a macOS shell that stays open for days would otherwise
/// have each launch's first alert quietly replace the previous launch's unread
/// one, which is still sitting in Notification Center.
static NOTIFICATION_COUNT: AtomicUsize = AtomicUsize::new(0);

define_class!(
    /// Hears what the user did with a notification.
    ///
    /// Both methods are mandatory in practice even though the protocol marks them
    /// optional. Without `willPresent` the OS shows NOTHING while the app is in
    /// the foreground, which is most of the time a socket-delivered alert exists;
    /// without `didReceiveResponse` a tap only activates the app and drops the
    /// session it was about.
    ///
    /// # Safety
    ///
    /// `NSObject` imposes no subclassing requirements, and this class has no
    /// ivars and no `Drop`.
    #[unsafe(super(NSObject))]
    #[name = "PANotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // Traced because an alert that never appears looks identical to one
            // that was never sent, and this is the line that tells the two apart:
            // past here it is the OS's decision, before here it is ours.
            trace!("presenting notification");
            // Show it even though the app is in front. Whether an alert is worth
            // interrupting for is the user's call, made in the OS's settings, and
            // the app being open does not mean the window they are looking at is
            // the session that just finished.
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let user_info = response.notification().request().content().userInfo();
            match (target_from_user_info(&user_info), SHELL.get()) {
                (Some(target), Some(app)) => {
                    trace!("notification tap -> {target}");
                    crate::openurl::open_target(app, target);
                }
                (Some(_), None) => trace!("notification tap before setup finished"),
                (None, _) => trace!("notification tap with no target"),
            }
            // Unconditional, and last: the OS holds the response open until this
            // is called and complains loudly in the log if it never is.
            completion.call(());
        }
    }
);

/// Read the target out of a notification payload, local or remote.
fn target_from_user_info(user_info: &NSDictionary) -> Option<String> {
    let key = NSString::from_str(TARGET_KEY);
    // Deref-coerced to the dictionary's erased key type: a payload that came
    // from APNs is whatever JSON the server sent, so nothing here may assume the
    // value is a string until it has been asked.
    let key: &AnyObject = &key;
    let value = user_info.objectForKey(key)?;
    Some(value.downcast_ref::<NSString>()?.to_string())
}

/// Install the notification delegate and ask the OS for permission.
///
/// `on_authorized` runs if permission is GRANTED, on whatever thread the OS
/// answers on. It is the one platform difference this module carries: iOS uses it
/// to register for APNs, and macOS — which has no push route, only the app's own
/// socket — passes a no-op.
///
/// Called from Tauri's `setup`, which on iOS runs inside
/// `application:didFinishLaunchingWithOptions:`. That timing is a requirement,
/// not a convenience: a notification TAP that launched the app is delivered to
/// the delegate only if one is set before launch finishes, and that is exactly
/// the tap most worth honouring.
pub fn setup(app: &AppHandle, on_authorized: fn()) {
    let _ = SHELL.set(app.clone());
    if !is_bundled() {
        trace!("notifications unavailable: no bundle identifier");
        return;
    }
    install_delegate();
    request_authorization(on_authorized);
}

/// The app handle the OS callbacks share, for the other native code that runs
/// without one: iOS's APNs callbacks, which tao's `AppDelegate` hands nothing.
#[cfg(target_os = "ios")]
pub fn shell() -> Option<&'static AppHandle> {
    SHELL.get()
}

/// Whether this process has a bundle identifier, which `UserNotifications`
/// requires: `currentNotificationCenter` raises an Objective-C exception when the
/// main bundle has none, and nothing here catches it, so it takes the process
/// with it. A `cargo tauri dev` binary is a bare executable under `target/`, so
/// it has none. Notifications are to be verified in a BUNDLED build anyway (see
/// this crate's `CLAUDE.md`); this is what keeps the unbundled one silent rather
/// than fatal.
fn is_bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

fn install_delegate() {
    let delegate: Retained<NotificationDelegate> =
        unsafe { msg_send![NotificationDelegate::alloc(), init] };
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // `delegate` is a WEAK property on the center. Dropping our reference here
    // would leave it nil and no tap would ever be reported, so the one delegate
    // this process needs is leaked deliberately — the alternative is a static
    // that would have to be `Send`, which `Retained` is not.
    std::mem::forget(delegate);
    trace!("notification delegate installed");
}

/// Ask the OS for permission, then hand off to `on_authorized` if it is granted.
///
/// Asked at launch rather than at the first alert. This shell exists largely to
/// deliver these, the prompt is once per install, and on iOS delaying it would
/// mean the device token — and therefore push delivery at all — waited for the
/// user to open a Settings page.
fn request_authorization(on_authorized: fn()) {
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let options = UNAuthorizationOptions::Alert
        | UNAuthorizationOptions::Sound
        | UNAuthorizationOptions::Badge;
    let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        // SAFETY: the OS passes either null or a valid `NSError`.
        if let Some(error) = unsafe { error.as_ref() } {
            trace!("notification authorization failed: {}", error.localizedDescription());
        }
        NOTIFICATIONS_ALLOWED.store(granted.as_bool(), Ordering::Relaxed);
        trace!("notifications allowed: {}", granted.as_bool());
        if granted.as_bool() {
            on_authorized();
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(options, &handler);
}

/// Whether the OS currently lets this app post notifications.
pub fn notifications_allowed() -> bool {
    NOTIFICATIONS_ALLOWED.load(Ordering::Relaxed)
}

/// Post a local notification that opens `target` when clicked or tapped.
///
/// This is the whole macOS route, and on iOS the fallback for a server with no
/// APNs credentials or a device token it has not accepted. It reaches only a
/// RUNNING app, which is the whole difference between this and push.
pub fn show(title: &str, body: &str, target: Option<&str>) -> Result<(), String> {
    if !notifications_allowed() {
        return Err(format!(
            "Notifications are turned off for this app in {SETTINGS_APP}."
        ));
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    if let Some(target) = target {
        let key = NSString::from_str(TARGET_KEY);
        let value = NSString::from_str(target);
        let user_info = NSDictionary::from_slices(&[&*key], &[&*value]);
        // Generic parameters are a Rust-side fiction over one Objective-C class,
        // and `setUserInfo` takes the unparameterised one.
        let user_info = unsafe { Retained::cast_unchecked::<NSDictionary>(user_info) };
        // SAFETY: the dictionary holds strings, which is what a payload may carry.
        unsafe { content.setUserInfo(&user_info) };
    }
    let identifier = NSString::from_str(&format!(
        "pa-{}-{}",
        std::process::id(),
        NOTIFICATION_COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    // No trigger: deliver it now.
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, None);
    Ok(())
}
