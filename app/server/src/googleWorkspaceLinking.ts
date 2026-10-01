import {
  listMeetArtifactsForConferenceRecord,
  type MeetArtifact,
} from "./googleMeetArtifacts.ts";
import {
  formatLocalDateTime,
  localDateOf,
  localDayRange,
} from "./googleTime.ts";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/";
const MEET_API_BASE = "https://meet.googleapis.com/v2/";

type AnyEvent = Record<string, any>;
type AnyRecord = Record<string, any>;
type AnySpace = Record<string, any>;
type AnyParticipant = Record<string, any>;
type AnySession = Record<string, any>;

type CalendarEventsPage = {
  items?: AnyEvent[];
  nextPageToken?: string;
};

type MeetListPage<T> = {
  conferenceRecords?: T[];
  participants?: T[];
  participantSessions?: T[];
  nextPageToken?: string;
};

export interface CalendarMatchForMeet {
  id: string | null;
  title: string;
  htmlLink: string | null;
  markdownLink: string | null;
  description: string | null;
  start: string | null;
  end: string | null;
  localStart: string | null;
  localEnd: string | null;
  meetingCode: string | null;
  responseStatus: string | null;
  overlapSeconds: number | null;
  overlap: string | null;
  matchReason: string;
}

export interface MeetRecordForCalendarEvent {
  name: string | null;
  meetingCode: string | null;
  meetingUri: string | null;
  startTime: string | null;
  endTime: string | null;
  localStart: string | null;
  localEnd: string | null;
  overlapSeconds: number | null;
  overlap: string | null;
  participantCount: number;
  participants: Array<{
    name: string | null;
    displayName: string | null;
    signedInUser: { user: string | null; displayName: string | null } | null;
    participantSessions: Array<{
      startTime: string | null;
      endTime: string | null;
      localStart: string | null;
      localEnd: string | null;
      durationSeconds: number | null;
      duration: string | null;
    }>;
  }>;
  artifacts: MeetArtifact[];
  artifactSummary: {
    total: number;
    transcripts: number;
    recordings: number;
    driveBacked: number;
    errors: number;
  };
  artifactErrors: string[];
  matchReason: string;
}

export async function findCalendarMatchesForMeet({
  accessToken,
  calendarId = "primary",
  meetingCode,
  startTime,
  endTime,
  includeDescriptions = true,
}: {
  accessToken: string;
  calendarId?: string;
  meetingCode: string | null | undefined;
  startTime: string | null | undefined;
  endTime?: string | null | undefined;
  includeDescriptions?: boolean;
}): Promise<CalendarMatchForMeet[]> {
  const code = normalizeMeetCode(meetingCode);
  if (!code || !startTime) return [];
  const range = localDayRangeForInstant(startTime);
  const events = await listCalendarEvents(
    accessToken,
    calendarId,
    range.from,
    range.to,
  );
  return events
    .filter((event) => normalizeMeetCode(calendarMeetingCode(event)) === code)
    .map((event) =>
      normalizeCalendarMatch(
        event,
        code,
        startTime,
        endTime,
        includeDescriptions,
      ),
    )
    .sort(
      (a, b) =>
        (b.overlapSeconds ?? -1) - (a.overlapSeconds ?? -1) ||
        Math.abs(startDiffMs(a.start, startTime)) -
          Math.abs(startDiffMs(b.start, startTime)),
    )
    .slice(0, 5);
}

export async function findMeetRecordsForCalendarEvent({
  accessToken,
  event,
  includeParticipants = true,
  includeParticipantSessions = true,
  includeArtifacts = true,
}: {
  accessToken: string;
  event: AnyEvent;
  includeParticipants?: boolean;
  includeParticipantSessions?: boolean;
  includeArtifacts?: boolean;
}): Promise<MeetRecordForCalendarEvent[]> {
  const code = normalizeMeetCode(calendarMeetingCode(event));
  const eventStart = event.start?.dateTime ?? event.start?.date;
  const eventEnd = event.end?.dateTime ?? event.end?.date;
  if (!code || !eventStart) return [];
  const range = localDayRangeForEventStart(event.start);
  const records = await listMeetRecords(
    accessToken,
    code,
    range.from,
    range.to,
  );
  const out: MeetRecordForCalendarEvent[] = [];
  for (const record of records) {
    const space = record.space
      ? await meetGet<AnySpace>(record.space, accessToken)
      : null;
    const participants =
      includeParticipants && record.name
        ? await listMeetParticipants(
            accessToken,
            record.name,
            includeParticipantSessions,
          )
        : [];
    const artifactResult = includeArtifacts
      ? await listMeetArtifactsForConferenceRecord({
          accessToken,
          recordName: record.name,
        })
      : { artifacts: [], errors: [] };
    out.push(
      normalizeMeetRecordMatch(
        record,
        space,
        participants,
        code,
        eventStart,
        eventEnd,
        artifactResult.artifacts,
        artifactResult.errors,
      ),
    );
  }
  return out
    .sort(
      (a, b) =>
        (b.overlapSeconds ?? -1) - (a.overlapSeconds ?? -1) ||
        Math.abs(startDiffMs(a.startTime, eventStart)) -
          Math.abs(startDiffMs(b.startTime, eventStart)),
    )
    .slice(0, 5);
}

