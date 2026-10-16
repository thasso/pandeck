/**
 * Initiatives as Sessions inbox items (`docs/initiatives.md`, The attention
 * list; `app/web/docs/ui-shell.md`).
 *
 * An ACTIVE Initiative is always an item, with nothing to settle: it is
 * ongoing work, not an outcome. A paused or done one stays an item while its
 * attention cursor holds a revision the user has not settled, and Settle
 * acknowledges exactly that rendered revision. Everything here reads the
 * `initiatives` topic summary alone, so an item never asks for the graph.
 *
 * The sessions an item discloses are the summary's own — started from a
 * member Task, live, at most 50 — resolved against the rows this browser
 * already holds. They are LISTED, never folded: each keeps its own card,
 * because a Task can belong to several Initiatives and no card owns a session.
 *
 * Framework-free by the `lib/` contract.
 */
import type { InitiativeSummary, SessionListItem } from "@assistant/shared";
import { relativeAge } from "./relativeTime.ts";
import {
  inboxCard,
  sessionCardKey,
  type SessionInboxCard,
} from "./sessionInbox.ts";

export interface InitiativeInboxItem {
  initiative: InitiativeSummary;
  /**
   * The attention revision Settle acknowledges, present exactly while Settle
   * is offered: the Initiative is paused or done and that revision is not
   * settled. Captured into the click, never re-read when the command leaves.
   */
  settleRevision?: number;
  /** The summary's sessions this browser holds, newest created first. */
  sessions: SessionInboxCard[];
  /**
   * Qualifying sessions the disclosure does not list: past the summary's page
   * of 50, or not among this browser's session rows. Stated as "and N more",
   * so the listed rows are never presented as all of them.
   */
  more: number;
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

/** Newest Initiative first: ids come from one sequence, so id is creation. */
function newestFirst(a: InitiativeSummary, b: InitiativeSummary): number {
  return Number(b.id) - Number(a.id) || (a.id < b.id ? 1 : -1);
}

/**
 * The Initiative items, newest first. The order is creation alone, so a
 * state change never moves an item: the cards hold still.
 */
export function buildInitiativeInbox(
  initiatives: readonly InitiativeSummary[],
  sessions: readonly SessionListItem[],
  readCurrentId?: string,
): InitiativeInboxItem[] {
  const items = initiatives.filter(initiativeInInbox);
  if (items.length === 0) return [];
  const byId = new Map(
    sessions
      .filter((session) => !session.archived)
      .map((session) => [session.id, session]),
  );
  return [...items].sort(newestFirst).map((initiative) => {
    const rows: SessionInboxCard[] = [];
    for (const id of initiative.sessionIds) {
      const session = byId.get(id);
      if (session) rows.push(inboxCard(session, readCurrentId));
    }
    const settleRevision = initiativeSettleRevision(initiative);
    return {
      initiative,
      ...(settleRevision !== undefined ? { settleRevision } : {}),
      sessions: rows,
      more: Math.max(0, initiative.sessionCount - rows.length),
    };
  });
}

/** The item's identity for React keys, layout measurement and focus. */
export function initiativeItemId(initiativeId: string): string {
  return `initiative:${initiativeId}`;
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
): string {
  return [
    initiativeItemKey(item, now),
    ...(expanded ? item.sessions.map((card) => sessionCardKey(card, now)) : []),
  ].join("\u0000");
}
