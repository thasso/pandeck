/**
 * Which sessions have a `/rename` in flight, as one token per session. A newer
 * `/rename` replaces the token and a manual rename deletes it, so a run whose
 * token is gone finishes without touching the title. A leaf module: the list
 * builder reads it, and the naming run (`sessionRetitle.ts`) writes it.
 */
import { touchSessionRows } from "./db/sessionListChanges.ts";

const inFlight = new Map<string, symbol>();

/** Claim the session's retitle; any earlier run's token is replaced. */
export function beginSessionRetitle(sessionId: string): symbol {
  const token = Symbol(sessionId);
  inFlight.set(sessionId, token);
  touchSessionRows([sessionId]);
  return token;
}

/** Whether `token` is still the session's live retitle. */
export function ownsSessionRetitle(sessionId: string, token: symbol): boolean {
  return inFlight.get(sessionId) === token;
}

/** Release the session's retitle if `token` still owns it. */
export function endSessionRetitle(sessionId: string, token: symbol): void {
  if (inFlight.get(sessionId) !== token) return;
  inFlight.delete(sessionId);
  touchSessionRows([sessionId]);
}

/** Whether the list should show this session's title as being generated. */
export function isRetitlingSession(sessionId: string): boolean {
  return inFlight.has(sessionId);
}

/** A manual rename wins over a retitle still running for the session. */
export function cancelSessionRetitle(sessionId: string): boolean {
  if (!inFlight.delete(sessionId)) return false;
  touchSessionRows([sessionId]);
  return true;
}
