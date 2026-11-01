import type { SessionListItem } from "./protocol.ts";

/**
 * The {@link SessionListItem} fields the server derives from LIVE state that a
 * restored row must not keep claiming: a run in flight, a pending human
 * decision, queued or held work, and owed replies. Each is ABSENT on a row
 * whose session has nothing live, except the two booleans the server always
 * emits (`isStreaming`, `awaitingInput`), which are `false` there.
 *
 * Every other field is durable or revision-stamped: a cached row that keeps it
 * is still the server's row at its revision, and a change since moves that
 * revision, so a digest re-reads it (`docs/state-sync.md`).
 */
export const SESSION_LIST_LIVE_FIELDS = [
  "isStreaming",
  "awaitingInput",
  "runStartedAt",
  "providerRetry",
  "attention",
  "queuedWork",
  "waitingForSlot",
  "awaitingRepliesFrom",
  "unansweredRequestsFrom",
] as const satisfies readonly (keyof SessionListItem)[];

/**
 * `row` with every {@link SESSION_LIST_LIVE_FIELDS} entry reset to the value
 * the server emits for a session with nothing live. A row already at rest maps
 * to a value-equal row, so it stays the canonical row at its revision; a row
 * that was live does not, which is how the shell cache tells them apart.
 */
export function sessionListItemAtRest(row: SessionListItem): SessionListItem {
  const atRest: SessionListItem = { ...row };
  for (const field of SESSION_LIST_LIVE_FIELDS) {
    if (field === "isStreaming" || field === "awaitingInput")
      atRest[field] = false;
    else delete atRest[field];
  }
  return atRest;
}
