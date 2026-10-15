import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Item } from "./ui/item.tsx";
import { IconButton } from "./common/IconButton.tsx";
import type { ProjectRecord } from "@assistant/shared";
import {
  TaskStatusIcon as StatusIcon,
  TASK_STATUS_LABEL,
} from "./TaskStatusIcon.tsx";
import { TaskProjectMeta } from "./TaskRowBody.tsx";
import { TaskBlockedIndicator } from "./TaskBlockedIndicator.tsx";
import { TaskIdBadge } from "./TaskIdBadge.tsx";
import { EmptyBox } from "./common/load.tsx";
import { EXIT_STAGE_MS, ExitStage } from "./common/ExitStage.tsx";
import { usePrefersReducedMotion } from "./shell/usePrefersReducedMotion.ts";
import {
  nextStatus,
  pendingStatusSuggestion,
  type Task,
} from "../lib/backlogTree.ts";
import { buildInboxList, taskOrigin } from "../lib/backlogInbox.ts";
import { taskPath } from "../hooks/useSessionRouting.ts";
import { followRowLink } from "../lib/rowLink.ts";
import type { BacklogDensity } from "../lib/backlogTreeModel.ts";

/** How long an accepted row stays hidden waiting for the save to take it
 *  out of the list, before it is shown again as not accepted. */
const RESTORE_AFTER_MS = 5000;

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
  flush = false,
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
  /** Edge-to-edge, hairline-divided rows (the sidebar); see `BacklogList`. */
  flush?: boolean;
}) {
  const tight = density === "tight";
  const items = useMemo(() => buildInboxList(tasks), [tasks]);
  // Accepting lets the row go the way settling a session does: it slides out
  // and the list closes behind it, and only then is the save sent, so the
  // update it causes never cuts the exit short. Reduced motion sends at once.
  //
  // The row stays gone until the Task actually LEAVES the list. Clearing the
  // mark when the save goes out let the row spring back for the round trip
  // and vanish again on the answer — the flicker. If the save never takes the
  // Task out (refused, offline), the row comes back after `RESTORE_AFTER_MS`
  // rather than staying invisible.
  const reducedMotion = usePrefersReducedMotion();
  const [leaving, setLeaving] = useState<string[]>([]);
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);
  // A Task that has left the list needs no mark (or timer) any more.
  useEffect(() => {
    const present = new Set(items.map((task) => task.id));
    setLeaving((ids) => {
      const kept = ids.filter((id) => present.has(id));
      if (kept.length === ids.length) return ids;
      for (const id of ids)
        if (!present.has(id)) {
          window.clearTimeout(timers.current.get(id));
          timers.current.delete(id);
        }
      return kept;
    });
  }, [items]);
  const dismissWithExit = (task: Task) => {
    if (reducedMotion) {
      onDismiss(task);
      return;
    }
    if (timers.current.has(task.id)) return;
    setLeaving((ids) => [...ids, task.id]);
    timers.current.set(
      task.id,
      window.setTimeout(() => {
        onDismiss(task);
        timers.current.set(
          task.id,
          window.setTimeout(() => {
            timers.current.delete(task.id);
            setLeaving((ids) => ids.filter((id) => id !== task.id));
          }, RESTORE_AFTER_MS),
        );
      }, EXIT_STAGE_MS),
    );
  };

  if (items.length === 0) {
    return (
      <EmptyBox>
        Inbox zero. Tasks that arrive on their own — from meeting minutes,
        Slack, or an agent — wait here until you have looked at them.
      </EmptyBox>
    );
  }

  return (
    <ul data-flush-list={flush || undefined} className="flex flex-col">
      {items.map((task) => (
        <InboxRow
          key={task.id}
          task={task}
          projectsById={projectsById}
          showProjectBadge={showProjectBadge}
          selected={task.id === selectedId}
          onOpen={onOpen}
          onCycle={onCycle}
          onDismiss={dismissWithExit}
          leaving={leaving.includes(task.id)}
          tight={tight}
          flush={flush}
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
  leaving,
  tight,
  flush,
}: {
  task: Task;
  projectsById: Map<string, ProjectRecord>;
  showProjectBadge: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onCycle: (task: Task) => void;
  onDismiss: (task: Task) => void;
  /** Accepted, and on its way out (`ExitStage`). */
  leaving: boolean;
  tight: boolean;
  flush: boolean;
}) {
  const origin = taskOrigin(task);
  // The preview is what the row is FOR — deciding about a Task you did not
  // write needs its first sentence, not just its title. It is dropped when the
  // Task has no body rather than leaving an empty line.
  const preview = task.descriptionPreview?.trim();

  return (
    <li data-list-row-id={task.id}>
      {/* The hairline rides inside the exit, so it leaves with its row. */}
      <ExitStage leaving={leaving}>
        <div className={flush ? "border-b border-border/60" : undefined}>
          {/* The Focus row's shape: the row is the click surface, the TITLE the
          link to the Task; the status glyph and the one action (dismiss) sit
          on the title line. */}
          <Item
            size={tight ? "xs" : "sm"}
            variant={selected ? "muted" : flush ? "default" : "outline"}
            onClick={() => onOpen(task.id)}
            className={`min-w-0 cursor-pointer flex-nowrap items-start gap-1.5 text-left ${tight ? "py-1" : "py-1.5"} ${
              flush ? "rounded-none border-0 pr-2 pl-1 hover:bg-muted" : "px-1"
            }`}
          >
            <IconButton
              label={`Status: ${TASK_STATUS_LABEL[task.status]}. Mark as ${TASK_STATUS_LABEL[nextStatus(task.status)].toLowerCase()}`}
              size={tight ? "icon-xs" : "icon-sm"}
              className="shrink-0"
              onClick={(event) => {
                event.stopPropagation();
                onCycle(task);
              }}
            >
              <StatusIcon
                status={task.status}
                size={tight ? 14 : 16}
                claimed={Boolean(pendingStatusSuggestion(task))}
              />
            </IconButton>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <a
                href={taskPath(task.id)}
                draggable={false}
                className={`min-w-0 truncate text-sm ${selected ? "font-medium" : ""} text-foreground`}
                onClick={(event) => {
                  event.stopPropagation();
                  followRowLink(event, taskPath(task.id), () =>
                    onOpen(task.id),
                  );
                }}
              >
                {task.title}
              </a>
              {/* Where it came from — what you decide with — after the id, as
              every Task row's second line. */}
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
                {showProjectBadge && task.projectId ? (
                  <TaskProjectMeta
                    projectId={task.projectId}
                    projectsById={projectsById}
                    href={null}
                  />
                ) : null}
                <TaskIdBadge id={task.id} />
                {task.openBlockerCount ? (
                  <TaskBlockedIndicator openBlockers={task.openBlockerCount} />
                ) : null}
                <span className="shrink-0">{origin}</span>
              </span>
              {preview ? (
                <p className="truncate text-xs text-muted-foreground">
                  {preview}
                </p>
              ) : null}
            </div>
            <IconButton
              label={`Dismiss "${task.title}" from the Inbox`}
              size={tight ? "icon-xs" : "icon-sm"}
              className="shrink-0"
              onClick={(event) => {
                event.stopPropagation();
                onDismiss(task);
              }}
            >
              <Check />
            </IconButton>
          </Item>
        </div>
      </ExitStage>
    </li>
  );
}