interface MeetParticipantAttendance {
  /** Best available display name (signed-in / anonymous / phone). */
  name: string | null;
  /** Time this person was present: the UNION of their participant sessions. */
  seconds: number | null;
  /** How many participant sessions Meet recorded for them (0 = no session evidence). */
  sessions: number;
  /** True when this participant is the connected user (id or display-name match). */
  self: boolean;
}

/** One Meet conference record, with who attended, durations, and MY session evidence. */
export interface MeetConferenceAttendance {
  meetingCode: string | null;
  meetingUri: string | null;
  startTime: string | null;
  endTime: string | null;
  /** The real conference duration — the CONFERENCE's, never mine. */
  conferenceSeconds: number | null;
  /** Who attended and for how long (best-effort; empty when participants unavailable). */
  participants: MeetParticipantAttendance[];
  /**
   * The participant list was READ successfully. False means we know nothing about
   * who was there — never evidence of absence (Task 224).
   */
  participantsRead: boolean;
  /**
   * ATTENDANCE (Task 224): the connected user was matched to a participant with at
   * least one participant SESSION. A listed conference record alone is NOT
   * attendance — the record can surface for a meeting the user never joined.
   */
  selfAttended: boolean;
  /** The connected user's own present time (union of my sessions), when self-matched. */
  selfSeconds: number | null;
  /** My presence window (first join → last leave), for overlap/conflict reasoning. */
  selfStart: string | null;
  selfEnd: string | null;
  /** How many participant sessions I had (a second device adds one). */
  selfSessions: number;
}

/** The connected user's Meet/People identity, for self-matching among participants. */
export interface MeetSelfIdentity {
  /** People/Meet numeric account id (from `people/me` resourceName). */
  userId: string | null;
  displayName: string | null;
}

