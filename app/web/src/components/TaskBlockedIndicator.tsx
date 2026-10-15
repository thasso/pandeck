import { Ban } from "lucide-react";

/** What every blocked marker says to a screen reader and in its tooltip. */
function taskBlockedLabel(openBlockers: number): string {
  return `Blocked by ${openBlockers} open ${openBlockers === 1 ? "task" : "tasks"}`;
}

/**
 * @component TaskBlockedIndicator
 * @purpose Says a Task is blocked, and by how many — the Tasks it waits on that
 *   are neither done nor archived (`TaskSummary.openBlockerCount`).
 * @useWhen Any Task row or Task page that states the Task's current state: the
 *   Backlog rows' meta line, a single-line row's title line, the Task page's
 *   facts line.
 * @intent ONE glyph and one label everywhere. Warning-toned rather than
 *   destructive: being blocked never stops a status change, it is information.
 *   A row has room for the glyph and the COUNT, which is what tells a Task
 *   waiting on one thing from one waiting on five; `label` adds the word where
 *   there is a line for it. The full sentence is the accessible name.
 */
export function TaskBlockedIndicator({
  openBlockers,
  label = false,
  size = 10,
  className = "",
}: {
  openBlockers: number;
  /** Lead with the word "Blocked" — a page's facts line, not a row. */
  label?: boolean;
  size?: number;
  className?: string;
}) {
  const name = taskBlockedLabel(openBlockers);
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={`inline-flex shrink-0 items-center gap-0.5 text-warning tabular-nums ${className}`}
    >
      <Ban size={size} aria-hidden />
      <span aria-hidden>
        {label ? `Blocked · ${openBlockers}` : openBlockers}
      </span>
    </span>
  );
}
