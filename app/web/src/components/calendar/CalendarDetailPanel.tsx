import {
  CalendarClock,
  ChevronLeft,
  ExternalLink,
  MapPin,
  MessageSquarePlus,
  Users,
  Video,
} from "lucide-react";
import type {
  CalendarConferenceLink,
  CalendarEventDto,
} from "@assistant/shared";
import type { CalendarController } from "../../hooks/useCalendar.ts";
import { EmptyBox } from "../common/load.tsx";
import { Inspector, InspectorSection } from "../shell/Inspector.tsx";
import { hm } from "./calendarDates.ts";
import { useUserTimeZone } from "../../hooks/useUserTimeZone.ts";

interface CalendarDetailPanelProps {
  calendar: CalendarController;
  /** Start a fresh chat. */
  onNewSession: () => void;
}

function durationLabel(start: string | null, end: string | null): string {
  if (!start || !end) return "";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export function CalendarDetailPanel({
  calendar,
  onNewSession,
}: CalendarDetailPanelProps) {
  const { selectedDate, selectedEvent } = calendar;

  // A selected calendar entry makes the inspector about that event.
  if (selectedEvent) {
    return (
      <Inspector
        relations={[]}
        actions={[
          {
            key: "back",
            icon: <ChevronLeft size={15} />,
            label: "Back to day",
            onRun: () => calendar.selectEvent(null),
          },
        ]}
        sectionStorageScope="calendar-event"
      >
        <InspectorSection
          id="event"
          storageScope="calendar-event"
          title="Event"
          icon={<CalendarClock size={13} />}
        >
          <EventDetail event={selectedEvent} />
        </InspectorSection>
      </Inspector>
    );
  }

  return (
    <Inspector
      relations={[]}
      actions={[
        {
          key: "new",
          icon: <MessageSquarePlus size={15} />,
          label: "New session",
          onRun: onNewSession,
        },
      ]}
      sectionStorageScope={`calendar:${selectedDate}`}
    >
      <EmptyBox>Select an event to see its details.</EmptyBox>
    </Inspector>
  );
}

function EventDetail({ event }: { event: CalendarEventDto }) {
  const timeZone = useUserTimeZone();
  const duration = durationLabel(event.start, event.end);
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-1.5 text-caption text-fg">
        <CalendarClock size={13} className="shrink-0 text-muted-foreground" />
        <span className="tabular-nums">
          {event.allDay
            ? "All day"
            : `${hm(event.start, timeZone)} – ${hm(event.end, timeZone)}`}
        </span>
        {duration && !event.allDay && (
          <span className="text-muted-foreground">· {duration}</span>
        )}
        {event.selfResponse && event.selfResponse !== "accepted" && (
          <span className="ml-auto rounded bg-raised px-1.5 py-0.5 text-micro capitalize text-muted-foreground">
            {event.selfResponse}
          </span>
        )}
      </div>

      {event.location && (
        <div className="flex items-start gap-1.5 text-caption text-muted-foreground">
          <MapPin size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{event.location}</span>
        </div>
      )}

      {event.conferenceLinks.length > 0 && (
        <div className="flex flex-col gap-1">
          {event.conferenceLinks.map((link) => (
            <ConferenceButton key={link.uri} link={link} />
          ))}
        </div>
      )}

      {event.attendees.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-caption font-medium text-faint">
            <Users size={12} />
            {event.attendeeCount} guest{event.attendeeCount === 1 ? "" : "s"}
          </div>
          <div className="flex flex-col gap-0.5">
            {event.attendees.slice(0, 12).map((attendee, attendeeIndex) => (
              <div
                key={attendee.email ?? attendee.name ?? attendeeIndex}
                className="flex items-center gap-1.5 text-caption"
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    attendee.response === "accepted"
                      ? "bg-emerald-500"
                      : attendee.response === "declined"
                        ? "bg-red-500"
                        : attendee.response === "tentative"
                          ? "bg-yellow-500"
                          : "bg-line-strong"
                  }`}
                  title={attendee.response ?? "no response"}
                />
                <span
                  className={`min-w-0 truncate ${attendee.self ? "font-medium text-fg" : "text-muted-foreground"}`}
                >
                  {attendee.name ?? attendee.email}
                </span>
                {attendee.organizer && (
                  <span className="shrink-0 text-micro text-faint">
                    organizer
                  </span>
                )}
              </div>
            ))}
            {event.attendees.length > 12 && (
              <span className="text-micro text-faint">
                +{event.attendees.length - 12} more
              </span>
            )}
          </div>
        </div>
      )}

      {event.description && (
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words border-t border-line pt-2 text-caption text-muted-foreground">
          {event.description}
        </div>
      )}

      {event.htmlLink && (
        <a
          href={event.htmlLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-caption text-muted-foreground hover:text-primary"
        >
          <ExternalLink size={11} />
          Open in Google Calendar
        </a>
      )}
    </div>
  );
}

function ConferenceButton({ link }: { link: CalendarConferenceLink }) {
  const tone =
    link.provider === "zoom"
      ? "border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-500/10"
      : link.provider === "teams"
        ? "border-indigo-500/40 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-500/10"
        : "border-primary/40 text-primary hover:bg-accent";
  return (
    <a
      href={link.uri}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-caption font-medium transition-colors ${tone}`}
    >
      <Video size={13} />
      Join {link.label}
    </a>
  );
}
