import { createHash } from "node:crypto";
import { defineAgentTool } from "../../mcp/tool.ts";
import {
  ensureGoogleAccessToken,
  getGoogleToolConfig,
} from "../../googleSettings.ts";
import {
  processedSourceKeys,
  sourceKeys,
} from "../../meetingMinutesProcessed.ts";
import { localDayRange, normalizeRfc3339 } from "../../googleTime.ts";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3/";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const DEFAULT_GMAIL_MINUTES_LABEL = "Minutes";
const MAX_DISCOVERY_RESULTS_PER_SOURCE = 500;
const MAX_CALENDAR_EVENTS = 1000;

type DiscoverySource = "calendar" | "drive" | "gmail";

export type MeetingMinutesDiscoveryParams = {
  date?: string;
  from?: string;
  to?: string;
  sources?: DiscoverySource[];
  calendarId?: string;
  gmailMinutesLabelName?: string;
  processed?: "exclude" | "include" | "only";
  maxResults?: number;
};

type CalendarEventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};
type CalendarEvent = {
  id?: string;
  htmlLink?: string;
  summary?: string;
  updated?: string;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
  attachments?: Array<{
    fileUrl?: string;
    title?: string;
    mimeType?: string;
    fileId?: string;
  }>;
};
type CalendarEventsPage = {
  summary?: string;
  timeZone?: string;
  nextPageToken?: string;
  items?: CalendarEvent[];
};

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
};
type DriveFilesPage = { nextPageToken?: string; files?: DriveFile[] };

type GmailLabel = { id?: string; name?: string; type?: string };
type GmailLabelsResponse = { labels?: GmailLabel[] };
type GmailThreadRef = { id?: string };
type GmailThreadsPage = {
  threads?: GmailThreadRef[];
  resultSizeEstimate?: number;
  nextPageToken?: string;
};
type GmailHeader = { name?: string; value?: string };
type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
  labelIds?: string[];
};
type GmailThread = { id?: string; messages?: GmailMessage[] };

type DiscoveryCandidate = {
  id: string;
  title: string;
  sourceLink: string;
  sourceIds: {
    driveFileId?: string;
    gmailThreadId?: string;
    calendarEventId?: string;
  };
  date: string | null;
};

type MutableCandidate = DiscoveryCandidate & { score: number };

const meetingMinutesDiscoveryParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    date: {
      type: "string",
      description:
        "User-local YYYY-MM-DD day. Expands to that day's start/end range.",
    },
    from: {
      type: "string",
      description:
        "RFC3339 lower bound for discovery. Optional if date is provided.",
    },
    to: {
      type: "string",
      description:
        "RFC3339 upper bound for discovery. Optional if date is provided.",
    },
    sources: {
      type: "array",
      items: { type: "string", enum: ["calendar", "drive", "gmail"] },
      description: "Sources to search. Defaults to calendar, drive, and gmail.",
    },
    calendarId: {
      type: "string",
      description:
        "Calendar id to scan for minute attachments. Defaults to primary.",
    },
    gmailMinutesLabelName: {
      type: "string",
      description:
        "Gmail label name used for meeting-minutes emails. Defaults to the Google Workspace setting, usually Minutes.",
    },
    processed: {
      type: "string",
      enum: ["exclude", "include", "only"],
      description:
        "Whether to exclude already-processed sources, include all sources, or return only processed sources. Defaults to exclude.",
    },
    maxResults: {
      type: "number",
      description:
        "Maximum deduplicated candidates to return. Defaults to 20, maximum 100.",
    },
  },
} as const;

