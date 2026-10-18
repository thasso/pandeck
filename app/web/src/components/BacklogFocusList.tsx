import { useMemo } from "react";
import { ListRowActions, type ListRowAction } from "./common/ListRowActions.tsx";
import { ListRow } from "./common/ListRow.tsx";
import {
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  CalendarRange,
  Check,
  CircleAlert,
  Lightbulb,
  Undo2,
  X,
} from "lucide-react";
import { ListGroupSection } from "./ListGroupSection.tsx";
import type { ProjectRecord, SessionListItem } from "@assistant/shared";
import {
  TaskProjectMeta,
  TaskRowDetails,
  TaskRowTitle,
} from "./TaskRowBody.tsx";
import { TaskIdBadge } from "./TaskIdBadge.tsx";
import { TaskStatusIcon, TASK_STATUS_LABEL } from "./TaskStatusIcon.tsx";
import { projectPath } from "../hooks/useSessionRouting.ts";
import { EmptyBox } from "./common/load.tsx";
import { nextStatus, type Task } from "../lib/backlogTree.ts";
import { buildFocusBuckets, type FocusBucketId } from "../lib/backlogFocus.ts";
import {
  buildTaskRowMeta,
  type TaskRowMeta,
  type TaskRowMetaContext,
} from "../lib/taskRowMeta.ts";
import type { WorktreeHostingMap } from "../lib/worktreeHosting.ts";
import type { DirtyWorktrees } from "../lib/worktreeDirty.ts";
import type { WorkflowIndicators } from "../lib/workflowIndicator.ts";
import type { BacklogDensity } from "../lib/backlogTreeModel.ts";

/**
 * @component BacklogFocusList
 * @purpose The Backlog's **Focus** view: a flat, when-grouped list of what to
 * work on — Confirm?, Overdue, Today, Tomorrow, This week, Later, No date —
 * sorted by priority inside each group.
 * @useWhen The Backlog list's view is `focus`.
 * @avoidWhen Arranging or restructuring the Backlog; that is the tree view
 * (`BacklogTreePane`), which owns hierarchy, manual order and drag editing.
 * @intent Three stable lines, like Attention and Pull Requests: Project and
 * Task id above, title in the middle, then a non-interactive status glyph,
 * planning, priority and live signals below. The metadata comes from the same derivation
 * as the tree, but its identity moves to the context line. An empty signal line
 * stays empty rather than repeating status and age as filler. There is no drag here on
 * purpose: a list that sorts itself cannot also be hand-arranged, and offering
 * both would make every drop silently snap back. The row's own click surface
 * opens the Task and its TITLE is the anchor that does so by name; suggestion
 * controls stop the click so answering one never also opens the row.
 * @related lib/backlogFocus.ts, lib/taskRowMeta.ts, TaskRowBody.tsx
 */
export function BacklogFocusList({
  tasks,
  today,
  projectsById,
  sessionById,
  worktreeNames,
  hosting,
  dirtyWorktrees,
  workflowIndicators,
  showProjectBadge,
  selectedId,
  onOpen,
  onCycle,
  onAcceptSuggestion,
  onDismissSuggestion,
  onNavigate,
  density,
  flush = false,
}: {
  tasks: Task[];
  /** Today as YYYY-MM-DD; passed in so one clock drives the whole surface. */
  today: string;
  projectsById: Map<string, ProjectRecord>;
  /** Live sessions, for the OBSERVED "working" signal (`lib/taskActivity.ts`). */
  sessionById: Map<string, SessionListItem>;
  worktreeNames?: TaskRowMetaContext["worktreeNames"];
  /** The app's PR/CI projection, for the row's delivery chip; see `TaskRowMeta`. */
  hosting?: WorktreeHostingMap | undefined;
  /** Worktrees with uncommitted changes, for the row's dirty dot; same rule. */
  dirtyWorktrees?: DirtyWorktrees | undefined;
  /** Active/paused Workflow Run markers per Task. */
  workflowIndicators?: WorkflowIndicators | undefined;
  showProjectBadge: boolean;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onCycle: (task: Task) => void;
  /** Accept an agent's status suggestion: move the Task where it says. */
  onAcceptSuggestion: (task: Task) => void;
  /** Dismiss the suggestion and leave the Task where it is. */
  onDismissSuggestion: (task: Task) => void;
  /** How this app navigates, for the links on a row's second line
   *  (`TaskRowBody`). A surface that passes none states those facts as text. */
  onNavigate?: ((path: string) => void) | undefined;
  /** How much room a row gets, decided by the host (`BacklogDensity`). */
  density: BacklogDensity;
  /** Edge-to-edge, hairline-divided rows (the sidebar); see `BacklogList`. */
  flush?: boolean;
}) {
  const tight = density === "tight";
  const buckets = useMemo(
    () => buildFocusBuckets(tasks, today),
    [tasks, today],
  );
  const metaContext = useMemo<TaskRowMetaContext>(
    () => ({
      today,
      sessionById,
      worktreeNames,
      showProjectBadge,
      ...(hosting !== undefined ? { hostingByWorktree: hosting } : {}),
      ...(dirtyWorktrees !== undefined ? { dirtyWorktrees } : {}),
      ...(workflowIndicators !== undefined
        ? { workflowByTask: workflowIndicators }
        : {}),
    }),
    [
      today,
      sessionById,
      worktreeNames,
      showProjectBadge,
      hosting,
      dirtyWorktrees,
      workflowIndicators,
    ],
  );

  if (buckets.length === 0) {
    return (
      <EmptyBox>
        Nothing to focus on. Tasks appear here once they are planned or due — or
        under “No date” when they are neither.
      </EmptyBox>
    );
  }

  return (
    <div data-flush-list={flush || undefined} className="flex flex-col">
      {buckets.map((bucket) => {
        const rows = (
          <ul className="flex flex-col">
            {bucket.tasks.map((task) => (
              <FocusRow
                key={task.id}
                task={task}
                meta={focusRowMeta(buildTaskRowMeta(task, metaContext))}
                projectsById={projectsById}
                selected={task.id === selectedId}
                onOpen={onOpen}
                onCycle={onCycle}
                onAcceptSuggestion={onAcceptSuggestion}
                onDismissSuggestion={onDismissSuggestion}
                onNavigate={onNavigate}
                tight={tight}
              />
            ))}
          </ul>
        );
        return (
          <ListGroupSection
            key={bucket.id}
            id={`focus:${bucket.id}`}
            title={bucket.label}
            count={bucket.tasks.length}
            emphasis={BUCKET_EMPHASIS.has(bucket.id)}
            icon={<BucketIcon id={bucket.id} />}
            containsSelected={bucket.tasks.some(
              (task) => task.id === selectedId,
            )}
          >
            {rows}
          </ListGroupSection>
        );
      })}
    </div>
  );
}