/** Resolve the connected user's People id + display name for self-matching (best-effort). */
export async function getMeetSelfIdentity(
  accessToken: string,
): Promise<MeetSelfIdentity> {
  try {
    const me = await meetGet<AnyRecord>(
      "https://people.googleapis.com/v1/people/me?personFields=names",
      accessToken,
    );
    const resource =
      typeof me.resourceName === "string" ? me.resourceName : null; // people/{id}
    const names: AnyRecord[] = Array.isArray(me.names) ? me.names : [];
    const primary = names.find((n) => n.metadata?.primary) ?? names[0];
    return {
      userId: resource ? resource.replace(/^people\//, "") : null,
      displayName: (primary?.displayName as string) ?? null,
    };
  } catch {
    return { userId: null, displayName: null };
  }
}

function accountIdOf(participant: AnyParticipant): string | null {
  const raw = participant.signedinUser?.user;
  return typeof raw === "string" ? raw.replace(/^users\//, "") : null;
}

function isSelfParticipant(
  participant: AnyParticipant,
  self: MeetSelfIdentity | undefined,
): boolean {
  if (!self) return false;
  const id = accountIdOf(participant);
  if (self.userId && id && id === self.userId) return true;
  const name = participantDisplayName(participant);
  return Boolean(
    self.displayName &&
    name &&
    name.trim().toLowerCase() === self.displayName.trim().toLowerCase(),
  );
}

/** One person's presence in a conference, derived from their participant sessions. */
export interface ParticipantPresence {
  /** Present time as the UNION of the sessions; null when no session is measurable. */
  seconds: number | null;
  /** First join / last leave across the sessions. */
  start: string | null;
  end: string | null;
  /** Number of participant sessions recorded (0 = no session evidence at all). */
  sessions: number;
}

/**
 * Presence from a participant's sessions. Sessions are UNIONED, never summed: the
 * same person joined from a second device (laptop + phone) produces OVERLAPPING
 * sessions, and adding them up would invent present time (Task 224). A session
 * still running (no `endTime`) counts as session evidence but contributes no
 * measurable seconds.
 */
export function participantPresence(
  participant: AnyParticipant,
): ParticipantPresence {
  const sessions: AnySession[] = Array.isArray(participant.participantSessions)
    ? participant.participantSessions
    : [];
  const spans: Array<{ start: number; end: number }> = [];
  let earliest: number | null = null;
  let latest: number | null = null;
  let counted = 0;
  for (const session of sessions) {
    const start = epochMs(session.startTime);
    const end = epochMs(session.endTime);
    if (start === null) continue;
    counted += 1;
    if (earliest === null || start < earliest) earliest = start;
    if (end !== null && end >= start) {
      spans.push({ start, end });
      if (latest === null || end > latest) latest = end;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let seconds: number | null = null;
  let mergedStart: number | null = null;
  let mergedEnd: number | null = null;
  for (const span of spans) {
    if (mergedEnd === null || span.start > mergedEnd) {
      if (mergedStart !== null && mergedEnd !== null)
        seconds = (seconds ?? 0) + Math.round((mergedEnd - mergedStart) / 1000);
      mergedStart = span.start;
      mergedEnd = span.end;
    } else if (span.end > mergedEnd) {
      mergedEnd = span.end;
    }
  }
  if (mergedStart !== null && mergedEnd !== null)
    seconds = (seconds ?? 0) + Math.round((mergedEnd - mergedStart) / 1000);
  return {
    seconds,
    start: earliest === null ? null : new Date(earliest).toISOString(),
    end: latest === null ? null : new Date(latest).toISOString(),
    sessions: counted,
  };
}

/** Read a conference record's participants + sessions → per-person durations + self match. */
async function resolveConferenceAttendance(
  accessToken: string,
  recordName: string,
  self: MeetSelfIdentity | undefined,
): Promise<
  Pick<
    MeetConferenceAttendance,
    | "participants"
    | "participantsRead"
    | "selfAttended"
    | "selfSeconds"
    | "selfStart"
    | "selfEnd"
    | "selfSessions"
  >
> {
  try {
    const raw = (
      await listMeetParticipants(accessToken, recordName, true)
    ).slice(0, 50);
    let mine: ParticipantPresence | null = null;
    const participants: MeetParticipantAttendance[] = [];
    for (const participant of raw) {
      const isSelf = isSelfParticipant(participant, self);
      const presence = participantPresence(participant);
      if (isSelf) mine = presence;
      participants.push({
        name: participantDisplayName(participant),
        seconds: presence.seconds,
        sessions: presence.sessions,
        self: isSelf,
      });
    }
    // A matched participant with NO session is not attendance evidence.
    return {
      participants,
      participantsRead: true,
      selfAttended: (mine?.sessions ?? 0) > 0,
      selfSeconds: mine?.seconds ?? null,
      selfStart: mine?.start ?? null,
      selfEnd: mine?.end ?? null,
      selfSessions: mine?.sessions ?? 0,
    };
  } catch {
    return {
      participants: [],
      participantsRead: false,
      selfAttended: false,
      selfSeconds: null,
      selfStart: null,
      selfEnd: null,
      selfSessions: 0,
    };
  }
}

/** List conference records matching a Meet API filter (paginated). */
async function listConferenceRecordsByFilter(
  accessToken: string,
  filter: string,
): Promise<AnyRecord[]> {
  const records: AnyRecord[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ filter, pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await meetGet<MeetListPage<AnyRecord>>(
      `conferenceRecords?${params}`,
      accessToken,
    );
    records.push(...(page.conferenceRecords ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return records;
}

/**
 * Day-scan Meet attendance (Task 173): EVERY Meet conference the connected user
 * may have been in on the day — calendar-linked OR ad-hoc (e.g. a link shared over
 * Slack) — keyed only by a time window (no meeting code). For each it reads
 * participants + sessions to report WHO attended and for how long, and
 * self-matches the connected user (People id / display name) to surface the
 * user's own present time.
 *
 * A returned record is NOT attendance (Task 224): the list can include a
 * conference the user only had an invitation to. `selfAttended` — a participant
 * SESSION for the connected user — is the only attendance evidence; callers must
 * not promote a listed record to attendance or a duration without it.
 *
 * Best-effort throughout; a per-record failure yields an empty participant list
 * (`participantsRead: false`, never read as absence) rather than dropping the
 * conference, and a failed space read leaves `meetingCode: null` — the conference is
 * real but unidentified, which consumers must treat as "correlate by time", never as
 * a code. Bounded to 25.
 */
export async function findMyMeetAttendanceForDay({
  accessToken,
  fromIso,
  toIso,
  self,
}: {
  accessToken: string;
  fromIso: string;
  toIso: string;
  self?: MeetSelfIdentity;
}): Promise<MeetConferenceAttendance[]> {
  const filter = `start_time >= "${fromIso}" AND start_time < "${toIso}"`;
  const records = (
    await listConferenceRecordsByFilter(accessToken, filter)
  ).slice(0, 25);
  const out: MeetConferenceAttendance[] = [];
  for (const record of records) {
    const space = record.space
      ? await meetGet<AnySpace>(record.space, accessToken).catch(() => null)
      : null;
    const attendance = record.name
      ? await resolveConferenceAttendance(accessToken, record.name, self)
      : {
          participants: [],
          participantsRead: false,
          selfAttended: false,
          selfSeconds: null,
          selfStart: null,
          selfEnd: null,
          selfSessions: 0,
        };
    out.push({
      // Canonical `abc-defg-hij` or null — never a half-normalized passthrough, so
      // every consumer compares codes without re-parsing (Task 224 review 2).
      meetingCode:
        canonicalMeetCode(space?.meetingCode ?? null) ??
        readMeetLink(space?.meetingUri ?? null).code,
      meetingUri: space?.meetingUri ?? null,
      startTime: record.startTime ?? null,
      endTime: record.endTime ?? null,
      conferenceSeconds: durationSeconds(record.startTime, record.endTime),
      ...attendance,
    });
  }
  return out;
}

function calendarMeetingCode(event: AnyEvent): string | null {
  const entryPoints = event.conferenceData?.entryPoints ?? [];
  const video =
    entryPoints.find((entry: any) => entry.entryPointType === "video") ??
    entryPoints[0];
  return normalizeMeetCode(
    video?.meetingCode ??
      event.conferenceData?.conferenceId ??
      video?.uri ??
      event.hangoutLink ??
      null,
  );
}

export function normalizeMeetCode(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const match = value.match(/[a-z]{3}-?[a-z]{4}-?[a-z]{3}/i);
  return match ? match[0].toLowerCase() : value;
}

/**
 * The CANONICAL `abc-defg-hij` form of a Meet MEETING CODE, or null when the value
 * is not a meeting code at all.
 *
 * The one reader for a value Google reported AS a code (`space.meetingCode`,
 * `conferenceData.meetingCode`, a code we committed earlier), which arrives dashed
 * or dash-less depending on the field. Canonicalizing on both the write and the
 * read side means a stored code always compares equal to a freshly read one, and a
 * value that is not a code (a space resource name, a URL) becomes null instead of
 * travelling on as if it were an id.
 */
export function canonicalMeetCode(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const compact = value.trim().toLowerCase().replace(/-/g, "");
  if (!/^[a-z]{10}$/.test(compact)) return null;
  return `${compact.slice(0, 3)}-${compact.slice(3, 7)}-${compact.slice(7)}`;
}

/** What a calendar event's conference LINK says about a possible Meet session. */
export interface MeetLinkRef {
  /**
   * The link is a Google Meet link. Only these meetings can ever be evidenced by
   * a Meet participant session; Zoom/Teams/other links cannot.
   */
  isMeet: boolean;
  /**
   * The canonical meeting code, when the link carries one. NULL WITH `isMeet` TRUE
   * is its own state: a Meet meeting whose code cannot be derived (a
   * `meet.google.com/lookup/<name>` or `g.co/meet/<nickname>` link), so it can only
   * be correlated to a conference record by time.
   */
  code: string | null;
}

const NOT_MEET: MeetLinkRef = { isMeet: false, code: null };

/**
 * Read a calendar event's conference link: is it Meet, and does it carry a code?
 *
 * A calendar event's `meetingUrl` is the first conference link found ANYWHERE on
 * the event (conferenceData, location, even the description), so it may belong to
 * any provider — hence the host check, and hence never `normalizeMeetCode`, which
 * passes unrecognized values through and would find a code-shaped letter run inside
 * a Zoom passcode. A code is taken only from a WHOLE dashed path segment
 * (`/abc-defg-hij`): slicing ten letters out of `/lookup/kickoffmeeting` would
 * invent a code no conference record can ever match.
 */
export function readMeetLink(value: string | null | undefined): MeetLinkRef {
  if (!value) return NOT_MEET;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    const code = canonicalMeetCode(trimmed);
    return code ? { isMeet: true, code } : NOT_MEET;
  }
  const isMeetHost =
    /^https?:\/\/(?:[a-z0-9-]+\.)*meet\.google\.com(?:[/?#]|$)/i.test(
      trimmed,
    ) || /^https?:\/\/g\.co\/meet(?:[/?#]|$)/i.test(trimmed);
  if (!isMeetHost) return NOT_MEET;
  const segments = (
    trimmed.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0] ?? ""
  )
    .split("/")
    .filter(Boolean);
  for (const segment of segments) {
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(segment))
      return { isMeet: true, code: segment.toLowerCase() };
  }
  return { isMeet: true, code: null };
}

async function listCalendarEvents(
  accessToken: string,
  calendarId: string,
  from: string,
  to: string,
): Promise<AnyEvent[]> {
  const out: AnyEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: from,
      timeMax: to,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      showDeleted: "false",
      conferenceDataVersion: "1",
      supportsAttachments: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await calendarGet<CalendarEventsPage>(
      `${CALENDAR_API_BASE}calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      accessToken,
    );
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

async function listMeetRecords(
  accessToken: string,
  meetingCode: string,
  from: string,
  to: string,
): Promise<AnyRecord[]> {
  const filter = `space.meeting_code = "${escapeFilterString(meetingCode)}" AND start_time >= "${from}" AND start_time < "${to}"`;
  const records: AnyRecord[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ filter, pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await meetGet<MeetListPage<AnyRecord>>(
      `conferenceRecords?${params}`,
      accessToken,
    );
    records.push(...(page.conferenceRecords ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return records;
}

async function listMeetParticipants(
  accessToken: string,
  recordName: string,
  includeSessions: boolean,
): Promise<AnyParticipant[]> {
  const participants = await listAllMeet<AnyParticipant>(
    `${recordName}/participants?pageSize=100`,
    "participants",
    accessToken,
  );
  if (!includeSessions) return participants;
  for (const participant of participants) {
    if (participant.name) {
      participant.participantSessions = await listAllMeet<AnySession>(
        `${participant.name}/participantSessions?pageSize=100`,
        "participantSessions",
        accessToken,
      );
    }
  }
  return participants;
}

async function listAllMeet<T>(
  path: string,
  field: "participants" | "participantSessions",
  accessToken: string,
): Promise<T[]> {
  const out: T[] = [];
  let next = path;
  while (next) {
    const page = await meetGet<MeetListPage<T>>(next, accessToken);
    out.push(...(page[field] ?? []));
    next = page.nextPageToken
      ? `${path}${path.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(page.nextPageToken)}`
      : "";
  }
  return out;
}

async function calendarGet<T>(url: string, accessToken: string): Promise<T> {
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

async function meetGet<T>(pathOrUrl: string, accessToken: string): Promise<T> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${MEET_API_BASE}${pathOrUrl.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Google Meet API returned HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function normalizeCalendarMatch(
  event: AnyEvent,
  code: string,
  meetStart: string | null | undefined,
  meetEnd: string | null | undefined,
  includeDescription: boolean,
): CalendarMatchForMeet {
  const start = event.start?.dateTime ?? event.start?.date ?? null;
  const end = event.end?.dateTime ?? event.end?.date ?? null;
  const overlap = overlapSeconds(start, end, meetStart, meetEnd);
  return {
    id: event.id ?? null,
    title: event.summary ?? "(untitled)",
    htmlLink: event.htmlLink ?? null,
    markdownLink: event.htmlLink
      ? markdownLink(event.summary ?? "(untitled)", event.htmlLink)
      : null,
    description: includeDescription
      ? truncateText(stripHtml(event.description ?? ""), 2000)
      : null,
    start,
    end,
    localStart: event.start?.date
      ? event.start.date
      : formatLocalDateTime(event.start?.dateTime),
    localEnd: event.end?.date
      ? event.end.date
      : formatLocalDateTime(event.end?.dateTime),
    meetingCode: code,
    responseStatus: selfAttendee(event)?.responseStatus ?? null,
    overlapSeconds: overlap,
    overlap: formatDuration(overlap),
    matchReason:
      overlap && overlap > 0
        ? "same Meet code and overlapping time"
        : "same Meet code on same local day",
  };
}

function normalizeMeetRecordMatch(
  record: AnyRecord,
  space: AnySpace | null,
  participants: AnyParticipant[],
  code: string,
  eventStart: string | null | undefined,
  eventEnd: string | null | undefined,
  artifacts: MeetArtifact[],
  artifactErrors: string[],
): MeetRecordForCalendarEvent {
  const overlap = overlapSeconds(
    eventStart,
    eventEnd,
    record.startTime,
    record.endTime,
  );
  return {
    name: record.name ?? null,
    meetingCode: normalizeMeetCode(space?.meetingCode ?? code),
    meetingUri: space?.meetingUri ?? null,
    startTime: record.startTime ?? null,
    endTime: record.endTime ?? null,
    localStart: formatLocalDateTime(record.startTime),
    localEnd: formatLocalDateTime(record.endTime),
    overlapSeconds: overlap,
    overlap: formatDuration(overlap),
    participantCount: participants.length,
    participants: participants.map((participant) => ({
      name: participant.name ?? null,
      displayName: participantDisplayName(participant),
      signedInUser: participant.signedinUser
        ? {
            user: participant.signedinUser.user ?? null,
            displayName: participant.signedinUser.displayName ?? null,
          }
        : null,
      participantSessions: (participant.participantSessions ?? []).map(
        (session: AnySession) => ({
          startTime: session.startTime ?? null,
          endTime: session.endTime ?? null,
          localStart: formatLocalDateTime(session.startTime),
          localEnd: formatLocalDateTime(session.endTime),
          durationSeconds: durationSeconds(session.startTime, session.endTime),
          duration: formatDuration(
            durationSeconds(session.startTime, session.endTime),
          ),
        }),
      ),
    })),
    artifacts,
    artifactSummary: summarizeArtifacts(artifacts, artifactErrors),
    artifactErrors,
    matchReason:
      overlap && overlap > 0
        ? "same Meet code and overlapping time"
        : "same Meet code on same local day",
  };
}

function summarizeArtifacts(artifacts: MeetArtifact[], errors: string[]) {
  return {
    total: artifacts.length,
    transcripts: artifacts.filter((artifact) => artifact.kind === "transcript")
      .length,
    recordings: artifacts.filter((artifact) => artifact.kind === "recording")
      .length,
    driveBacked: artifacts.filter((artifact) => artifact.driveFileId).length,
    errors: errors.length,
  };
}

function markdownLink(label: string, href: string): string {
  return `[${label.replace(/[\\[\]]/g, "\\$&")}](${href})`;
}

function selfAttendee(event: AnyEvent): AnyEvent | undefined {
  return event.attendees?.find((attendee: AnyEvent) => attendee.self === true);
}

function participantDisplayName(participant: AnyParticipant): string | null {
  return (
    participant.signedinUser?.displayName ??
    participant.anonymousUser?.displayName ??
    participant.phoneUser?.displayName ??
    null
  );
}

function localDayRangeForInstant(value: string): { from: string; to: string } {
  return localDayRange(localDateOf(value));
}

function localDayRangeForEventStart(start: AnyEvent): {
  from: string;
  to: string;
} {
  const value =
    start?.dateTime ??
    (start?.date ? `${start.date}T00:00:00Z` : new Date().toISOString());
  return start?.date
    ? localDayRange(start.date)
    : localDayRangeForInstant(value);
}

function epochMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function durationSeconds(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    return null;
  return Math.round((endMs - startMs) / 1000);
}

function overlapSeconds(
  aStart: string | null | undefined,
  aEnd: string | null | undefined,
  bStart: string | null | undefined,
  bEnd: string | null | undefined,
): number | null {
  if (!aStart || !aEnd || !bStart || !bEnd) return null;
  const start = Math.max(
    new Date(aStart).getTime(),
    new Date(bStart).getTime(),
  );
  const end = Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime());
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return 0;
  return Math.round((end - start) / 1000);
}

function startDiffMs(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (!a || !b) return Number.MAX_SAFE_INTEGER;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs))
    return Number.MAX_SAFE_INTEGER;
  return aMs - bMs;
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

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function escapeFilterString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
