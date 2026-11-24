/**
 * The switching fence (`docs/session-runtime-switching.md` "Switching fence"):
 * from the moment a cross-harness switch releases a session from its engine
 * until the switch commits or is abandoned, no one may drive the session.
 * Neither engine shows it resident and opening it refuses as busy, so a
 * viewer's command, a background completion or a peer delivery cannot reopen
 * the engine it is leaving, or reach the one it is moving to before the
 * binding commits. Lanes treat busy as "try later"; lifting the fence offers
 * the session its waiting work again.
 */
import { wakeSessionDelivery } from "../deliveryWake.ts";
import { SessionBusyError } from "../session/runtime/errors.ts";

const switching = new Set<string>();

/** Refused while the session moves between engines; retry once it has. */
export class SessionSwitchingEnginesError extends SessionBusyError {
  constructor(sessionId: string) {
    super(
      sessionId,
      "This session is moving to another engine; send it again in a moment.",
    );
    this.name = "SessionSwitchingEnginesError";
  }
}

/** Whether a switch holds the session's fence now. */
export function isSwitchingEngines(sessionId: string): boolean {
  return switching.has(sessionId);
}

/**
 * Raise the fence for one switch. The answer lifts it once (later calls do
 * nothing) and wakes the session's delivery, so work refused meanwhile is
 * offered again on whichever engine the session is now bound to.
 */
export function raiseEngineSwitchFence(sessionId: string): () => void {
  if (switching.has(sessionId))
    throw new SessionSwitchingEnginesError(sessionId);
  switching.add(sessionId);
  let lifted = false;
  return () => {
    if (lifted) return;
    lifted = true;
    switching.delete(sessionId);
    wakeSessionDelivery(sessionId);
  };
}
