import { useEffect, useRef, useState } from "react";
import { Clock, Video } from "lucide-react";
import type { CalendarEventDto, CalendarWorklogDto } from "@assistant/shared";
import { useNow } from "../../hooks/useNow.ts";
import { useUserTimeZone } from "../../hooks/useUserTimeZone.ts";
import {
  dayOfMonth,
  hm,
  minutesOfDay,
  sameDay,
  shortWeekday,
  todayIso,
} from "./calendarDates.ts";

const DAY_MINUTES = 24 * 60;
const MIN_EVENT_MINUTES = 25;
const MIN_HOUR_PX = 22;
const MAX_HOUR_PX = 160;

interface TimeGridProps {
  days: string[];
  eventsByDay: Map<string, CalendarEventDto[]>;
  /** Logged Tempo time per day, rendered as a parallel right-hand track. */
  worklogsByDay?: Map<string, CalendarWorklogDto[]> | undefined;
  selectedDate: string;
  selectedEventId: string | null;
  onSelectDay: (date: string) => void;
  /** Jump into Day view for a date (from the header day-number). */
  onOpenDay: (date: string) => void;
  onSelectEvent: (id: string) => void;
  /** Show per-day column headers (week view). Day view hides them. */
  showHeaders: boolean;
  /** Persisted vertical zoom (pixels per hour). */
  hourPx: number;
  /** Persist a new zoom level (debounced by the caller's pref store). */
  onHourPxChange: (hourPx: number) => void;
}

interface Positioned {
  event: CalendarEventDto;
  topPx: number;
  heightPx: number;
  leftPct: number;
  widthPct: number;
}

