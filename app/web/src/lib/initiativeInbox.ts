/**
 * Initiatives as Sessions inbox items (`docs/initiatives.md`, The attention
 * list; `app/web/docs/ui-shell.md`).
 *
 * An ACTIVE Initiative is always an item, with nothing to settle: it is
 * ongoing work, not an outcome, and it stands in its own block above the
 * working set. A paused or done one is an OUTCOME while its attention cursor
 * holds a revision the user has not settled: it is an item of **Needs you**,
 * counted there like an ended Workflow Run, and Settle acknowledges exactly
 * that rendered revision. Everything here reads the `initiatives` topic
 * summary alone, so an item never asks for the graph.
 *
 * The sessions an item discloses are the summary's own — started from a
 * member Task, live, at most 50 — resolved against the rows this browser
 * already holds, and at most {@link INITIATIVE_DISCLOSURE_ROWS} of them are
 * shown. They are LISTED, never folded: each keeps its own card, because a
 * Task can belong to several Initiatives and no card owns a session.
 *
 * Framework-free by the `lib/` contract.
 */
import type { InitiativeSummary, SessionListItem } from "@assistant/shared";
import { relativeAge } from "./relativeTime.ts";
import {
  compareSessionsNeedingUserFirst,
  inboxCard,
  inboxItemId,
  itemPosition,
  sessionCardKey,
  type SessionInboxCard,
  type SessionInboxItem,
} from "./sessionInbox.ts";

/**
 * How many sessions an opened disclosure lists. The summary carries up to 50
 * ids (the data bound); this is the initial display bound. Show more reveals
 * the remaining locally available sessions inline.
 */
export const INITIATIVE_DISCLOSURE_ROWS = 5;

export interface InitiativeInboxItem {
  initiative: InitiativeSummary;
  /**
   * The attention revision Settle acknowledges, present exactly while the
   * Initiative is an unsettled paused or done OUTCOME — which is also what
   * puts it in Needs you. Captured into the click, never re-read when the
   * command leaves.
   */
  settleRevision?: number;
  /**
   * The sessions the disclosure lists: the summary's that this browser holds,
   * those needing the user first, then newest, at most
   * {@link INITIATIVE_DISCLOSURE_ROWS}.
   */
  sessions: SessionInboxCard[];
  /** Remaining known sessions, revealed inline by Show more. */
  additionalSessions?: SessionInboxCard[];
  /**
   * Qualifying sessions the disclosure does not list — past the display
   * bound, past the summary's page of 50, or not among this browser's rows:
   * the full count minus the initial rows. Known additional rows can expand;
   * the remainder is informational because its session details are not loaded.
   */
  more: number;
}

/** The two places Initiative items stand in the inbox. */
export interface InitiativeInbox {
  /** Active Initiatives: their own block above the working set. */
  active: InitiativeInboxItem[];
  /** Unsettled paused or done outcomes: items of Needs you. */
  outcomes: InitiativeInboxItem[];
}

/** The pending revision of a paused or done Initiative, else undefined. */
export function initiativeSettleRevision(
  initiative: InitiativeSummary,
): number | undefined {
  if (initiative.state === "active") return undefined;
  const attention = initiative.attention;
  return attention && attention.revision > attention.settledRevision
    ? attention.revision
    : undefined;
}

/** Whether the Initiative is a Sessions inbox item at all. */
export function initiativeInInbox(initiative: InitiativeSummary): boolean {
  return (
    initiative.state === "active" ||
    initiativeSettleRevision(initiative) !== undefined
  );
}

/** The item's identity for React keys, layout measurement and focus. */
export function initiativeItemId(initiativeId: string): string {
  return `initiative:${initiativeId}`;
}

