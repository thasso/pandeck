import type {
  SessionListItem,
  TaskPriority,
  TaskStatusSuggestion,
} from "@assistant/shared";
import { pendingStatusSuggestion, type Task } from "./backlogTree.ts";
import type { BacklogDensity, BacklogView } from "./backlogTreeModel.ts";
import { dueLabel, scheduledLabel } from "./backlogFocus.ts";
import { taskStartSession } from "./taskActivity.ts";
import { relativeAge } from "./relativeTime.ts";
import {
  hostingAttention,
  type HostingAttention,
  type WorktreeHostingMap,
} from "./worktreeHosting.ts";
import type { DirtyWorktrees } from "./worktreeDirty.ts";
import type { WorkflowIndicators } from "./workflowIndicator.ts";

/**
 * Where the Task's branch stands with its pull request and its checks, for the
 * ONE chip that says so. `state` is the shared ladder (`worktreeHosting.ts`),
 * so this row and a worktree card cannot rank the same PR differently; the
 * numbers are here because the chip is two words wide and its TOOLTIP is where
 * "which PR" and "how many checks" fit, and the `url` because the chip is also
 * the way TO the pull request.
 */
export interface TaskRowDelivery {
  state: HostingAttention;
  /** The pull request behind the state, when there is one. */
  prNumber: number | null;
  /** Where the state can be INSPECTED, so the chip leads there: the pull
   *  request, or the checks' own page for a branch that has none. Null when the
   *  projection named neither — a chip that links nowhere must not pretend to. */
  url: string | null;
  /** How many individual checks the CI state summarises; 0 = it did not say. */
  checks: number;
  changesRequested: boolean;
  unresolvedThreads: number;
}

/**
 * What a Task row's SECOND line may state, in the order it states it.
 *
 * One derivation for every Backlog view, because a row that says different
 * things about the same Task depending on which view you are in is worse than a
 * row that says less. Everything here but `delivery`, `dirty`, and `workflow`
 * is FREE — already in the narrow `BacklogState` (`hooks/useBacklog.ts`) — and
 * that is still the rule for anything new. The three paid facts each arrive as
 * a content-stable slice: `delivery` is the app's PR/CI projection
 * (`hooks/useWorktreeHosting.ts`), `dirty` is one boolean lifted out of
 * `worktreeStatuses` (`lib/worktreeDirty.ts`), and `workflow` comes from the
 * run summaries (`lib/workflowIndicator.ts`). Their raw records still have no
 * business in `BacklogState`: frequent broadcasts would repaint every memoized
 * row.
 */
export interface TaskRowMeta {
  /** An agent has claimed a status and nobody has answered. */
  suggestion: TaskStatusSuggestion | null;
  /** OBSERVED: a session started from this Task is streaming right now. */
  working: boolean;
  /** The session started from this Task, when the browser holds one. */
  session: SessionListItem | null;
  /** The worktree that session runs in. An id, not a branch: the worktree
   *  RECORDS are not in `BacklogState`, so the chip is a glyph, not a name. */
  worktreeId: string | null;
  /** That worktree's PR/CI, when a surface passes the projection and it says
   *  something. It SUBSUMES the worktree glyph: a PR is a stronger statement of
   *  "there is code" than a branch, and line 2 clips from the right. */
  delivery: TaskRowDelivery | null;
  /** That worktree has uncommitted changes. It subsumes NOTHING — work in
   *  progress on disk is true alongside any PR the branch already has — so it
   *  is a marker ON the chip that states the code, never a chip of its own. */
  dirty: boolean;
  /** A non-terminal Workflow Run exists; attention means at least one is paused. */
  workflow: { attention: boolean } | null;
  /** The day the user planned to work on this, when it says more than `due`. */
  planned: string | null;
  due: string | null;
  /** The deadline has passed — the one date that is danger-toned. */
  overdue: boolean;
  /** Set only when it is NOT the default; see `PRIORITY_TONE`. */
  priority: TaskPriority | null;
  projectId: string | null;
  /** How long since the Task last moved. Only ever a FALLBACK (see below). */
  age: string;
}

/**
 * Whether a Backlog surface's rows have a SECOND LINE at all — the line
 * everything above is stated on. A `tight` TREE row is one line (the desktop
 * rail, which reveals on hover instead), while Focus rows carry their second
 * line at either density.
 *
 * It is one predicate rather than an expression per caller because two costs
 * hang off it and both fail silently: the app polls a provider for PR/CI
 * (`lib/worktreeHosting.ts`) and watches git status per worktree only for rows
 * that can state them. Too wide is invisible traffic, too narrow is a row that
 * renders perfectly and says nothing.
 */
