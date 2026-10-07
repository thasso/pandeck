import { useEffect, useState } from "react";
import { AlertTriangle, Bell, CheckCircle2 } from "lucide-react";
import type {
  ApnsConfigResponse,
  WebPushConfigResponse,
} from "@assistant/shared";
import { ErrorNote, Spinner } from "./ui/load.tsx";
import {
  nativeNotify,
  nativeShellPlatform,
  notificationsNeedNativeShell,
  pushRegistration,
  type PushRegistration,
} from "../lib/nativeShell.ts";
import { fetchApnsConfig, sendApnsTest } from "../lib/apnsPush.ts";
import {
  disableWebPush,
  enableWebPush,
  fetchWebPushConfig,
  registerWebPushSubscription,
  webPushBrowserSupport,
  type WebPushBrowserSupport,
} from "../lib/webPush.ts";

interface LoadedState {
  support: WebPushBrowserSupport;
  config: WebPushConfigResponse | null;
  subscription: PushSubscription | null;
}

/**
 * The native app's half of this setting.
 *
 * The shell is a WKWebView with no push service of its own, so there is no
 * subscription to create and nothing here to switch on. What the user needs from
 * this page is which of two delivery routes they are actually on — because the
 * difference is whether an alert arrives when the app is closed — and a way to
 * prove the wiring end to end without waiting for a real turn to finish.
 *
 * The iOS case is the one with something to report, so it reads the state rather
 * than asserting it: `push` when Apple will deliver (a device token registered
 * against a server that has an APNs key), and `live` when it falls back to the
 * app's own connection, which is all macOS ever has.
 */
