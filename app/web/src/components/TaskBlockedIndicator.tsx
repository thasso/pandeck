import { Ban } from "lucide-react";

/** The sentence every blocked marker carries as its tooltip. */
function taskBlockedTitle(openBlockers: number): string {
  return `Blocked: waiting on ${openBlockers} open ${openBlockers === 1 ? "Task" : "Tasks"}`;
}

/**
 * @component TaskBlockedIndicator
 * @purpose Says a Task is blocked — at least one Task it waits on is neither
 *   done nor archived (`TaskSummary.openBlockerCount`).
 * @useWhen Any Task row or Task page that states the Task's current state: the
 *   Backlog rows' meta line, a single-line row's title line (`glyph`), the Task
 *   page's facts line.
 * @intent ONE wording and one glyph everywhere. Warning-toned rather than
 *   destructive: being blocked never stops a status change, it is information.
 *   The count is the tooltip, because "blocked" is the fact a row has room for
 *   and "by how many" is the detail.
 */
export function TaskBlockedIndicator({
  openBlockers,
  glyph = false,
  size = 10,
  className = "",
}: {
  openBlockers: number;
  /** The glyph alone, for a line with room for one character. */
  glyph?: boolean;
  size?: number;
  className?: string;
}) {
  const title = taskBlockedTitle(openBlockers);
  if (glyph)
    return (
      <span
        role="img"
        aria-label={title}
        title={title}
        className={`inline-flex shrink-0 items-center text-warning ${className}`}
      >
        <Ban size={size} aria-hidden />
      </span>
    );
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-0.5 text-warning ${className}`}
    >
      <Ban size={size} aria-hidden />
      Blocked
    </span>
  );
}
