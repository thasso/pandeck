/**
 * Ownership of agent-spawned peer sessions ([Task-637](pa://task/637)).
 *
 * A `session_spawn` child starts out owned by its coordinator, and it stays
 * that way until the user SAYS otherwise — the explicit Take over (and its
 * reverse, Hand back) command. Messaging a peer is not that decision: users
 * poke stalled peers all the time, and a poke that silently moved ownership
 * pulled the peer out of its coordinator's fold and revoked the
 * coordinator's control over it. The fact is durable, because the attention
 * inbox folds coordinator-owned children under their coordinator and must
 * never fold away a session the user has taken.
 */
import { sessionStore } from "./db/sessionStore.ts";
import { errorText } from "./errors.ts";
import type { HumanPromptSignal } from "./session/runtime/liveSession.ts";

/**
 * Set a spawned child's owner on the user's explicit word, returning whether
 * ownership actually moved — the one condition that justifies a session-list
 * broadcast — or `undefined` when the session has no spawn edge to set.
 */
export function setSpawnOwnership(
  sessionId: string,
  ownership: "taken-over" | "coordinator",
): boolean | undefined {
  if (!sessionStore.spawnedParentsByChildIds([sessionId]).has(sessionId))
    return undefined;
  try {
    return sessionStore.setSpawnedOwnership(sessionId, ownership);
  } catch (err) {
    console.warn(
      `[spawn] failed to set ownership of ${sessionId}:`,
      errorText(err),
    );
    return false;
  }
}

/**
 * The runtime's human-prompt hook: every human-origin prompt closes the peer
 * chains its session takes part in, visible or hidden. It deliberately does
 * NOT move ownership — that is {@link setSpawnOwnership}'s, on request.
 */
export function humanPromptHandler(deps: {
  closeChains: (sessionId: string) => void;
}): (sessionId: string, signal: HumanPromptSignal) => void {
  return (sessionId) => deps.closeChains(sessionId);
}