/** Greedy column packing for overlapping events within one day column. */
function layoutDay(
  events: CalendarEventDto[],
  hourPx: number,
  timeZone: string,
): Positioned[] {
  const timed = events
    .filter((event) => !event.allDay && event.start)
    .map((event) => {
      const start = minutesOfDay(event.start, timeZone);
      const rawEnd =
        event.end && sameDay(event.start, event.end, timeZone)
          ? minutesOfDay(event.end, timeZone)
          : DAY_MINUTES;
      const end = Math.min(
        DAY_MINUTES,
        Math.max(rawEnd, start + MIN_EVENT_MINUTES),
      );
      return { event, start, end };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: Positioned[] = [];
  let cluster: Array<{
    event: CalendarEventDto;
    start: number;
    end: number;
    col: number;
  }> = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    const cols = Math.max(...cluster.map((item) => item.col)) + 1;
    for (const item of cluster) {
      out.push({
        event: item.event,
        topPx: (item.start / 60) * hourPx,
        heightPx: Math.max(((item.end - item.start) / 60) * hourPx, 12),
        leftPct: (item.col / cols) * 100,
        widthPct: (1 / cols) * 100,
      });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const item of timed) {
    if (clusterEnd >= 0 && item.start >= clusterEnd) flush();
    const colEnds: number[] = [];
    for (const member of cluster)
      colEnds[member.col] = Math.max(colEnds[member.col] ?? 0, member.end);
    let col = colEnds.findIndex((end) => end <= item.start);
    if (col < 0) col = colEnds.length;
    cluster.push({ ...item, col });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return out;
}

export function TimeGrid({
  days,
  eventsByDay,
  worklogsByDay,
  selectedDate,
  selectedEventId,
  onSelectDay,
  onOpenDay,
  onSelectEvent,
  showHeaders,
  hourPx,
  onHourPxChange,
}: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timeZone = useUserTimeZone();
  const today = todayIso(timeZone);
  const [zoom, setZoom] = useState(hourPx);

  // Adopt external zoom changes (e.g. another surface) without fighting local edits.
  useEffect(() => setZoom(hourPx), [hourPx]);

  // Persist the zoom shortly after it settles.
  useEffect(() => {
    if (zoom === hourPx) return;
    const timer = setTimeout(() => onHourPxChange(zoom), 350);
    return () => clearTimeout(timer);
  }, [zoom, hourPx, onHourPxChange]);

  // Scroll to ~7am when the visible range changes — and ONLY then. `zoom` is
  // read through a ref on purpose: re-running this on a zoom change would yank
  // the grid back to 7am mid-pinch, under the finger doing the zooming.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const firstDay = days[0];
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * zoomRef.current;
  }, [firstDay]);

  // Shift+wheel or trackpad pinch (ctrlKey) adjusts the vertical time scale.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.shiftKey) return;
      e.preventDefault();
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      setZoom((current) => {
        const next = current * (delta > 0 ? 0.92 : 1.08);
        return Math.round(Math.min(MAX_HOUR_PX, Math.max(MIN_HOUR_PX, next)));
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const now = useNow(60_000);
  const nowMinutes = minutesOfDay(new Date(now).toISOString(), timeZone);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showHeaders && (
        <div className="flex shrink-0 border-b border-line pl-12">
          {days.map((date) => {
            const isToday = date === today;
            return (
              <button
                key={date}
                type="button"
                onClick={() => onSelectDay(date)}
                title="Select day"
                className={`flex flex-1 items-baseline justify-center gap-1.5 border-l border-line py-1.5 text-left first:border-l-0 hover:bg-raised/60 ${
                  date === selectedDate ? "bg-accent/30" : ""
                }`}
              >
                <span className="text-sm uppercase tracking-wide text-faint">
                  {shortWeekday(date)}
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  title="Open day view"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenDay(date);
                  }}
                  className={`flex size-5 items-center justify-center rounded-full text-sm hover:ring-1 hover:ring-primary ${isToday ? "bg-primary font-semibold text-primary-foreground" : "text-fg"}`}
                >
                  {dayOfMonth(date)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <AllDayBand
        days={days}
        eventsByDay={eventsByDay}
        selectedEventId={selectedEventId}
        onSelectEvent={onSelectEvent}
      />

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="relative flex" style={{ height: zoom * 24 }}>
          <div className="relative w-12 shrink-0">
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                className="absolute right-1 -translate-y-1/2 text-xs tabular-nums text-faint"
                style={{ top: h * zoom }}
              >
                {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
              </div>
            ))}
          </div>

          {days.map((date) => {
            const positioned = layoutDay(
              eventsByDay.get(date) ?? [],
              zoom,
              timeZone,
            );
            const dayWorklogs = worklogsByDay?.get(date) ?? [];
            // With Tempo shown, events keep the left ~68% and logged time gets a
            // parallel right-hand track so overlaps stay readable.
            const eventScale = dayWorklogs.length > 0 ? 0.68 : 1;
            const isToday = date === today;
            return (
              <div
                key={date}
                className="relative min-w-0 flex-1 border-l border-line"
                onClick={() => onSelectDay(date)}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-line/50"
                    style={{ top: h * zoom }}
                  />
                ))}
                {isToday && (
                  <div
                    className="absolute inset-x-0 z-10 border-t-2 border-red-500"
                    style={{ top: (nowMinutes / 60) * zoom }}
                  >
                    <span className="absolute -left-1 -top-1 size-2 rounded-full bg-red-500" />
                  </div>
                )}
                {positioned.map(
                  ({ event, topPx, heightPx, leftPct, widthPct }) => (
                    <EventBlock
                      key={event.id}
                      event={event}
                      topPx={topPx}
                      heightPx={heightPx}
                      leftPct={leftPct * eventScale}
                      widthPct={widthPct * eventScale}
                      selected={event.id === selectedEventId}
                      onSelect={onSelectEvent}
                    />
                  ),
                )}
                {dayWorklogs.map((worklog, i) => (
                  <TempoBlock
                    key={worklog.id}
                    worklog={worklog}
                    index={i}
                    zoom={zoom}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AllDayBand({
  days,
  eventsByDay,
  selectedEventId,
  onSelectEvent,
}: {
  days: string[];
  eventsByDay: Map<string, CalendarEventDto[]>;
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
}) {
  const anyAllDay = days.some((date) =>
    (eventsByDay.get(date) ?? []).some((event) => event.allDay),
  );
  if (!anyAllDay) return null;
  return (
    <div className="flex shrink-0 border-b border-line pl-12">
      {days.map((date) => {
        const allDay = (eventsByDay.get(date) ?? []).filter(
          (event) => event.allDay,
        );
        return (
          <div
            key={date}
            className="flex min-w-0 flex-1 flex-col gap-0.5 border-l border-line p-1 first:border-l-0"
          >
            {allDay.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => onSelectEvent(event.id)}
                className={`truncate rounded px-1 py-0.5 text-left text-xs ${
                  event.id === selectedEventId
                    ? "bg-primary text-primary-foreground"
                    : "bg-accent text-primary hover:opacity-80"
                }`}
              >
                {event.title}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** A logged Tempo worklog in the parallel right-hand track (emerald, distinct from events). */
function TempoBlock({
  worklog,
  index,
  zoom,
}: {
  worklog: CalendarWorklogDto;
  index: number;
  zoom: number;
}) {
  const hours = worklog.seconds / 3600;
  const hoursLabel = Number.isInteger(hours)
    ? `${hours}h`
    : `${hours.toFixed(2)}h`;
  const startMin = worklog.startTime
    ? Number(worklog.startTime.slice(0, 2)) * 60 +
      Number(worklog.startTime.slice(3, 5))
    : null;
  // Timed worklogs sit at their start; untimed ones stack from the top of the track.
  const topPx =
    startMin != null && Number.isFinite(startMin)
      ? (startMin / 60) * zoom
      : index * 18;
  const heightPx = Math.max((worklog.seconds / 3600) * zoom, 14);
  const label = worklog.issueKey ?? worklog.description ?? "Logged";
  const body = (
    <>
      <div className="flex items-center gap-1">
        <Clock size={9} className="shrink-0" />
        <span className="min-w-0 truncate font-medium">{label}</span>
      </div>
      {heightPx > 26 && (
        <div className="truncate text-xs tabular-nums opacity-80">
          {hoursLabel}
        </div>
      )}
    </>
  );
  const className =
    "absolute z-[1] overflow-hidden rounded-md border border-emerald-500/40 bg-emerald-500/15 px-1 py-0.5 text-left text-xs text-emerald-700 dark:text-emerald-300";
  const style = {
    top: topPx + 1,
    height: heightPx - 2,
    left: "70%",
    width: "29%",
  };
  return worklog.issueUrl ? (
    <a
      href={worklog.issueUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`${hoursLabel} · ${worklog.description || label}`}
      className={`${className} hover:bg-emerald-500/25`}
      style={style}
    >
      {body}
    </a>
  ) : (
    <div
      title={`${hoursLabel} · ${worklog.description || label}`}
      className={className}
      style={style}
    >
      {body}
    </div>
  );
}

function EventBlock({
  event,
  topPx,
  heightPx,
  leftPct,
  widthPct,
  selected,
  onSelect,
}: {
  event: CalendarEventDto;
  topPx: number;
  heightPx: number;
  leftPct: number;
  widthPct: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const timeZone = useUserTimeZone();
  const declined = event.selfResponse === "declined";
  const compact = heightPx < 34;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(event.id);
      }}
      title={`${hm(event.start, timeZone)}–${hm(event.end, timeZone)} · ${event.title}`}
      className={`absolute z-[1] overflow-hidden rounded-md border px-1.5 py-0.5 text-left transition-shadow ${
        selected
          ? "border-primary bg-accent ring-1 ring-primary"
          : "border-primary/30 bg-accent/70 hover:border-primary/60"
      } ${declined ? "opacity-50" : ""}`}
      style={{
        top: topPx + 1,
        height: heightPx - 2,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
      }}
    >
      <div
        className={`flex items-center gap-1 ${declined ? "line-through" : ""}`}
      >
        {event.meetingUrl && (
          <Video size={9} className="shrink-0 text-primary" />
        )}
        <span
          className={`min-w-0 truncate text-sm font-medium ${selected ? "text-primary" : "text-fg"}`}
        >
          {event.title}
        </span>
      </div>
      {!compact && (
        <div className="truncate text-xs tabular-nums text-muted-foreground">
          {hm(event.start, timeZone)}
        </div>
      )}
    </button>
  );
}
