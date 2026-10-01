/**
 * Detection of, and the typed surface for, the native Tauri shell.
 *
 * The shell loads this same hosted app rather than bundling it, so the browser
 * and the shell run identical code and every native affordance has to be an
 * enhancement behind a check — never an assumption. This module is the only
 * place that knows the shell exists; everything else asks it a question.
 *
 * Detection reads an ATTRIBUTE the shell stamps on the root element from an
 * initialization script, not a `window` global, because the attribute is set
 * before the app's first paint. A capability that has to be awaited would mean
 * rendering the browser layout first and correcting it a frame later, which is
 * visible as a jump in exactly the chrome this exists to tidy up.
 */

import type { BuildInfo } from "@assistant/shared/buildInfo";
import type {
  PortForwardGrant,
  PortForwardTunnelStatus,
} from "@assistant/shared/portForwarding";
import {
  isPortForwardPort,
  PORT_FORWARD_MAX_PORT,
  PORT_FORWARD_MIN_PORT,
} from "@assistant/shared/portForwarding";
import { isLoopbackHostname, parseLoopbackLink } from "./portForwardLinks.ts";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

/** Platforms the shell reports. `desktop` is a non-macOS desktop build. */
export type NativeShellPlatform = "macos" | "ios" | "desktop";

const PLATFORMS: readonly string[] = ["macos", "ios", "desktop"];

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      event?: {
        listen?: (
          event: string,
          handler: (message: { payload: unknown }) => void,
        ) => Promise<() => void>;
      };
    };
  }
}

/**
 * The event the shell raises when something OUTSIDE the page asks for a place
 * inside it: a clicked notification, or a `pa://` link opened anywhere on the
 * machine. One event for both, because they are one request.
 */
const OPEN_URL_EVENT = "assistant://open-url";

/**
 * Raised when Apple issues this launch's APNs device token. iOS only, and paired
 * with {@link pushRegistration}: the token usually arrives before the page has
 * loaded, so whichever of the two sees it first is the one that matters.
 */
const APNS_TOKEN_EVENT = "assistant://apns-token";

/** Which native shell is hosting the page, or null in an ordinary browser. */
export function nativeShellPlatform(): NativeShellPlatform | null {
  if (typeof document === "undefined") return null;
  const value = document.documentElement.getAttribute("data-native-shell");
  return value && PLATFORMS.includes(value)
    ? (value as NativeShellPlatform)
    : null;
}

function isNativeShell(): boolean {
  return nativeShellPlatform() !== null;
}

/**
 * Whether the window's title bar is drawn OVER the page, so the app's own header
 * row is the window chrome and must behave like one (draggable, and clear of the
 * native window controls via `--app-drag-inset-left`).
 */
export function usesOverlayTitlebar(): boolean {
  return nativeShellPlatform() === "macos";
}

/**
 * Whether the microphone grant survives on its own here.
 *
 * True in the shell because the native side answers WebKit's capture prompt for
 * our origin, leaving only the one-time OS permission — so the elaborate
 * stream-parking `speechCapture.ts` does for Safari buys nothing and would only
 * hold the device and its recording indicator open for no reason.
 */
export function microphoneGrantPersists(): boolean {
  return isNativeShell();
}

/**
 * Whether the app may claim the screen edges for gestures of its own.
 *
 * In a browser it may not: iOS drives back/forward from both edges even in a
 * Home Screen app, and an app gesture there fights the platform's and loses.
 * The shell is the one place the edge is free — wry leaves WKWebView's
 * `allowsBackForwardNavigationGestures` off, and it is unsupported on iOS
 * anyway — so a shell page owns both edges and everything the page draws on
 * them is the page's own doing.
 */
export function ownsScreenEdgeGestures(): boolean {
  return isNativeShell();
}

