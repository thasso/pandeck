import { memo } from "react";
import {
  Ban,
  Check,
  ChevronRight,
  CirclePause,
  ArrowRight,
  Flag,
  Users,
  Waypoints,
} from "lucide-react";
import {
  initiativeItemSummary,
  initiativeSessionsLabel,
  sameInitiativeItemProps,
  type InitiativeInboxItem,
} from "../lib/initiativeInbox.ts";
import { relativeAge } from "../lib/relativeTime.ts";
import { CARD_OUTER_ROW, type RowDensity } from "../lib/rowDensity.ts";
import { useInertOverflow } from "../hooks/useInertOverflow.ts";
import { IconButton } from "./common/IconButton.tsx";
import { Markdown } from "./Markdown.tsx";
import { Button } from "@/components/ui/button";
import { Item } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";

/** Settle, inline at the end of the signal row like a session card's. */
const INLINE_ACTION_SIZE: Record<RowDensity, "icon-xs" | "icon-sm"> = {
  tight: "icon-xs",
  comfortable: "icon-sm",
};

export interface InitiativeInboxCardProps {
  item: InitiativeInboxItem;
  /** Shared ticker value; the card never owns a timer of its own. */
  now: number;
  /** The host's row density: thumb-sized controls on a phone screen. */
  density?: RowDensity;
  /** Whether the user has opened the list of sessions working on its Tasks. */
  expanded?: boolean;
  /** Open the Initiative's page, where the map is. */
  onOpen: (initiativeId: string) => void;
  /**
   * Acknowledge a paused or done Initiative's outcome. `throughRevision` is
   * the revision THIS card rendered, captured at the click: a newer outcome
   * landing before the command leaves stays awake.
   */
  onSettle: (initiativeId: string, throughRevision: number) => void;
  /** Show or hide the session rows under the card. */
  onToggleSessions: (initiativeId: string) => void;
  /** Move keyboard focus to the previous/next row in the browser. */
  onFocusSibling?: (delta: 1 | -1) => void;
}

/**
 * @component InitiativeInboxCard
 * @purpose The Sessions inbox's card for ONE Initiative: its title and state,
 * how far it has come, what can start now and what is blocked, the next open
 * milestone, and the sessions working on its Tasks.
 * @useWhen The Sessions inbox is rendering an active Initiative, or a paused or
 * done one whose outcome the user has not settled.
 * @avoidWhen Reading or steering the Initiative itself; that is its page
 * (`/initiatives/:id`), which this card opens. Agents manage Initiatives, so
 * the card offers no edit.
 * @intent An Initiative is the long view over many sessions, so the card says
 * where the whole stands in the session card's three rows, and Settle is its
 * one verb — offered only while a paused or done outcome is unacknowledged,
 * never on an active one, which is work in progress. Its sessions are listed
 * on request but keep their own cards: a Task may belong to several
 * Initiatives, so no Initiative owns a session.
 * @related SessionInbox, WorkflowRunInboxCard, ClusterChildRow,
 * initiativeInbox (lib)
 */
