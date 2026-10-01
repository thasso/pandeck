/**
 * Pure shaping for background work ([Task-486](pa://task/486)): the registry
 * route's filtering/paging, the row labels both it and the session inspector
 * render, the session card's chip, and the content keys those memoized rows
 * hold on.
 *
 * The browser owns NO lifecycle state here. Every function is a deterministic
 * read of `BackgroundWorkItemSummary` (the server's one narrowing) plus an
 * explicit `now`, so a row can never claim an item is finished before an event
 * says so — the only local state a surface may add is the pending flag on a
 * Stop control it just pressed.
 */
import type {
  BackgroundWorkItemSummary,
  BackgroundWorkState,
  SessionBackgroundActivity,
  SessionListItem,
} from "@assistant/shared";
import { elapsedLabel } from "./relativeTime.ts";

/** Nonterminal states: reserved-but-not-executing, and executing. */
const ACTIVE_STATES: ReadonlySet<BackgroundWorkState> = new Set([
  "pending-launch",
  "running",
]);

export function isActiveBackgroundWork(
  item: BackgroundWorkItemSummary,
): boolean {
  return ACTIVE_STATES.has(item.state);
}

/** The registry's two lists, plus "everything" for a deliberate wider read. */
export type BackgroundWorkFilter = "active" | "recent" | "all";

/** How many rows one page of the registry shows before "Show more". */
export const BACKGROUND_WORK_PAGE_SIZE = 25;

/**
 * How many rows the session inspector shows per group. The inspector is a
 * summary of ONE session's work with the registry a click away, so it is bounded
 * far tighter than the page — a section that can grow without limit is what
 * turns an inspector into a second registry.
 */
export const BACKGROUND_WORK_INSPECTOR_LIMIT = 5;

/**
 * Order: active first, then newest. Within each group the ordering key is the
 * item's own last movement (`updatedAt`), so a row that just changed state
 * surfaces rather than staying wherever its creation put it. The id breaks ties
 * so the list is stable under a rebroadcast.
 */
