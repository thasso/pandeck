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
import { Card } from "../ui/card.tsx";
import { Badge } from "../ui/badge.tsx";
import { LinkButton } from "../common/LinkButton.tsx";
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
    <Card className="gap-2.5">
      <div className="flex items-center gap-1.5 text-sm text-foreground">
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
          <Badge
            variant={
              event.selfResponse === "declined"
                ? "destructive"
                : event.selfResponse === "tentative"
                  ? "warning"
                  : "secondary"
            }
            className="ml-auto capitalize"
          >
            {event.selfResponse}
          </Badge>
        )}
      </div>

      {event.location && (
        <div className="flex items-start gap-1.5 text-sm text-muted-foreground">
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
          <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Users size={12} />
            {event.attendeeCount} guest{event.attendeeCount === 1 ? "" : "s"}
          </div>
          <div className="flex flex-col gap-0.5">
            {event.attendees.slice(0, 12).map((attendee, attendeeIndex) => (
              <div
                key={attendee.email ?? attendee.name ?? attendeeIndex}
                className="flex items-center gap-1.5 text-sm"
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    attendee.response === "accepted"
                      ? "bg-success"
                      : attendee.response === "declined"
                        ? "bg-destructive"
                        : attendee.response === "tentative"
                          ? "bg-warning"
                          : "bg-input"
                  }`}
                  title={attendee.response ?? "no response"}
                />
                <span
                  className={`min-w-0 truncate ${attendee.self ? "font-medium text-foreground" : "text-muted-foreground"}`}
                >
                  {attendee.name ?? attendee.email}
                </span>
                {attendee.organizer && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    organizer
                  </span>
                )}
              </div>
            ))}
            {event.attendees.length > 12 && (
              <span className="text-xs text-muted-foreground">
                +{event.attendees.length - 12} more
              </span>
            )}
          </div>
        </div>
      )}

      {event.description && (
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words border-t border-border pt-2 text-sm text-muted-foreground">
          {event.description}
        </div>
      )}

      {event.htmlLink && (
        <a
          href={event.htmlLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
        >
          <ExternalLink size={11} />
          Open in Google Calendar
        </a>
      )}
    </Card>
  );
}

function ConferenceButton({ link }: { link: CalendarConferenceLink }) {
  return (
    <LinkButton
      href={link.uri}
      target="_blank"
      rel="noopener noreferrer"
      variant="outline"
      size="sm"
      className="justify-center"
    >
      <Video />
      Join {link.label}
    </LinkButton>
  );
}
