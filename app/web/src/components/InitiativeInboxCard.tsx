import { memo } from "react";
import {
  Ban,
  Check,
  ChevronRight,
  CirclePause,
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
import type { RowDensity } from "../lib/rowDensity.ts";
import { ListRow } from "./common/ListRow.tsx";
import { ListExpansionRow } from "./common/ListExpansionRow.tsx";
import { ListRowActions } from "./common/ListRowActions.tsx";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

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
   * Acknowledge the Initiative's activity. `throughRevision` is
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
 * @useWhen The Sessions inbox is rendering an Initiative with unsettled activity.
 * @avoidWhen Reading or steering the Initiative itself; that is its page
 * (`/initiatives/:id`), which this card opens. Agents manage Initiatives, so
 * the card offers no edit.
 * @intent An Initiative is the long view over many sessions, so the card says
 * where the whole stands in the session card's three rows, and Settle is its
 * one verb, offered in every state while activity is unacknowledged. Its sessions are listed
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
  const settleLabel = `Settle activity for “${initiative.title}”`;

  return (
    <ListRow
      interaction="content"
      divider={false}
      density={density}
      data-session-row
      data-list-row-id={`initiative:${initiative.id}`}
      role="group"
      tabIndex={-1}
      aria-label={`Open Initiative ${initiative.title} — ${initiativeItemSummary(item)}`}
      onOpen={open}
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
      context={
        <>
          <span className="flex shrink-0 items-center gap-1">
            <Waypoints size={12} aria-hidden />
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
        </>
      }
      age={relativeAge(initiative.updatedAt, now)}
      identity={
        <>
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
            {initiative.title}
          </span>
        </>
      }
      signals={
        <>
            {initiative.sessionCount > 0 ? (
              <Badge
                variant="ghost"
                render={<button type="button" />}
                className="cursor-pointer gap-1 rounded-none border-0 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} the ${initiativeSessionsLabel(
                  initiative.sessionCount,
                )} working on its Tasks`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSessions(initiative.id);
                }}
              >
                <ChevronRight
                  aria-hidden
                  className={expanded ? "rotate-90" : ""}
                />
                <Users aria-hidden />
                <span>{initiativeSessionsLabel(initiative.sessionCount)}</span>
              </Badge>
            ) : null}
            {progress.startable > 0 ? (
              <span className="shrink-0 font-medium text-primary tabular-nums">
                {progress.startable} ready
              </span>
            ) : null}
            {progress.blocked > 0 ? (
              <span className="flex shrink-0 items-center gap-0.5 text-warning tabular-nums">
                <Ban size={12} aria-hidden />
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
                <Flag size={12} className="shrink-0" aria-hidden />
                <span className="min-w-0 truncate">
                  {initiative.nextMilestone.title}
                </span>
              </span>
            ) : null}
        </>
      }
      actions={settle ? (
        <ListRowActions actions={[
          {
            id: "settle",
            label: "Settle",
            accessibleLabel: settleLabel,
            icon: <Check />,
            onSelect: settle,
          },
        ]} />
      ) : undefined}
    />
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

/** Reveal the remaining known sessions inline, without leaving Attention. */
export const InitiativeMoreRow = memo(function InitiativeMoreRow({
  initiativeId,
  title,
  more,
  density = "tight",
  onShowMore,
  onFocusSibling,
}: {
  initiativeId: string;
  title: string;
  more: number;
  density?: RowDensity;
  onShowMore: (initiativeId: string) => void;
  onFocusSibling?: (delta: 1 | -1) => void;
}) {
  return (
    <ListExpansionRow
      density={density}
      rowId={`initiative:${initiativeId}:more`}
      label={`Show ${more} more`}
      accessibleLabel={`Show ${more} more sessions for Initiative ${title}`}
      expanded={false}
      onToggle={() => onShowMore(initiativeId)}
      onFocusSibling={onFocusSibling}
    />
  );
});