/**
 * Whether alerts have to come from the OS through the shell rather than from the
 * browser's own notification stack.
 *
 * The shell is a WKWebView: it implements neither `Notification` nor
 * `PushManager`, so the Declarative Web Push flow Settings offers cannot even
 * subscribe there, and nothing the server pushes over it ever arrives. What
 * replaces it differs by platform — macOS has only the live socket, iOS also
 * registers for APNs — so this answers "is this a shell", and `apnsPush.ts`'s
 * `shouldRaiseAppNotification` answers the narrower question of who acts on a
 * socket-delivered alert. Exactly one runtime must, or a finished turn buzzes
 * twice.
 */
export function notificationsNeedNativeShell(): boolean {
  return isNativeShell();
}

/**
 * Which build of the SHELL is hosting the page, or null in an ordinary browser.
 *
 * The shell is installed and updated by hand while the page comes from whichever
 * server it loaded, so this is genuinely a different answer from the bundle's own
 * `appBuildInfo()` and the server's `serverBuild` — Settings → About shows all
 * three rather than implying one version covers the app.
 */
export async function nativeShellBuild(): Promise<BuildInfo | null> {
  if (!isNativeShell()) return null;
  try {
    const info = await invokeNative<{ build?: BuildInfo }>("shell_info");
    return info.build ?? null;
  } catch {
    return null;
  }
}

/** Whether this shell build may create loopback port forwards. */
export function supportsNativePortForwarding(): boolean {
  return nativeShellPlatform() === "macos";
}

/**
 * Whether a `localhost` link in content means "on the server", so that a click
 * on one should be forwarded rather than opened as written.
 *
 * Only in the macOS shell, and only when the app itself is served from
 * somewhere else: a page served from loopback is on the same machine as the
 * service the link names, and there the link already works as written.
 */
export function forwardsLoopbackLinks(): boolean {
  if (!supportsNativePortForwarding()) return false;
  try {
    return !isLoopbackHostname(new URL(serverHttpOrigin()).hostname);
  } catch {
    return false;
  }
}

async function revokePortForwardGrant(id: string): Promise<void> {
  const response = await fetch(
    `${serverHttpOrigin()}/api/port-forward-grants`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ id }),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Could not revoke port-forward grant (${response.status}).`,
    );
  }
}

/** The user answered the shell's consent dialog with Cancel. Not a failure. */
export class PortForwardCancelledError extends Error {
  constructor() {
    super("Port forwarding was cancelled.");
    this.name = "PortForwardCancelledError";
  }
}

/**
 * The listener is stopped but the server still holds its grant. Bounded harm:
 * the grant expires on its own, and its token left memory with the listener.
 */
export class PortForwardRevokeError extends Error {
  constructor(
    readonly port: number,
    cause: unknown,
  ) {
    super(
      `The forward for localhost:${port} is stopped, but its server grant could not be revoked; it expires on its own.`,
      { cause },
    );
    this.name = "PortForwardRevokeError";
  }
}

/** What `start_port_forward` rejects with: a tagged reason, never bare text. */
interface PortForwardStartFailure {
  kind: "cancelled" | "failed";
  message?: string;
}

function startFailure(error: unknown): Error {
  if (error && typeof error === "object" && "kind" in error) {
    const failure = error as PortForwardStartFailure;
    if (failure.kind === "cancelled") return new PortForwardCancelledError();
    if (typeof failure.message === "string") return new Error(failure.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Ask the server for an expiring scoped grant, then let the macOS shell bind
 * the matching IPv4 loopback port after native confirmation. A Cancel in that
 * dialog rejects with {@link PortForwardCancelledError}.
 */
export async function startNativePortForward(
  port: number,
): Promise<PortForwardTunnelStatus> {
  if (!supportsNativePortForwarding()) {
    throw new Error("Port forwarding requires the macOS native shell.");
  }
  if (!isPortForwardPort(port)) {
    throw new Error(
      `Port must be an integer from ${PORT_FORWARD_MIN_PORT} through ${PORT_FORWARD_MAX_PORT}.`,
    );
  }
  const response = await fetch(
    `${serverHttpOrigin()}/api/port-forward-grants`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ port }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not create port-forward grant (${response.status}).`,
    );
  }
  const grant = (await response.json()) as PortForwardGrant;
  try {
    return await invokeNative<PortForwardTunnelStatus>("start_port_forward", {
      grant,
    });
  } catch (error) {
    await revokePortForwardGrant(grant.id).catch(() => undefined);
    throw startFailure(error);
  }
}

