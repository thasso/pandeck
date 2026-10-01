import { defineAgentTool } from "../../mcp/tool.ts";
import {
  ensureGoogleAccessToken,
  getGoogleToolConfig,
} from "../../googleSettings.ts";
import { findMeetRecordsForCalendarEvent } from "../../googleWorkspaceLinking.ts";
import {
  formatLocalDateTime,
  localDayRange,
  normalizeRfc3339,
} from "../../googleTime.ts";

type CalendarEventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type CalendarPerson = {
  id?: string;
  email?: string;
  displayName?: string;
  self?: boolean;
};

type CalendarAttendee = CalendarPerson & {
  optional?: boolean;
  organizer?: boolean;
  resource?: boolean;
  responseStatus?: string;
  comment?: string;
};

type CalendarEvent = {
  id?: string;
  iCalUID?: string;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: CalendarPerson;
  organizer?: CalendarPerson;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
  endTimeUnspecified?: boolean;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: CalendarEventDateTime;
  transparency?: string;
  visibility?: string;
  attendees?: CalendarAttendee[];
  hangoutLink?: string;
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: {
      key?: { type?: string };
      name?: string;
      iconUri?: string;
    };
    entryPoints?: Array<{
      entryPointType?: string;
      uri?: string;
      label?: string;
      pin?: string;
      accessCode?: string;
      meetingCode?: string;
      passcode?: string;
      password?: string;
    }>;
  };
  attachments?: Array<{
    fileUrl?: string;
    title?: string;
    mimeType?: string;
    iconLink?: string;
    fileId?: string;
  }>;
  eventType?: string;
  [key: string]: unknown;
};

type CalendarEventsPage = {
  summary?: string;
  timeZone?: string;
  nextPageToken?: string;
  items?: CalendarEvent[];
};

type DetailLevel = "compact" | "standard" | "full";

type ListCalendarEventsParams = {
  date?: string;
  from?: string;
  to?: string;
  calendarId?: string;
  query?: string;
  includeDeclined?: boolean;
  includeCancelled?: boolean;
  includeDescriptions?: boolean;
  includeMeetRecords?: boolean;
  includeMeetArtifacts?: boolean;
  detailLevel?: DetailLevel;
  render?: boolean;
  maxResults?: number;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/";

const listCalendarEventsParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    date: {
      type: "string",
      description:
        "User-local day in YYYY-MM-DD format. Expands to that day's start/end range.",
    },
    from: {
      type: "string",
      description:
        "RFC3339 lower bound for event start/end overlap. Optional if date is provided.",
    },
    to: {
      type: "string",
      description:
        "RFC3339 upper bound for event start/end overlap. Optional if date is provided.",
    },
    calendarId: {
      type: "string",
      description: "Calendar id to read. Defaults to primary.",
    },
    query: {
      type: "string",
      description: "Optional Google Calendar full-text search query (q).",
    },
    includeDeclined: {
      type: "boolean",
      description:
        "Include events where the configured Google user declined. Defaults to true so declined meetings are visible as evidence.",
    },
    includeCancelled: {
      type: "boolean",
      description: "Include cancelled events. Defaults to false.",
    },
    includeDescriptions: {
      type: "boolean",
      description:
        "Include event descriptions, truncated to keep output readable. Defaults to false in compact mode; request explicitly when descriptions are needed.",
    },
    includeMeetRecords: {
      type: "boolean",
      description:
        "For events with a Google Meet code, deterministically fetch matching Meet conference records from the same user-local day. Defaults to false; request explicitly for attendance evidence.",
    },
    includeMeetArtifacts: {
      type: "boolean",
      description:
        "When Meet records are included, also fetch Meet-generated transcripts/notes and recordings metadata. Defaults to false unless explicitly requested. An artifact with a driveFileId is retrieved with google_drive_get_file before you summarize it.",
    },
    detailLevel: {
      type: "string",
      enum: ["compact", "standard", "full"],
      description:
        "How much event detail to return. compact is the default and returns agenda/evidence rows; standard includes attendees/descriptions when requested; full preserves verbose Meet participant/link details. render=true uses full.",
    },
    render: {
      type: "boolean",
      description:
        "Set true only when the user explicitly asks for a visual/card/table/agenda-style display. The UI will render a rich Calendar card in addition to the assistant's text; do not repeat the rendered events in prose, add only what the card does not show (conflicts, missing attendance evidence, caveats).",
    },
    maxResults: {
      type: "number",
      description: "Maximum events to return. Defaults to 25, maximum 500.",
    },
  },
} as const;

