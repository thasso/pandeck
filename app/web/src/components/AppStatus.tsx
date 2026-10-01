import { useEffect, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";

import {
  appStatus,
  appStatusGraceElapsed,
  noteAppStatusPending,
  subscribeAppStatusGrace,
  type AppReloadState,
  type AppStatusState,
} from "../lib/appStatus.ts";
import { useMobileLayout } from "./shell/useMobileLayout.ts";
import { Spinner } from "./ui/load.tsx";

/**
 * How long the socket may be down before the app says so. A shell restored from
 * cache is hydrated but not yet live until the server's `ready` lands, and a
 * dropped socket usually returns inside one retry: an announcement without the
 * delay would be a flash on every cold start rather than a signal.
 */
export const RECONNECT_GRACE_MS = 1200;

/**
 * @component AppStatus
 * @purpose The app status slot: the ONE surface allowed to announce something
 *   globally, and only for app-wide lifecycle state the user cannot act on that
 *   ends by itself — a server restart, and a dropped socket
 *   (`docs/messaging.md`).
 * @useWhen Rendering the slot itself. The placements do NOT share a lifetime:
 *   `floating` is mounted always and gates on the layout, while `bar` exists
 *   only for as long as `Topbar` does — that is, on wide layouts. This is why
 *   the grace period lives in `lib/appStatus.ts`'s module store and not in
 *   state here: a timer owned by a component restarts when the viewport crosses
 *   the breakpoint, so a rotate blanks an announcement that has been up for
 *   minutes and the user reads it as the app recovering. Do not move the wait
 *   back into the component, and do not reason from both placements being
 *   mounted at once — one of them usually is not.
 * @avoidWhen Anything about an object. A failed load, a refused write or a
 *   blocked session belongs on that object, not here — an announcement in this
 *   slot cannot be acted on and cannot say which thing it was about.
 * @intent Two placements because the app has two shells, one derivation because
 *   they must never disagree: inline in the App Header Bar on wide layouts,
 *   where window chrome already lives and no layout moves, and a floating pill
 *   at the top centre on narrow ones, which have no header bar and where an
 *   overlay is the only thing visible from the sidebar. Deliberately not a
 *   banner: a full-width row would push every laid-out pane around on each
 *   flaky-network blip.
 * @related lib/appStatus.ts, Topbar.tsx, ../../docs/messaging.md
 */
export interface AppStatusProps {
  connected: boolean;
  reloading: AppReloadState | null | undefined;
  hydrationSource: "empty" | "cache" | "live";
  /**
   * `bar` renders inline for a host that is already wide-only (the header bar);
   * `floating` mounts the narrow-layout pill and gates itself on the layout.
   */
  placement: "bar" | "floating";
}

export function AppStatus({
  connected,
  reloading,
  hydrationSource,
  placement,
}: AppStatusProps) {
  const mobile = useMobileLayout();
  // Only the connection waits: a restart is announced the moment it is queued,
  // because it is a decision the server has already taken.
  const pending = !connected && !reloading;
  // The wait lives in a module store, not here: the header-bar placement is
  // unmounted below the breakpoint, and a timer owned by a component would
  // restart on a rotate and blank an announcement that has been up for minutes.
  const graceElapsed = useSyncExternalStore(
    subscribeAppStatusGrace,
    appStatusGraceElapsed,
    appStatusGraceElapsed,
  );
  useEffect(() => {
    noteAppStatusPending(pending, RECONNECT_GRACE_MS);
  }, [pending]);

  const status = appStatus({
    connected,
    reloading,
    hydrationSource,
    graceElapsed,
  });
  if (!status) return null;
  if (placement === "floating") {
    if (!mobile) return null;
    return (
      <div className="pointer-events-none fixed inset-x-0 top-[calc(var(--app-safe-area-top,0px)+0.375rem)] z-50 flex justify-center px-3">
        <StatusPill status={status} />
      </div>
    );
  }
  // `pointer-events-none` is load-bearing in the header bar, not decoration:
  // the native shell's drag handler tests the element a click HIT, so a pill
  // that swallowed the pointer would stop that stretch of the title bar
  // dragging the window. Nothing here is interactive, so it passes through to
  // the marked bar underneath.
  return <StatusPill status={status} className="pointer-events-none min-w-0" />;
}

function StatusPill({
  status,
  className = "",
}: {
  status: AppStatusState;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={`flex items-center gap-1.5 rounded-full border border-line bg-panel/95 px-3 py-1.5 text-caption text-muted shadow-lg shadow-black/10 backdrop-blur ${className}`}
    >
      {/* Queued is a state (the restart is waiting on sessions), so it is the
          static icon; everything else is a wait for an answer, so it is the
          app's spinner. */}
      {status.busy ? <Spinner size="sm" /> : <RefreshCw size={13} />}
      <span className="truncate">{status.label}</span>
    </div>
  );
}