/** Current native listeners. No grant credential is returned. */
export async function listNativePortForwards(): Promise<
  PortForwardTunnelStatus[]
> {
  if (!supportsNativePortForwarding()) return [];
  return await invokeNative<PortForwardTunnelStatus[]>("list_port_forwards");
}

interface StoppedPortForward {
  grantId: string;
}

/**
 * Stop one local listener, then revoke the server-side grant it used. The
 * listener is gone once this rejects with {@link PortForwardRevokeError}; any
 * other rejection means it is still running.
 */
export async function stopNativePortForward(port: number): Promise<void> {
  if (!supportsNativePortForwarding()) return;
  const stopped = await invokeNative<StoppedPortForward>("stop_port_forward", {
    port,
  });
  try {
    await revokePortForwardGrant(stopped.grantId);
  } catch (error) {
    throw new PortForwardRevokeError(port, error);
  }
}

/**
 * Open one forwarded localhost URL in the OS default browser.
 *
 * The page validates the shape first and fails closed; the shell validates it
 * again and refuses a port it is not currently forwarding, so the command can
 * never be turned into a generic opener. A window of the shell itself is never
 * the answer: a forwarded service belongs in the user's browser, where its own
 * devtools and cookies live.
 */
export async function openNativePortForwardUrl(url: string): Promise<void> {
  if (!supportsNativePortForwarding()) {
    throw new Error("Port forwarding requires the macOS native shell.");
  }
  const link = parseLoopbackLink(url);
  if (!link) throw new Error("Not a forwardable localhost URL.");
  await invokeNative<void>("open_port_forward_url", { url: link.localUrl });
}

/** Open one validated token-free file grant in the OS default browser. */
export async function openNativeServedFile(url: string): Promise<void> {
  const serverOrigin = serverHttpOrigin();
  const grant = new URL(url, `${serverOrigin}/`);
  if (
    grant.origin !== serverOrigin ||
    !grant.pathname.startsWith("/api/file-grants/") ||
    grant.search ||
    grant.hash
  )
    throw new Error("Not an allowed token-free file grant URL.");
  await invokeNative<void>("open_served_file", { url: grant.href });
}

/** Same-origin served actions need the narrow native command in Tauri. */
export function opensServedFileInNativeBrowser(url: string): boolean {
  if (!isNativeShell()) return false;
  try {
    return new URL(url, location.href).origin === serverHttpOrigin();
  } catch {
    return false;
  }
}

/** What the OS has granted this installation, and its APNs token if it has one. */
export interface PushRegistration {
  /** Whether the OS lets the shell post a notification at all. */
  allowed: boolean;
  /**
   * This launch's APNs device token, lowercase hex. iOS only, and absent until
   * Apple has issued one — {@link onNativeApnsToken} is the other half.
   */
  deviceToken?: string;
  /** Which of Apple's push hosts the token belongs to. */
  apnsEnvironment: "development" | "production";
}

/**
 * Ask the shell what it can do about notifications right now.
 *
 * Null in a browser, where every part of the answer is something the page can
 * find out for itself through the standard APIs.
 */
export async function pushRegistration(): Promise<PushRegistration | null> {
  if (!isNativeShell()) return null;
  try {
    return await invokeNative<PushRegistration>("push_registration");
  } catch {
    return null;
  }
}

/**
 * Subscribe to the APNs device token arriving. Returns an unsubscribe, and a
 * no-op one anywhere the shell has no push registration to report.
 *
 * Same two-part shape as {@link onNativeOpenUrl}: the event covers a token that
 * lands while the page is up, and {@link pushRegistration} covers the far more
 * common case of one that landed during launch, before this page existed.
 */
