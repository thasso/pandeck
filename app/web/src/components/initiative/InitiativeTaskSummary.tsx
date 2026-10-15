import type { TaskSummary } from "@assistant/shared";
import { Button } from "../ui/button.tsx";
import { InspectorSection } from "../shell/Inspector.tsx";
import { TASK_STATUS_LABEL, TaskStatusIcon } from "../TaskStatusIcon.tsx";
import { TaskBlockedIndicator } from "../TaskBlockedIndicator.tsx";

/**
 * @component InitiativeTaskSummary
 * @purpose The object panel's summary of the Task selected on an Initiative
 *   page: its title, its status as the usual cycling control, and the way to
 *   its own page.
 * @useWhen Above the Task inspector's sections while an Initiative page has a
 *   member or outside blocker selected; the main pane is the Initiative, so
 *   nothing else on screen names the Task.
 * @intent The status button is the Backlog's own save (`cycleTaskStatus`):
 *   the panel changes a Task the usual way, while the map itself writes nothing.
 */
export function InitiativeTaskSummary({
  task,
  onCycleStatus,
  onOpenTask,
}: {
  task: TaskSummary;
  onCycleStatus: (task: TaskSummary) => void;
  onOpenTask: (id: string) => void;
}) {
  const archived = task.archivedAt !== undefined;
  return (
    <InspectorSection
      id="initiative-selected-task"
      title="Selected Task"
      collapsible={false}
      forceOpen
    >
      <div className="flex flex-col gap-2 px-1">
        <p className="text-sm font-medium break-words">{task.title}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={archived}
            aria-label={`Status: ${TASK_STATUS_LABEL[task.status]}. Change status`}
            onClick={() => onCycleStatus(task)}
          >
            <TaskStatusIcon status={task.status} size={12} />
            {TASK_STATUS_LABEL[task.status]}
          </Button>
          {task.openBlockerCount && task.status !== "done" ? (
            <TaskBlockedIndicator openBlockers={task.openBlockerCount} label />
          ) : null}
          {archived ? (
            <span className="text-xs text-muted-foreground">Archived</span>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => onOpenTask(task.id)}
          >
            Open Task-{task.id}
          </Button>
        </div>
      </div>
    </InspectorSection>
  );
}
