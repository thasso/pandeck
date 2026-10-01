import { defineAgentTool } from "../../mcp/tool.ts";
import {
  ensureGoogleAccessToken,
  getGoogleToolConfig,
} from "../../googleSettings.ts";
import {
  listMeetArtifactsForConferenceRecord,
  type MeetArtifact,
} from "../../googleMeetArtifacts.ts";
import { findCalendarMatchesForMeet } from "../../googleWorkspaceLinking.ts";
import {
  formatLocalDateTime,
  localDayRange,
  normalizeRfc3339,
} from "../../googleTime.ts";

type MeetRecord = {
  name?: string;
  space?: string;
  startTime?: string;
  endTime?: string;
  expireTime?: string;
  [key: string]: unknown;
};

type MeetSpace = {
  name?: string;
  meetingUri?: string;
  meetingCode?: string;
  config?: unknown;
  [key: string]: unknown;
};

type MeetParticipant = {
  name?: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
  earliestStartTime?: string;
  latestEndTime?: string;
  participantSessions?: MeetParticipantSession[];
  [key: string]: unknown;
};

type MeetParticipantSession = {
  name?: string;
  startTime?: string;
  endTime?: string;
  [key: string]: unknown;
};

type MeetListPage<T> = {
  conferenceRecords?: T[];
  participants?: T[];
  participantSessions?: T[];
  nextPageToken?: string;
};

type DetailLevel = "compact" | "standard" | "full";

type ListMeetRecordsParams = {
  date?: string;
  from?: string;
  to?: string;
  meetingCode?: string;
  participantFilter?: string;
  includeSpaceDetails?: boolean;
  includeParticipants?: boolean;
  includeParticipantSessions?: boolean;
  includeCalendarMatches?: boolean;
  includeArtifacts?: boolean;
  includeTranscriptEntries?: boolean;
  calendarId?: string;
  detailLevel?: DetailLevel;
  render?: boolean;
  maxRecords?: number;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEET_API_BASE = "https://meet.googleapis.com/v2/";

const listMeetRecordsParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    date: {
      type: "string",
      description:
        "User-local day in YYYY-MM-DD format. Expands to that day's start/end filter.",
    },
    from: {
      type: "string",
      description:
        "RFC3339 lower bound for conference start_time, inclusive. Optional if date is provided.",
    },
    to: {
      type: "string",
      description:
        "RFC3339 upper bound for conference start_time, exclusive. Optional if date is provided.",
    },
    meetingCode: {
      type: "string",
      description: "Optional Meet code filter, for example abc-defg-hij.",
    },
    participantFilter: {
      type: "string",
      description:
        "Optional case-insensitive substring filter applied to participant display names and signed-in user resource IDs after participants are loaded, e.g. a first name. Records without matching participants are omitted.",
    },
    includeSpaceDetails: {
      type: "boolean",
      description:
        "Fetch Meet space details such as meetingCode and meetingUri. Defaults to false unless rendering or filtering by meeting code.",
    },
    includeParticipants: {
      type: "boolean",
      description:
        "Fetch participants for each conference record. Defaults to false unless participantFilter is provided or render=true.",
    },
    includeParticipantSessions: {
      type: "boolean",
      description:
        "Fetch join/leave sessions for loaded participants. Defaults to false unless participantFilter is provided or render=true.",
    },
    includeCalendarMatches: {
      type: "boolean",
      description:
        "Deterministically fetch matching Calendar events by Meet code. Defaults to false unless render=true.",
    },
    includeArtifacts: {
      type: "boolean",
      description:
        "Fetch Meet-generated transcripts/notes and recordings metadata. Defaults to false unless render=true or detailLevel=full.",
    },
    includeTranscriptEntries: {
      type: "boolean",
      description:
        "Also fetch transcript entry text previews from the Meet API when transcripts exist. Defaults to false; use google_drive_get_file with artifact driveFileId for full docs.",
    },
    calendarId: {
      type: "string",
      description:
        "Calendar id used for calendar matching. Defaults to primary.",
    },
    detailLevel: {
      type: "string",
      enum: ["compact", "standard", "full"],
      description:
        "How much record detail to return. compact is default and returns attendance evidence rows; standard includes compact participant sessions and artifact metadata; full preserves verbose API/resource details. render=true uses full.",
    },
    render: {
      type: "boolean",
      description:
        "Set true only when the user explicitly asks for a visual/card/table/agenda-style display. The UI will render a rich Meet card in addition to the assistant's text; do not repeat the rendered records in prose, add only what the cards do not show (attendance gaps, unmatched calendar context, caveats).",
    },
    maxRecords: {
      type: "number",
      description:
        "Maximum conference records to return. Defaults to 25, maximum 500.",
    },
  },
} as const;