const meetingMinutesDiscoveryTool =
  defineAgentTool<MeetingMinutesDiscoveryParams>({
    name: "meeting_minutes_discovery",
    label: "Discover Meeting Minutes",
    description:
      "Token-efficient discovery of likely meeting-minutes sources across Calendar attachments, Drive Gemini notes, and Gmail minutes labels — the first step for any broad 'find meeting minutes / notes / action items' request over multiple days. It returns deduplicated candidate source links and minimal metadata only, never document or email bodies. Gemini notes are recognised by title/link pattern, not by file owner. Afterwards inspect only the selected candidates (meeting_minutes_scan_source, or google_drive_get_file / google_gmail_read mode=thread with a small maxChars); if the candidate set is still broad, narrow the date range or sources and run discovery again instead of falling back to generic Drive/Gmail/Calendar searches. Use each candidate's sourceLink as the stable de-duplication URL, and do not create Tasks before an action item is confirmed from the source content.",
    parameters: meetingMinutesDiscoveryParamsSchema,
    async execute(params) {
      const gathered = await gatherMeetingMinutesCandidates(params);
      const processedMode = params.processed ?? "exclude";
      const processedKeys =
        processedMode === "include" ? new Set<string>() : processedSourceKeys();
      const matchingCandidates = gathered.candidates.filter((candidate) => {
        if (processedMode === "include") return true;
        const isProcessed = sourceKeys(candidate).some((key) =>
          processedKeys.has(key),
        );
        return processedMode === "only" ? isProcessed : !isProcessed;
      });
      const maxResults = clamp(params.maxResults ?? 20, 1, 100);
      const returnedCandidates = matchingCandidates.slice(0, maxResults);
      const payload = {
        date: params.date ?? null,
        from: gathered.from,
        to: gathered.to,
        sources: gathered.sources,
        processed: processedMode,
        candidateCount: returnedCandidates.length,
        totalCandidateCount: matchingCandidates.length,
        truncated: matchingCandidates.length > returnedCandidates.length,
        sourceCounts: gathered.sourceCounts,
        ...(Object.keys(gathered.sourceWarnings).length > 0
          ? { sourceWarnings: gathered.sourceWarnings }
          : {}),
        candidates: returnedCandidates,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });

export interface GatheredMeetingMinutes {
  candidates: DiscoveryCandidate[];
  from: string;
  to: string;
  sources: DiscoverySource[];
  sourceCounts: Partial<Record<DiscoverySource, number>>;
  sourceWarnings: Partial<Record<DiscoverySource, string>>;
}

/**
 * Reusable discovery core: gather + dedup + score-sort the day's likely
 * meeting-minutes candidates across Calendar attachments, Drive Gemini notes,
 * and Gmail (no processed-ledger filtering — callers decide). Shared by the
 * agent tool above and the day-scan minutes pipeline (`../../dayScan/minutesPipeline.ts`).
 */
export async function gatherMeetingMinutesCandidates(
  params: MeetingMinutesDiscoveryParams,
): Promise<GatheredMeetingMinutes> {
  const range = normalizeRange(params);
  if (!range.from || !range.to)
    throw new Error(
      "Provide date or both from and to to avoid an unbounded meeting-minutes discovery query.",
    );

  const requestedSources = normalizeSources(params.sources);
  const calendarId = params.calendarId?.trim() || "primary";

  const config = getGoogleToolConfig();
  const accessToken = await ensureGoogleAccessToken(config);
  const gmailMinutesLabelName =
    params.gmailMinutesLabelName?.trim() ||
    config.gmailMinutesLabelName?.trim() ||
    DEFAULT_GMAIL_MINUTES_LABEL;

  const candidates = new Map<string, MutableCandidate>();
  const sourceCounts: Partial<Record<DiscoverySource, number>> = {};
  const sourceWarnings: Partial<Record<DiscoverySource, string>> = {};

  if (requestedSources.includes("calendar")) {
    sourceCounts.calendar = 0;
    try {
      const events = await listCalendarEvents({
        accessToken,
        calendarId,
        from: range.from,
        to: range.to,
        maxResults: MAX_CALENDAR_EVENTS,
      });
      for (const event of events) {
        for (const attachment of event.attachments ?? []) {
          if (!isMinutesLike(attachment.title ?? "")) continue;
          sourceCounts.calendar += 1;
          upsertCandidate(
            candidates,
            candidateFromCalendarAttachment(event, attachment),
          );
        }
      }
      if (events.length >= MAX_CALENDAR_EVENTS)
        sourceWarnings.calendar = `Reached internal calendar event safety cap of ${MAX_CALENDAR_EVENTS}; narrow the date range if results seem incomplete.`;
    } catch (err) {
      sourceWarnings.calendar =
        err instanceof Error ? err.message : String(err);
    }
  }

  if (requestedSources.includes("drive")) {
    sourceCounts.drive = 0;
    try {
      const files = await searchDriveGeminiMinutes({
        accessToken,
        from: range.from,
        to: range.to,
        maxResults: MAX_DISCOVERY_RESULTS_PER_SOURCE,
      });
      sourceCounts.drive = files.length;
      if (files.length >= MAX_DISCOVERY_RESULTS_PER_SOURCE)
        sourceWarnings.drive = `Reached internal Drive safety cap of ${MAX_DISCOVERY_RESULTS_PER_SOURCE}; narrow the date range if results seem incomplete.`;
      for (const file of files)
        upsertCandidate(candidates, candidateFromDriveFile(file));
    } catch (err) {
      sourceWarnings.drive = err instanceof Error ? err.message : String(err);
    }
  }

  if (requestedSources.includes("gmail")) {
    sourceCounts.gmail = 0;
    try {
      const gmail = await searchGmailMinutes({
        accessToken,
        from: range.from,
        to: range.to,
        labelName: gmailMinutesLabelName,
        maxResults: MAX_DISCOVERY_RESULTS_PER_SOURCE,
      });
      sourceCounts.gmail = gmail.threads.length;
      if (gmail.warning) sourceWarnings.gmail = gmail.warning;
      for (const thread of gmail.threads)
        upsertCandidate(candidates, candidateFromGmailThread(thread));
    } catch (err) {
      sourceWarnings.gmail = err instanceof Error ? err.message : String(err);
    }
  }

  const sorted = uniqueCandidateValues(candidates)
    .sort(compareCandidates)
    .map(stripScore);
  return {
    candidates: sorted,
    from: range.from,
    to: range.to,
    sources: requestedSources,
    sourceCounts,
    sourceWarnings,
  };
}

export const assistantMeetingMinutesDiscoveryTools = [
  meetingMinutesDiscoveryTool,
];

async function listCalendarEvents({
  accessToken,
  calendarId,
  from,
  to,
  maxResults,
}: {
  accessToken: string;
  calendarId: string;
  from: string;
  to: string;
  maxResults: number;
}): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: from,
      timeMax: to,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(250, maxResults - out.length)),
      showDeleted: "false",
      supportsAttachments: "true",
      fields:
        "nextPageToken,items(id,htmlLink,summary,updated,start,end,attachments(fileId,fileUrl,title,mimeType))",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleGet<CalendarEventsPage>(
      `${CALENDAR_API_BASE}calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      accessToken,
    );
    for (const event of page.items ?? []) {
      out.push(event);
      if (out.length >= maxResults) return out;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

async function searchDriveGeminiMinutes({
  accessToken,
  from,
  to,
  maxResults,
}: {
  accessToken: string;
  from: string;
  to: string;
  maxResults: number;
}): Promise<DriveFile[]> {
  const query = [
    "trashed = false",
    `(mimeType = '${GOOGLE_DOC_MIME}' or mimeType = 'application/pdf')`,
    `modifiedTime >= '${escapeDriveString(from)}'`,
    `modifiedTime < '${escapeDriveString(to)}'`,
    "(name contains 'Notes by Gemini' or name contains 'notes by Gemini' or name contains 'Meeting notes' or name contains 'meeting notes' or name contains 'Minutes' or name contains 'minutes')",
  ].join(" and ");
  const fields =
    "nextPageToken,files(id,name,mimeType,webViewLink,createdTime,modifiedTime)";
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: query,
      pageSize: String(Math.min(100, maxResults - out.length)),
      fields,
      orderBy: "modifiedTime desc",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleGet<DriveFilesPage>(
      `${DRIVE_API_BASE}files?${params}`,
      accessToken,
    );
    for (const file of page.files ?? []) {
      out.push(file);
      if (out.length >= maxResults) return out;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

async function searchGmailMinutes({
  accessToken,
  from,
  to,
  labelName,
  maxResults,
}: {
  accessToken: string;
  from: string;
  to: string;
  labelName: string;
  maxResults: number;
}): Promise<{
  threads: GmailThread[];
  resultSizeEstimate: number | null;
  warning?: string;
}> {
  const label = await findGmailLabel(accessToken, labelName);
  const query = `after:${gmailDate(from)} before:${gmailDate(to)}`;
  const refs: GmailThreadRef[] = [];
  let resultSizeEstimate: number | null = null;
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(500, maxResults - refs.length)),
      includeSpamTrash: "false",
    });
    if (label?.id) params.append("labelIds", label.id);
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleGet<GmailThreadsPage>(
      `${GMAIL_API_BASE}threads?${params}`,
      accessToken,
    );
    resultSizeEstimate = page.resultSizeEstimate ?? resultSizeEstimate;
    for (const thread of page.threads ?? []) {
      refs.push(thread);
      if (refs.length >= maxResults) break;
    }
    pageToken = refs.length >= maxResults ? undefined : page.nextPageToken;
  } while (pageToken);

  const threads: GmailThread[] = [];
  for (const item of refs) {
    if (!item.id) continue;
    const metaParams = new URLSearchParams({ format: "metadata" });
    metaParams.append("metadataHeaders", "Subject");
    metaParams.append("metadataHeaders", "From");
    metaParams.append("metadataHeaders", "Date");
    const thread = await googleGet<GmailThread>(
      `${GMAIL_API_BASE}threads/${encodeURIComponent(item.id)}?${metaParams}`,
      accessToken,
    );
    threads.push(thread);
  }

  const warnings = [
    label
      ? null
      : `Gmail label '${labelName}' was not found; searched by date without a label filter. Configure the label in Settings → Google Workspace if needed.`,
    refs.length >= maxResults
      ? `Reached internal Gmail safety cap of ${maxResults}; narrow the date range if results seem incomplete.`
      : null,
  ].filter(Boolean);
  return {
    threads,
    resultSizeEstimate,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

async function findGmailLabel(
  accessToken: string,
  labelName: string,
): Promise<GmailLabel | null> {
  const labels = await googleGet<GmailLabelsResponse>(
    `${GMAIL_API_BASE}labels`,
    accessToken,
  );
  const normalized = labelName.trim().toLocaleLowerCase();
  return (
    (labels.labels ?? []).find(
      (label) => label.name?.trim().toLocaleLowerCase() === normalized,
    ) ?? null
  );
}

function candidateFromCalendarAttachment(
  event: CalendarEvent,
  attachment: NonNullable<CalendarEvent["attachments"]>[number],
): MutableCandidate {
  const href = attachment.fileUrl || event.htmlLink || "";
  const attachmentTitle = attachment.title || "Calendar attachment";
  const title =
    isGenericMinutesTitle(attachmentTitle) && event.summary
      ? event.summary
      : attachmentTitle;
  const date =
    event.start?.dateTime || event.start?.date || event.updated || null;
  return {
    id: candidateId(
      "calendar",
      attachment.fileId || href || `${event.id ?? "event"}:${title}`,
    ),
    title,
    sourceLink: href,
    sourceIds: {
      ...(event.id != null ? { calendarEventId: event.id } : {}),
      ...(attachment.fileId != null ? { driveFileId: attachment.fileId } : {}),
    },
    date,
    score: 70 + scoreTitle(title),
  };
}

function candidateFromDriveFile(file: DriveFile): MutableCandidate {
  const title = file.name || "Drive meeting minutes";
  const href =
    file.webViewLink ||
    `https://drive.google.com/open?id=${encodeURIComponent(file.id ?? "")}`;
  return {
    id: candidateId("drive", file.id || href),
    title,
    sourceLink: href,
    sourceIds: { ...(file.id != null ? { driveFileId: file.id } : {}) },
    date: file.modifiedTime ?? file.createdTime ?? null,
    score: 80 + scoreTitle(title),
  };
}

function candidateFromGmailThread(thread: GmailThread): MutableCandidate {
  const messages = [...(thread.messages ?? [])].sort(
    (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
  );
  const first = messages[0];
  const last = messages[messages.length - 1] ?? first;
  const subject =
    header(first, "Subject") ||
    header(last, "Subject") ||
    "Gmail meeting minutes";
  const href = gmailThreadUrl(thread.id ?? first?.threadId ?? "");
  const gmailThreadIdValue = thread.id ?? first?.threadId ?? undefined;
  return {
    id: candidateId("gmail", thread.id || first?.threadId || subject),
    title: subject,
    sourceLink: href,
    sourceIds: {
      ...(gmailThreadIdValue !== undefined
        ? { gmailThreadId: gmailThreadIdValue }
        : {}),
    },
    date: last?.internalDate
      ? new Date(Number(last.internalDate)).toISOString()
      : null,
    score: 60 + scoreTitle(subject),
  };
}

function upsertCandidate(
  candidates: Map<string, MutableCandidate>,
  incoming: MutableCandidate,
): void {
  const keys = candidateKeys(incoming);
  const existingKey = keys.find((key) => candidates.has(key));
  if (!existingKey) {
    for (const key of keys) candidates.set(key, incoming);
    return;
  }
  const existing = candidates.get(existingKey)!;
  existing.score = Math.max(existing.score, incoming.score) + 8;
  existing.sourceIds = { ...existing.sourceIds, ...incoming.sourceIds };
  if (shouldUseIncomingTitle(existing.title, incoming.title))
    existing.title = incoming.title;
  if (!existing.sourceLink && incoming.sourceLink)
    existing.sourceLink = incoming.sourceLink;
  if (!existing.date && incoming.date) existing.date = incoming.date;
  for (const key of keys) candidates.set(key, existing);
}

function candidateKeys(candidate: DiscoveryCandidate): string[] {
  const keys = [];
  if (candidate.sourceIds.driveFileId)
    keys.push(`drive:${candidate.sourceIds.driveFileId}`);
  if (candidate.sourceIds.gmailThreadId)
    keys.push(`gmail:${candidate.sourceIds.gmailThreadId}`);
  if (candidate.sourceLink) keys.push(`link:${candidate.sourceLink}`);
  keys.push(`id:${candidate.id}`);
  return unique(keys);
}

function uniqueCandidateValues(
  candidates: Map<string, MutableCandidate>,
): MutableCandidate[] {
  return [...new Set(candidates.values())];
}

function compareCandidates(a: MutableCandidate, b: MutableCandidate): number {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;
  return dateMs(b.date) - dateMs(a.date);
}

function stripScore(candidate: MutableCandidate): DiscoveryCandidate {
  const { score: _score, ...rest } = candidate;
  return rest;
}

function normalizeSources(
  sources: DiscoverySource[] | undefined,
): DiscoverySource[] {
  const allowed = new Set<DiscoverySource>(["calendar", "drive", "gmail"]);
  const out = unique(
    (sources ?? ["calendar", "drive", "gmail"]).filter(
      (source): source is DiscoverySource => allowed.has(source),
    ),
  );
  if (out.length === 0)
    throw new Error(
      "At least one source must be selected: calendar, drive, or gmail.",
    );
  return out;
}

function normalizeRange(params: MeetingMinutesDiscoveryParams): {
  from: string | null;
  to: string | null;
} {
  if (params.date) {
    if (!ISO_DATE_RE.test(params.date))
      throw new Error("date must be a YYYY-MM-DD date.");
    return localDayRange(params.date);
  }
  if (!params.from || !params.to) return { from: null, to: null };
  return {
    from: normalizeRfc3339(params.from, "from"),
    to: normalizeRfc3339(params.to, "to"),
  };
}

function isMinutesLike(value: string): boolean {
  return /notes by gemini|meeting notes|minutes|transcript/i.test(value);
}

function isGenericMinutesTitle(value: string): boolean {
  return /^(notes by gemini|meeting notes|minutes|transcript|calendar attachment)$/i.test(
    value.trim(),
  );
}

function shouldUseIncomingTitle(current: string, incoming: string): boolean {
  if (isGenericMinutesTitle(current) && !isGenericMinutesTitle(incoming))
    return true;
  return (
    incoming.length > current.length + 12 && !isGenericMinutesTitle(incoming)
  );
}

function scoreTitle(value: string): number {
  let score = 0;
  if (/notes by gemini/i.test(value)) score += 35;
  if (/meeting notes/i.test(value)) score += 20;
  if (/minutes/i.test(value)) score += 15;
  if (/transcript/i.test(value)) score += 8;
  return score;
}

function header(
  message: GmailMessage | undefined,
  name: string,
): string | null {
  const normalized = name.toLocaleLowerCase();
  return (
    message?.payload?.headers?.find(
      (item) => item.name?.toLocaleLowerCase() === normalized,
    )?.value ?? null
  );
}

function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`;
}

function gmailDate(value: string): string {
  const date = new Date(value);
  return `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

async function googleGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Google API returned HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function candidateId(source: string, key: string): string {
  return `${source}_${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
}

function escapeDriveString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function dateMs(value: string | null): number {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
