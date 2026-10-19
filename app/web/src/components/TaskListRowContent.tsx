import type { ReactNode } from "react";
import type { ProjectRecord } from "@assistant/shared";
import { MessageSquare, MessageSquarePlus } from "lucide-react";
import { ListRowContent } from "./common/ListRow.tsx";
import {
  ListRowActions,
  type ListRowAction,
} from "./common/ListRowActions.tsx";
import {
  TaskProjectMeta,
  TaskRowDetails,
  TaskRowTitle,
} from "./TaskRowBody.tsx";
import { TaskStatusIcon, TASK_STATUS_LABEL } from "./TaskStatusIcon.tsx";
import { TaskIdBadge } from "./TaskIdBadge.tsx";
import { TaskBlockedIndicator } from "./TaskBlockedIndicator.tsx";
import { ProjectBadge } from "./ProjectBadge.tsx";
import { projectPath } from "../hooks/useSessionRouting.ts";
import { pendingStatusSuggestion, type Task } from "../lib/backlogTree.ts";
import { taskRowMetaEmpty, type TaskRowMeta } from "../lib/taskRowMeta.ts";
import type { RowDensity } from "../lib/rowDensity.ts";

/** One Task presentation for Backlog, Focus and Inbox; hosts own actions and hierarchy. */
export function TaskListRowContent({
  task,
  meta,
  projectsById,
  selected,
  dimmed = false,
  density,
  showProjectBadge = false,
  disclosure,
  actions: suppliedActions,
  alwaysVisible = selected,
  onOpenTask,
  onOpenSession,
  onStartSession,
  onNavigate,
}: {
  task: Task;
  /** Null is the explicit single-line picker presentation. */
  meta: TaskRowMeta | null;
  projectsById: Map<string, ProjectRecord>;
  selected: boolean;
  dimmed?: boolean;
  density: RowDensity;
  showProjectBadge?: boolean;
  disclosure?: ReactNode;
  actions?: ListRowAction[] | undefined;
  alwaysVisible?: boolean;
  onOpenTask?: ((id: string) => void) | undefined;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onStartSession?: ((task: Task) => void) | undefined;
  onNavigate?: ((path: string) => void) | undefined;
}) {
  const suggestion = pendingStatusSuggestion(task);
  const claim = suggestion
    ? suggestion.to === "done"
      ? "an agent says it is finished"
      : "an agent says it is not finished"
    : null;
  const session = meta?.session;
  const signals = meta && !meta.working ? { ...meta, session: null } : meta;
  const actions: ListRowAction[] =
    suppliedActions ??
    (meta && onOpenSession && onStartSession
      ? [
          {
            id: "session",
            label: session ? "Open session" : "Start session",
            accessibleLabel: session
              ? `Open the session for "${task.title}"`
              : `Start a session for "${task.title}"`,
            icon: session ? <MessageSquare /> : <MessageSquarePlus />,
            onSelect: () => {
              if (session) onOpenSession(session.id);
              else onStartSession(task);
            },
          },
        ]
      : []);
  const status = (
    <span
      role="img"
      aria-label={`${TASK_STATUS_LABEL[task.status]}${claim ? `, ${claim}` : ""}`}
      title={TASK_STATUS_LABEL[task.status]}
      className="flex size-4 shrink-0 items-center justify-center"
    >
      <TaskStatusIcon
        status={task.status}
        size={12}
        claimed={Boolean(suggestion)}
      />
    </span>
  );
  return (
    <ListRowContent
      density={density}
      context={
        meta ? (
          meta.projectId ? (
            <TaskProjectMeta
              projectId={meta.projectId}
              projectsById={projectsById}
              href={projectPath(meta.projectId)}
              onNavigate={onNavigate}
            />
          ) : null
        ) : undefined
      }
      contextTrailing={
        meta ? (
          <span className="flex items-center gap-1.5">
            {status}
            <TaskIdBadge id={task.id} onNavigate={onNavigate} />
          </span>
        ) : undefined
      }
      identity={
        <>
          {!meta ? status : null}
          <TaskRowTitle
            task={task}
            selected={selected}
            dimmed={dimmed}
            onOpenTask={onOpenTask}
          />
          {!meta && showProjectBadge && task.projectId ? (
            <ProjectBadge
              projectId={task.projectId}
              projectsById={projectsById}
              size="sm"
            />
          ) : null}
          {!meta && task.openBlockerCount ? (
            <TaskBlockedIndicator
              openBlockers={task.openBlockerCount}
              size={12}
            />
          ) : null}
          {!meta ? <TaskIdBadge id={task.id} onNavigate={onNavigate} /> : null}
        </>
      }
      signals={
        signals &&
        (disclosure || !taskRowMetaEmpty({ ...signals, projectId: null })) ? (
          <>
            {disclosure}
            <TaskRowDetails
              task={task}
              meta={signals}
              projectsById={projectsById}
              onNavigate={onNavigate}
              showContext={false}
            />
          </>
        ) : undefined
      }
      actions={
        actions.length ? (
          <ListRowActions
            actions={actions}
            label="Task actions"
            alwaysVisible={alwaysVisible}
          />
        ) : undefined
      }
    />
  );
}
