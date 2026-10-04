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
import type { SettableSpawnOwnership } from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";

/**
 * What an explicit ownership command did. `unavailable` is a session the user
 * cannot act on (missing, deleted, or not in the user's scope); `not-spawned`
 * has no spawn edge, so no owner to change.
 */
export type SpawnOwnershipResult =
  "changed" | "unchanged" | "unavailable" | "not-spawned";

/**
 * Set a spawned child's owner on the user's explicit word. A store failure
 * THROWS rather than reading as "unchanged": the caller reports it, so the
 * browser's optimistic change is recovered instead of standing over a write
 * that never happened.
 */
export function setSpawnOwnership(
  sessionId: string,
  ownership: SettableSpawnOwnership,
): SpawnOwnershipResult {
  const meta = sessionStore.get(sessionId);
  if (!meta || meta.scope !== "user") return "unavailable";
  if (!sessionStore.spawnedParentsByChildIds([sessionId]).has(sessionId))
    return "not-spawned";
  return sessionStore.setSpawnedOwnership(sessionId, ownership)
    ? "changed"
    : "unchanged";
}

/**
 * The runtime's human-prompt hook: every human-origin prompt closes the peer
 * chains its session takes part in, visible or hidden. It deliberately does
 * NOT move ownership — that is {@link setSpawnOwnership}'s, on request.
 */
export function humanPromptHandler(deps: {
  closeChains: (sessionId: string) => void;
}): (sessionId: string) => void {
  return (sessionId) => deps.closeChains(sessionId);
}
