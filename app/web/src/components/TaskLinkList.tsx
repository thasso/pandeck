import { useState } from "react";
import type { TaskStatus } from "@assistant/shared";
import { Button } from "./ui/button.tsx";
import { TaskStatusIcon } from "./TaskStatusIcon.tsx";

/** One Task as a link row, with the Tasks under it when it is a tree. */
export interface TaskLinkItem {
  id: string;
  title: string;
  status: TaskStatus;
  children?: TaskLinkItem[] | undefined;
}

/**
 * @component TaskLinkList
 * @purpose Tasks listed as links to them: the status glyph, the title (struck
 *   through once done) and the id, a row that opens the Task. Subtasks nest
 *   under their parent on a guide line.
 * @useWhen Anywhere a Task is named as a related object rather than worked on
 *   — the Task page's subtasks, the inspectors' Tasks sections — so a Task
 *   reads the same in each.
 * @avoidWhen The Backlog, which edits and drags Tasks (`TaskRowBody`).
 * @intent `maxVisible` bounds the TOP-LEVEL rows until "Show more": a long list
 *   (a session's tasks) must not push what is under it off the panel.
 */
export function TaskLinkList({
  items,
  onOpen,
  maxVisible,
}: {
  items: TaskLinkItem[];
  onOpen: (id: string) => void;
  maxVisible?: number | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const limit =
    maxVisible !== undefined && !showAll ? maxVisible : items.length;
  const hidden = items.length - limit;
  return (
    <ul className="flex flex-col">
      {items.slice(0, limit).map((item) => (
        <TaskLinkRow key={item.id} item={item} onOpen={onOpen} />
      ))}
      {hidden > 0 ? (
        <li>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start font-normal text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            Show {hidden} more
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

function TaskLinkRow({
  item,
  onOpen,
}: {
  item: TaskLinkItem;
  onOpen: (id: string) => void;
}) {
  return (
    <li>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2 font-normal"
        onClick={() => onOpen(item.id)}
      >
        <TaskStatusIcon status={item.status} size={14} />
        <span
          className={`min-w-0 flex-1 truncate text-left ${item.status === "done" ? "text-muted-foreground line-through" : ""}`}
        >
          {item.title}
        </span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          #{item.id}
        </span>
      </Button>
      {item.children?.length ? (
        <ul className="ml-3 flex flex-col border-l pl-2">
          {item.children.map((child) => (
            <TaskLinkRow key={child.id} item={child} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
