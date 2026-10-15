import type { TaskLinkedTask, TaskLinks } from "@assistant/shared";
import { TaskLinkList, type TaskLinkItem } from "./TaskLinkList.tsx";

/** The groups in the order they are read: what holds this Task up first. */
const GROUPS: ReadonlyArray<{ key: keyof TaskLinks; label: string }> = [
  { key: "blockedBy", label: "Blocked by" },
  { key: "blocks", label: "Blocks" },
  { key: "relates", label: "Related" },
];

function linkItem(task: TaskLinkedTask): TaskLinkItem {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.archived ? { archived: true } : {}),
  };
}

/**
 * @component TaskLinksSection
 * @purpose A Task's links to other Tasks on its page, grouped as they read
 *   from this Task: Blocked by, Blocks, Related. Each row is a `TaskLinkList`
 *   row — status glyph, title, id — that opens the linked Task.
 * @useWhen The Task page, from the full Task's `links` (`getTask`). Summaries
 *   never carry links.
 * @avoidWhen Editing links: agents manage them (`task_manage`), so this is
 *   read-only and offers no add or remove.
 * @intent Says nothing when there is nothing to say: an empty group is
 *   dropped, and a Task with no links renders no section at all. Done and
 *   archived Tasks stay listed — a done blocker is why this Task is no longer
 *   blocked — but toned back, as `TaskLinkList` draws them.
 */
export function TaskLinksSection({
  links,
  onOpenTask,
}: {
  links: TaskLinks | undefined;
  onOpenTask: (id: string) => void;
}) {
  const groups = GROUPS.filter(({ key }) => links?.[key].length);
  if (!links || !groups.length) return null;
  return (
    <section aria-label="Links" className="mb-6 flex flex-col gap-3">
      {groups.map(({ key, label }) => (
        <div key={key} role="group" aria-label={label}>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {label}
          </p>
          <TaskLinkList items={links[key].map(linkItem)} onOpen={onOpenTask} />
        </div>
      ))}
    </section>
  );
}
