import type { CalendarEventDto } from "@assistant/shared";
import { hm } from "./calendarDates.ts";
import { useUserTimeZone } from "../../hooks/useUserTimeZone.ts";

/** Compact one-line event chip for the month grid. Clicking selects the event
 *  (opens the detail pane) rather than navigating to Google Calendar. */
export function EventChip({
  event,
  selected,
  onSelect,
}: {
  event: CalendarEventDto;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const timeZone = useUserTimeZone();
  const declined = event.selfResponse === "declined";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(event.id);
      }}
      title={`${event.allDay ? "All day" : hm(event.start, timeZone)} · ${event.title}`}
      className={`group flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-sm transition-colors ${
        selected ? "bg-primary text-primary-foreground" : "hover:bg-accent"
      } ${declined && !selected ? "text-faint line-through" : selected ? "" : "text-fg"}`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${selected ? "bg-primary-foreground" : event.meetingUrl ? "bg-primary" : "bg-line-strong"}`}
      />
      {!event.allDay && (
        <span
          className={`shrink-0 tabular-nums ${selected ? "text-primary-foreground/80" : "text-muted-foreground"}`}
        >
          {hm(event.start, timeZone)}
        </span>
      )}
      <span className="min-w-0 truncate">{event.title}</span>
    </button>
  );
}