function InitiativeInboxCardImpl({
  item,
  now,
  density = "tight",
  expanded = false,
  onOpen,
  onSettle,
  onToggleSessions,
  onFocusSibling,
}: InitiativeInboxCardProps) {
  const { initiative, settleRevision } = item;
  const { progress } = initiative;
  const signalRowRef = useInertOverflow<HTMLDivElement>();
  const open = () => onOpen(initiative.id);
  const settle =
    settleRevision === undefined
      ? undefined
      : () => onSettle(initiative.id, settleRevision);
  const stateLabel =
    initiative.state === "paused"
      ? "Paused"
      : initiative.state === "done"
        ? "Done"
        : undefined;
  const settleLabel = `Settle — acknowledge that “${initiative.title}” is ${
    initiative.state === "done" ? "done" : "paused"
  }`;

  return (
    <div
      data-session-row
      data-list-row-id={`initiative:${initiative.id}`}
      role="button"
      tabIndex={-1}
      aria-label={`Open Initiative ${initiative.title} — ${initiativeItemSummary(item)}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          onFocusSibling?.(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key.toLowerCase() === "s" && settle) {
          e.preventDefault();
          settle();
        }
      }}
      className="group flex w-full cursor-pointer select-none overflow-hidden text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
    >
      {/* The session card's three rows: what it is with the time, the title
          led by its state, then its signals with Settle at the right edge. */}
      <div
        className={`flex min-w-0 flex-1 flex-col justify-center gap-0.5 pl-2 pr-1 ${density === "comfortable" ? "py-2.5" : "py-2"}`}
      >
        <div
          className={`flex ${CARD_OUTER_ROW[density].row} min-w-0 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground`}
        >
          <span className="flex shrink-0 items-center gap-1">
            <Waypoints size={11} aria-hidden />
            Initiative
          </span>
          {/* Progress is the Initiative's own measure, so it leads the
              context row the way a session's Project does. */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <Progress
              value={
                progress.total === 0
                  ? 0
                  : (progress.done / progress.total) * 100
              }
              aria-hidden
              className="w-10 shrink-0"
            />
            <span className="shrink-0 tabular-nums">
              {progress.done}/{progress.total}
            </span>
          </span>
          <span className="shrink-0 tabular-nums">
            {relativeAge(initiative.updatedAt, now)}
          </span>
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex size-4 shrink-0 items-center justify-center">
            {stateLabel ? (
              <span
                role="img"
                aria-label={stateLabel}
                title={stateLabel}
                className={`flex size-4 shrink-0 items-center justify-center ${
                  initiative.state === "done"
                    ? "text-success"
                    : "text-muted-foreground"
                }`}
              >
                {initiative.state === "done" ? (
                  <Check size={13} aria-hidden />
                ) : (
                  <CirclePause size={13} aria-hidden />
                )}
              </span>
            ) : (
              <Waypoints size={13} className="text-primary" aria-hidden />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            <Markdown text={initiative.title} inline />
          </span>
        </div>

        <div
          className={`flex ${CARD_OUTER_ROW[density].min} min-w-0 items-center gap-1.5 text-xs`}
        >
          {/* Signals show whole or not at all, in drop order: the sessions,
              what can start, what is blocked, then the milestone. Everything
              dropped is still in the card's spoken label. */}
          <div
            ref={signalRowRef}
            className="session-card-status-line flex h-5 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-4 overflow-hidden"
          >
            {initiative.sessionCount > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                className="-mx-1"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} the ${initiativeSessionsLabel(
                  initiative.sessionCount,
                )} working on its Tasks`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSessions(initiative.id);
                }}
              >
                <Users aria-hidden />
                <span>{initiativeSessionsLabel(initiative.sessionCount)}</span>
                <ChevronRight
                  aria-hidden
                  className={expanded ? "rotate-90" : ""}
                />
              </Button>
            ) : null}
            {progress.startable > 0 ? (
              <span className="shrink-0 font-medium text-primary tabular-nums">
                {progress.startable} ready
              </span>
            ) : null}
            {progress.blocked > 0 ? (
              <span className="flex shrink-0 items-center gap-0.5 text-warning tabular-nums">
                <Ban size={11} aria-hidden />
                {progress.blocked} blocked
              </span>
            ) : null}
            {initiative.nextMilestone ? (
              // Shortens into the width the others leave, but never below a
              // readable stub: under that it drops to the hidden line whole.
              <span
                className="flex min-w-16 flex-1 basis-16 items-center gap-1 text-muted-foreground"
                title={`Next milestone: ${initiative.nextMilestone.title}`}
              >
                <Flag size={11} className="shrink-0" aria-hidden />
                <span className="min-w-0 truncate">
                  <Markdown text={initiative.nextMilestone.title} inline />
                </span>
              </span>
            ) : null}
          </div>
          {settle ? (
            <IconButton
              size={INLINE_ACTION_SIZE[density]}
              className="-my-0.5"
              label={settleLabel}
              title={settleLabel}
              onClick={(e) => {
                e.stopPropagation();
                settle();
              }}
            >
              <Check />
            </IconButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoized on CONTENT: the item is rebuilt on every session and every
 * Initiative broadcast, and the session list moves several times a second
 * while agents run.
 */
export const InitiativeInboxCard = memo(
  InitiativeInboxCardImpl,
  sameInitiativeItemProps,
);

/**
 * @component InitiativeMoreRow
 * @purpose The last row of an open Initiative disclosure: how many of the
 * sessions working on its Tasks the rows above do not list, as ONE row that
 * opens the Initiative's page, where all of its work is.
 * @useWhen An open disclosure lists fewer sessions than the summary counts —
 * past the five-row display bound, past the summary's 50 ids, or not held by
 * this browser.
 * @intent The disclosure is bounded so an open card never pushes the inbox off
 * screen; the count stays truthful, and the rest is one step away rather than
 * an ever longer list. It is a row of the list like the session rows above it:
 * reached by the arrow keys, opened by Enter or a click, and it opens the
 * Initiative alone — never a session, never the fold.
 * @related InitiativeInboxCard, ClusterChildRow, SessionInbox
 */
export const InitiativeMoreRow = memo(function InitiativeMoreRow({
  initiativeId,
  title,
  more,
  density = "tight",
  onOpen,
  onFocusSibling,
}: {
  initiativeId: string;
  /** The Initiative's title, for the row's spoken label. */
  title: string;
  /** The sessions not listed above; the row renders only when positive. */
  more: number;
  density?: RowDensity;
  onOpen: (initiativeId: string) => void;
  onFocusSibling?: (delta: 1 | -1) => void;
}) {
  return (
    <Item
      size="xs"
      render={<button type="button" />}
      data-session-row
      data-list-row-id={`initiative:${initiativeId}:more`}
      tabIndex={-1}
      aria-label={`Open Initiative ${title} for the ${initiativeSessionsLabel(more)} not listed here`}
      onClick={() => onOpen(initiativeId)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(initiativeId);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          onFocusSibling?.(e.key === "ArrowDown" ? 1 : -1);
        }
      }}
      style={{ paddingLeft: "0.75rem" }}
      className={`cursor-pointer select-none flex-nowrap gap-1.5 rounded-none border-0 border-t border-border/60 py-0 pr-2.5 text-left text-xs text-muted-foreground hover:bg-muted dark:hover:bg-muted/50 ${density === "comfortable" ? "h-10" : "h-7"}`}
    >
      <span className="min-w-0 flex-1 truncate">and {more} more</span>
      <ArrowRight className="size-3 shrink-0" aria-hidden />
    </Item>
  );
});