export function onNativeApnsToken(
  handler: (token: string) => void,
): () => void {
  return listenNative(APNS_TOKEN_EVENT, handler);
}

/**
 * Raise an OS notification through the shell. Best effort by design: a failed
 * alert is never worth surfacing an error over the work it was announcing.
 *
 * `target` is where a click should land — an app path or a `pa://` URI. It goes
 * to the shell rather than being remembered here because the click arrives at
 * the OS, minutes later, possibly at a window this page no longer belongs to.
 */
export async function nativeNotify(
  title: string,
  body: string,
  target?: string,
): Promise<boolean> {
  if (!isNativeShell()) return false;
  try {
    await invokeNative<void>("notify", { title, body, target });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tell the shell this window is showing the app, and which theme it drew.
 *
 * A shell window is created HIDDEN and pointed straight at the server, so this
 * call is what reveals it: the alternative — the window a browser would give
 * you — appears instantly and then spends a round trip admitting it has nothing
 * in it. Only the first call per window reveals anything; the shell ignores the
 * rest, so calling it again on a later render or a theme change is free.
 *
 * The theme goes with it because the shell has to paint the NEXT window's frame
 * before any page exists to be asked, and `assistant.prefs` lives on this origin
 * where Rust cannot read it. It is a last-known value, never authoritative.
 *
 * Best effort, like {@link nativeNotify}: the shell has a deadline of its own and
 * shows the window regardless, so a failure here costs a delay and never the
 * window.
 */
export async function notifyWindowReady(
  theme: "dark" | "light",
): Promise<void> {
  if (!isNativeShell()) return;
  try {
    await invokeNative<void>("window_ready", { theme });
  } catch {
    // The shell's own show deadline is the backstop.
  }
}

/**
 * Subscribe to open requests from outside the page. Returns an unsubscribe, and
 * a no-op one in a browser.
 *
 * Resolves asynchronously (the bridge is a promise), so a request that lands in
 * the gap — most importantly the one that LAUNCHED the app — is not delivered
 * here at all. {@link takePendingNativeOpenUrl} is that half.
 */
export function onNativeOpenUrl(handler: (target: string) => void): () => void {
  return listenNative(OPEN_URL_EVENT, handler);
}

/**
 * Subscribe to one of the shell's string-payload events, ignoring anything else
 * that arrives under that name.
 *
 * Registration resolves a tick later than the caller's teardown can happen, so
 * the unsubscribe has to be answerable before it exists: `stopped` is what tells
 * a late-arriving listener to take itself straight back off again.
 */
function listenNative(
  event: string,
  handler: (payload: string) => void,
): () => void {
  const listen = window.__TAURI__?.event?.listen;
  if (!isNativeShell() || !listen) return () => {};
  let stop: (() => void) | null = null;
  let stopped = false;
  void listen(event, (message) => {
    if (typeof message.payload === "string") handler(message.payload);
  }).then(
    (unlisten) => {
      if (stopped) unlisten();
      else stop = unlisten;
    },
    () => {},
  );
  return () => {
    stopped = true;
    stop?.();
  };
}

/**
 * The open request that arrived before this page could listen, if any. Taking it
 * clears it in the shell, so a reload does not send the user back somewhere they
 * have since navigated away from.
 */
export async function takePendingNativeOpenUrl(): Promise<string | null> {
  if (!isNativeShell()) return null;
  try {
    return (await invokeNative<string | null>("take_pending_open_url")) ?? null;
  } catch {
    return null;
  }
}

/**
 * Call a shell command. Rejects in a browser, so callers must already know they
 * are in the shell — this is not a feature check.
 */
async function invokeNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke)
    throw new Error(
      `Not running in the native shell: ${command} is unavailable.`,
    );
  return (await invoke(command, args)) as T;
}