const googleCalendarListEventsTool = defineAgentTool<ListCalendarEventsParams>({
  name: "google_calendar_list_events",
  label: "Google Calendar: List Events",
  description:
    "List read-only Google Calendar events for a date/range from a calendar, including attendees, response status, links, and Meet conference details. An event does not prove attendance on its own — ask for includeMeetRecords, or use google_meet_list_records, and weigh selfAttendee.responseStatus (a declined meeting is normally not attended). Cite an event with its markdownLink, or htmlLink as the href; never write a placeholder link like [title](...), and leave the title unlinked if you have neither.",
  parameters: listCalendarEventsParamsSchema,
  async execute(params) {
    const range = normalizeRange(params);
    if (!range.from || !range.to)
      throw new Error(
        "Provide date or both from and to to avoid an unbounded Google Calendar query.",
      );

    const calendarId = params.calendarId?.trim() || "primary";
    const detailLevel = normalizeDetailLevel(
      params.detailLevel,
      params.render === true ? "full" : "compact",
    );
    const includeDeclined = params.includeDeclined !== false;
    const includeCancelled = params.includeCancelled === true;
    const includeDescriptions =
      params.render === true ||
      params.includeDescriptions === true ||
      detailLevel === "full";
    const includeMeetRecords =
      params.render === true || params.includeMeetRecords === true;
    const includeMeetArtifacts =
      params.render === true || params.includeMeetArtifacts === true;
    const maxResults = clampMax(params.maxResults);

    const config = getGoogleToolConfig();
    const accessToken = await ensureGoogleAccessToken(config);
    const page = await listEvents({
      accessToken,
      calendarId,
      from: range.from,
      to: range.to,
      ...(params.query !== undefined ? { query: params.query } : {}),
      includeCancelled,
      maxResults,
    });

    const filtered = page.items.filter((event) => {
      if (!includeCancelled && event.status === "cancelled") return false;
      if (
        !includeDeclined &&
        selfAttendee(event)?.responseStatus === "declined"
      )
        return false;
      return true;
    });

    const events = [];
    for (const event of filtered) {
      const meetRecords = includeMeetRecords
        ? await findMeetRecordsForCalendarEvent({
            accessToken,
            event,
            includeParticipants: true,
            includeParticipantSessions: true,
            includeArtifacts: includeMeetArtifacts,
          })
        : [];
      events.push(
        calendarEventForDetail(
          { ...normalizeEvent(event, { includeDescriptions }), meetRecords },
          detailLevel,
        ),
      );
    }
    const payload = {
      calendarId,
      calendarSummary: page.summary ?? null,
      calendarTimeZone: page.timeZone ?? null,
      date: params.date ?? null,
      from: range.from,
      to: range.to,
      localFrom: formatLocalDateTime(range.from),
      localTo: formatLocalDateTime(range.to),
      query: params.query ?? null,
      includeDeclined,
      includeCancelled,
      includeMeetRecords,
      includeMeetArtifacts,
      detailLevel,
      renderRequested: params.render === true,
      eventCount: events.length,
      presentationGuidance:
        params.render === true
          ? "The UI will render these events as a rich Calendar card. Do not duplicate the full event list in text; only add concise context not already visible in the card, such as conflicts, caveats, missing attendance evidence, or available Meet artifacts. Never use placeholder links like [title](...)."
          : "Compact Calendar rows are returned by default. Use localStart/localEnd for user-local times and markdownLink/htmlLink for real links. Calendar presence does not prove attendance; request includeMeetRecords=true or call google_meet_list_records with participantFilter for attendance evidence. Request includeDescriptions/includeMeetArtifacts only when needed.",
      events,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    };
  },
});

export const assistantGoogleCalendarTools = [googleCalendarListEventsTool];

/**
 * UI-focused, read-only listing of a calendar over a bounded time range,
 * returning compact {@link CalendarEventDto} rows for the web calendar view.
 * Reuses the same Google access-token + event-listing/normalization helpers as
 * the agent tool, but emits a stable, minimal shape (no Meet records).
 */
