//! Everything the iOS build has that no other platform does: the APNs device
//! token, and letting the page draw under the safe area.
//!
//! The notification half — the delegate that hears a tap, the authorization
//! request and the local-notification builder — is NOT here: macOS needs the same
//! three, so they live in [`crate::usernotify`]. What is left is the part that is
//! genuinely iOS-only, and it is all written against `UserNotifications`/`UIKit`
//! with `objc2` rather than through `tauri-plugin-notification`, which has no APNs
//! surface at all — no `registerForRemoteNotifications`, no device token — because
//! it only ever schedules LOCAL notifications. Keeping it out also keeps its Swift
//! package out of the generated Xcode project, so the iOS app carries no SPM
//! dependency.
//!
//! Two delivery routes end up in the same place. A local alert
//! ([`crate::usernotify::show`]) is what the shell raises when push delivery is
//! not available, and an APNs payload from the server arrives while the app is
//! backgrounded or closed. Both carry the target under the same
//! [`crate::usernotify::TARGET_KEY`] — for the local one because we put it there,
//! for the push because the server does — so the tap is read exactly one way, and
//! neither route knows the other exists.

use std::ffi::CStr;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{ffi, msg_send, sel, MainThreadMarker};
use objc2_foundation::{NSData, NSError, NSString};
use objc2_ui_kit::{UIApplication, UIScrollView, UIScrollViewContentInsetAdjustmentBehavior};
use tauri::{AppHandle, Emitter};

use crate::trace;

/// Raised once the device token arrives, so the page can register it with the
/// server. The page also has [`crate::device_token`] for the token that landed
/// before it was listening — the usual case, since a token arrives within a
/// second of launch and a page takes longer than that to load.
pub const APNS_TOKEN_EVENT: &str = "assistant://apns-token";

/// Type encoding of `-(void)application:(id)app someObject:(id)obj` — the shape
/// both APNs callbacks share.
const VOID_TWO_OBJECTS: &CStr = c"v@:@@";

/// The APNs device token as lowercase hex, once Apple has issued one. A token can
/// change between launches, so this is whatever the CURRENT launch was given.
static DEVICE_TOKEN: Mutex<Option<String>> = Mutex::new(None);

/// Let the page draw the whole screen, notch and home indicator included.
///
/// A `WKWebView` defaults its scroll view to `contentInsetAdjustmentBehavior =
/// .automatic`, which insets the WEB CONTENT by the safe area — so the page gets
/// a 402x778 viewport on an 874pt screen, with black bands above and below where
/// nothing is drawn, and `env(safe-area-inset-*)` reads zero because the content
/// never reaches the unsafe area. Both halves are wrong for this app: the web
/// build already pads its own chrome from those insets (it has to, for the
/// installed Home Screen app), so it wants the FULL screen and honest insets, and
/// `.never` is what gives it both.
pub fn cover_safe_area(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        let handle = webview.inner();
        if handle.is_null() {
            return;
        }
        // SAFETY: on iOS `PlatformWebview::inner` is the `WKWebView`, which always
        // has a scroll view, and this closure is dispatched to the main thread.
        unsafe {
            let scroll_view: Retained<UIScrollView> =
                msg_send![handle.cast::<AnyObject>(), scrollView];
            scroll_view.setContentInsetAdjustmentBehavior(
                UIScrollViewContentInsetAdjustmentBehavior::Never,
            );
        }
        trace!("webview extended under the safe area");
    });
}

/// Install the APNs callbacks, then the notification delegate and permission
/// request this platform shares with macOS.
///
/// Called from Tauri's `setup`, which runs inside
/// `application:didFinishLaunchingWithOptions:`. That timing is a requirement,
/// not a convenience: a notification TAP that launched the app is delivered to
/// the delegate only if one is set before launch finishes, and that is exactly
/// the tap most worth honouring.
pub fn setup(app: &AppHandle) {
    // Before the authorization request, not after: a GRANT is what registers for
    // push, and the token that follows is delivered to these very callbacks.
    install_remote_notification_callbacks();
    crate::usernotify::setup(app, register_for_remote_notifications);
}

