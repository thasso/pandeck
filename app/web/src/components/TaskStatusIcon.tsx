import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import type { TaskStatus } from "@assistant/shared";

/**
 * The Backlog's circular status glyph: empty for todo, dotted for doing, checked
 * for done.
 *
 * One implementation, because it is read as a STATE everywhere it appears — the
 * Backlog rows, the Task detail's title block, the object dock's status action —
 * and a glyph that means "doing" in one place and something subtly different in
 * another is worse than no glyph. It also doubles as the face of the control that
 * cycles status, so the thing you look at and the thing you press are the same.
 */
export function TaskStatusIcon({
  status,
  size = 16,
  claimed = false,
}: {
  status: TaskStatus;
  size?: number;
  claimed?: boolean;
}) {
  // A pending completion claim is a statement ABOUT the status, so it belongs on
  // the glyph rather than beside it: the shape still says where the Task stands,
  // and the amber says that an agent disputes it. Putting it in its own row item
  // would have been a second thing to notice, in a row that just lost every
  // trailing badge it had.
  if (claimed) {
    const Shape =
      status === "done"
        ? CheckCircle2
        : status === "doing"
          ? CircleDot
          : Circle;
    return <Shape size={size} className="text-amber-500" />;
  }
  if (status === "done")
    return <CheckCircle2 size={size} className="text-emerald-500" />;
  if (status === "doing")
    return <CircleDot size={size} className="text-primary" />;
  return <Circle size={size} className="text-faint" />;
}

/** Sentence-case label for the three statuses, for chips and control labels. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "In progress",
  done: "Done",
};
