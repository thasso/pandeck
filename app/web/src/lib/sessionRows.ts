import type { SessionListItem } from "@assistant/shared";
import { sessionDeliveryKey } from "./sessionDelivery.ts";

/** Compact relative timestamp sized for single-line rows ("now", "5m", "3h", "Jun 3"). */
export function relativeTime(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Content key for a sidebar session row: everything `SessionRow` /
 * `SessionRowContent` render, and nothing else.
 *
 * The session list is rebroadcast up to ~4x/second while any agent streams, and
 * every broadcast builds brand-new row objects, so the rows' `memo` can only
 * hold on CONTENT. Same rule (and same failure mode) as
 * `transcriptKeys.ts`: widening what a row reads without widening this key
 * fails invisibly — the row simply stops updating.
 *
 * The rendered relative timestamp is part of the key rather than the raw
 * `updatedAt`: it is what the row shows, so a row whose label ticks over from
 * "5m" to "6m" must re-render even though nothing about the session changed.
 */
export function sessionRowKey(session: SessionListItem): string {
  const progress = session.taskProgress;
  return [
    session.id,
    session.title,
    session.titleGenerationPending ? "1" : "",
    relativeTime(session.updatedAt),
    session.harness ?? "",
    session.agentType ?? "",
    session.isStreaming ? "1" : "",
    session.awaitingInput ? "1" : "",
    // The blocking badge is WORDED by the attention kind, so the kind is part
    // of what the row renders — not just the fact that something blocks.
    session.attention ?? "",
    session.unread ? "1" : "",
    session.archived ? "1" : "",
    progress
      ? `${progress.todo}\u001f${progress.doing}\u001f${progress.done}`
      : "",
    // The pull-request glyph. Derived, so keyed on what it RENDERS rather than
    // on the summary's fields: CI turning red is a change that arrives while
    // everything else about the session stands still.
    sessionDeliveryKey(session),
  ].join("\u0000");
}

/**
 * Content key for everything the BACKLOG reads off the session list: which
 * sessions EXIST (a Task row offers to open the one its work started in, so a
 * row must not hold a session the list has dropped), which are streaming (the
 * observed "Working", and the archive blocker), whether one is archived (put
 * away, so no longer what a row opens), which worktree each runs in, and what
 * each is CALLED.
 *
 * The title is in it because a consumer names a session with it: a Workflow
 * Run's role-session buttons (`WorkflowRunCard.tsx`) fall back to the raw
 * `sessionId` when the title is empty, and a role session enters the list
 * untitled and is auto-titled seconds later. Without the title in the key that
 * button showed an id for the whole run.
 *
 * That it can afford to be here is settled by {@link sessionRowKey}, not by an
 * estimate: that key ALREADY reads `session.title`, and it is the key for the
 * ~220 sidebar rows — the hot path this whole gate exists for. A title that
 * moved on the rebroadcast would already be defeating it there. So `title` is
 * not in the churning group; `unread` and `updatedAt` are.
 *
 * Same reason as {@link sessionRowKey}: the list is rebroadcast up to ~4x/second
 * and almost none of those broadcasts change these answers, so the Backlog's
 * ~220 rows should not rebuild for an unread flag moving. A consumer keyed on
 * this therefore holds an OLDER session array whose other fields have moved —
 * reading anything not listed here needs the key widened. What it deliberately
 * omits is `unread`, `updatedAt` and the list ORDER, each for the reason below.
 *
 * `updatedAt` is deliberately NOT in it: it moves on every streamed token, so
 * keying on it would defeat the gate entirely. The one thing that reads it
 * (`lib/taskActivity.ts`'s recency tie-break between several sessions started
 * from one Task) therefore chooses on a possibly stale ordering — between two
 * sessions that both exist, which is a preference, not a broken action.
 *
 * Leaving it out is only half the gate, and the ORDER is the other half: the
 * list is sorted BY `updatedAt`, so every streamed token re-sorts it, and a key
 * that read the rows in list order changed for exactly the broadcasts this
 * exists to absorb. The Backlog reads these as a `sessionById` lookup, so the
 * tokens are sorted and the order is not information.
 */
export function backlogSessionsKey(
  sessions: readonly SessionListItem[],
): string {
  return sessions
    .map((session) =>
      [
        session.id,
        session.isStreaming ? "!" : "",
        session.archived ? "-" : "",
        session.worktreeId ?? "",
        session.title,
      ].join("\u001f"),
    )
    .sort()
    .join("\u0000");
}

/**
 * `memo` comparator for a session row: every prop by identity, except the
 * session row itself which is compared on {@link sessionRowKey}.
 *
 * Enumerating the props here rather than listing them keeps a newly added prop
 * covered by default — the safe direction, since a missed prop would silently
 * freeze the row.
 */
export function sameSessionRowProps<P extends { session: SessionListItem }>(
  prev: P,
  next: P,
): boolean {
  const keys = Object.keys(prev);
  if (keys.length !== Object.keys(next).length) return false;
  for (const key of keys) {
    if (key === "session") continue;
    if (!Object.is(prev[key as keyof P], next[key as keyof P])) return false;
  }
  return sessionRowKey(prev.session) === sessionRowKey(next.session);
}
