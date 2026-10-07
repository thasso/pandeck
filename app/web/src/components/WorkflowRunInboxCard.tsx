import { memo } from "react";
import {
  Ban,
  Check,
  ChevronRight,
  CirclePause,
  ClipboardList,
  FolderKanban,
  GitBranch,
  GitMerge,
  GitPullRequestArrow,
  Hourglass,
  Split,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  sameWorkflowRunItemProps,
  sessionClusterBubbleLabel,
  sessionStatusBadge,
  workflowRunBadge,
  WORKFLOW_PHASE_LABEL,
  workflowRunPullRequestSession,
  workflowRunRolesSummary,
  workflowRunSettleOffered,
  workflowRunStatusText,
  workflowRunTitle,
  type SessionStatusTone,
  type WorkflowRunBadgeKind,
  type WorkflowRunInboxItem,
} from "../lib/sessionInbox.ts";
import { relativeAge } from "../lib/relativeTime.ts";
import { CARD_OUTER_ROW, type RowDensity } from "../lib/rowDensity.ts";
import { useInertOverflow } from "../hooks/useInertOverflow.ts";
import { sessionDelivery } from "../lib/sessionDelivery.ts";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { SessionStatusIcon } from "./SessionStatusBadge.tsx";
import { Spinner } from "./common/load.tsx";

/** The same semantic tones the session cards use, at the same weight. */
const BADGE_TONE: Record<SessionStatusTone, string> = {
  accent: "bg-accent text-primary",
  warning: "bg-warning-soft text-warning",
  danger: "bg-destructive/10 text-destructive",
  success: "bg-success-soft text-success",
  muted: "bg-border text-muted-foreground",
};

/** Every run state has a glyph, so its badge survives the icon-only rail. */
const RUN_BADGE_ICON: Record<
  Exclude<WorkflowRunBadgeKind, "working">,
  LucideIcon
> = {
  merged: GitMerge,
  completed: Check,
  cancelled: Ban,
  cancelling: Ban,
  decide: Split,
  "merge-decision": GitPullRequestArrow,
  paused: CirclePause,
  active: Hourglass,
};

function RunBadgeIcon({
  kind,
  size = 12,
}: {
  kind: WorkflowRunBadgeKind;
  size?: number;
}) {
  if (kind === "working") return <Spinner size="xs" className="shrink-0" />;
  const Icon = RUN_BADGE_ICON[kind];
  return <Icon size={size} className="shrink-0" aria-hidden />;
}

/** Settle, inline at the end of the status row like a session card's. */
const INLINE_ACTION =
  "flex shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground";
const INLINE_ACTION_SIZE: Record<RowDensity, string> = {
  tight: "size-6 -my-0.5",
  comfortable: "size-8 -my-0.5",
};

export interface WorkflowRunInboxCardProps {
  item: WorkflowRunInboxItem;
  /** Shared ticker value; the card never owns a timer of its own. */
  now: number;
  /** The host's row density: a thumb-sized Settle on a phone screen. */
  density?: RowDensity;
  /**
   * Whether the user has OPENED this run's session list. Same contract as the
   * cluster card's disclosure: it says what the click does, and a search
   * decides on its own which rows are visible under it.
   */
  expanded?: boolean;
  /**
   * Open the run where it can be acted on: its Workflow card, on its Task. Both
   * ids travel, because a run item that opened the Task alone would land the
   * user in a list of runs to find this one in again.
   */
  onOpen: (taskId: string, runId: string) => void;
  /** Open one of the run's own sessions directly. */
  onOpenSession: (sessionId: string) => void;
  /**
   * Acknowledge the run's latest event and put it — and the role sessions it
   * owns — out of the working set. Offered only while the run carries an
   * unacknowledged event; disabled, with the reason, while the run waits on a
   * user decision. `throughRevision` is the revision THIS card rendered,
   * captured at the click: the command is sent after an exit animation, and a
   * newer event landing in that window must stay awake rather than be
   * acknowledged by a click that never saw it.
   */
  onSettle?: (runId: string, throughRevision: number) => void;
  /** Show or hide the run's session rows. */
  onToggleRoles?: (runId: string) => void;
  /** Move keyboard focus to the previous/next row in the browser. */
  onFocusSibling?: (delta: 1 | -1) => void;
  /** The run's Project, as the session cards show it: key, tooltip name, color. */
  projectKey?: string | undefined;
  projectName?: string | undefined;
  projectColor?: string | undefined;
}

