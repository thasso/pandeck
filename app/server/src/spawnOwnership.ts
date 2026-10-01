/**
 * Ownership of agent-spawned peer sessions ([Task-637](pa://task/637)).
 *
 * A `session_spawn` child starts out owned by its coordinator. The moment the
 * user sends it a direct, visible prompt, they own it instead — and that fact is
 * durable, because a later consumer (the attention inbox) may fold
 * coordinator-owned children under their coordinator and must never fold away a
 * session the user personally intervened in.
 *
 * Only a VISIBLE human-origin prompt counts. Opening, reading, routing, peer
 * prompts, agent/system continuations, hidden provenance prompts, rejected sends
 * and deduplicated retries all leave ownership alone — the first three never
 * reach this seam, and the rest are filtered here or by the runtime hook that
 * fires only after a durable human user entry was appended.
 */
import { sessionStore } from "./db/sessionStore.ts";
import { errorText } from "./errors.ts";
import type { HumanPromptSignal } from "./session/runtime/liveSession.ts";

/**
 * Record that the user took a spawned child over, returning whether ownership
 * actually moved. Best-effort: a store failure leaves the stored ownership as it
 * was rather than failing the user's prompt.
 */
function recordDirectTakeover(sessionId: string): boolean {
  try {
    return sessionStore.markSpawnedTakenOver(sessionId);
  } catch (err) {
    console.warn(
      `[spawn] failed to record takeover of ${sessionId}:`,
      errorText(err),
    );
    return false;
  }
}

/**
 * Compose the runtime's human-prompt hook: the peer-chain reset runs for EVERY
 * human-origin prompt as before, and the takeover only for a visible one. The
 * session list is broadcast only when ownership actually transitioned, so the
 * marker reaches every tab without adding churn to ordinary prompting.
 */
export function humanPromptHandler(deps: {
  closeChains: (sessionId: string) => void;
  broadcastSessions: () => void;
}): (sessionId: string, signal: HumanPromptSignal) => void {
  return (sessionId, signal) => {
    deps.closeChains(sessionId);
    if (signal.hidden) return;
    if (recordDirectTakeover(sessionId)) deps.broadcastSessions();
  };
}