const googleMeetListRecordsTool = defineAgentTool<ListMeetRecordsParams>({
  name: "google_meet_list_records",
  label: "Google Meet: List Conference Records",
  description:
    "List read-only Google Meet conference records, optional space details, participants, and participant join/leave sessions — the tool for actual attendance, join/leave times, and ad-hoc calls. A participant session is far stronger attendance evidence than a calendar event; use participantFilter so a lookup for one person does not return every attendee. calendarMatches are deterministic (same Meet code, same user-local day); cite them with markdownLink, or htmlLink as the href, never a placeholder like [title](...).",
  parameters: listMeetRecordsParamsSchema,
  async execute(params) {
    const range = normalizeRange(params);
    const maxRecords = clampMax(params.maxRecords);
    const detailLevel = normalizeDetailLevel(
      params.detailLevel,
      params.render === true ? "full" : "compact",
    );
    const participantRequested =
      params.participantFilter !== undefined || params.render === true;
    const includeSpaceDetails =
      params.includeSpaceDetails === true ||
      params.render === true ||
      params.meetingCode !== undefined;
    const includeParticipants =
      params.includeParticipants === true || participantRequested;
    const includeParticipantSessions =
      includeParticipants &&
      (params.includeParticipantSessions === true || participantRequested);
    const includeCalendarMatches =
      params.includeCalendarMatches === true || params.render === true;
    const includeArtifacts =
      params.render === true ||
      params.includeArtifacts === true ||
      detailLevel === "full";
    const includeTranscriptEntries = params.includeTranscriptEntries === true;
    const calendarId = params.calendarId?.trim() || "primary";

    const config = getGoogleToolConfig();
    const accessToken = await ensureGoogleAccessToken(config);
    const filter = buildFilter({
      ...range,
      ...(params.meetingCode !== undefined
        ? { meetingCode: params.meetingCode }
        : {}),
    });
    if (!filter)
      throw new Error(
        "Provide at least date, from/to, or meetingCode to avoid an unbounded Google Meet query.",
      );

    const records = await listConferenceRecords(
      filter,
      accessToken,
      maxRecords,
    );
    const enriched = [];
    const participantNeedle = params.participantFilter?.trim().toLowerCase();

    for (const record of records) {
      const space =
        (includeSpaceDetails || includeCalendarMatches) && record.space
          ? await googleMeetGet<MeetSpace>(record.space, accessToken)
          : null;
      let participants: MeetParticipant[] = [];
      if (includeParticipants && record.name) {
        participants = await listAll<MeetParticipant>(
          `${record.name}/participants?pageSize=100`,
          "participants",
          accessToken,
        );
        if (participantNeedle)
          participants = participants.filter((p) =>
            participantSearchText(p).includes(participantNeedle),
          );
        if (includeParticipantSessions) {
          for (const participant of participants) {
            if (participant.name) {
              participant.participantSessions =
                await listAll<MeetParticipantSession>(
                  `${participant.name}/participantSessions?pageSize=100`,
                  "participantSessions",
                  accessToken,
                );
            }
          }
        }
      }
      if (participantNeedle && participants.length === 0) continue;
      const calendarMatches = includeCalendarMatches
        ? await findCalendarMatchesForMeet({
            accessToken,
            calendarId,
            meetingCode: space?.meetingCode,
            startTime: record.startTime,
            endTime: record.endTime,
            includeDescriptions: detailLevel !== "compact",
          })
        : [];
      const artifactResult = includeArtifacts
        ? await listMeetArtifactsForConferenceRecord({
            accessToken,
            recordName: record.name,
            includeTranscriptEntries,
          })
        : { artifacts: [], errors: [] };
      enriched.push(
        meetRecordForDetail(
          normalizeRecord(
            record,
            space,
            participants,
            calendarMatches,
            artifactResult.artifacts,
            artifactResult.errors,
          ),
          detailLevel,
        ),
      );
    }

    const payload = {
      filter,
      date: params.date ?? null,
      from: range.from ?? null,
      to: range.to ?? null,
      meetingCode: params.meetingCode ?? null,
      participantFilter: params.participantFilter ?? null,
      includeSpaceDetails,
      includeParticipants,
      includeParticipantSessions,
      includeCalendarMatches,
      includeArtifacts,
      includeTranscriptEntries,
      calendarId,
      detailLevel,
      renderRequested: params.render === true,
      recordCount: enriched.length,
      presentationGuidance:
        params.render === true
          ? "The UI will render these records as rich Meet cards. Do not duplicate the full record list in text; only add concise context not already visible in the cards, such as attendance gaps, unmatched calendar context, available artifacts, or caveats. Never use placeholder links like [title](...)."
          : "Compact Meet records are returned by default. Use localStart/localEnd and compact participant sessions for attendance evidence. Use participantFilter to narrow to the user when possible. Request detailLevel=standard/full, includeArtifacts, or google_drive_get_file only for specific records needing deeper context.",
      records: enriched,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    };
  },
});

