import { useMemo, type ReactNode } from "react";
import { Check, Undo2, X } from "lucide-react";
import type { ProjectRecord, SessionListItem } from "@assistant/shared";
import {
  TaskStatusIcon as StatusIcon,
  TASK_STATUS_LABEL,
} from "./TaskStatusIcon.tsx";
import { TaskRowBody } from "./TaskRowBody.tsx";
import { EmptyBox } from "./ui/load.tsx";
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
 * @intent A row here stands ALONE, so it gets two lines: the title takes the
 * first and `TaskRowBody` carries the id and answers "why is this here" on the
 * second — the same line, from the same derivation, as the tree's `comfortable`
 * rows, because a row that says different things about one Task in two views is
 * worse than a row that says less. Focus differs in one thing only: a Task with
 * nothing to report keeps its id and stops there, where a tree row falls back to
 * its status and age, since these rows are read as a GROUP and a line of filler
 * repeated down a list is noise rather than context. There is no drag here on
 * purpose: a list that sorts itself cannot also be hand-arranged, and offering
 * both would make every drop silently snap back. The row's own click surface
 * opens the Task and its TITLE is the anchor that does so by name; every control
 * inside stops the click, so answering a suggestion or cycling a status never
 * also opens the row it sits on.
 * @related lib/backlogFocus.ts, lib/taskRowMeta.ts, TaskRowBody.tsx
 */
export function BacklogFocusList({
  tasks,
  today,
  projectsById,
  sessionById,
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
}: {
  tasks: Task[];
  /** Today as YYYY-MM-DD; passed in so one clock drives the whole surface. */
  today: string;
  projectsById: Map<string, ProjectRecord>;
  /** Live sessions, for the OBSERVED "working" signal (`lib/taskActivity.ts`). */
  sessionById: Map<string, SessionListItem>;
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
    <div className="flex flex-col gap-3">
      {buckets.map((bucket) => (
        <section key={bucket.id} aria-label={bucket.label}>
          <h3
            className={`px-1 pb-1 font-medium uppercase tracking-wide ${tight ? "text-micro" : "text-caption"} ${BUCKET_TONE[bucket.id]}`}
          >
            {bucket.label}
          </h3>
          <ul className="flex flex-col">
            {bucket.tasks.map((task) => (
              <FocusRow
                key={task.id}
                task={task}
                meta={buildTaskRowMeta(task, metaContext)}
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
        </section>
      ))}
    </div>
  );
}

/**
 * Only the two buckets that mean "act" are toned. Colouring every heading would
 * make the list a rainbow in which nothing stands out, which is the opposite of
 * what a heading tone is for.
 */
const BUCKET_TONE: Record<FocusBucketId, string> = {
  review: "text-amber-500",
  overdue: "text-danger",
  today: "text-primary",
  tomorrow: "text-muted-foreground",
  week: "text-muted-foreground",
  later: "text-faint",
  unscheduled: "text-faint",
};

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

  return (
    <li data-list-row-id={task.id}>
      {/* The row is a plain CLICK SURFACE and the TITLE is the button — an
          anchor to the Task (`TaskRowBody`'s `onOpenTask`). It is deliberately
          not the session shelf's `role="button"` row: that role makes every
          descendant presentational, so the links line 2 now draws would be
          announced by nothing, and ARIA forbids focusable descendants inside it
          anyway. This way the whole two-line block still opens the Task under a
          finger, the keyboard gets a real named target, and a modifier click
          opens the Task in a tab. */}
      <div
        onClick={() => onOpen(task.id)}
        className={`group/row flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-lg px-1 text-left ${tight ? "py-1" : "py-1.5"} ${selected ? "bg-raised" : "hover:bg-panel"}`}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCycle(task);
          }}
          className={`flex shrink-0 cursor-pointer items-center justify-center ${tight ? "size-5" : "size-6"}`}
          title={`Mark as ${TASK_STATUS_LABEL[nextStatus(task.status)].toLowerCase()}`}
          aria-label={`Status: ${TASK_STATUS_LABEL[task.status]}. Mark as ${TASK_STATUS_LABEL[nextStatus(task.status)].toLowerCase()}`}
        >
          <StatusIcon
            status={task.status}
            size={tight ? 14 : 16}
            claimed={Boolean(suggestion)}
          />
        </button>
        <div className="min-w-0 flex-1">
          <TaskRowBody
            task={task}
            meta={meta}
            projectsById={projectsById}
            selected={selected}
            onNavigate={onNavigate}
            onOpenTask={onOpen}
          />
        </div>
        {/* The suggestion is answered ON the row: it is a yes/no, and making it
            a trip into the Task detail is what leaves these sitting for days. */}
        {suggestion ? (
          <span className="flex shrink-0 items-center gap-0.5">
            <ClaimButton
              icon={
                suggestion.to === "done" ? (
                  <Check size={13} />
                ) : (
                  <Undo2 size={13} />
                )
              }
              label={
                suggestion.to === "done"
                  ? `Confirm "${task.title}" is done`
                  : `Put "${task.title}" back on the to-do pile`
              }
              tone={
                suggestion.to === "done"
                  ? "border-emerald-500/50 text-emerald-500 hover:bg-emerald-500/10"
                  : "border-primary/50 text-primary hover:bg-primary/10"
              }
              onClick={() => onAcceptSuggestion(task)}
              tight={tight}
            />
            <ClaimButton
              icon={<X size={13} />}
              label={`Disagree: dismiss the agent's suggestion on "${task.title}"`}
              tone="border-line text-faint hover:bg-raised hover:text-muted-foreground"
              onClick={() => onDismissSuggestion(task)}
              tight={tight}
            />
          </span>
        ) : null}
      </div>
    </li>
  );
}

function ClaimButton({
  icon,
  label,
  tone,
  onClick,
  tight,
}: {
  icon: ReactNode;
  label: string;
  tone: string;
  onClick: () => void;
  tight: boolean;
}) {
  return (
    <button
      type="button"
      // Answering the suggestion is not opening the Task: the row around this
      // opens it, on any click it is left.
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className={`flex shrink-0 cursor-pointer items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${tight ? "size-6" : "size-7"} ${tone}`}
    >
      {icon}
    </button>
  );
}