/** The buckets that mean "act now": their band title is set bolder. */
const BUCKET_EMPHASIS: ReadonlySet<FocusBucketId> = new Set([
  "review",
  "overdue",
  "today",
]);

const BUCKET_ICON: Record<FocusBucketId, typeof CalendarDays> = {
  review: Lightbulb,
  overdue: CircleAlert,
  today: CalendarCheck,
  tomorrow: CalendarDays,
  week: CalendarRange,
  later: CalendarClock,
  unscheduled: CalendarOff,
};

/**
 * A bucket's glyph carries the act-now tone on the shared group header.
 */
function BucketIcon({ id }: { id: FocusBucketId }) {
  const Icon = BUCKET_ICON[id];
  const tone =
    id === "review"
      ? "text-warning"
      : id === "overdue"
        ? "text-destructive"
        : "";
  return <Icon size={14} className={`shrink-0 ${tone}`} aria-hidden />;
}

function FocusRow({
  task,
  meta,
  projectsById,
  selected,
  onOpen,
  onCycle,
  onAcceptSuggestion,
  onDismissSuggestion,
  onNavigate,
  tight,
}: {
  task: Task;
  meta: TaskRowMeta;
  projectsById: Map<string, ProjectRecord>;
  selected: boolean;
  onOpen: (id: string) => void;
  onCycle: (task: Task) => void;
  onAcceptSuggestion: (task: Task) => void;
  onDismissSuggestion: (task: Task) => void;
  onNavigate?: ((path: string) => void) | undefined;
  tight: boolean;
}) {
  const suggestion = meta.suggestion;
  const actions: ListRowAction[] = suggestion ? [
    {
      id: "accept",
      label: `Confirm ${TASK_STATUS_LABEL[suggestion.to].toLowerCase()}`,
      accessibleLabel: `Confirm "${task.title}" is ${TASK_STATUS_LABEL[suggestion.to].toLowerCase()}`,
      icon: suggestion.to === "done" ? <Check /> : <Undo2 />,
      onSelect: () => onAcceptSuggestion(task),
    },
    {
      id: "dismiss",
      label: task.status === "done" ? "Keep done" : "Keep open",
      accessibleLabel: `Keep "${task.title}" ${TASK_STATUS_LABEL[task.status].toLowerCase()} and dismiss the suggestion`,
      icon: <X />,
      onSelect: () => onDismissSuggestion(task),
    },
  ] : [
    {
      id: "status",
      label: `Mark ${TASK_STATUS_LABEL[nextStatus(task.status)].toLowerCase()}`,
      icon: <TaskStatusIcon status={nextStatus(task.status)} />,
      onSelect: () => onCycle(task),
    },
  ];

  return (
    <li data-list-row-id={task.id}>
      <ListRow
        interaction="content"
        active={selected}
        density={tight ? "tight" : "comfortable"}
        onOpen={() => onOpen(task.id)}
        context={
          meta.projectId ? (
            <TaskProjectMeta
              projectId={meta.projectId}
              projectsById={projectsById}
              href={projectPath(meta.projectId)}
              onNavigate={onNavigate}
            />
          ) : null
        }
        contextTrailing={<TaskIdBadge id={task.id} onNavigate={onNavigate} />}
        identity={<TaskRowTitle task={task} selected={selected} onOpenTask={onOpen} />}
        actions={<ListRowActions actions={actions} alwaysVisible={Boolean(suggestion)} />} 
        signals={
          <>
            <span
              role="img"
              aria-label={TASK_STATUS_LABEL[task.status]}
              title={TASK_STATUS_LABEL[task.status]}
              className="flex shrink-0 items-center"
            >
              <TaskStatusIcon
                status={task.status}
                size={12}
                claimed={Boolean(suggestion)}
              />
            </span>
            <TaskRowDetails
              task={task}
              meta={meta}
              projectsById={projectsById}
              onNavigate={onNavigate}
              showContext={false}
            />
          </>
        }
      />
    </li>
  );
}

/**
 * What a Focus row keeps of the shared metadata across its supporting lines. Focus is for
 * picking what to work on, so it drops the plumbing: the "Session" item, and
 * the bare worktree glyph with its dirty dot, which said "there is code" in a
 * way nobody could read. What stays is what bears on the choice — planning,
 * priority, a run in progress ("Working", still leading to its session), a
 * pull request's state, and the Project.
 */
function focusRowMeta(meta: TaskRowMeta): TaskRowMeta {
  return {
    ...meta,
    session: meta.working ? meta.session : null,
    worktreeId: null,
    dirty: false,
  };
}
