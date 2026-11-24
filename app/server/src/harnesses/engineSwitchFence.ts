/**
 * The switching fence (`docs/session-runtime-switching.md` "Switching fence"):
 * from the moment a cross-harness switch releases a session from its engine
 * until the switch commits or is abandoned, no one may drive the session.
 * Neither engine shows it resident and opening it refuses as busy, so a
 * viewer's command, a background completion or a peer delivery cannot reopen
 * the engine it is leaving, or reach the one it is moving to before the
 * binding commits. Lanes treat busy as "try later"; a commit, or a rollback
 * after the fence refused someone, offers the session its waiting work again.
 * A rollback that refused no one wakes nothing: the switching turn's own work
 * is held, and waking it would only retry the failed switch.
 */
import { wakeSessionDelivery } from "../deliveryWake.ts";
import { SessionBusyError } from "../session/runtime/errors.ts";

/** Each switching session, and whether its fence refused anyone yet. */
const switching = new Map<string, { refused: boolean }>();

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

/** The refusal for driving a fenced session, noted so its lift wakes delivery. */
export function engineSwitchRefusal(
  sessionId: string,
): SessionSwitchingEnginesError {
  const fence = switching.get(sessionId);
  if (fence) fence.refused = true;
  return new SessionSwitchingEnginesError(sessionId);
}

/**
 * Raise the fence for one switch. The answer lifts it once (later calls do
 * nothing). Lifting after a commit always wakes the session's delivery, so
 * work that waited is offered on the new engine; lifting after a rollback
 * wakes it only when the fence refused someone meanwhile.
 */
export function raiseEngineSwitchFence(
  sessionId: string,
): (committed: boolean) => void {
  if (switching.has(sessionId))
    throw new SessionSwitchingEnginesError(sessionId);
  const fence = { refused: false };
  switching.set(sessionId, fence);
  let lifted = false;
  return (committed) => {
    if (lifted) return;
    lifted = true;
    switching.delete(sessionId);
    if (committed || fence.refused) wakeSessionDelivery(sessionId);
  };
}
