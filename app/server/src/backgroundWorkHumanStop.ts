/**
 * Human Stop for background work ([Task-486](pa://task/486)).
 *
 * The browser's Stop and Stop-all reach the SUPERVISOR's domain services
 * directly, under human authorization. They deliberately do not go through
 * `background_tasks`, the model-facing tool: that tool answers a model in the
 * OWNING session, scoped to what that session owns and to its own harness's
 * backend, and it reports through a tool result. A human is scoped to neither
 * and reports through the registry. Two callers, one authority — nothing here
 * decides an item's fate, terminalizes a row, or keeps Stop state of its own.
 *
 * The answer is control feedback only. Every fact the UI renders about a row
 * arrives as a `background` state event, so a Stop that is merely REQUESTED
 * (unacknowledged, or issued before the provider handle was bound) stays
 * visibly nonterminal instead of being drawn as closed.
 */
import type {
  BackgroundWorkStopAnswer,
  BackgroundWorkStopOutcome,
} from "@assistant/shared";
import type {
  BackgroundWorkStopOneRequest,
  BackgroundWorkStopAllOwnerRequest,
  BackgroundWorkStopResult,
} from "./backgroundWork/supervisor.ts";
import { backgroundWorkSupervisor } from "./backgroundWork/supervisor.ts";
import { backgroundWorkStore } from "./db/backgroundWorkStore.ts";

/** Ids arrive from the browser, so they are bounded before anything is read. */
const MAX_ID_CHARS = 200;

const HOST_LIVE_STATES = new Set(["creating", "live", "draining"]);

/**
 * Everything this module reaches for, injected so the human path can be tested
 * without a live supervisor — and so it cannot quietly grow a second one.
 */
export interface BackgroundWorkHumanStopDeps {
  stopOne(
    request: BackgroundWorkStopOneRequest,
  ): Promise<BackgroundWorkStopResult>;
  stopAllOwner(
    request: BackgroundWorkStopAllOwnerRequest,
  ): Promise<BackgroundWorkStopResult[]>;
  getItem(itemId: string): { id: string; ownerSessionId: string } | undefined;
  /** The owner's retained Claude host epoch, read AFTER the Stop-all effect. */
  hostStateForOwner(ownerSessionId: string): string | undefined;
  /**
   * True while an ordinary prompted turn is inside its safe boundary. The same
   * predicate the supervisor is configured with, read here only to EXPLAIN a
   * wait the supervisor already decided — never to decide one.
   */
  ordinaryTurnActive(ownerSessionId: string): boolean;
}

export const backgroundWorkHumanStopDeps = (
  ordinaryTurnActive: (ownerSessionId: string) => boolean,
): BackgroundWorkHumanStopDeps => ({
  stopOne: (request) => backgroundWorkSupervisor.stopOne(request),
  stopAllOwner: (request) => backgroundWorkSupervisor.stopAllOwner(request),
  getItem: (itemId) => backgroundWorkStore.getItem(itemId),
  hostStateForOwner: (ownerSessionId) =>
    backgroundWorkStore.hostForOwner(ownerSessionId)?.state,
  ordinaryTurnActive,
});

function validId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > MAX_ID_CHARS) return undefined;
  return id;
}

function outcomeOf(
  result: BackgroundWorkStopResult,
): BackgroundWorkStopOutcome {
  return result.state === "not-owner" ? "unknown" : result.state;
}

/**
 * Stop one item. The owner comes from the durable row rather than the client:
 * a human addresses work by PA id alone, and the supervisor still revalidates
 * ownership immediately before each port effect.
 */
export async function stopBackgroundWorkForHuman(
  itemId: unknown,
  requestId: string,
  deps: BackgroundWorkHumanStopDeps,
): Promise<BackgroundWorkStopAnswer> {
  const id = validId(itemId);
  const item = id ? deps.getItem(id) : undefined;
  if (!id || !item)
    return { requestId, items: id ? [{ itemId: id, outcome: "unknown" }] : [] };
  const result = await deps.stopOne({
    itemId: item.id,
    ownerSessionId: item.ownerSessionId,
    sourceRequestId: `human:${requestId}`,
    reason: "Stopped by you",
  });
  return {
    requestId,
    items: [{ itemId: item.id, outcome: outcomeOf(result) }],
  };
}

/**
 * Stop everything one session owns. `callerSessionId` is deliberately absent:
 * it is what the supervisor reads as "the owner's own turn is asking", and a
 * human is not that caller. The supervisor therefore protects an ordinary
 * prompted turn — and only that turn — on its own.
 */
export async function stopAllBackgroundWorkForHuman(
  ownerSessionId: unknown,
  requestId: string,
  deps: BackgroundWorkHumanStopDeps,
): Promise<BackgroundWorkStopAnswer> {
  const owner = validId(ownerSessionId);
  if (!owner) return { requestId, items: [] };
  const answer = { requestId, ownerSessionId: owner };
  const results = await deps.stopAllOwner({
    ownerSessionId: owner,
    sourceRequestId: `human:${requestId}`,
    reason: "Stopped by you",
  });
  // Read the host back from durable state: a retained epoch still open after
  // Stop-all is a close the supervisor deferred, and the only honest reason we
  // can give for it is the protected turn it was deferred behind.
  const hostState = deps.hostStateForOwner(owner);
  const waiting = hostState !== undefined && HOST_LIVE_STATES.has(hostState);
  return {
    ...answer,
    items: results.flatMap((result) =>
      result.item
        ? [{ itemId: result.item.id, outcome: outcomeOf(result) }]
        : [],
    ),
    ...(waiting
      ? { hostCloseWaiting: { protectedTurn: deps.ordinaryTurnActive(owner) } }
      : {}),
  };
}
