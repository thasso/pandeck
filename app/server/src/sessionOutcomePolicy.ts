import { isDirectlyOwnedSession, type SpawnOwnership } from "@assistant/shared";
import type { AgentStopReason, PromptOrigin } from "@assistant/shared/session";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { sessionStore } from "./db/sessionStore.ts";

export interface SessionRunOutcomeContext {
  ownership: SpawnOwnership | undefined;
  origin: PromptOrigin | undefined;
  stopReason: AgentStopReason;
  outstandingResponseRequestCount: number;
}

export type SessionRunOutcomeDisposition =
  "raise" | "coordinator-owned" | "aborted" | "intermediate-peer-wake";

/**
 * How one completed provider run affects user attention.
 */
function runOutcomeDisposition(
  context: SessionRunOutcomeContext,
): SessionRunOutcomeDisposition {
  if (!isDirectlyOwnedSession(context.ownership)) return "coordinator-owned";
  if (context.stopReason === "aborted") return "aborted";
  if (context.stopReason === "error") return "raise";
  if (
    context.origin?.kind === "agent" &&
    context.outstandingResponseRequestCount > 0
  )
    return "intermediate-peer-wake";
  return "raise";
}

/**
 * Whether one completed provider run is an outcome the user should be told
 * about, in both the Sessions inbox and OS notifications.
 *
 * A coordinator-owned child reports to its parent, not to the user. A parent
 * turn driven by a peer report is also intermediate while another explicitly
 * requested peer reply remains outstanding. Human- and system-driven turns
 * remain their own outcomes even while orchestration is active. A failure is
 * always an outcome for a directly owned session; an aborted turn never is.
 */
export function runOutcomeNeedsUser(
  context: SessionRunOutcomeContext,
): boolean {
  return runOutcomeDisposition(context) === "raise";
}

/** Whether this session itself, rather than its coordinator, belongs to the user. */
export function sessionIsDirectlyOwned(sessionId: string): boolean {
  const spawn = sessionStore
    .spawnedParentsByChildIds([sessionId])
    .get(sessionId);
  return isDirectlyOwnedSession(spawn?.ownership);
}

/** Read the durable coordination facts and classify one completed run. */
export function sessionRunOutcomeDisposition(
  sessionId: string,
  stopReason: AgentStopReason,
  origin: PromptOrigin | undefined,
): SessionRunOutcomeDisposition {
  const spawn = sessionStore
    .spawnedParentsByChildIds([sessionId])
    .get(sessionId);
  return runOutcomeDisposition({
    ownership: spawn?.ownership,
    origin,
    stopReason,
    outstandingResponseRequestCount:
      peerPromptStore.outstandingResponseRequestCount(sessionId),
  });
}

/** Read the durable coordination facts and apply {@link runOutcomeNeedsUser}. */
export function sessionRunOutcomeNeedsUser(
  sessionId: string,
  stopReason: AgentStopReason,
  origin: PromptOrigin | undefined,
): boolean {
  return (
    sessionRunOutcomeDisposition(sessionId, stopReason, origin) === "raise"
  );
}
