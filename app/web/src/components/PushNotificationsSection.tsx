import { useEffect, useState } from "react";
import { AlertTriangle, Bell, CheckCircle2 } from "lucide-react";
import type {
  ApnsConfigResponse,
  WebPushConfigResponse,
} from "@assistant/shared";
import { ErrorNote, Spinner } from "./common/load.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
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
      <p className="text-sm text-muted-foreground">
        {push
          ? "This device is registered for Apple push, so alerts arrive even when the app is closed."
          : ios
            ? "Alerts arrive over this app's own connection, so they only arrive while it is running. Apple push would also reach it when closed."
            : "Alerts arrive over this app's own connection and are shown by macOS, so they need no separate subscription — but they only arrive while the app is running."}{" "}
        Allow or mute them for Pandeck in {settingsApp}.
      </p>

      {ios && state && (
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>
            <Alert
              variant={state.registration?.allowed ? "success" : "warning"}
              role="note"
            >
              {state.registration?.allowed ? (
                <CheckCircle2 />
              ) : (
                <AlertTriangle />
              )}
              <AlertDescription>
                {state.registration?.allowed
                  ? "iOS allows notifications for this app."
                  : `iOS is not allowing notifications for this app — turn them on in ${settingsApp}.`}
              </AlertDescription>
            </Alert>
          </li>
          <li>
            <Alert
              variant={state.config?.configured ? "success" : "warning"}
              role="note"
            >
              {state.config?.configured ? <CheckCircle2 /> : <AlertTriangle />}
              <AlertDescription>
                {state.config?.configured
                  ? `The server can push to ${state.config.bundleId ?? "this app"} (${state.config.deviceCount} device${state.config.deviceCount === 1 ? "" : "s"} registered).`
                  : "The server has no Apple push key, so it can only reach this app while it is running."}
              </AlertDescription>
            </Alert>
          </li>
          <li>
            <Alert
              variant={state.registration?.deviceToken ? "success" : "warning"}
              role="note"
            >
              {state.registration?.deviceToken ? (
                <CheckCircle2 />
              ) : (
                <AlertTriangle />
              )}
              <AlertDescription>
                {state.registration?.deviceToken
                  ? `Apple issued this install a ${state.registration.apnsEnvironment} device token.`
                  : "Apple has not issued this install a device token."}
              </AlertDescription>
            </Alert>
          </li>
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          busy={testing}
          onClick={() => {
            setTesting(true);
            void runTest(push)
              .then(setTest)
              .finally(() => setTesting(false));
          }}
        >
          {push ? "Send a test push" : "Send a test notification"}
        </Button>
        {test.state === "sent" && (
          <Badge variant="success">
            <CheckCircle2 />
            {test.detail}
          </Badge>
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
      <h2 className="text-lg font-semibold">Notifications</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Receive an alert when an assistant session finishes a turn. This setting
        applies only to this installation.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell />
            Session turn notifications
          </CardTitle>
          <CardDescription>
            Notifications show whether the turn finished, failed, or stopped,
            together with the session name. Tapping one opens that session
            directly.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {native && <NativeNotificationsPanel />}

          {!native && !state && (
            <div
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Spinner size="sm" />
              Checking this installation…
            </div>
          )}

          {state && !state.support.supported && (
            <Alert variant="warning" role="note">
              <AlertTriangle />
              <AlertDescription>{state.support.reason}</AlertDescription>
            </Alert>
          )}

          {state?.support.supported && enabled && (
            <Badge variant="success">
              <CheckCircle2 />
              Notifications are enabled for this installation.
            </Badge>
          )}

          {state?.support.supported && permission === "denied" && (
            <Alert variant="warning" role="note">
              <AlertTriangle />
              <AlertDescription>
                Notifications are blocked for this installation. Allow them in
                your browser's site settings — on iPhone, in Settings →
                Notifications → Assistant — then return here.
              </AlertDescription>
            </Alert>
          )}

          {error && <ErrorNote message={error} />}

          {state?.support.supported && (
            <div className="flex flex-wrap gap-2">
              {state.subscription ? (
                <Button
                  variant="outline"
                  onClick={() => void disable()}
                  busy={busy}
                >
                  Disable notifications
                </Button>
              ) : (
                <Button
                  onClick={() => void enable()}
                  disabled={permission === "denied" || !state.config}
                  busy={busy}
                >
                  Enable notifications
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-sm text-muted-foreground">
        Session names may be visible on the Lock Screen.{" "}
        {native
          ? "Every route shows the same text, so this reads the same however the alert reached you."
          : "On iPhone in a browser, notifications require opening the installed Home Screen app on a current iOS version."}
      </p>
    </div>
  );
}
