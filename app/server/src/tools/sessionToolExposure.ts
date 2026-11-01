/**
 * Which tools each live session exposes to its model, for the Tools inspector
 * (`docs/agent-harnesses.md`). The harness that runs a session registers how
 * to read its exposure and removes it on teardown; a reader asks by session id
 * alone and never learns which engine answered. Loads nothing of either engine.
 */
import type { SessionToolExposure } from "@assistant/shared";

const sources = new Map<string, () => SessionToolExposure | undefined>();

/**
 * Register how to read a session's tool exposure, replacing an earlier one.
 * Returns the unregister, which removes only this registration. A read may
 * answer undefined: the engine has no app tools.
 */
export function registerSessionToolExposure(
  sessionId: string,
  read: () => SessionToolExposure | undefined,
): () => void {
  sources.set(sessionId, read);
  return () => {
    if (sources.get(sessionId) === read) sources.delete(sessionId);
  };
}

/** The session's current tool exposure, when its engine registered one. */
export function sessionToolExposure(
  sessionId: string,
): SessionToolExposure | undefined {
  return sources.get(sessionId)?.();
}
