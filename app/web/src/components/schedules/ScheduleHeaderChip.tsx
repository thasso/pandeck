import { memo } from "react";
import { CalendarClock } from "lucide-react";
import {
  formatScheduleDue,
  formatScheduleInstant,
  type ScheduleSummary,
} from "@assistant/shared/schedules";
import { schedulePath } from "../../hooks/useSessionRouting.ts";
import { openInApp } from "./scheduleLinks.ts";

/**
 * @component ScheduleHeaderChip
 * @purpose The session header's next scheduled prompt (AC12, U3): the
 *   earliest enabled repeating Schedule targeting the session
 *   (`nextRepeatingForSession`), linked to its detail.
 * @useWhen Beside the session title, as a sibling of the title block's links,
 *   never inside one.
 * @intent The due label shows from `md` up; on a phone the chip is the icon
 *   alone, and the approved label names it for every width.
 */
export const ScheduleHeaderChip = memo(function ScheduleHeaderChip({
  schedule,
  onOpen,
}: {
  /** Enabled, repeating, with a next occurrence. */
  schedule: ScheduleSummary & { nextDueAtMs: number };
  onOpen: (path: string) => void;
}) {
  const href = schedulePath(schedule.id);
  const label = `Next scheduled prompt: ${formatScheduleInstant(
    schedule.nextDueAtMs,
    schedule.timing.timeZone,
  )} · ${schedule.name}`;
  return (
    <a
      href={href}
      onClick={(event) => openInApp(event, href, onOpen)}
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <CalendarClock aria-hidden className="size-3 shrink-0" />
      <span className="hidden tabular-nums md:inline">
        {formatScheduleDue(schedule.nextDueAtMs, schedule.timing.timeZone)}
      </span>
    </a>
  );
});
