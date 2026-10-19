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
import type { RowDensity } from "../lib/rowDensity.ts";
import { ListRow, ListRowContent } from "./common/ListRow.tsx";
import { sessionDelivery } from "../lib/sessionDelivery.ts";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { SessionStatusIcon } from "./SessionStatusBadge.tsx";
import { ListRowActions } from "./common/ListRowActions.tsx";
import { Spinner } from "./common/load.tsx";
import { Button } from "@/components/ui/button";

/** The run state's glyph colour, by the same semantic tones the session cards use. */
const TONE_TEXT: Record<SessionStatusTone, string> = {
  accent: "text-primary",
  warning: "text-warning",
  danger: "text-destructive",
  success: "text-success",
  muted: "text-muted-foreground",
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
  const roles =
    item.counts.total > 0 ? workflowRunRolesSummary(item.counts) : null;
  const bubbleLabel = bubbled ? sessionClusterBubbleLabel(bubbled, now) : null;
  const bubbleTone = bubbled
    ? sessionStatusBadge(bubbled.session, bubbled.status, now)?.tone
    : undefined;
  const open = () => onOpen(run.taskId, run.id);

  return (
    <ListRow
      interaction="content"
      divider={false}
      data-session-row
      data-list-row-id={`run:${run.id}`}
      role="group"
      tabIndex={-1}
      aria-label={`Open workflow run on ${title} — ${workflowRunStatusText(item)}${
        roles ? ` — ${roles}` : ""
      }${bubbleLabel ? ` — ${bubbleLabel}` : ""}${
        prDelivery ? ` — pull request: ${prDelivery.title}` : ""
      }${settleOffered && item.settleBlocked ? ` — ${settleLabel}` : ""}`}
      onOpen={open}
      onFocusSibling={onFocusSibling}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (
          e.key.toLowerCase() === "s" &&
          settleOffered &&
          !item.settleBlocked
        ) {
          e.preventDefault();
          settle();
        }
      }}
    >
      <ListRowContent
        density={density}
        context={
          <>
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
          </>
        }
        age={relativeAge(run.updatedAt, now)}
        identity={
          <>
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
                  className={`flex size-4 shrink-0 items-center justify-center ${TONE_TEXT[badge.tone]}`}
                >
                  <RunBadgeIcon kind={badge.kind} size={13} />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {title}
            </span>
          </>
        }
        signals={
          <>
            {item.counts.total > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                className={
                  item.counts.working > 0 ? "-mx-1 text-primary" : "-mx-1"
                }
                title={roles ?? undefined}
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} the ${item.counts.total} workflow session${
                  item.counts.total === 1 ? "" : "s"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleRoles?.(run.id);
                }}
              >
                {item.counts.working > 0 ? (
                  <Spinner size="xs" />
                ) : (
                  <Users aria-hidden />
                )}
                <span>
                  {item.counts.total} session
                  {item.counts.total === 1 ? "" : "s"}
                </span>
                <ChevronRight
                  aria-hidden
                  className={expanded ? "rotate-90" : ""}
                />
              </Button>
            ) : null}
            {bubbled ? (
              <Button
                variant={bubbleTone === "danger" ? "destructive" : "secondary"}
                size="xs"
                className="session-status-responsive-badge min-w-0"
                title={`Open “${bubbled.session.title.trim() || "Untitled session"}”`}
                aria-label={bubbleLabel ?? undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSession(bubbled.session.id);
                }}
              >
                <SessionStatusIcon status={bubbled.status} />
                <span className="session-status-badge-label min-w-0 truncate">
                  {bubbleLabel}
                </span>
              </Button>
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
          </>
        }
        actions={
          settleOffered ? (
            <ListRowActions
              actions={[
                {
                  id: "settle",
                  label: "Settle",
                  accessibleLabel: settleLabel,
                  icon: <Check />,
                  disabled: Boolean(item.settleBlocked),
                  onSelect: settle,
                },
              ]}
            />
          ) : undefined
        }
      />
    </ListRow>
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