export const assistantGoogleMeetTools = [googleMeetListRecordsTool];

function normalizeRange(params: ListMeetRecordsParams): {
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

function buildFilter({
  from,
  to,
  meetingCode,
}: {
  from?: string;
  to?: string;
  meetingCode?: string;
}): string {
  const parts: string[] = [];
  const code = meetingCode?.trim();
  if (code) parts.push(`space.meeting_code = "${escapeFilterString(code)}"`);
  if (from) parts.push(`start_time >= "${from}"`);
  if (to) parts.push(`start_time < "${to}"`);
  return parts.join(" AND ");
}

async function listConferenceRecords(
  filter: string,
  accessToken: string,
  maxRecords: number,
): Promise<MeetRecord[]> {
  const params = new URLSearchParams({ filter, pageSize: "100" });
  const records: MeetRecord[] = [];
  let pageToken: string | undefined;
  do {
    const path = `conferenceRecords?${params}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const page = await googleMeetGet<MeetListPage<MeetRecord>>(
      path,
      accessToken,
    );
    for (const record of page.conferenceRecords ?? []) {
      records.push(record);
      if (records.length >= maxRecords) return records;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return records;
}

async function listAll<T>(
  path: string,
  field: "participants" | "participantSessions",
  accessToken: string,
): Promise<T[]> {
  const out: T[] = [];
  let next = path;
  while (next) {
    const page = await googleMeetGet<MeetListPage<T>>(next, accessToken);
    out.push(...(page[field] ?? []));
    next = page.nextPageToken
      ? `${path}${path.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(page.nextPageToken)}`
      : "";
  }
  return out;
}

async function googleMeetGet<T>(
  pathOrUrl: string,
  accessToken: string,
): Promise<T> {
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

function normalizeDetailLevel(
  value: DetailLevel | undefined,
  fallback: DetailLevel,
): DetailLevel {
  return value === "compact" || value === "standard" || value === "full"
    ? value
    : fallback;
}

function meetRecordForDetail(
  record: Record<string, any>,
  detailLevel: DetailLevel,
): Record<string, any> {
  if (detailLevel === "full") return record;
  return compactObject({
    name: detailLevel === "standard" ? record.name : undefined,
    spaceName: detailLevel === "standard" ? record.spaceName : undefined,
    meetingCode: record.meetingCode,
    meetingUri: record.meetingUri,
    startTime: record.startTime,
    endTime: record.endTime,
    localStart: record.localStart,
    localEnd: record.localEnd,
    participantCount: record.participantCount,
    participants: (record.participants ?? []).map((participant: any) =>
      compactParticipant(participant, detailLevel),
    ),
    calendarMatches: (record.calendarMatches ?? []).map((match: any) =>
      compactCalendarMatch(match, detailLevel),
    ),
    artifactSummary: record.artifactSummary,
    artifacts: (record.artifacts ?? []).map(compactArtifact),
    artifactErrors: record.artifactErrors,
  });
}

function compactParticipant(
  participant: Record<string, any>,
  detailLevel: DetailLevel,
): Record<string, any> {
  return compactObject({
    displayName: participant.displayName,
    signedInUser:
      detailLevel === "standard"
        ? (participant.signedInUser?.displayName ??
          participant.signedInUser?.user)
        : undefined,
    localEarliestStart: participant.localEarliestStart,
    localLatestEnd: participant.localLatestEnd,
    participantSessions: (participant.participantSessions ?? []).map(
      (session: any) => ({
        startTime: session.startTime,
        endTime: session.endTime,
        localStart: session.localStart,
        localEnd: session.localEnd,
        durationSeconds: session.durationSeconds,
        duration: session.duration,
      }),
    ),
  });
}

function compactCalendarMatch(
  match: Record<string, any>,
  detailLevel: DetailLevel,
): Record<string, any> {
  return compactObject({
    title: match.title,
    htmlLink: match.htmlLink,
    markdownLink: match.markdownLink,
    description: detailLevel === "standard" ? match.description : undefined,
    localStart: match.localStart,
    localEnd: match.localEnd,
    responseStatus: match.responseStatus,
    overlapSeconds: match.overlapSeconds,
    overlap: match.overlap,
    matchReason: match.matchReason,
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

function normalizeRecord(
  record: MeetRecord,
  space: MeetSpace | null,
  participants: MeetParticipant[],
  calendarMatches: unknown[],
  artifacts: MeetArtifact[],
  artifactErrors: string[],
) {
  return {
    name: record.name ?? null,
    spaceName: record.space ?? null,
    meetingCode: space?.meetingCode ?? null,
    meetingUri: space?.meetingUri ?? null,
    startTime: record.startTime ?? null,
    endTime: record.endTime ?? null,
    localStart: formatLocalDateTime(record.startTime),
    localEnd: formatLocalDateTime(record.endTime),
    expireTime: record.expireTime ?? null,
    participantCount: participants.length,
    participants: participants.map(normalizeParticipant),
    calendarMatches,
    artifacts,
    artifactSummary: summarizeArtifacts(artifacts, artifactErrors),
    artifactErrors,
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

function normalizeParticipant(participant: MeetParticipant) {
  const displayName = participantDisplayName(participant);
  return {
    name: participant.name ?? null,
    displayName,
    signedInUser: participant.signedinUser
      ? {
          user: participant.signedinUser.user ?? null,
          displayName: participant.signedinUser.displayName ?? null,
        }
      : null,
    anonymousUser: participant.anonymousUser
      ? { displayName: participant.anonymousUser.displayName ?? null }
      : null,
    phoneUser: participant.phoneUser
      ? { displayName: participant.phoneUser.displayName ?? null }
      : null,
    earliestStartTime: participant.earliestStartTime ?? null,
    latestEndTime: participant.latestEndTime ?? null,
    localEarliestStart: formatLocalDateTime(participant.earliestStartTime),
    localLatestEnd: formatLocalDateTime(participant.latestEndTime),
    participantSessions: (participant.participantSessions ?? []).map(
      (session) => ({
        name: session.name ?? null,
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
  };
}

function participantDisplayName(participant: MeetParticipant): string | null {
  return (
    participant.signedinUser?.displayName ??
    participant.anonymousUser?.displayName ??
    participant.phoneUser?.displayName ??
    null
  );
}

function participantSearchText(participant: MeetParticipant): string {
  return [
    participant.name,
    participant.signedinUser?.user,
    participant.signedinUser?.displayName,
    participant.anonymousUser?.displayName,
    participant.phoneUser?.displayName,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
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

function clampMax(value: number | undefined): number {
  if (value === undefined) return 25;
  if (!Number.isFinite(value) || value <= 0) return 25;
  return Math.min(500, Math.floor(value));
}

function escapeFilterString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