function compareBackgroundWork(
  a: BackgroundWorkItemSummary,
  b: BackgroundWorkItemSummary,
): number {
  const active =
    Number(isActiveBackgroundWork(b)) - Number(isActiveBackgroundWork(a));
  if (active !== 0) return active;
  const moved = b.updatedAt - a.updatedAt;
  if (moved !== 0) return moved;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BackgroundWorkQuery {
  filter?: BackgroundWorkFilter;
  /** Free text over the bounded label and the owning session's title. */
  query?: string;
  /** Only this session's work; the inspector and an owner link both use it. */
  ownerSessionId?: string;
  /** How many rows to return; the caller pages by raising it. */
  limit?: number;
  /** Owner titles, so the free-text query can match the session a row belongs to. */
  ownerTitles?: ReadonlyMap<string, string>;
  /**
   * One row that must survive the page cutoff — the item a deep link addressed.
   * A link is a promise that the thing it names is ON the page it opens, and
   * paging it out is worse than not scrolling to it: the row is not there at
   * all, so nothing tells the reader the link worked. Same guarantee, and the
   * same reason, as the routed settled session in `sessionInbox.ts`.
   */
  pinnedId?: string | undefined;
}

export interface BackgroundWorkListView {
  rows: BackgroundWorkItemSummary[];
  /** True when `pinnedId` matched a row the cutoff would otherwise have hidden. */
  pinnedOutOfPage: boolean;
  /** Matches beyond `limit`; the page reveals them rather than dropping them. */
  hidden: number;
  /** Every match before paging — what the surface counts, never `rows.length`. */
  total: number;
  /** Nonterminal matches, so a page can say what is still running. */
  activeTotal: number;
}

/**
 * Filter, search, sort and PAGE in one place. Paging is a cutoff over the
 * complete match set rather than a windowed traversal: a running item can never
 * fall off the end because a page boundary moved under it, which is the failure
 * a cursor over a live list has.
 */
export function backgroundWorkListView(
  items: readonly BackgroundWorkItemSummary[],
  {
    filter = "active",
    query = "",
    ownerSessionId,
    limit = BACKGROUND_WORK_PAGE_SIZE,
    ownerTitles,
    pinnedId,
  }: BackgroundWorkQuery = {},
): BackgroundWorkListView {
  const needle = query.trim().toLowerCase();
  const matches = items.filter((item) => {
    if (ownerSessionId && item.ownerSessionId !== ownerSessionId) return false;
    const active = isActiveBackgroundWork(item);
    if (filter === "active" && !active) return false;
    if (filter === "recent" && active) return false;
    if (!needle) return true;
    const title = ownerTitles?.get(item.ownerSessionId) ?? "";
    return (
      item.label.toLowerCase().includes(needle) ||
      (item.description ?? "").toLowerCase().includes(needle) ||
      (item.command ?? "").toLowerCase().includes(needle) ||
      title.toLowerCase().includes(needle)
    );
  });
  matches.sort(compareBackgroundWork);
  const cutoff = Math.max(0, limit);
  const rows = matches.slice(0, cutoff);
  // The pinned row is APPENDED rather than sorted in: it is out of order by
  // definition (the cutoff already passed it), and moving it to the top would
  // displace the rows above it. The sorted PREFIX is therefore never disturbed
  // — the exception is exactly one trailing row. Pressing "Show more" does move
  // the pin down, because rows that sort ahead of it become visible and are
  // inserted in order; that is the reader asking for them, not a rebroadcast
  // reordering the list under them.
  const pinned =
    pinnedId && !rows.some((item) => item.id === pinnedId)
      ? matches.find((item) => item.id === pinnedId)
      : undefined;
  if (pinned) rows.push(pinned);
  return {
    rows,
    pinnedOutOfPage: Boolean(pinned),
    // The pinned row is shown, so it is no longer hidden — otherwise "show N
    // more" offers a row that is already on screen.
    hidden: Math.max(0, matches.length - cutoff - (pinned ? 1 : 0)),
    total: matches.length,
    activeTotal: matches.filter(isActiveBackgroundWork).length,
  };
}

/** Semantic colour of a row's state marker; the renderer maps it to tokens. */
export type BackgroundWorkTone =
  "accent" | "warning" | "danger" | "muted" | "success";

export interface BackgroundWorkStateBadge {
  label: string;
  tone: BackgroundWorkTone;
}

/**
 * The row's state as one scannable badge.
 *
 * A Stop that has been REQUESTED but not answered never reads as terminal: the
 * item is still running, and saying otherwise is exactly the lie the supervisor
 * refuses to tell in its own row (`stopState` stays set on a nonterminal item).
 * `Stop unconfirmed` is a warning rather than a success for the same reason.
 */
export function backgroundWorkStateBadge(
  item: BackgroundWorkItemSummary,
): BackgroundWorkStateBadge {
  if (isActiveBackgroundWork(item)) {
    if (item.stopState === "unconfirmed")
      return { label: "Stop unconfirmed", tone: "warning" };
    if (item.stopState !== "none")
      return { label: "Stopping", tone: "warning" };
    return item.state === "pending-launch"
      ? { label: "Starting", tone: "muted" }
      : { label: "Running", tone: "accent" };
  }
  switch (item.state) {
    case "completed":
      return { label: "Completed", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "stopped":
      return { label: "Stopped", tone: "muted" };
    case "not-started":
      return { label: "Never started", tone: "muted" };
    case "lost":
      return { label: "Lost", tone: "danger" };
    default:
      return { label: item.state, tone: "muted" };
  }
}

/**
 * The command a row shows UNDER its title, or nothing when the title already
 * is the whole command. The title is the agent's description when it gave one,
 * else the command's first line: a one-line command with no description would
 * print itself twice, so the detail exists only when it adds something — a
 * description above it, further lines, or a cut at the cap.
 */
export function backgroundWorkCommandDetail(
  item: Pick<
    BackgroundWorkItemSummary,
    "label" | "description" | "command" | "commandTruncated"
  >,
): string | undefined {
  const command = item.command?.trim();
  if (!command) return undefined;
  if (item.description || item.commandTruncated) return command;
  const firstLine = command
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  return firstLine === item.label && !command.includes("\n")
    ? undefined
    : command;
}

/** What may follow a repeated title before the outcome itself begins. */
const OUTCOME_TITLE_DELIMITER = /^[\s.:;,·–—-]/;

/**
 * The outcome sentence a card shows under its title, or nothing when the title
 * already said it. The server's summary for Claude-query work opens with the
 * job's own description — verbatim, it would repeat the line directly above it,
 * and a summary that is ONLY the description says nothing about the outcome at
 * all, so it is dropped rather than shown twice.
 */
export function backgroundWorkOutcomeDetail(item: {
  label: string;
  /**
   * The delivered status, when the caller has it. Only a `completed` update may
   * lose its clean-exit sentence: that inference holds for a PA-supervised
   * process, whose state IS its exit code, and nowhere else. A Claude task
   * reports a provider status instead, so a failed one keeps every word it has.
   */
  status?: string | undefined;
  outcomeSummary?: string | undefined;
}): string | undefined {
  const summary = item.outcomeSummary?.trim();
  if (!summary) return undefined;
  // A clean exit is what the success mark already says. The exact sentence
  // only, so the variant that goes on to report dropped output still speaks.
  if (
    (item.status === undefined || item.status === "completed") &&
    /^exited with code 0\.?$/i.test(summary)
  )
    return undefined;
  const label = item.label.trim();
  if (!label || !summary.toLowerCase().startsWith(label.toLowerCase()))
    return summary;
  const rest = summary.slice(label.length);
  // A LEXICAL prefix is not a repeated title: label "Test" must not turn the
  // summary "Tests failed" into "s failed".
  if (rest.length > 0 && !OUTCOME_TITLE_DELIMITER.test(rest)) return summary;
  const outcome = rest.replace(/^[\s.:;,·–—-]+/, "");
  return outcome.length > 0 ? outcome : undefined;
}

/** What kind of work this is, in words. The backend is stated separately. */
export function backgroundWorkKindLabel(
  item: BackgroundWorkItemSummary,
): string {
  switch (item.kind) {
    case "shell":
      return "Shell";
    case "monitor-command":
      return "Command monitor";
    case "monitor-websocket":
      return "WebSocket monitor";
  }
}

/**
 * Which runtime supervises it, as a CAPABILITY rather than a vendor id: a
 * Claude item runs inside the retained query that issued it, a host-process item
 * is supervised by PA itself.
 */
export function backgroundWorkBackendLabel(
  item: BackgroundWorkItemSummary,
): string {
  return item.backend === "claude-query" ? "Claude query" : "PA process";
}

/** How long this item has been alive, or how long it ran before it ended. */
export function backgroundWorkAgeLabel(
  item: BackgroundWorkItemSummary,
  now: number,
): string {
  const start = item.startedAt ?? item.createdAt;
  return elapsedLabel((item.terminalAt ?? now) - start);
}

/**
 * The FROZEN deadline as remaining wall clock. It was fixed at admission from
 * the settings generation on the row and is never re-read, so a later Settings
 * edit does not move it — the label says "overdue" rather than pretending a
 * passed deadline already terminalized the item, which only the supervisor can
 * do.
 */
export function backgroundWorkDeadlineLabel(
  item: BackgroundWorkItemSummary,
  now: number,
): string {
  if (item.terminalAt !== undefined) return "—";
  const remaining = item.deadlineAt - now;
  return remaining <= 0
    ? `overdue by ${elapsedLabel(-remaining)}`
    : `${elapsedLabel(remaining)} left`;
}

/**
 * The retained Claude host epoch beside an item, when it has one. `Closing`
 * is a Stop-all the supervisor recorded but has not completed — a wait, not a
 * finished close.
 */
export function backgroundWorkHostLabel(
  item: BackgroundWorkItemSummary,
): string | undefined {
  const host = item.host;
  if (!host) return undefined;
  if (host.stopAllRequestedAt !== undefined && host.state !== "closed")
    return "Retained host: closing";
  switch (host.state) {
    case "creating":
      return "Retained host: starting";
    case "live":
      return "Retained host: live";
    case "draining":
      return "Retained host: draining";
    case "closed":
      return "Retained host: closed";
    case "stopped":
      return "Retained host: stopped";
    case "lost":
      return "Retained host: lost";
  }
}

/**
 * What is durably known about an item's outcome, as a short fact list. Bounded
 * METADATA only: an artifact id is never rendered, output bodies and host paths
 * never reach the wire, and a declined capture states its bounded reason with
 * no content at all.
 */
export function backgroundWorkEvidenceFacts(
  item: BackgroundWorkItemSummary,
): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  if (item.exitCode !== undefined)
    facts.push({ label: "Exit code", value: String(item.exitCode) });
  if (item.terminalReason)
    facts.push({ label: "Reason", value: item.terminalReason });
  if (item.stopReason && item.stopState !== "none")
    facts.push({ label: "Stop reason", value: item.stopReason });
  if (item.stopAttempts)
    facts.push({ label: "Stop attempts", value: String(item.stopAttempts) });
  if (item.outcomeSummary)
    facts.push({ label: "Outcome", value: item.outcomeSummary });
  const evidence = item.evidence;
  if (evidence?.refusalReason)
    facts.push({ label: "Output not captured", value: evidence.refusalReason });
  else if (evidence?.capturedBytes !== undefined)
    facts.push({
      label: "Output captured",
      value:
        evidence.truncated && evidence.originalBytes !== undefined
          ? `${formatBytes(evidence.capturedBytes)} of ${formatBytes(evidence.originalBytes)} (truncated)`
          : formatBytes(evidence.capturedBytes),
    });
  return facts;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The session card's chip, e.g. `Background 2 · 8m`.
 *
 * Deliberately its OWN label, separate from the card's provider status: a
 * session with background work is not streaming, so nothing here may be read as
 * a turn. A retained host with no children left still shows, because the epoch
 * outlives its last item by design and letting it go silent would hide a live
 * provider query.
 */
export function backgroundActivityChip(
  activity: SessionBackgroundActivity | undefined,
  now: number,
): string | undefined {
  if (!activity) return undefined;
  if (activity.activeCount <= 0)
    return activity.retainedHost ? "Background host" : undefined;
  const age =
    activity.oldestStartedAt > 0
      ? ` · ${elapsedLabel(now - activity.oldestStartedAt)}`
      : "";
  return `Background ${activity.activeCount}${age}`;
}

/** The chip's assistive-technology sentence; the visual label is an abbreviation. */
export function backgroundActivityText(
  activity: SessionBackgroundActivity | undefined,
): string | undefined {
  if (!activity) return undefined;
  if (activity.activeCount <= 0)
    return activity.retainedHost
      ? "Holds a retained background host"
      : undefined;
  const parts = [
    activity.activeCount === 1
      ? "1 background process running"
      : `${activity.activeCount} background processes running`,
  ];
  if (activity.startingCount > 0)
    parts.push(`${activity.startingCount} starting`);
  if (activity.stoppingCount > 0)
    parts.push(`${activity.stoppingCount} stopping`);
  return parts.join(", ");
}

/**
 * The chip's content key. Same contract (and the same silent failure) as
 * `sessionInbox.ts`: a memoized card that reads a field this key omits stops
 * updating, and the session list is rebroadcast several times a second.
 */
export function backgroundActivityKey(
  activity: SessionBackgroundActivity | undefined,
  now: number,
): string {
  if (!activity) return "";
  return [
    backgroundActivityChip(activity, now) ?? "",
    backgroundActivityText(activity) ?? "",
  ].join("\u0000");
}

/**
 * How much background work is running across every session, from the SESSION
 * summaries — no registry subscription, so ongoing work stays visible on
 * surfaces that never open the registry. A retained host with no items left
 * counts as an owner, not as an item.
 */
export function globalBackgroundActivity(
  sessions: readonly SessionListItem[],
): { activeCount: number; ownerCount: number } {
  let activeCount = 0;
  let ownerCount = 0;
  for (const session of sessions) {
    const activity = session.backgroundActivity;
    if (!activity) continue;
    if (activity.activeCount > 0 || activity.retainedHost) ownerCount += 1;
    activeCount += Math.max(0, activity.activeCount);
  }
  return { activeCount, ownerCount };
}

/**
 * Content key for one registry/inspector row: everything the row renders and
 * nothing else, including the RENDERED age and deadline labels rather than the
 * raw timestamps, so a tick that changes no character does not re-render.
 *
 * The separator is NUL, like `sessionInbox.ts`: this key folds in free text
 * (the bounded label, a terminal reason, an outcome summary), and a separator
 * that text could forge would let two different rows share one key — which
 * fails the silent way, by freezing a row rather than breaking anything. It is
 * written as the `\u0000` ESCAPE, never as a raw control byte.
 */
export function backgroundWorkRowKey(
  item: BackgroundWorkItemSummary,
  now: number,
): string {
  const badge = backgroundWorkStateBadge(item);
  return [
    item.id,
    item.label,
    item.description ?? "",
    item.command ?? "",
    item.commandTruncated ? "1" : "",
    item.ownerSessionId,
    backgroundWorkKindLabel(item),
    backgroundWorkBackendLabel(item),
    `${badge.tone}:${badge.label}`,
    backgroundWorkAgeLabel(item, now),
    backgroundWorkDeadlineLabel(item, now),
    backgroundWorkHostLabel(item) ?? "",
    item.providerBound ? "1" : "",
    backgroundWorkEvidenceFacts(item)
      .map((fact) => `${fact.label}\u0000${fact.value}`)
      .join("\u0000"),
  ].join("\u0000");
}

/** The one wording for a Stop control's disabled state. */
export function backgroundWorkStopDisabledReason(
  item: BackgroundWorkItemSummary,
): string | undefined {
  if (!isActiveBackgroundWork(item)) return "This work has already finished.";
  return undefined;
}
