import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { ListRow } from "./common/ListRow.tsx";
import { TaskListRowContent } from "./TaskListRowContent.tsx";
import type { ProjectRecord } from "@assistant/shared";
import {
  buildTaskRowMeta,
  type TaskRowMeta,
  type TaskRowMetaContext,
} from "../lib/taskRowMeta.ts";
import { EmptyBox } from "./common/load.tsx";
import { EXIT_STAGE_MS, ExitStage } from "./common/ExitStage.tsx";
import { usePrefersReducedMotion } from "./shell/usePrefersReducedMotion.ts";
import type { Task } from "../lib/backlogTree.ts";
import { buildInboxList } from "../lib/backlogInbox.ts";
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
 * @intent A triage queue, newest first, using the same TaskListRowContent and
 * metadata as Backlog and Focus. Its action accepts into the task list without
 * changing status. Everything else that
 * would process a Task (open it and set a date, change its status, give it a
 * project) already counts as triage on the server, so the Inbox empties as a
 * side effect of doing the work rather than needing a second gesture.
 * @related lib/backlogInbox.ts, BacklogList.tsx, BacklogFocusList.tsx
 */
export function BacklogInboxList({
  tasks,
  projectsById,
  metaContext,
  onNavigate,
  selectedId,
  onOpen,
  onDismiss,
  density,
  flush = false,
}: {
  tasks: Task[];
  projectsById: Map<string, ProjectRecord>;
  metaContext: TaskRowMetaContext;
  onNavigate?: ((path: string) => void) | undefined;
  selectedId: string | null;
  onOpen: (id: string) => void;
  /** Accept into the task list without changing status; take it out of Inbox. */
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
          meta={buildTaskRowMeta(task, metaContext)}
          onNavigate={onNavigate}
          selected={task.id === selectedId}
          onOpen={onOpen}
          onDismiss={dismissWithExit}
          leaving={leaving.includes(task.id)}
          tight={tight}
        />
      ))}
    </ul>
  );
}

function InboxRow({
  task,
  projectsById,
  meta,
  onNavigate,
  selected,
  onOpen,
  onDismiss,
  leaving,
  tight,
}: {
  task: Task;
  projectsById: Map<string, ProjectRecord>;
  meta: TaskRowMeta;
  onNavigate?: ((path: string) => void) | undefined;
  selected: boolean;
  onOpen: (id: string) => void;
  onDismiss: (task: Task) => void;
  /** Accepted, and on its way out (`ExitStage`). */
  leaving: boolean;
  tight: boolean;
}) {
  return (
    <li data-list-row-id={task.id}>
      {/* The hairline rides inside the exit, so it leaves with its row. */}
      <ExitStage leaving={leaving}>
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
            onOpenTask={onOpen}
            onNavigate={onNavigate}
            alwaysVisible
            actions={[
              {
                id: "dismiss",
                label: "Accept",
                accessibleLabel: `Accept "${task.title}" into the task list`,
                icon: <Check />,
                onSelect: () => onDismiss(task),
              },
            ]}
          />
        </ListRow>
      </ExitStage>
    </li>
  );
}
