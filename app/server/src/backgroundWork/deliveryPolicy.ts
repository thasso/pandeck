/**
 * Whether a terminal background-work fact is worth a TURN.
 *
 * Delivery used to be unconditional: every terminal item queued a notice, and
 * because the owner is normally mid-turn when its own work settles, the queue
 * drained as a fresh prompt the moment that turn ended. Sessions therefore paid
 * a full-context turn to be told something the agent already knew — the
 * measured shape was 23 delivery turns against 26 human ones in one session,
 * eleven of them answered verbatim "No response requested."
 *
 * The rule this module encodes is narrower than "notify on completion":
 *
 *   Some events must be KNOWN before the next action. None of them justify
 *   CREATING one.
 *
 * So a `wake` is reserved for the one case that has no other way to be seen —
 * work the session was parked on, settling while nothing is running — and
 * everything else DEFERS. A defer is not a drop: the durable row and the
 * background-tasks UI are unchanged, and `completionDelivery.ts` carries the
 * same model context into the next turn the session takes for any other reason.
 *
 * Nothing here is ever discarded. An earlier revision dropped a `claude-query`
 * completion outright when a turn was running, reasoning that the CLI had
 * already injected its own `<task-notification>` into that turn. Review found
 * the premise unprovable from this evidence: `ClaudeSdkSession` also
 * terminalizes from the Stop snapshot precisely WHEN a notification is missing,
 * and the SDK's `skip_transcript` flag is not consulted. Both sample a running
 * turn and would have been dropped, leaving the fact nowhere but the UI. Paying
 * a bounded block on the next turn is the cheap side of that trade; a fact the
 * model never learns is not.
 */

import type { BackgroundWorkBackend } from "@assistant/shared";
import type { BackgroundWorkStopOrigin } from "../db/backgroundWorkStore.ts";

/** Which runtime executes the work: the durable row's `backend`. */
export type BackgroundDeliveryBackend = BackgroundWorkBackend;

/**
 * `wake` means the fact must reach the model on its own account. Delivery
 * satisfies it as cheaply as it can: joining a running turn with `steerOnly`
 * where the driver takes mid-turn input, and otherwise starting a turn. `defer`
 * costs no turn and still reaches the model, on the next one.
 */
type BackgroundDeliveryDisposition = "wake" | "defer";

/**
 * Why a disposition was chosen. Kept as a closed vocabulary rather than prose so
 * tests and logs can assert the REASON, not just the outcome — two rules that
 * happen to agree today must still be distinguishable.
 */
type BackgroundDeliveryReason =
  | "stop-requested"
  | "already-in-turn"
  | "awaited"
  | "unrequested-stop"
  | "deadline-expired";

/**
 * WHO wanted the Stop — not why, and never its wording. The row records it
 * (`backgroundWorkStore.ts`), naming the Stop that actually ended the work.
 *
 * `requester` covers every stop somebody holds the answer to already.
 * `deadline` and `system` are PA stopping work on its own account — the frozen
 * deadline expiring, the monitor event-rate limit — which leaves the owner
 * believing the work is still running, often while it waits parked for it.
 */
export type BackgroundStopOrigin = BackgroundWorkStopOrigin;

export interface BackgroundDeliveryEvidence {
  backend: BackgroundDeliveryBackend;
  /** The row carries a Stop request from ANY source: agent, human, or PA itself. */
  stopRequested: boolean;
  /** Who asked. Meaningful only while `stopRequested`; defaults to `requester`. */
  stopOrigin?: BackgroundStopOrigin;
  /** The owner session had a turn in flight when this fact became durable. */
  ownerTurnRunning: boolean;
}

export interface BackgroundDeliveryDecision {
  disposition: BackgroundDeliveryDisposition;
  reason: BackgroundDeliveryReason;
}

/**
 * Decide how a terminal fact reaches the model. Pure, and deliberately blind to
 * the item's state and outcome: WHY the work ended does not change whether the
 * agent needs a turn to hear about it.
 *
 * Deployment drain is deliberately absent. A drained item never arrives here at
 * all — `supervisor.ts` suppresses `completionRecorded` while draining, and the
 * hub stops delivery with admission — so a branch for it would be unreachable
 * code claiming a guarantee the system does not make. Restart resumes nothing;
 * a drain fact lives in its row and the UI. A `server-task` fact recorded while
 * draining, or ended by boot, is the one exception, and it still never comes
 * through here: the store owes it a retained `wake` receipt in its terminal
 * transaction, which boot restores (`backgroundCompletionNotices.ts`).
 */
export function backgroundCompletionDisposition(
  evidence: BackgroundDeliveryEvidence,
): BackgroundDeliveryDecision {
  // PA stopped work nobody asked it to stop. The owner is holding the opposite
  // belief — that its monitor is still watching, that its job is still running
  // — and deferring would confirm that belief by saying nothing. Both are
  // ordered FIRST so a Stop of PA's own can never fall into the requester
  // branch below.
  if (evidence.stopRequested && evidence.stopOrigin === "system")
    return { disposition: "wake", reason: "unrequested-stop" };

  // The frozen deadline ran out. The agent set that budget, but nothing told it
  // the budget was spent: a session parked on a one-hour test run sat idle for
  // over two hours after its deadline Stop, because this used to defer as if
  // the agent had asked. It also wakes a running turn, as the event-rate Stop
  // does: the CLI's own notification is not evidence the fact was seen.
  if (evidence.stopRequested && evidence.stopOrigin === "deadline")
    return { disposition: "wake", reason: "deadline-expired" };

  // A Stop was requested. Every requester already holds the answer: the agent
  // got the terminal row back from its own `background_tasks` stop call, and
  // the human is looking at the UI they clicked. Keying on the stop reason
  // string would couple this policy to supervisor wording, which is why the
  // exceptions above are a typed origin rather than a reason match.
  if (evidence.stopRequested)
    return { disposition: "defer", reason: "stop-requested" };

  // Claude background work executes INSIDE the retained query, so a turn was
  // live to receive whatever the CLI injected for itself. That makes a turn of
  // PA's own redundant at best — but not the message, since the injection is not
  // guaranteed for every terminal path (see the header).
  if (evidence.backend === "claude-query" && evidence.ownerTurnRunning)
    return { disposition: "defer", reason: "already-in-turn" };

  // Nothing else was watching: the session went idle and stayed idle. This is
  // the parked case — the monitor or job the agent yielded for — and the only
  // one where no turn means no delivery at all.
  return { disposition: "wake", reason: "awaited" };
}