function NativeNotificationsPanel() {
  const [test, setTest] = useState<
    | { state: "idle" }
    | { state: "sent"; detail: string }
    | { state: "failed"; detail: string }
  >({ state: "idle" });
  const [testing, setTesting] = useState(false);
  const ios = nativeShellPlatform() === "ios";
  const [state, setState] = useState<{
    registration: PushRegistration | null;
    config: ApnsConfigResponse | null;
  } | null>(null);

  useEffect(() => {
    if (!ios) return;
    let active = true;
    void (async () => {
      const registration = await pushRegistration();
      // `configured` is the server's half and the only part that can fail; a
      // failure reads the same as "no key", which is the honest fallback.
      const config = await fetchApnsConfig().catch(() => null);
      if (active) setState({ registration, config });
    })();
    return () => {
      active = false;
    };
  }, [ios]);

  const settingsApp = ios
    ? "iOS Settings → Notifications"
    : "System Settings → Notifications";
  // DERIVED from the two facts rather than read from `apnsDeliveryActive()`: that
  // flag is set by `useApnsRegistration`, which may still be in flight when this
  // page renders, and a module read is not something React would re-render for.
  // These two are what "Apple will deliver" actually means anyway.
  const push = Boolean(
    state?.registration?.deviceToken && state.config?.configured,
  );

  return (
    <>
      <p className="text-caption text-muted-foreground">
        {push
          ? "This device is registered for Apple push, so alerts arrive even when the app is closed."
          : ios
            ? "Alerts arrive over this app's own connection, so they only arrive while it is running. Apple push would also reach it when closed."
            : "Alerts arrive over this app's own connection and are shown by macOS, so they need no separate subscription — but they only arrive while the app is running."}{" "}
        Allow or mute them for Pandeck in {settingsApp}.
      </p>

      {ios && state && (
        <ul className="space-y-1 text-caption text-muted-foreground">
          <li className="flex items-center gap-2">
            {state.registration?.allowed ? (
              <CheckCircle2 size={14} className="shrink-0 text-success" />
            ) : (
              <AlertTriangle size={14} className="shrink-0 text-warning" />
            )}
            {state.registration?.allowed
              ? "iOS allows notifications for this app."
              : `iOS is not allowing notifications for this app — turn them on in ${settingsApp}.`}
          </li>
          <li className="flex items-center gap-2">
            {state.config?.configured ? (
              <CheckCircle2 size={14} className="shrink-0 text-success" />
            ) : (
              <AlertTriangle size={14} className="shrink-0 text-warning" />
            )}
            {state.config?.configured
              ? `The server can push to ${state.config.bundleId ?? "this app"} (${state.config.deviceCount} device${state.config.deviceCount === 1 ? "" : "s"} registered).`
              : "The server has no Apple push key, so it can only reach this app while it is running."}
          </li>
          <li className="flex items-center gap-2">
            {state.registration?.deviceToken ? (
              <CheckCircle2 size={14} className="shrink-0 text-success" />
            ) : (
              <AlertTriangle size={14} className="shrink-0 text-warning" />
            )}
            {state.registration?.deviceToken
              ? `Apple issued this install a ${state.registration.apnsEnvironment} device token.`
              : "Apple has not issued this install a device token."}
          </li>
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={testing}
          aria-busy={testing || undefined}
          onClick={() => {
            setTesting(true);
            void runTest(push)
              .then(setTest)
              .finally(() => setTesting(false));
          }}
          className="settings-button inline-flex items-center gap-2 disabled:opacity-40"
        >
          {testing ? <Spinner size="sm" /> : null}
          {push ? "Send a test push" : "Send a test notification"}
        </button>
        {test.state === "sent" && (
          <span className="flex items-center gap-2 text-caption text-success">
            <CheckCircle2 size={14} />
            {test.detail}
          </span>
        )}
        {test.state === "failed" && <ErrorNote message={test.detail} />}
      </div>
    </>
  );
}

/**
 * Prove the route the user is actually on.
 *
 * With push live the test has to go through the SERVER — a locally raised banner
 * would prove the permission and nothing about Apple, which is the half that
 * silently fails. Without it, raising one locally is exactly the delivery path a
 * real alert would take.
 */
async function runTest(
  push: boolean,
): Promise<
  { state: "sent"; detail: string } | { state: "failed"; detail: string }
> {
  if (!push) {
    const shown = await nativeNotify("Pandeck", "Notifications are working.");
    return shown
      ? {
          state: "sent",
          detail: "Sent. Nothing shown? Check your notification settings.",
        }
      : { state: "failed", detail: "The app could not raise a notification." };
  }
  try {
    const report = await sendApnsTest();
    if (report.failures.length > 0)
      return { state: "failed", detail: report.failures.join(" ") };
    return {
      state: "sent",
      detail: `Apple accepted it for ${report.delivered} device${report.delivered === 1 ? "" : "s"}.`,
    };
  } catch (error) {
    return {
      state: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function PushNotificationsSection() {
  const [state, setState] = useState<LoadedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The native shell has no push service to interrogate, and asking anyway is
  // what produced a browser-shaped verdict ("blocked, allow it in Settings")
  // about a permission WebKit never offered it in the first place.
  const native = notificationsNeedNativeShell();

  useEffect(() => {
    if (native) return;
    let active = true;
    const support = webPushBrowserSupport();
    if (!support.supported) {
      setState({ support, config: null, subscription: null });
      return () => {
        active = false;
      };
    }

    void (async () => {
      try {
        const [config, subscription] = await Promise.all([
          fetchWebPushConfig(),
          support.pushManager.getSubscription(),
        ]);
        if (!active) return;
        setState({ support, config, subscription });
        // Re-register an existing browser subscription when this page opens. It
        // makes a restored server data directory self-heal without re-prompting.
        if (subscription && Notification.permission === "granted") {
          try {
            await registerWebPushSubscription(subscription);
          } catch (cause) {
            if (active)
              setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setState({ support, config: null, subscription: null });
      }
    })();

    return () => {
      active = false;
    };
  }, [native]);

  const enable = async () => {
    if (!state?.support.supported || !state.config) return;
    setBusy(true);
    setError(null);
    try {
      const subscription = await enableWebPush(
        state.support.pushManager,
        state.config.applicationServerKey,
      );
      setState({ ...state, subscription });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!state?.subscription) return;
    setBusy(true);
    setError(null);
    try {
      await disableWebPush(state.subscription);
    } catch (cause) {
      setError(
        `Notifications were disabled on this installation, but server cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setState((current) =>
        current ? { ...current, subscription: null } : current,
      );
      setBusy(false);
    }
  };

  const permission =
    "Notification" in window ? Notification.permission : "default";
  const enabled = Boolean(state?.subscription && permission === "granted");

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-heading font-semibold">Notifications</h2>
      <p className="mt-1 text-caption text-muted-foreground">
        Receive an alert when an assistant session finishes a turn. This setting
        applies only to this installation.
      </p>

      <div className="mt-6 space-y-4 rounded-xl border border-line bg-panel p-4">
        <div className="flex items-start gap-3">
          <Bell size={18} className="mt-0.5 shrink-0 text-primary" />
          <div>
            <h3 className="text-body font-semibold text-fg">
              Session turn notifications
            </h3>
            <p className="mt-1 text-caption text-muted-foreground">
              Notifications show whether the turn finished, failed, or stopped,
              together with the session name. Tapping one opens that session
              directly.
            </p>
          </div>
        </div>

        {native && <NativeNotificationsPanel />}

        {!native && !state && (
          <div
            role="status"
            className="flex items-center gap-2 text-caption text-muted-foreground"
          >
            <Spinner size="sm" />
            Checking this installation…
          </div>
        )}

        {state && !state.support.supported && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-caption text-warning">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{state.support.reason}</span>
          </div>
        )}

        {state?.support.supported && enabled && (
          <div className="flex items-center gap-2 text-caption text-success">
            <CheckCircle2 size={14} />
            Notifications are enabled for this installation.
          </div>
        )}

        {state?.support.supported && permission === "denied" && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-caption text-warning">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              Notifications are blocked for this installation. Allow them in
              your browser's site settings — on iPhone, in Settings →
              Notifications → Assistant — then return here.
            </span>
          </div>
        )}

        {error && <ErrorNote message={error} />}

        {/* `settings-button` geometry, not `ui/Button`'s: these two sit among
            ~20 buttons wearing that class across Settings, and the busy state
            is what this change is for, not the shape. The three parts are here
            all the same, with the label held still — "Enabling…" moved the
            button's width at the moment it stopped accepting clicks. */}
        {state?.support.supported && (
          <div className="flex flex-wrap gap-2">
            {state.subscription ? (
              <button
                type="button"
                onClick={() => void disable()}
                disabled={busy}
                aria-busy={busy || undefined}
                className="settings-button inline-flex items-center gap-2 disabled:opacity-40"
              >
                {busy ? <Spinner size="sm" /> : null}
                Disable notifications
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void enable()}
                disabled={busy || permission === "denied" || !state.config}
                aria-busy={busy || undefined}
                className="settings-button-primary inline-flex items-center gap-2 disabled:opacity-40"
              >
                {busy ? <Spinner size="sm" /> : null}
                Enable notifications
              </button>
            )}
          </div>
        )}
      </div>

      <p className="mt-4 text-caption text-faint">
        Session names may be visible on the Lock Screen.{" "}
        {native
          ? "Every route shows the same text, so this reads the same however the alert reached you."
          : "On iPhone in a browser, notifications require opening the installed Home Screen app on a current iOS version."}
      </p>
    </div>
  );
}