/** Newest created first, the inbox's order for an item nobody dragged. */
function newestFirst(a: InitiativeInboxItem, b: InitiativeInboxItem): number {
  const created = b.initiative.createdAt - a.initiative.createdAt;
  if (created !== 0) return created;
  const left = initiativeItemId(a.initiative.id);
  const right = initiativeItemId(b.initiative.id);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The Initiative items, split by where they stand. A state change moves an
 * item only between those two places, never within one: each is ordered by
 * creation alone, since an Initiative is never dragged.
 */
export function buildInitiativeInbox(
  initiatives: readonly InitiativeSummary[],
  sessions: readonly SessionListItem[],
  readCurrentId?: string,
): InitiativeInbox {
  const inbox: InitiativeInbox = { active: [], outcomes: [] };
  const listed = initiatives.filter(initiativeInInbox);
  if (listed.length === 0) return inbox;
  const byId = new Map(
    sessions
      .filter((session) => !session.archived)
      .map((session) => [session.id, session]),
  );
  for (const initiative of listed) {
    const known: SessionInboxCard[] = [];
    for (const id of initiative.sessionIds) {
      const session = byId.get(id);
      if (session) known.push(inboxCard(session, readCurrentId));
    }
    known.sort(compareSessionsNeedingUserFirst);
    const shown = known.slice(0, INITIATIVE_DISCLOSURE_ROWS);
    const additionalSessions = known.slice(INITIATIVE_DISCLOSURE_ROWS);
    const settleRevision = initiativeSettleRevision(initiative);
    const item: InitiativeInboxItem = {
      initiative,
      ...(settleRevision !== undefined ? { settleRevision } : {}),
      sessions: shown,
      ...(additionalSessions.length ? { additionalSessions } : {}),
      more: Math.max(0, initiative.sessionCount - shown.length),
    };
    (settleRevision !== undefined ? inbox.outcomes : inbox.active).push(item);
  }
  inbox.active.sort(newestFirst);
  inbox.outcomes.sort(newestFirst);
  return inbox;
}

/** One row of Needs you: a session or run item, or an Initiative outcome. */
export type NeedsYouEntry =
  | { kind: "inbox"; item: SessionInboxItem }
  | { kind: "initiative"; item: InitiativeInboxItem };

export function needsYouEntryId(entry: NeedsYouEntry): string {
  return entry.kind === "inbox"
    ? inboxItemId(entry.item)
    : initiativeItemId(entry.item.initiative.id);
}

function entryPosition(entry: NeedsYouEntry): number {
  return entry.kind === "inbox"
    ? itemPosition(entry.item)
    : entry.item.initiative.createdAt;
}

/**
 * Needs you with the Initiative outcomes in it, ordered as the block always
 * is: highest position first — an Initiative's is its creation time, the
 * position of any item nobody dragged — then by item id.
 */
export function mergeNeedsYou(
  needsYou: readonly SessionInboxItem[],
  outcomes: readonly InitiativeInboxItem[],
): NeedsYouEntry[] {
  const entries: NeedsYouEntry[] = [
    ...needsYou.map((item) => ({ kind: "inbox" as const, item })),
    ...outcomes.map((item) => ({ kind: "initiative" as const, item })),
  ];
  if (outcomes.length === 0) return entries;
  return entries.sort((a, b) => {
    const position = entryPosition(b) - entryPosition(a);
    if (position !== 0) return position;
    const left = needsYouEntryId(a);
    const right = needsYouEntryId(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** "3 sessions", the disclosure's own count over every qualifying session. */
export function initiativeSessionsLabel(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}

/**
 * The card's spoken sentence after its title: state, progress, what can start
 * and what is blocked, the next open milestone, its sessions.
 */
export function initiativeItemSummary(item: InitiativeInboxItem): string {
  const { initiative } = item;
  const { done, total, startable, blocked } = initiative.progress;
  return [
    initiative.state === "active"
      ? "Active"
      : initiative.state === "paused"
        ? "Paused"
        : "Done",
    `${done} of ${total} Tasks done`,
    `${startable} ready to start`,
    `${blocked} blocked`,
    initiative.nextMilestone
      ? `next milestone ${initiative.nextMilestone.title}`
      : "no open milestone",
    initiative.sessionCount > 0
      ? `${initiativeSessionsLabel(initiative.sessionCount)} working on its Tasks`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Everything an item renders, as one string: the memo key of its card and its
 * part of the inbox's layout digest. A field this key omits silently stops
 * updating on the card.
 */
export function initiativeItemKey(
  item: InitiativeInboxItem,
  now: number,
): string {
  const { initiative } = item;
  const { progress } = initiative;
  return [
    initiative.id,
    initiative.title,
    initiative.state,
    `${progress.total}/${progress.done}/${progress.doing}/${progress.startable}/${progress.blocked}`,
    initiative.nextMilestone
      ? `${initiative.nextMilestone.id}:${initiative.nextMilestone.title}`
      : "",
    String(initiative.sessionCount),
    String(item.more),
    String(item.settleRevision ?? ""),
    relativeAge(initiative.updatedAt, now),
    ...item.sessions.map((card) => card.session.id),
    ...(item.additionalSessions ?? []).map((card) => card.session.id),
  ].join("\u0000");
}

/**
 * `memo` comparator for an Initiative card: every prop by identity except the
 * item, rebuilt on every session or Initiative broadcast, and the shared
 * ticker, which matter through {@link initiativeItemKey} alone.
 */
export function sameInitiativeItemProps<
  P extends { item: InitiativeInboxItem; now: number },
>(prev: P, next: P): boolean {
  const keys = Object.keys(prev);
  if (keys.length !== Object.keys(next).length) return false;
  for (const key of keys) {
    if (key === "item" || key === "now") continue;
    if (!Object.is(prev[key as keyof P], next[key as keyof P])) return false;
  }
  return (
    initiativeItemKey(prev.item, prev.now) ===
    initiativeItemKey(next.item, next.now)
  );
}

/** The layout digest of an item with its open disclosure. */
export function initiativeLayoutKey(
  item: InitiativeInboxItem,
  expanded: boolean,
  now: number,
  showMore = false,
): string {
  const rows = showMore ? [...item.sessions, ...(item.additionalSessions ?? [])] : item.sessions;
  return [
    initiativeItemKey(item, now),
    ...(expanded ? rows.map((card) => sessionCardKey(card, now)) : []),
  ].join("\u0000");
}