/// Teach tao's app delegate the two APNs callbacks.
///
/// tao builds the `AppDelegate` class at runtime with a fixed method list and
/// offers no hook to extend it, so the methods are added to the registered class
/// directly. That is a supported runtime operation for a METHOD (unlike an ivar),
/// and the timing is safe: UIKit only asks whether the delegate responds to these
/// when a token arrives, which is after `registerForRemoteNotifications` — itself
/// after the authorization prompt is answered.
fn install_remote_notification_callbacks() {
    let Some(class) = AnyClass::get(c"AppDelegate") else {
        trace!("apns: no AppDelegate class to extend");
        return;
    };
    let class = class as *const AnyClass as *mut AnyClass;
    // SAFETY: both functions have the signature `VOID_TWO_OBJECTS` describes,
    // and neither touches the delegate instance it is called on.
    unsafe {
        ffi::class_addMethod(
            class,
            sel!(application:didRegisterForRemoteNotificationsWithDeviceToken:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject),
                Imp,
            >(did_register_for_remote_notifications),
            VOID_TWO_OBJECTS.as_ptr(),
        );
        ffi::class_addMethod(
            class,
            sel!(application:didFailToRegisterForRemoteNotificationsWithError:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject),
                Imp,
            >(did_fail_to_register_for_remote_notifications),
            VOID_TWO_OBJECTS.as_ptr(),
        );
    }
}

extern "C-unwind" fn did_register_for_remote_notifications(
    _this: *mut AnyObject,
    _cmd: Sel,
    _application: *mut AnyObject,
    token: *mut AnyObject,
) {
    // SAFETY: UIKit passes the token as a non-null `NSData` here.
    let Some(data) = (unsafe { token.cast::<NSData>().as_ref() }) else { return };
    let hex: String = data.to_vec().iter().map(|byte| format!("{byte:02x}")).collect();
    trace!("apns token {}…{} ({} bytes)", &hex[..hex.len().min(8)], &hex[hex.len().saturating_sub(4)..], hex.len() / 2);
    if let Ok(mut stored) = DEVICE_TOKEN.lock() {
        *stored = Some(hex.clone());
    }
    // Best effort: the page ALSO asks for the token at load through
    // `device_token`, which is what covers a token that arrived before any page
    // was listening — the common case, since the token beats the first paint.
    if let Some(app) = crate::usernotify::shell() {
        let _ = app.emit(APNS_TOKEN_EVENT, hex);
    }
}

extern "C-unwind" fn did_fail_to_register_for_remote_notifications(
    _this: *mut AnyObject,
    _cmd: Sel,
    _application: *mut AnyObject,
    error: *mut AnyObject,
) {
    // Nothing to recover: without a token the server cannot push, and the shell
    // falls back to raising alerts locally over the live socket. The page reports
    // the missing registration in Settings, so this only has to say why.
    // SAFETY: UIKit passes a non-null `NSError` here.
    if let Some(error) = unsafe { error.cast::<NSError>().as_ref() } {
        trace!("apns registration failed: {}", error.localizedDescription());
    }
}

/// Ask Apple for a device token. Done on every launch, per Apple's guidance: a
/// token is not durable, and the server's copy is only as good as the last one
/// the page registered.
fn register_for_remote_notifications() {
    let Some(app) = crate::usernotify::shell() else { return };
    // The authorization completion runs on an arbitrary thread and this is UIKit,
    // which is main-thread-only.
    let _ = app.run_on_main_thread(|| {
        let Some(mtm) = MainThreadMarker::new() else { return };
        UIApplication::sharedApplication(mtm).registerForRemoteNotifications();
    });
}

/// This launch's APNs device token, if Apple has issued one yet.
pub fn device_token() -> Option<String> {
    DEVICE_TOKEN.lock().ok().and_then(|token| token.clone())
}