export function taskRowsHaveMeta(
  density: BacklogDensity,
  view: BacklogView,
): boolean {
  return density === "comfortable" || view === "focus";
}

export interface TaskRowMetaContext {
  /** Today as YYYY-MM-DD, so one clock drives the whole surface. */
  today: string;
  /** Live sessions, for the observed "working" and session signals. */
  sessionById: Map<string, SessionListItem>;
  /** Whether the surface shows per-row project chips at all. */
  showProjectBadge: boolean;
  /**
   * The app's PR/CI projection (`hooks/useWorktreeHosting.ts`). Optional: a
   * surface that does not have it — a picker, a single-line list — states no
   * delivery rather than fetching its own.
   */
  hostingByWorktree?: WorktreeHostingMap;
  /**
   * The worktrees with uncommitted changes (`lib/worktreeDirty.ts`). Optional
   * for the same reason: a surface that is not given the slice states nothing
   * about the working tree rather than claiming a branch is clean — an id that
   * is simply not in the set is UNKNOWN as readily as it is committed.
   */
  dirtyWorktrees?: DirtyWorktrees;
  /** Content-stable active/paused Workflow Run indicators per Task. */
  workflowByTask?: WorkflowIndicators;
  /** Now, for the age fallback. Passed in so a row owns no clock. */
  now?: number;
}

/**
 * The delivery chip's facts, or null when the branch's hosting asks nothing
 * (no PR and green or absent checks) — the row then keeps its bare worktree
 * glyph. An absent entry is UNKNOWN, not clean, and answers null the same way.
 */
function taskRowDelivery(
  worktreeId: string | null,
  hostingByWorktree: WorktreeHostingMap | undefined,
): TaskRowDelivery | null {
  const hosting = worktreeId ? hostingByWorktree?.[worktreeId] : undefined;
  const state = hostingAttention(hosting);
  if (!state || !hosting) return null;
  return {
    state,
    prNumber: hosting.pr?.number ?? null,
    url: hosting.pr?.url ?? hosting.ci?.url ?? null,
    checks: hosting.ci?.total ?? 0,
    changesRequested: Boolean(hosting.review?.changesRequested),
    unresolvedThreads: hosting.review?.unresolvedThreads ?? 0,
  };
}

export function buildTaskRowMeta(
  task: Task,
  ctx: TaskRowMetaContext,
): TaskRowMeta {
  const session = taskStartSession(task, ctx.sessionById);
  const worktreeId = session?.worktreeId ?? null;
  const workflowIndicator = ctx.workflowByTask?.get(task.id);
  return {
    suggestion: pendingStatusSuggestion(task) ?? null,
    working: Boolean(session?.isStreaming),
    session,
    worktreeId,
    delivery: taskRowDelivery(worktreeId, ctx.hostingByWorktree),
    dirty: Boolean(worktreeId && ctx.dirtyWorktrees?.has(worktreeId)),
    workflow: workflowIndicator
      ? { attention: workflowIndicator.attention }
      : null,
    planned: scheduledLabel(task, ctx.today),
    due: dueLabel(task, ctx.today),
    overdue: Boolean(task.dueDate && task.dueDate < ctx.today),
    priority:
      task.priority && task.priority !== "normal" ? task.priority : null,
    projectId: ctx.showProjectBadge ? (task.projectId ?? null) : null,
    age: relativeAge(task.updatedAt, ctx.now ?? Date.now()),
  };
}

/**
 * Does this meta state anything at all?
 *
 * The two views answer an empty line differently, and both answers are right
 * for their own list: Focus drops the line (a blank strip reads as a missing
 * value in a list you scan), while a two-line tree row states the facts that
 * always exist instead, because rows alternating between 28 and 52px are harder
 * to hit than a list that is simply taller.
 *
 * Every field a chip can be drawn from is listed, `worktreeId` included — even
 * though `buildTaskRowMeta` only ever sets it ALONGSIDE the session it came
 * from. A caller may drop the session and keep the worktree (`TaskRowBody`'s
 * `sessionShownElsewhere` does exactly that), and those are two different facts:
 * one says work was started, the other that there is code. Omitting it here made
 * an actively-worked row with no dates fall back to "To do · 2d" and lose the
 * branch glyph — reading as "nothing going on" for a Task with code in flight.
 * `delivery`, `dirty`, and `workflow` are listed for the same rule: what a chip
 * is drawn from belongs here, not what happens to imply something else today.
 */
export function taskRowMetaEmpty(meta: TaskRowMeta): boolean {
  return !(
    meta.suggestion ||
    meta.working ||
    meta.session ||
    meta.worktreeId ||
    meta.delivery ||
    meta.dirty ||
    meta.workflow ||
    meta.planned ||
    meta.due ||
    meta.priority ||
    meta.projectId
  );
}
