import { useMemo } from "react";
import { Check } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import {
  TaskStatusIcon as StatusIcon,
  TASK_STATUS_LABEL,
} from "./TaskStatusIcon.tsx";
import { ProjectBadge } from "./ProjectBadge.tsx";
import { TaskIdBadge } from "./TaskIdBadge.tsx";
import { EmptyBox } from "./common/load.tsx";
import {
  nextStatus,
  pendingStatusSuggestion,
  type Task,
} from "../lib/backlogTree.ts";
import { buildInboxList, taskOrigin } from "../lib/backlogInbox.ts";
import type { BacklogDensity } from "../lib/backlogTreeModel.ts";

/**
 * @component BacklogInboxList
 * @purpose The Backlog's **Inbox** view: Tasks that arrived on their own —
 * meeting minutes, Slack intake, an agent noticing work — and still need a
 * decision from you.
 * @useWhen The Backlog list's view is `inbox`.
 * @avoidWhen Planning or arranging; those are the Focus and Backlog views.
 * @intent A triage queue, newest first, where the row carries what you need to
 * DECIDE with — where it came from and what it says — rather than the planning
 * metadata Focus shows. There is one control: dismiss. Everything else that
 * would process a Task (open it and set a date, change its status, give it a
 * project) already counts as triage on the server, so the Inbox empties as a
 * side effect of doing the work rather than needing a second gesture.
 * @related lib/backlogInbox.ts, BacklogList.tsx, BacklogFocusList.tsx
 */
export function BacklogInboxList({
  tasks,
  projectsById,
  showProjectBadge,
  selectedId,
  onOpen,
  onCycle,
  onDismiss,
  density,
}: {
  tasks: Task[];
  projectsById: Map<string, ProjectRecord>;
  showProjectBadge: boolean;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onCycle: (task: Task) => void;
  /** Processed, nothing to do — take it out of the Inbox. */
  onDismiss: (task: Task) => void;
  /** How much room a row gets, decided by the host (`BacklogDensity`). */
  density: BacklogDensity;
}) {
  const tight = density === "tight";
  const items = useMemo(() => buildInboxList(tasks), [tasks]);

  if (items.length === 0) {
    return (
      <EmptyBox>
        Inbox zero. Tasks that arrive on their own — from meeting minutes,
        Slack, or an agent — wait here until you have looked at them.
      </EmptyBox>
    );
  }

  return (
    <ul className="flex flex-col">
      {items.map((task) => (
        <InboxRow
          key={task.id}
          task={task}
          projectsById={projectsById}
          showProjectBadge={showProjectBadge}
          selected={task.id === selectedId}
          onOpen={onOpen}
          onCycle={onCycle}
          onDismiss={onDismiss}
          tight={tight}
        />
      ))}
    </ul>
  );
}

function InboxRow({
  task,
  projectsById,
  showProjectBadge,
  selected,
  onOpen,
  onCycle,
  onDismiss,
  tight,
}: {
  task: Task;
  projectsById: Map<string, ProjectRecord>;
  showProjectBadge: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onCycle: (task: Task) => void;
  onDismiss: (task: Task) => void;
  tight: boolean;
}) {
  const origin = taskOrigin(task);
  // The preview is what the row is FOR — deciding about a Task you did not
  // write needs its first sentence, not just its title. It is dropped when the
  // Task has no body rather than leaving an empty line.
  const preview = task.descriptionPreview?.trim();

  return (
    <li data-list-row-id={task.id}>
      <div
        className={`flex w-full min-w-0 items-start gap-1.5 rounded-lg px-1 ${tight ? "py-1" : "py-1.5"} ${selected ? "bg-raised" : "hover:bg-panel"}`}
      >
        <button
          type="button"
          onClick={() => onCycle(task)}
          className={`flex shrink-0 cursor-pointer items-center justify-center ${tight ? "size-5" : "size-6"}`}
          title={`Mark as ${TASK_STATUS_LABEL[nextStatus(task.status)].toLowerCase()}`}
          aria-label={`Status: ${TASK_STATUS_LABEL[task.status]}. Mark as ${TASK_STATUS_LABEL[nextStatus(task.status)].toLowerCase()}`}
        >
          <StatusIcon
            status={task.status}
            size={tight ? 14 : 16}
            claimed={Boolean(pendingStatusSuggestion(task))}
          />
        </button>
        <button
          type="button"
          onClick={() => onOpen(task.id)}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span
              className={`min-w-0 flex-1 truncate text-sm ${selected ? "font-medium text-fg" : "text-fg"}`}
            >
              {task.title}
            </span>
            <TaskIdBadge id={task.id} />
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">{origin}</span>
            {showProjectBadge && task.projectId ? (
              <ProjectBadge
                projectId={task.projectId}
                projectsById={projectsById}
                size="sm"
              />
            ) : null}
          </span>
          {preview ? (
            <span className="mt-0.5 block truncate text-xs text-faint">
              {preview}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => onDismiss(task)}
          title={`Dismiss "${task.title}" from the Inbox`}
          aria-label={`Dismiss "${task.title}" from the Inbox`}
          className={`flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line text-faint transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${tight ? "size-6" : "size-7"}`}
        >
          <Check size={13} />
        </button>
      </div>
    </li>
  );
}