export async function listCalendarEventsForUi({
  from,
  to,
  calendarId = "primary",
  includeCancelled = false,
  maxResults = 500,
}: {
  from: string;
  to: string;
  calendarId?: string;
  includeCancelled?: boolean;
  maxResults?: number;
}): Promise<{
  calendarId: string;
  calendarSummary: string | null;
  timeZone: string | null;
  events: CalendarEventDtoInternal[];
}> {
  const fromIso = normalizeRfc3339(from, "from");
  const toIso = normalizeRfc3339(to, "to");
  const config = getGoogleToolConfig();
  const accessToken = await ensureGoogleAccessToken(config);
  const page = await listEvents({
    accessToken,
    calendarId,
    from: fromIso,
    to: toIso,
    includeCancelled,
    maxResults: clampMax(maxResults),
  });
  const events: CalendarEventDtoInternal[] = [];
  for (const raw of page.items) {
    if (!includeCancelled && raw.status === "cancelled") continue;
    const event = normalizeEvent(raw, { includeDescriptions: true });
    const conferenceLinks = event.conferenceLinks.map((link) => ({
      provider: link.provider,
      label: link.label,
      uri: link.uri,
    }));
    events.push({
      id: event.id ?? raw.iCalUID ?? `${event.start ?? ""}:${event.title}`,
      title: event.title,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      status: event.status,
      htmlLink: event.htmlLink,
      location: event.location,
      description: (event as { description?: string }).description ?? null,
      meetingUrl: conferenceLinks[0]?.uri ?? event.meet.meetingUri ?? null,
      conferenceLinks,
      organizer: event.organizer?.displayName ?? event.organizer?.email ?? null,
      selfResponse: event.selfAttendee?.responseStatus ?? null,
      attendees: event.attendees.map((attendee) => ({
        name: attendee.displayName ?? null,
        email: attendee.email ?? null,
        self: attendee.self === true,
        optional: attendee.optional === true,
        organizer: attendee.organizer === true,
        response: attendee.responseStatus ?? null,
      })),
      attendeeCount: event.attendees.length,
      hasMinutesAttachment: event.attachments.some((attachment) =>
        isMinutesLikeTitle(attachment.title ?? ""),
      ),
      transparency: event.transparency ?? null,
    });
  }
  return {
    calendarId,
    calendarSummary: page.summary ?? null,
    timeZone: page.timeZone ?? null,
    events,
  };
}

/** Mirror of {@link CalendarEventDto} (kept local to avoid importing shared types into this tool file). */
type CalendarEventDtoInternal = {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  status: string | null;
  htmlLink: string | null;
  location: string | null;
  description: string | null;
  meetingUrl: string | null;
  conferenceLinks: Array<{
    provider: "google-meet" | "zoom" | "teams" | "other";
    label: string;
    uri: string;
  }>;
  organizer: string | null;
  selfResponse: string | null;
  attendees: Array<{
    name: string | null;
    email: string | null;
    self: boolean;
    optional: boolean;
    organizer: boolean;
    response: string | null;
  }>;
  attendeeCount: number;
  hasMinutesAttachment: boolean;
  transparency: string | null;
};

function isMinutesLikeTitle(value: string): boolean {
  return /notes by gemini|meeting notes|minutes|transcript/i.test(value);
}