/**
 * @component WorkflowRunInboxCard
 * @purpose The Sessions inbox's card for ONE formal Workflow Run in the working
 * set: what it works on, what it is doing or what it came to, why it stopped,
 * and how much of its own agent work is moving or stuck.
 * @useWhen The Sessions inbox is rendering a live Workflow Run, or one that
 * ended and has not been settled.
 * @avoidWhen Showing or steering the run itself; that is `WorkflowRunCard` on
 * the Task, which owns pause, resume, retry, ceilings, cancel, merge and the
 * cleanup that settles the run — so this item can disappear from a click made
 * there rather than from its own Settle.
 * @intent A run is the coarser unit of the same attention this browser already
 * shows, so it gets one card and never one per role session — but a card that
 * hides a paused run's REASON would be worse than the flood it replaces, so the
 * reason and the run's own sessions are on it. Settle is the one verb it
 * carries, because the run's ENDING is the thing the user acknowledges and
 * settling it puts its roles down with it; every control that steers the run
 * stays in one place, where the run's full evidence is.
 * @related SessionInbox, ActiveSessionCard, WorkflowRunCard, sessionInbox (lib)
 */
function WorkflowRunInboxCardImpl({
  item,
  now,
  density = "tight",
  expanded = false,
  onOpen,
  onOpenSession,
  onSettle,
  onToggleRoles,
  onFocusSibling,
  projectKey,
  projectName,
  projectColor,
}: WorkflowRunInboxCardProps) {
  const { run, bubbled } = item;
  const settleOffered = Boolean(onSettle) && workflowRunSettleOffered(item);
  const settle = () => onSettle?.(run.id, run.attention?.revision ?? 0);
  const settleLabel = item.settleBlocked
    ? `Cannot settle: ${item.settleBlocked}`
    : "Settle — acknowledge the run and put its sessions down";
  const title = workflowRunTitle(item);
  const badge = workflowRunBadge(item);
  const phase = item.card ? WORKFLOW_PHASE_LABEL[item.card.phase] : undefined;
  const moving = badge.kind === "working" || badge.kind === "active";
  // The run's pull request, as its owning role session reports it: that row
  // carries the live CI and review state the run card itself does not.
  const prSession = workflowRunPullRequestSession(item);
  const prDelivery = prSession ? sessionDelivery(prSession) : undefined;
  const signalRowRef = useInertOverflow<HTMLDivElement>();
  const roles =
    item.counts.total > 0 ? workflowRunRolesSummary(item.counts) : null;
  const bubbleLabel = bubbled ? sessionClusterBubbleLabel(bubbled, now) : null;
  const bubbleTone = bubbled
    ? sessionStatusBadge(bubbled.session, bubbled.status, now)?.tone
    : undefined;
  const open = () => onOpen(run.taskId, run.id);

  return (
    <div
      data-session-row
      data-list-row-id={`run:${run.id}`}
      role="button"
      tabIndex={-1}
      aria-label={`Open workflow run on ${title} — ${workflowRunStatusText(item)}${
        roles ? ` — ${roles}` : ""
      }${bubbleLabel ? ` — ${bubbleLabel}` : ""}${
        prDelivery ? ` — pull request: ${prDelivery.title}` : ""
      }${settleOffered && item.settleBlocked ? ` — ${settleLabel}` : ""}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          onFocusSibling?.(e.key === "ArrowDown" ? 1 : -1);
        } else if (
          e.key.toLowerCase() === "s" &&
          settleOffered &&
          !item.settleBlocked
        ) {
          e.preventDefault();
          settle();
        }
      }}
      className="group flex w-full cursor-pointer select-none overflow-hidden text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
    >
      {/* The session card's three rows, in the same places: context with the
          time, identity with the state in the leading slot, then signals with
          Settle at the right edge. Each row shows an item whole or not at all. */}
      <div
        className={`flex min-w-0 flex-1 flex-col justify-center gap-0.5 pl-2 pr-1 ${density === "comfortable" ? "py-2.5" : "py-2"}`}
      >
        <div
          className={`flex ${CARD_OUTER_ROW[density].row} min-w-0 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground`}
        >
          <div className="flex h-lh min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-4 overflow-hidden">
            {projectKey ? (
              <span
                className="flex max-w-full shrink-0 items-center gap-1"
                title={projectName ?? projectKey}
              >
                <FolderKanban
                  size={11}
                  className="shrink-0"
                  style={projectColor ? { color: projectColor } : undefined}
                  aria-hidden
                />
                <span className="min-w-0 truncate">{projectKey}</span>
              </span>
            ) : null}
            {run.branch ? (
              <span
                className="flex min-w-0 max-w-max flex-1 basis-0 items-center gap-1"
                title={run.branch}
              >
                <GitBranch size={11} className="shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{run.branch}</span>
              </span>
            ) : null}
            <span className="flex shrink-0 items-center gap-1">
              <ClipboardList size={11} aria-hidden />#{run.taskId}
            </span>
          </div>
          <span className="shrink-0 tabular-nums">
            {relativeAge(run.updatedAt, now)}
          </span>
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          {/* A moving run shows what it IS; one that stopped, ended or waits
              on you shows that state instead. */}
          <span className="flex size-4 shrink-0 items-center justify-center">
            {moving ? (
              <Workflow
                size={13}
                className="shrink-0 text-primary"
                aria-hidden
              />
            ) : (
              <span
                role="img"
                aria-label={badge.label}
                title={badge.label}
                className={`flex size-4 shrink-0 items-center justify-center rounded-full ${BADGE_TONE[badge.tone]}`}
              >
                <RunBadgeIcon kind={badge.kind} size={10} />
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {title}
          </span>
        </div>

        <div
          className={`flex ${CARD_OUTER_ROW[density].min} min-w-0 items-center gap-1.5 text-xs`}
        >
          {/* Signals show whole or not at all; DOM order is the drop order, so
              the role session that needs you outlasts the phase. */}
          <div
            ref={signalRowRef}
            className="session-card-status-line flex h-5 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-4 overflow-hidden"
          >
            {item.counts.total > 0 ? (
              <button
                type="button"
                title={roles ?? undefined}
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} the ${item.counts.total} workflow session${
                  item.counts.total === 1 ? "" : "s"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleRoles?.(run.id);
                }}
                className={`-mx-0.5 flex shrink-0 items-center gap-1 rounded px-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  item.counts.working > 0
                    ? "text-primary hover:text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {item.counts.working > 0 ? (
                  <Spinner size="xs" className="shrink-0" />
                ) : (
                  <Users size={11} className="shrink-0" aria-hidden />
                )}
                <span>
                  {item.counts.total} session
                  {item.counts.total === 1 ? "" : "s"}
                </span>
                <ChevronRight
                  size={11}
                  aria-hidden
                  className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
                />
              </button>
            ) : null}
            {bubbled ? (
              <button
                type="button"
                title={`Open “${bubbled.session.title.trim() || "Untitled session"}”`}
                aria-label={bubbleLabel ?? undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSession(bubbled.session.id);
                }}
                className={`session-status-responsive-badge flex min-w-0 shrink-0 items-center gap-1 rounded-full px-1.5 py-px font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  BADGE_TONE[bubbleTone ?? "accent"]
                }`}
              >
                <SessionStatusIcon status={bubbled.status} />
                <span className="session-status-badge-label min-w-0 truncate">
                  {bubbleLabel}
                </span>
              </button>
            ) : null}
            {prSession ? (
              <span className="flex shrink-0 items-center">
                <SessionDeliveryMark
                  session={prSession}
                  variant="responsive"
                  showNumber
                />
              </span>
            ) : null}
            {phase ? (
              <span className="min-w-0 flex-1 basis-0 truncate text-muted-foreground">
                {phase}
              </span>
            ) : null}
          </div>
          {/* A disabled Settle keeps its reason as the tooltip AND in the
              card's spoken label, so the refusal is readable without a
              pointer. */}
          {settleOffered ? (
            <button
              type="button"
              className={`${INLINE_ACTION} ${INLINE_ACTION_SIZE[density]}`}
              title={settleLabel}
              aria-label={settleLabel}
              disabled={Boolean(item.settleBlocked)}
              onClick={(e) => {
                e.stopPropagation();
                settle();
              }}
            >
              <Check size={14} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoized on CONTENT for the same reason the session cards are: this item is
 * rebuilt from scratch on every session and every workflow broadcast, and both
 * arrive several times a second while a run is moving.
 */
export const WorkflowRunInboxCard = memo(
  WorkflowRunInboxCardImpl,
  sameWorkflowRunItemProps,
);
