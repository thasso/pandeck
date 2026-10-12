/**
 * The follow-up an agent queued for itself before a dev-server reload
 * (`workshop_defer_after_reload`), delivered once the server is back.
 *
 * Consuming it deletes its only copy, and reopening the session it belongs to
 * is awaited — long enough for the user to press Stop meanwhile. So it becomes
 * a durable agent handoff BEFORE anything is awaited, and is delivered through
 * that queue: a held or busy session keeps it queued, in order, until its idle
 * edge or the user's Resume (`automaticTurnHold.ts`), instead of failing it.
 */
import { drainAgentHandoffs, enqueueAgentHandoff } from "./agentHandoffs.ts";

/** One origin for every path, so the transcript labels it the same way. */
const POST_RELOAD_CONTINUATION_SOURCE = "post-reload-continuation";

export async function deliverPostReloadContinuation(
  continuation: { sessionId: string; message: string },
  /** Brings the session back (and onto the reader's view); may throw. */
  reopen: () => Promise<unknown>,
): Promise<void> {
  enqueueAgentHandoff({
    sessionId: continuation.sessionId,
    text: continuation.message,
    origin: { kind: "system", source: POST_RELOAD_CONTINUATION_SOURCE },
    visible: true,
  });
  await reopen();
  await drainAgentHandoffs(continuation.sessionId);
}