async function listEvents({
  accessToken,
  calendarId,
  from,
  to,
  query,
  includeCancelled,
  maxResults,
}: {
  accessToken: string;
  calendarId: string;
  from: string;
  to: string;
  query?: string;
  includeCancelled: boolean;
  maxResults: number;
}): Promise<{ summary?: string; timeZone?: string; items: CalendarEvent[] }> {
  const out: CalendarEvent[] = [];
  let summary: string | undefined;
  let timeZone: string | undefined;
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: from,
      timeMax: to,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(250, maxResults - out.length)),
      showDeleted: includeCancelled ? "true" : "false",
      conferenceDataVersion: "1",
      supportsAttachments: "true",
    });
    if (query?.trim()) params.set("q", query.trim());
    if (pageToken) params.set("pageToken", pageToken);

    const url = `${CALENDAR_API_BASE}calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const page = await googleCalendarGet<CalendarEventsPage>(url, accessToken);
    summary = page.summary ?? summary;
    timeZone = page.timeZone ?? timeZone;
    for (const event of page.items ?? []) {
      out.push(event);
      if (out.length >= maxResults)
        return {
          ...(summary !== undefined ? { summary } : {}),
          ...(timeZone !== undefined ? { timeZone } : {}),
          items: out,
        };
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return {
    ...(summary !== undefined ? { summary } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    items: out,
  };
}

async function googleCalendarGet<T>(
  url: string,
  accessToken: string,
): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Google Calendar API returned HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function normalizeDetailLevel(
  value: DetailLevel | undefined,
  fallback: DetailLevel,
): DetailLevel {
  return value === "compact" || value === "standard" || value === "full"
    ? value
    : fallback;
}

function calendarEventForDetail(
  event: Record<string, any>,
  detailLevel: DetailLevel,
): Record<string, any> {
  if (detailLevel === "full") return event;
  const compact = {
    id: event.id,
    title: event.title,
    status: event.status,
    eventType: event.eventType,
    htmlLink: event.htmlLink,
    markdownLink: event.markdownLink,
    location: event.location,
    description: detailLevel === "standard" ? event.description : undefined,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    localStart: event.localStart,
    localEnd: event.localEnd,
    durationSeconds: event.durationSeconds,
    duration: event.duration,
    transparency: event.transparency,
    organizer: compactPerson(event.organizer),
    selfAttendee: event.selfAttendee
      ? {
          responseStatus: event.selfAttendee.responseStatus,
          optional: event.selfAttendee.optional,
        }
      : null,
    attendeeSummary: event.attendeeSummary,
    attendees:
      detailLevel === "standard"
        ? (event.attendees ?? []).map(compactAttendee)
        : undefined,
    meet: event.meet
      ? {
          meetingCode: event.meet.meetingCode,
          meetingUri: event.meet.meetingUri,
          solutionName: event.meet.solutionName,
        }
      : null,
    conferenceLinks: event.conferenceLinks,
    attachments: (event.attachments ?? []).map((attachment: any) => ({
      fileId: attachment.fileId,
      title: attachment.title,
      mimeType: attachment.mimeType,
      fileUrl: attachment.fileUrl,
      markdownLink: attachment.markdownLink,
    })),
    meetRecords: (event.meetRecords ?? []).map((record: any) =>
      compactCalendarMeetRecord(record, detailLevel),
    ),
  };
  return compactObject(compact);
}

function compactCalendarMeetRecord(
  record: Record<string, any>,
  detailLevel: DetailLevel,
): Record<string, any> {
  return compactObject({
    name: detailLevel === "standard" ? record.name : undefined,
    meetingCode: record.meetingCode,
    meetingUri: record.meetingUri,
    startTime: record.startTime,
    endTime: record.endTime,
    localStart: record.localStart,
    localEnd: record.localEnd,
    overlapSeconds: record.overlapSeconds,
    overlap: record.overlap,
    participantCount: record.participantCount,
    participants:
      detailLevel === "standard"
        ? (record.participants ?? []).map(compactMeetParticipant)
        : undefined,
    artifactSummary: record.artifactSummary,
    artifacts: (record.artifacts ?? []).map(compactArtifact),
    artifactErrors: record.artifactErrors,
    matchReason: record.matchReason,
  });
}

function compactMeetParticipant(
  participant: Record<string, any>,
): Record<string, any> {
  return compactObject({
    displayName:
      participant.displayName ?? participant.signedInUser?.displayName,
    participantSessions: (participant.participantSessions ?? []).map(
      (session: any) => ({
        localStart: session.localStart,
        localEnd: session.localEnd,
        duration: session.duration,
        startTime: session.startTime,
        endTime: session.endTime,
      }),
    ),
  });
}

function compactArtifact(artifact: Record<string, any>): Record<string, any> {
  return compactObject({
    kind: artifact.kind,
    title: artifact.title,
    driveFileId: artifact.driveFileId,
    mimeType: artifact.mimeType,
    url: artifact.url ?? artifact.webUrl,
  });
}

function compactPerson(
  person: Record<string, any> | null | undefined,
): Record<string, any> | null {
  if (!person) return null;
  return compactObject({
    email: person.email,
    displayName: person.displayName,
    self: person.self,
  });
}

function compactAttendee(attendee: Record<string, any>): Record<string, any> {
  return compactObject({
    email: attendee.email,
    displayName: attendee.displayName,
    self: attendee.self,
    responseStatus: attendee.responseStatus,
    optional: attendee.optional,
  });
}

function compactObject<T extends Record<string, any>>(value: T): T {
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    if (!Array.isArray(item) && typeof item === "object") {
      const nested = compactObject(item);
      if (Object.keys(nested).length === 0) continue;
      out[key] = nested;
      continue;
    }
    out[key] = item;
  }
  return out as T;
}

function normalizeEvent(
  event: CalendarEvent,
  { includeDescriptions }: { includeDescriptions: boolean },
) {
  const start = event.start ?? {};
  const end = event.end ?? {};
  const allDay = Boolean(start.date && !start.dateTime);
  const self = selfAttendee(event);
  const meet = extractMeet(event);
  const conferenceLinks = extractConferenceLinks(event, meet);
  return {
    id: event.id ?? null,
    iCalUID: event.iCalUID ?? null,
    status: event.status ?? null,
    eventType: event.eventType ?? null,
    title: event.summary ?? "(untitled)",
    htmlLink: event.htmlLink ?? null,
    markdownLink: event.htmlLink
      ? markdownLink(event.summary ?? "(untitled)", event.htmlLink)
      : null,
    location: event.location ?? null,
    ...(includeDescriptions
      ? { description: truncateText(stripHtml(event.description ?? ""), 4000) }
      : {}),
    start: start.dateTime ?? start.date ?? null,
    end: end.dateTime ?? end.date ?? null,
    allDay,
    localStart: allDay
      ? (start.date ?? null)
      : formatLocalDateTime(start.dateTime),
    localEnd: allDay ? (end.date ?? null) : formatLocalDateTime(end.dateTime),
    startTimeZone: start.timeZone ?? null,
    endTimeZone: end.timeZone ?? null,
    durationSeconds: allDay
      ? null
      : durationSeconds(start.dateTime, end.dateTime),
    duration: allDay
      ? null
      : formatDuration(durationSeconds(start.dateTime, end.dateTime)),
    transparency: event.transparency ?? "opaque",
    visibility: event.visibility ?? "default",
    creator: normalizePerson(event.creator),
    organizer: normalizePerson(event.organizer),
    selfAttendee: self ? normalizeAttendee(self) : null,
    attendees: (event.attendees ?? []).map(normalizeAttendee),
    attendeeSummary: summarizeAttendees(event.attendees ?? []),
    recurrence: event.recurrence ?? [],
    recurringEventId: event.recurringEventId ?? null,
    originalStartTime:
      event.originalStartTime?.dateTime ??
      event.originalStartTime?.date ??
      null,
    created: event.created ?? null,
    updated: event.updated ?? null,
    meet,
    conferenceLinks,
    attachments: (event.attachments ?? []).map((attachment) => ({
      fileId: attachment.fileId ?? null,
      title: attachment.title ?? null,
      mimeType: attachment.mimeType ?? null,
      fileUrl: attachment.fileUrl ?? null,
      iconLink: attachment.iconLink ?? null,
      markdownLink:
        attachment.fileUrl && attachment.title
          ? markdownLink(attachment.title, attachment.fileUrl)
          : null,
    })),
  };
}

function normalizePerson(person: CalendarPerson | undefined) {
  if (!person) return null;
  return {
    id: person.id ?? null,
    email: person.email ?? null,
    displayName: person.displayName ?? null,
    self: person.self === true,
  };
}

function normalizeAttendee(attendee: CalendarAttendee) {
  return {
    id: attendee.id ?? null,
    email: attendee.email ?? null,
    displayName: attendee.displayName ?? null,
    self: attendee.self === true,
    optional: attendee.optional === true,
    organizer: attendee.organizer === true,
    resource: attendee.resource === true,
    responseStatus: attendee.responseStatus ?? null,
    comment: attendee.comment ?? null,
  };
}

function summarizeAttendees(attendees: CalendarAttendee[]) {
  const counts: Record<string, number> = {};
  for (const attendee of attendees)
    counts[attendee.responseStatus ?? "unknown"] =
      (counts[attendee.responseStatus ?? "unknown"] ?? 0) + 1;
  return {
    total: attendees.length,
    accepted: counts.accepted ?? 0,
    declined: counts.declined ?? 0,
    tentative: counts.tentative ?? 0,
    needsAction: counts.needsAction ?? 0,
    unknown: counts.unknown ?? 0,
  };
}

function selfAttendee(event: CalendarEvent): CalendarAttendee | undefined {
  return event.attendees?.find((attendee) => attendee.self === true);
}

function extractMeet(event: CalendarEvent) {
  const entryPoints = event.conferenceData?.entryPoints ?? [];
  const video = entryPoints.find((entry) => entry.entryPointType === "video");
  const uri = video?.uri ?? event.hangoutLink ?? null;
  return {
    conferenceId: event.conferenceData?.conferenceId ?? null,
    solutionName: event.conferenceData?.conferenceSolution?.name ?? null,
    solutionType: event.conferenceData?.conferenceSolution?.key?.type ?? null,
    hangoutLink: event.hangoutLink ?? null,
    meetingUri: uri,
    meetingCode: normalizeMeetCode(
      video?.meetingCode ?? event.conferenceData?.conferenceId ?? uri,
    ),
    entryPoints: entryPoints.map((entry) => ({
      type: entry.entryPointType ?? null,
      uri: entry.uri ?? null,
      label: entry.label ?? null,
      meetingCode: entry.meetingCode ?? null,
      passcode: entry.passcode ?? entry.password ?? null,
      accessCode: entry.accessCode ?? null,
      pin: entry.pin ?? null,
    })),
  };
}

function extractConferenceLinks(
  event: CalendarEvent,
  meet: ReturnType<typeof extractMeet>,
) {
  const links: Array<{
    provider: "google-meet" | "zoom" | "teams" | "other";
    label: string;
    uri: string;
    source: string;
  }> = [];
  const add = (uri: string | null | undefined, source: string) => {
    if (!uri) return;
    const decoded = decodeHtml(uri.trim());
    if (!/^https?:\/\//i.test(decoded)) return;
    const provider = classifyConferenceProvider(decoded);
    if (provider === "other") return;
    if (links.some((link) => link.uri === decoded)) return;
    links.push({
      provider,
      label: providerLabel(provider),
      uri: decoded,
      source,
    });
  };

  add(meet.meetingUri, "conferenceData");
  for (const entry of meet.entryPoints)
    add(entry.uri, "conferenceData.entryPoints");
  for (const link of extractUrls(event.location ?? "")) add(link, "location");
  for (const link of extractUrls(event.description ?? ""))
    add(link, "description");
  for (const link of extractHrefUrls(event.description ?? ""))
    add(link, "description.href");

  return links;
}

function classifyConferenceProvider(
  uri: string,
): "google-meet" | "zoom" | "teams" | "other" {
  const lower = uri.toLowerCase();
  if (lower.includes("meet.google.com/")) return "google-meet";
  if (lower.includes("zoom.us/") || lower.includes("zoom.com/")) return "zoom";
  if (
    lower.includes("teams.microsoft.com/") ||
    lower.includes("teams.live.com/")
  )
    return "teams";
  return "other";
}

function providerLabel(
  provider: "google-meet" | "zoom" | "teams" | "other",
): string {
  if (provider === "google-meet") return "Google Meet";
  if (provider === "zoom") return "Zoom";
  if (provider === "teams") return "Microsoft Teams";
  return "Meeting link";
}

function extractUrls(value: string): string[] {
  return [...value.matchAll(/https?:\/\/[^\s<>()\]"']+/gi)].map((match) =>
    match[0].replace(/[.,;:!?]+$/, ""),
  );
}

function extractHrefUrls(value: string): string[] {
  return [...value.matchAll(/href=["']([^"']+)["']/gi)].map((match) =>
    decodeHtml(match[1] ?? ""),
  );
}

function normalizeRange(params: ListCalendarEventsParams): {
  from?: string;
  to?: string;
} {
  if (params.date) {
    if (!ISO_DATE_RE.test(params.date))
      throw new Error("date must be a YYYY-MM-DD date.");
    return localDayRange(params.date);
  }
  return {
    ...(params.from ? { from: normalizeRfc3339(params.from, "from") } : {}),
    ...(params.to ? { to: normalizeRfc3339(params.to, "to") } : {}),
  };
}

function durationSeconds(
  start: string | undefined,
  end: string | undefined,
): number | null {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    return null;
  return Math.round((endMs - startMs) / 1000);
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function markdownLink(label: string, href: string): string {
  return `[${label.replace(/[\\[\]]/g, "\\$&")}](${href})`;
}

function normalizeMeetCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/[a-z]{3}-?[a-z]{4}-?[a-z]{3}/i);
  return match ? match[0].toLowerCase() : value;
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function clampMax(value: number | undefined): number {
  if (value === undefined) return 25;
  if (!Number.isFinite(value) || value <= 0) return 25;
  return Math.min(500, Math.floor(value));
}
