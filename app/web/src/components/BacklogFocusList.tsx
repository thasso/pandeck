import { useMemo } from "react";
import type { ListRowAction } from "./common/ListRowActions.tsx";
import { TaskListRowContent } from "./TaskListRowContent.tsx";
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
import { TASK_STATUS_LABEL } from "./TaskStatusIcon.tsx";
import { EmptyBox } from "./common/load.tsx";
import type { Task } from "../lib/backlogTree.ts";
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
 * @intent Shares TaskListRowContent with Backlog and Inbox, including metadata
 * and the open/start-session action. Pending suggestions replace that action
 * with decision controls. No drag: Focus owns its sort order. The row's own click surface
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
  onOpenSession,
  onStartSession,
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
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onStartSession?: ((task: Task) => void) | undefined;
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
                meta={buildTaskRowMeta(task, metaContext)}
                projectsById={projectsById}
                selected={task.id === selectedId}
                onOpen={onOpen}
                onOpenSession={onOpenSession}
                onStartSession={onStartSession}
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
  onOpenSession,
  onStartSession,
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
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onStartSession?: ((task: Task) => void) | undefined;
  onAcceptSuggestion: (task: Task) => void;
  onDismissSuggestion: (task: Task) => void;
  onNavigate?: ((path: string) => void) | undefined;
  tight: boolean;
}) {
  const suggestion = meta.suggestion;
  const actions: ListRowAction[] | undefined = suggestion
    ? [
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
      ]
    : undefined;

  return (
    <li data-list-row-id={task.id}>
      <ListRow
        interaction="content"
        active={selected}
        onOpen={() => onOpen(task.id)}
      >
        <TaskListRowContent
          task={task}
          meta={meta}
          projectsById={projectsById}
          selected={selected}
          density={tight ? "tight" : "comfortable"}
          actions={actions}
          alwaysVisible={selected || Boolean(suggestion)}
          onOpenTask={onOpen}
          onOpenSession={onOpenSession}
          onStartSession={onStartSession}
          onNavigate={onNavigate}
        />
      </ListRow>
    </li>
  );
}

