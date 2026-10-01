/**
 * The browser's half of starting and opening a desktop port forward.
 *
 * Two surfaces start forwards: the Settings page, and a click on a
 * `localhost` link in content (`portForwardLinks.ts`). Both go through here so
 * that one port is never being started twice at once — the second request
 * joins the first's native confirmation instead of raising a second dialog
 * over it, which is what a double-click or a link clicked during a Settings
 * start would otherwise do.
 */
import type { PortForwardTunnelStatus } from "@assistant/shared/portForwarding";
import { loadErrorMessage } from "./loadState.ts";
import {
  listNativePortForwards,
  openNativePortForwardUrl,
  PortForwardCancelledError,
  startNativePortForward,
} from "./nativeShell.ts";
import type { LoopbackLink } from "./portForwardLinks.ts";
import { showToast, TOAST_DWELL_MS } from "./toast.ts";

/** Starts in flight, one per port, so a repeat joins rather than races. */
const starting = new Map<number, Promise<PortForwardTunnelStatus>>();

/**
 * Start a forward for `port`, or join the start already running for it. The
 * shell's confirmation and bind happen once per call that reaches the shell.
 */
export function startPortForward(
  port: number,
): Promise<PortForwardTunnelStatus> {
  const inFlight = starting.get(port);
  if (inFlight) return inFlight;
  const started = startNativePortForward(port).finally(() => {
    starting.delete(port);
  });
  starting.set(port, started);
  return started;
}

/**
 * Open a forwarded link in the OS browser, starting the forward first when
 * its port is not yet listening. Failures have no surface of their own — the
 * link is a line of text — so they go to a toast naming the address. The
 * user's own Cancel in the consent dialog is not a failure and says nothing.
 */
export async function openForwardedLink(link: LoopbackLink): Promise<void> {
  try {
    const active = (await listNativePortForwards()).some(
      (status) => status.port === link.port,
    );
    if (!active) await startPortForward(link.port);
    await openNativePortForwardUrl(link.localUrl);
  } catch (error) {
    if (error instanceof PortForwardCancelledError) return;
    showToast(`localhost:${link.port}: ${loadErrorMessage(error)}`, {
      tone: "error",
      durationMs: TOAST_DWELL_MS,
      key: `port-forward-${link.port}`,
    });
  }
}
