import type { CalendarEventDto } from "@assistant/shared";
import { Button } from "../ui/button.tsx";
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
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(event.id);
      }}
      title={`${event.allDay ? "All day" : hm(event.start, timeZone)} · ${event.title}`}
      className={`group w-full justify-start truncate ${declined ? "line-through" : ""}`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${selected ? "bg-primary-foreground" : event.meetingUrl ? "bg-primary" : "bg-input"}`}
      />
      {!event.allDay && (
        <span
          className={`shrink-0 tabular-nums ${selected ? "text-primary-foreground/80" : "text-muted-foreground"}`}
        >
          {hm(event.start, timeZone)}
        </span>
      )}
      <span className="min-w-0 truncate">{event.title}</span>
    </Button>
  );
}
