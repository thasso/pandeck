import { Fragment, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock,
  ExternalLink,
  AlertCircle,
  Bell,
  FileText,
  Inbox,
  Info,
  Mail,
  MailOpen,
  Megaphone,
  MessageCircle,
  Paperclip,
  Send,
  Star,
  Tag,
  Trash2,
  UserRound,
  Users,
  Video,
  XCircle,
} from "lucide-react";
import type { DisplayBlock } from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "../lib/serverOrigin.ts";
import { normalizedToolName } from "./tools/toolName.ts";
import { ChatWideCard } from "./ChatWideCard.tsx";
import { Skeleton, Spinner } from "./common/load.tsx";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

type CalendarPayload = {
  calendarSummary?: string | null;
  date?: string | null;
  localFrom?: string | null;
  localTo?: string | null;
  eventCount?: number;
  events?: CalendarEvent[];
};

type CalendarEvent = {
  title?: string;
  htmlLink?: string | null;
  description?: string | null;
  localStart?: string | null;
  localEnd?: string | null;
  start?: string | null;
  end?: string | null;
  duration?: string | null;
  location?: string | null;
  selfAttendee?: { responseStatus?: string | null } | null;
  meet?: { meetingCode?: string | null; meetingUri?: string | null } | null;
  conferenceLinks?: ConferenceLink[];
  attachments?: CalendarAttachment[];
  meetRecords?: MeetRecord[];
};

type CalendarAttachment = {
  fileId?: string | null;
  title?: string | null;
  mimeType?: string | null;
  fileUrl?: string | null;
};

type ConferenceLink = {
  provider?: "google-meet" | "zoom" | "teams" | "other";
  label?: string;
  uri?: string;
  source?: string;
};

type MeetPayload = {
  date?: string | null;
  from?: string | null;
  to?: string | null;
  recordCount?: number;
  records?: MeetRecord[];
};

type DriveDocumentPayload = {
  file?: DriveFile | null;
  exportMimeType?: string | null;
  truncated?: boolean;
  textCharCount?: number;
  text?: string;
};

type DriveFile = {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  webViewLink?: string | null;
  localModified?: string | null;
  owners?: Array<{ displayName?: string | null; emailAddress?: string | null }>;
};

type DrivePreview = {
  file?: DriveFile | null;
  exportMimeType?: string | null;
  truncated?: boolean;
  textCharCount?: number;
  text?: string;
  error?: string;
};

type MeetRecord = {
  name?: string | null;
  meetingCode?: string | null;
  meetingUri?: string | null;
  localStart?: string | null;
  localEnd?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  participantCount?: number;
  participants?: MeetParticipant[];
  calendarMatches?: CalendarMatch[];
  artifacts?: MeetArtifact[];
  artifactSummary?: {
    total?: number;
    transcripts?: number;
    recordings?: number;
    driveBacked?: number;
    errors?: number;
  };
  artifactErrors?: string[];
};

type MeetArtifact = {
  kind?: "transcript" | "recording";
  state?: string | null;
  localStart?: string | null;
  localEnd?: string | null;
  driveFileId?: string | null;
  webViewLink?: string | null;
  exportUri?: string | null;
  entryCount?: number | null;
  textPreview?: string | null;
};

type MeetParticipant = {
  displayName?: string | null;
  signedInUser?: { displayName?: string | null; user?: string | null } | null;
  participantSessions?: Array<{
    localStart?: string | null;
    localEnd?: string | null;
    duration?: string | null;
  }>;
};

type CalendarMatch = {
  title?: string;
  htmlLink?: string | null;
  localStart?: string | null;
  localEnd?: string | null;
  responseStatus?: string | null;
  overlap?: string | null;
};

type MinutesLink = {
  label: string;
  href?: string | null;
  driveFileId?: string | null;
  source: string;
};

type GmailPayload =
  GmailSearchPayload | GmailThreadPayload | GmailMessagePayload;

type GmailSearchPayload = {
  mode: "search";
  query?: string;
  resultSizeEstimate?: number | null;
  returned?: number;
  threads?: GmailThreadSummary[];
};

type GmailThreadPayload = {
  mode: "thread";
  threadId?: string;
  gmailUrl?: string;
  subject?: string;
  unread?: boolean;
  messageCount?: number;
  localLatestDate?: string | null;
  participants?: GmailParticipant[];
  labels?: string[];
  labelIds?: string[];
  messages?: GmailFullMessage[];
  totalTextCharCount?: number;
  truncated?: boolean;
  error?: string;
};

type GmailMessagePayload = {
  mode: "message";
  message?: GmailFullMessage;
};

type GmailThreadSummary = {
  id: string;
  gmailUrl?: string;
  subject?: string;
  snippet?: string;
  unread?: boolean;
  inbox?: boolean;
  starred?: boolean;
  important?: boolean;
  messageCount?: number;
  localLatestDate?: string | null;
  latestFrom?: string | null;
  participants?: GmailParticipant[];
  labels?: string[];
  labelIds?: string[];
  messages?: GmailMessageSummary[];
};

type GmailParticipant = {
  name?: string | null;
  email?: string | null;
  label?: string;
};

type GmailMessageSummary = {
  id?: string | null;
  localDate?: string | null;
  from?: string | null;
  fromName?: string | null;
  fromEmail?: string | null;
  to?: string | null;
  subject?: string;
  snippet?: string;
  unread?: boolean;
  labels?: string[];
};

type GmailFullMessage = GmailMessageSummary & {
  text?: string;
  textCharCount?: number;
  truncated?: boolean;
  attachments?: Array<{
    filename?: string;
    mimeType?: string | null;
    attachmentId?: string | null;
    size?: number | null;
  }>;
  gmailUrl?: string | null;
};

export function shouldRenderGoogleWorkspaceTool(block: ToolBlock): boolean {
  if (!block.done || block.isError) return false;
  if (
    block.name !== "google_calendar_list_events" &&
    block.name !== "google_meet_list_records" &&
    block.name !== "google_drive_get_file" &&
    block.name !== "google_gmail_read"
  )
    return false;
  const args = block.args as { render?: unknown } | null;
  if (args?.render !== true) return false;
  return Boolean(parseJson(block.output));
}

export function GoogleWorkspaceToolCard({ block }: { block: ToolBlock }) {
  const payload = parseJson(block.output);
  if (!payload) return null;
  const name = normalizedToolName(block.name);
  if (name === "google_calendar_list_events")
    return <CalendarCard payload={payload as CalendarPayload} />;
  if (name === "google_meet_list_records")
    return <MeetCard payload={payload as MeetPayload} />;
  if (name === "google_drive_get_file")
    return <DriveDocumentCard payload={payload as DriveDocumentPayload} />;
  if (name === "google_gmail_read")
    return <GmailCard payload={payload as GmailPayload} />;
  return null;
}

function CalendarCard({ payload }: { payload: CalendarPayload }) {
  const events = payload.events ?? [];
  return (
    <ChatWideCard maxWidth={1120}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <CalendarDays size={18} className="text-primary" />
          <div>
            <div className="text-body font-semibold text-fg">Calendar</div>
            <div className="text-caption text-faint">
              {payload.calendarSummary || "Primary calendar"}
            </div>
          </div>
        </div>
        <div className="text-right text-caption text-muted-foreground">
          <div>
            {payload.date || rangeLabel(payload.localFrom, payload.localTo)}
          </div>
          <div>
            {events.length} event{events.length === 1 ? "" : "s"}
          </div>
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-separate border-spacing-0 text-left text-caption">
          <thead className="bg-surface/70 text-micro uppercase tracking-wide text-faint">
            <tr>
              <th className="w-36 px-4 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Event</th>
              <th
                className="w-10 px-2 py-2 text-center font-medium"
                title="Your response status"
              >
                ✓
              </th>
              <th
                className="w-10 px-2 py-2 text-center font-medium"
                title="Meeting link"
              >
                <Video size={12} className="mx-auto" />
              </th>
              <th
                className="w-10 px-2 py-2 text-center font-medium"
                title="Minutes/transcript link"
              >
                <FileText size={12} className="mx-auto" />
              </th>
              <th
                className="w-10 px-2 py-2 text-center font-medium"
                title="Meet attendance info"
              >
                <Users size={12} className="mx-auto" />
              </th>
              <th
                className="w-10 px-3 py-2 text-center font-medium"
                title="Details"
              >
                <Info size={12} className="mx-auto" />
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, index) => (
              <CalendarEventRow
                key={`${event.htmlLink ?? event.title ?? "event"}-${index}`}
                event={event}
              />
            ))}
            {events.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  No calendar events found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ChatWideCard>
  );
}

function CalendarEventRow({ event }: { event: CalendarEvent }) {
  const [open, setOpen] = useState(false);
  const meetRecords = event.meetRecords ?? [];
  const minutesLinks = minutesLinksForEvent(event);
  const hasDetails = Boolean(
    event.description?.trim() ||
    meetRecords.length > 0 ||
    minutesLinks.length > 0,
  );
  return (
    <Fragment>
      <tr className="border-t border-line odd:bg-surface/30">
        <td className="whitespace-nowrap border-t border-line px-4 py-3 align-top font-mono text-caption text-fg">
          {timeRange(event.localStart, event.localEnd)}
          {event.duration && (
            <span className="text-muted-foreground"> · {event.duration}</span>
          )}
        </td>
        <td className="min-w-0 border-t border-line px-3 py-3 align-top">
          <ExternalTitle
            title={event.title || "(untitled)"}
            href={event.htmlLink}
          />
          {event.location && <LocationLine location={event.location} />}
        </td>
        <td className="border-t border-line px-2 py-3 text-center align-top">
          <StatusIcon status={event.selfAttendee?.responseStatus} />
        </td>
        <td className="border-t border-line px-2 py-3 text-center align-top">
          <MeetingLinkIcon event={event} />
        </td>
        <td className="border-t border-line px-2 py-3 text-center align-top">
          <MinutesIcon links={minutesLinks} />
        </td>
        <td className="border-t border-line px-2 py-3 text-center align-top">
          <AttendanceIcon records={meetRecords} />
        </td>
        <td className="border-t border-line px-3 py-3 text-center align-top">
          {hasDetails ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              title={
                open
                  ? "Hide details"
                  : "Show description and attendance details"
              }
              className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
            >
              <ChevronDown
                size={15}
                className={`transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
          ) : (
            <span className="text-faint">—</span>
          )}
        </td>
      </tr>
      {open && hasDetails && (
        <tr className="bg-surface/60">
          <td colSpan={7} className="border-t border-line px-4 py-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
              <DescriptionPanel
                description={event.description}
                location={event.location}
              />
              <AttendancePanel
                records={meetRecords}
                minutesLinks={minutesLinks}
              />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function DescriptionPanel({
  description,
  location,
}: {
  description?: string | null | undefined;
  location?: string | null | undefined;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="mb-2 text-micro font-semibold uppercase tracking-wide text-faint">
        Description
      </div>
      {description?.trim() ? (
        <div className="max-h-72 overflow-auto whitespace-pre-wrap text-caption text-fg">
          <LinkifiedText text={description} />
        </div>
      ) : location ? (
        <div className="text-caption text-fg">
          <LinkifiedText text={location} />
        </div>
      ) : (
        <div className="text-caption text-faint">No description.</div>
      )}
    </div>
  );
}

function AttendancePanel({
  records,
  minutesLinks,
}: {
  records: MeetRecord[];
  minutesLinks: MinutesLink[];
}) {
  const sessionCount = records
    .flatMap((r) => r.participants ?? [])
    .flatMap((p) => p.participantSessions ?? []).length;
  const artifactCount = records.flatMap((r) => r.artifacts ?? []).length;
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-micro font-semibold uppercase tracking-wide text-faint">
          Meet attendance
        </div>
        {records.length > 0 && (
          <div className="text-micro text-faint">
            {records.length} record{records.length === 1 ? "" : "s"} ·{" "}
            {sessionCount} session{sessionCount === 1 ? "" : "s"} ·{" "}
            {artifactCount} artifact{artifactCount === 1 ? "" : "s"}
          </div>
        )}
      </div>
      <MinutesLinksList links={minutesLinks} />
      {records.length === 0 ? (
        <div className="text-caption text-faint">
          No matching Meet attendance record.
        </div>
      ) : (
        <div className="max-h-72 space-y-2 overflow-auto pr-1">
          {records.map((record, index) => (
            <div
              key={`${record.name ?? "record"}-${index}`}
              className="rounded-lg bg-raised/60 p-2 text-caption"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-mono text-faint">
                  {timeRange(record.localStart, record.localEnd)}
                </div>
                {record.meetingUri && (
                  <a
                    href={record.meetingUri}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <Video size={12} /> Meet
                  </a>
                )}
              </div>
              <div className="mt-1 space-y-1">
                {(record.participants ?? []).map((participant, pIndex) => (
                  <div
                    key={`${participant.displayName ?? participant.signedInUser?.user ?? "participant"}-${pIndex}`}
                    className="rounded-md bg-panel/70 px-2 py-1"
                  >
                    <div className="font-medium text-fg">
                      {participant.displayName ||
                        participant.signedInUser?.displayName ||
                        participant.signedInUser?.user ||
                        "Participant"}
                    </div>
                    {participant.participantSessions?.length ? (
                      <div className="text-faint">
                        {participant.participantSessions
                          .map(
                            (s) =>
                              `${timeRange(s.localStart, s.localEnd)}${s.duration ? ` (${s.duration})` : ""}`,
                          )
                          .join(", ")}
                      </div>
                    ) : (
                      <div className="text-faint">No session details</div>
                    )}
                  </div>
                ))}
              </div>
              <ArtifactList
                artifacts={record.artifacts ?? []}
                errors={record.artifactErrors ?? []}
                compact
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MeetCard({ payload }: { payload: MeetPayload }) {
  const records = payload.records ?? [];
  return (
    <ChatWideCard maxWidth={1120}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <Video size={18} className="text-primary" />
          <div>
            <div className="text-body font-semibold text-fg">
              Google Meet records
            </div>
            <div className="text-caption text-faint">
              Conference records and participant sessions
            </div>
          </div>
        </div>
        <div className="text-right text-caption text-muted-foreground">
          <div>{payload.date || rangeLabel(payload.from, payload.to)}</div>
          <div>
            {records.length} record{records.length === 1 ? "" : "s"}
          </div>
        </div>
      </header>

      <div className="grid gap-3 p-3 md:grid-cols-2">
        {records.map((record, index) => (
          <article
            key={`${record.name ?? "meet"}-${index}`}
            className="rounded-xl border border-line bg-surface p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-caption text-faint">
                  {timeRange(record.localStart, record.localEnd)}
                </div>
                <div className="mt-1 text-body font-semibold text-fg">
                  <ExternalTitle
                    title={
                      record.calendarMatches?.[0]?.title ||
                      record.meetingCode ||
                      "Meet record"
                    }
                    href={
                      record.calendarMatches?.[0]?.htmlLink || record.meetingUri
                    }
                  />
                </div>
              </div>
              {record.meetingUri && (
                <a
                  href={record.meetingUri}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="shrink-0 rounded-md border border-line px-2 py-1 text-caption text-primary hover:bg-raised"
                >
                  Meet
                </a>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2 text-caption text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-1">
                <Users size={12} />{" "}
                {record.participantCount ?? record.participants?.length ?? 0}{" "}
                participants
              </span>
              {record.meetingCode && (
                <span className="rounded-full bg-raised px-2 py-1 font-mono">
                  {record.meetingCode}
                </span>
              )}
              {record.calendarMatches?.[0]?.overlap && (
                <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-1">
                  <Clock size={12} /> {record.calendarMatches[0].overlap}{" "}
                  overlap
                </span>
              )}
              {(record.artifactSummary?.total ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-1">
                  <FileText size={12} /> {artifactSummaryLabel(record)}
                </span>
              )}
            </div>

            <div className="mt-3 space-y-1.5">
              {(record.participants ?? [])
                .slice(0, 6)
                .map((participant, pIndex) => (
                  <div
                    key={`${participant.displayName ?? "participant"}-${pIndex}`}
                    className="rounded-lg bg-raised/60 px-2 py-1.5 text-caption"
                  >
                    <div className="font-medium text-fg">
                      {participant.displayName ||
                        participant.signedInUser?.displayName ||
                        participant.signedInUser?.user ||
                        "Participant"}
                    </div>
                    {participant.participantSessions?.length ? (
                      <div className="mt-0.5 text-faint">
                        {participant.participantSessions
                          .map(
                            (s) =>
                              `${timeRange(s.localStart, s.localEnd)}${s.duration ? ` (${s.duration})` : ""}`,
                          )
                          .join(", ")}
                      </div>
                    ) : null}
                  </div>
                ))}
              {(record.participants?.length ?? 0) > 6 && (
                <div className="text-caption text-faint">
                  +{(record.participants?.length ?? 0) - 6} more participants
                </div>
              )}
            </div>
            <ArtifactList
              artifacts={record.artifacts ?? []}
              errors={record.artifactErrors ?? []}
            />
          </article>
        ))}
        {records.length === 0 && (
          <div className="p-6 text-center text-muted-foreground">
            No Meet records found.
          </div>
        )}
      </div>
    </ChatWideCard>
  );
}

function MinutesLinksList({ links }: { links: MinutesLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="mb-2 space-y-1.5">
      <div className="text-micro font-semibold uppercase tracking-wide text-faint">
        Minutes / transcripts
      </div>
      {links.map((link, index) => (
        <div
          key={`${link.driveFileId ?? link.href ?? link.label}-${index}`}
          className="rounded-lg bg-raised/60 px-2 py-1.5 text-caption"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex min-w-0 items-center gap-1 font-medium text-fg">
              <FileText size={12} className="shrink-0 text-primary" />
              {link.href ? (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="truncate text-primary hover:underline"
                >
                  {link.label}
                </a>
              ) : (
                <span className="truncate">{link.label}</span>
              )}
            </div>
            <span className="rounded-full bg-panel px-1.5 py-0.5 text-micro text-muted-foreground">
              {link.source}
            </span>
          </div>
          {link.driveFileId && <DrivePreviewButton fileId={link.driveFileId} />}
        </div>
      ))}
      <div className="text-micro text-faint">
        Preview loads here only in the browser; it is not sent to the assistant
        context.
      </div>
    </div>
  );
}

function ArtifactList({
  artifacts,
  errors,
  compact = false,
}: {
  artifacts: MeetArtifact[];
  errors: string[];
  compact?: boolean;
}) {
  if (artifacts.length === 0 && errors.length === 0) return null;
  return (
    <div className={`${compact ? "mt-2" : "mt-3"} space-y-1.5`}>
      {artifacts.length > 0 && (
        <div className="text-micro font-semibold uppercase tracking-wide text-faint">
          Artifacts
        </div>
      )}
      {artifacts.map((artifact, index) => {
        const label =
          artifact.kind === "recording" ? "Recording" : "Transcript / notes";
        const href = artifact.webViewLink || artifact.exportUri || undefined;
        return (
          <div
            key={`${artifact.kind ?? "artifact"}-${artifact.driveFileId ?? index}`}
            className="rounded-lg bg-panel/70 px-2 py-1.5 text-caption"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1 font-medium text-fg">
                <FileText size={12} className="text-primary" />
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-primary hover:underline"
                  >
                    {label}
                  </a>
                ) : (
                  label
                )}
              </div>
              {artifact.state && (
                <span className="rounded-full bg-raised px-1.5 py-0.5 text-micro text-muted-foreground">
                  {artifact.state}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-faint">
              {timeRange(artifact.localStart, artifact.localEnd)}
              {artifact.entryCount !== undefined && artifact.entryCount !== null
                ? ` · ${artifact.entryCount} entries`
                : ""}
              {artifact.driveFileId ? " · Drive doc available" : ""}
            </div>
            {artifact.driveFileId && (
              <DrivePreviewButton fileId={artifact.driveFileId} />
            )}
            {artifact.textPreview && (
              <div className="mt-1 max-h-16 overflow-hidden whitespace-pre-wrap text-fg">
                {artifact.textPreview}
              </div>
            )}
          </div>
        );
      })}
      {errors.map((error, index) => (
        <div key={index} className="text-caption text-faint">
          Artifact lookup: {error}
        </div>
      ))}
    </div>
  );
}

function artifactSummaryLabel(record: MeetRecord): string {
  const transcripts = record.artifactSummary?.transcripts ?? 0;
  const recordings = record.artifactSummary?.recordings ?? 0;
  const parts = [];
  if (transcripts)
    parts.push(`${transcripts} transcript${transcripts === 1 ? "" : "s"}`);
  if (recordings)
    parts.push(`${recordings} recording${recordings === 1 ? "" : "s"}`);
  return parts.join(", ") || `${record.artifactSummary?.total ?? 0} artifacts`;
}

function DrivePreviewButton({ fileId }: { fileId: string }) {
  const [preview, setPreview] = useState<DrivePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  async function loadPreview() {
    if (preview) {
      setOpen((value) => !value);
      return;
    }
    setLoading(true);
    setOpen(true);
    try {
      const res = await fetch(
        `${serverHttpOrigin()}/api/google/drive/file/${encodeURIComponent(fileId)}/preview?maxChars=16000`,
        { headers: { ...authHeaders() } },
      );
      const data = (await res.json().catch(() => ({}))) as DrivePreview;
      if (!res.ok) setPreview({ error: data.error || `HTTP ${res.status}` });
      else setPreview(data);
    } catch (err) {
      setPreview({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => void loadPreview()}
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-caption text-primary transition-colors hover:bg-raised"
        aria-busy={loading}
      >
        {loading ? <Spinner size="sm" /> : null}
        {loading
          ? "Loading preview…"
          : preview && open
            ? "Hide preview"
            : preview
              ? "Show preview"
              : "Load preview"}
      </button>
      {open && preview && (
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-line bg-panel p-2">
          {preview.error ? (
            <div className="text-caption text-danger">{preview.error}</div>
          ) : (
            <>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-micro text-faint">
                <span>{preview.file?.name || "Drive document"}</span>
                <span>
                  {preview.textCharCount?.toLocaleString()} chars
                  {preview.truncated ? " · truncated" : ""}
                </span>
              </div>
              <pre className="whitespace-pre-wrap break-words font-sans text-caption text-fg">
                {preview.text}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GmailCard({ payload }: { payload: GmailPayload }) {
  if (payload.mode === "search") return <GmailSearchCard payload={payload} />;
  if (payload.mode === "thread") return <GmailThreadCard payload={payload} />;
  if (payload.mode === "message")
    return <GmailMessageCard message={payload.message} />;
  return null;
}

function GmailSearchCard({ payload }: { payload: GmailSearchPayload }) {
  const threads = payload.threads ?? [];
  return (
    <ChatWideCard maxWidth={1180}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/40 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Mail size={18} className="shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="text-body font-semibold text-fg">Gmail search</div>
            <div className="truncate font-mono text-caption text-faint">
              {payload.query || "in:inbox"}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right text-caption text-muted-foreground">
          <div>
            {threads.length} thread{threads.length === 1 ? "" : "s"}
          </div>
          {payload.resultSizeEstimate !== undefined &&
            payload.resultSizeEstimate !== null && (
              <div>estimate {payload.resultSizeEstimate}</div>
            )}
        </div>
      </header>

      <table className="w-full table-fixed border-separate border-spacing-0 text-left text-caption">
        <colgroup>
          <col className="w-9" />
          <col className="w-[6.4rem]" />
          <col className="w-[10.5rem]" />
          <col />
          <col className="w-14" />
        </colgroup>
        <thead className="bg-surface/70 text-micro uppercase tracking-wide text-faint">
          <tr>
            <th className="px-2 py-2 font-medium" aria-label="Expand" />
            <th className="px-2 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 font-medium">Thread</th>
            <th className="px-2 py-2 text-center font-medium" title="Messages">
              #
            </th>
          </tr>
        </thead>
        <tbody>
          {threads.map((thread) => (
            <GmailThreadRow key={thread.id} thread={thread} />
          ))}
          {threads.length === 0 && (
            <tr>
              <td
                colSpan={5}
                className="px-4 py-8 text-center text-muted-foreground"
              >
                No Gmail threads found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="border-t border-line px-4 py-2 text-micro text-faint">
        Search results contain metadata and snippets only. Expanding a thread
        loads the email body in your browser without adding it to assistant
        context.
      </div>
    </ChatWideCard>
  );
}

function GmailThreadRow({ thread }: { thread: GmailThreadSummary }) {
  const [preview, setPreview] = useState<GmailThreadPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  async function toggleThread() {
    if (preview) {
      setOpen((value) => !value);
      return;
    }
    setLoading(true);
    setOpen(true);
    try {
      const res = await fetch(
        `${serverHttpOrigin()}/api/google/gmail/thread/${encodeURIComponent(thread.id)}/preview?maxChars=40000`,
        { headers: { ...authHeaders() } },
      );
      const data = (await res.json().catch(() => ({}))) as GmailThreadPayload;
      if (!res.ok)
        setPreview({
          mode: "thread",
          error: data.error || `HTTP ${res.status}`,
        });
      else setPreview(data);
    } catch (err) {
      setPreview({
        mode: "thread",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }

  const latest = splitGmailLocalDate(thread.localLatestDate);
  const sender = senderDisplay(thread);
  return (
    <Fragment>
      <tr className="border-t border-line odd:bg-surface/30">
        <td className="border-t border-line px-2 py-3 text-center align-top">
          <button
            type="button"
            onClick={() => void toggleThread()}
            title={open ? "Collapse thread" : "Read thread"}
            aria-label={open ? "Collapse thread" : "Read thread"}
            className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-primary"
          >
            {loading ? (
              <Spinner size="sm" />
            ) : (
              <ChevronDown
                size={15}
                className={`transition-transform ${open ? "rotate-180" : ""}`}
              />
            )}
          </button>
        </td>
        <td className="border-t border-line px-2 py-3 align-top">
          <div className="flex min-w-0 items-start gap-1.5">
            <GmailStatusIcon unread={thread.unread} />
            <div className="min-w-0 font-mono text-caption text-muted-foreground">
              <div className="truncate">{latest.date}</div>
              <div className="truncate text-faint">{latest.time}</div>
            </div>
          </div>
        </td>
        <td className="border-t border-line px-3 py-3 align-top text-muted-foreground">
          <div className="truncate" title={sender}>
            {sender}
          </div>
        </td>
        <td className="min-w-0 border-t border-line px-3 py-3 align-top">
          <div className="flex min-w-0 items-center gap-2">
            <ExternalTitle
              title={thread.subject || "(no subject)"}
              href={thread.gmailUrl}
            />
            <GmailCategoryIcons thread={thread} />
          </div>
          {thread.snippet && (
            <div className="mt-1 line-clamp-2 overflow-hidden text-ellipsis text-caption text-muted-foreground">
              {thread.snippet}
            </div>
          )}
        </td>
        <td className="border-t border-line px-2 py-3 text-center align-top text-muted-foreground">
          {thread.messageCount ?? 0}
        </td>
      </tr>
      {open && (
        <tr className="bg-surface/60">
          <td colSpan={5} className="border-t border-line px-4 py-3">
            {/* R4: the message rows this expands into, at their height, so the
                table does not jump when the body lands. */}
            {loading && (
              <div
                role="status"
                aria-label="Loading Gmail thread"
                className="space-y-2 rounded-xl border border-line bg-panel p-4"
              >
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            )}
            {!loading && preview && <GmailThreadInline payload={preview} />}
            {!loading && !preview && (
              <GmailSnippetList messages={thread.messages ?? []} />
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function GmailThreadInline({ payload }: { payload: GmailThreadPayload }) {
  if (payload.error)
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-caption text-danger">
        {payload.error}
      </div>
    );
  return <GmailThreadCard payload={payload} embedded />;
}

function GmailThreadCard({
  payload,
  embedded = false,
}: {
  payload: GmailThreadPayload;
  embedded?: boolean;
}) {
  const messages = payload.messages ?? [];
  const body = (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-raised/40 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          {payload.unread ? (
            <Mail size={18} className="mt-0.5 shrink-0 text-primary" />
          ) : (
            <MailOpen
              size={18}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
          )}
          <div className="min-w-0">
            <div className="text-body font-semibold text-fg">
              <ExternalTitle
                title={payload.subject || "(no subject)"}
                href={payload.gmailUrl}
              />
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground">
              <span>{payload.unread ? "Unread" : "Read"}</span>
              <span>
                {messages.length || payload.messageCount || 0} message
                {(messages.length || payload.messageCount || 0) === 1
                  ? ""
                  : "s"}
              </span>
              {payload.localLatestDate && (
                <span>Latest {payload.localLatestDate}</span>
              )}
              {payload.totalTextCharCount !== undefined && (
                <span>
                  {payload.totalTextCharCount.toLocaleString()} chars
                  {payload.truncated ? " · truncated" : ""}
                </span>
              )}
            </div>
            {payload.labels?.length ? (
              <GmailLabelList
                labels={payload.labels}
                labelIds={payload.labelIds}
              />
            ) : null}
          </div>
        </div>
        {payload.participants?.length ? (
          <div className="max-w-72 text-right text-caption text-muted-foreground">
            {payload.participants
              .map((p) => p.name || p.email || p.label)
              .filter(Boolean)
              .slice(0, 4)
              .join(", ")}
          </div>
        ) : null}
      </header>
      <div className="max-h-[620px] space-y-3 overflow-auto p-4">
        {messages.map((message, index) => (
          <GmailMessageArticle key={message.id ?? index} message={message} />
        ))}
        {messages.length === 0 && (
          <div className="py-8 text-center text-muted-foreground">
            No readable messages returned.
          </div>
        )}
      </div>
    </>
  );
  if (embedded)
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {body}
      </div>
    );
  return <ChatWideCard maxWidth={980}>{body}</ChatWideCard>;
}

function GmailMessageCard({
  message,
}: {
  message?: GmailFullMessage | undefined;
}) {
  if (!message) return null;
  return (
    <ChatWideCard maxWidth={900} className="p-4">
      <GmailMessageArticle message={message} />
    </ChatWideCard>
  );
}

function GmailMessageArticle({ message }: { message: GmailFullMessage }) {
  return (
    <article
      className={`rounded-xl border ${message.unread ? "border-primary/40 bg-accent/20" : "border-line bg-surface"} p-3`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-fg">
            {messageSenderDisplay(message)}
          </div>
          <div className="mt-0.5 text-caption text-muted-foreground">
            {message.localDate || ""}
            {message.to ? ` · to ${message.to}` : ""}
          </div>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-micro ${message.unread ? "bg-accent font-semibold text-primary" : "bg-raised text-muted-foreground"}`}
        >
          {message.unread ? "Unread" : "Read"}
        </span>
      </div>
      {message.text ? (
        <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-caption text-fg">
          {message.text}
        </pre>
      ) : (
        <div className="mt-3 text-caption text-faint">
          No readable body text.
        </div>
      )}
      {message.truncated && (
        <div className="mt-2 text-caption text-faint">Message truncated.</div>
      )}
      {message.attachments?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {message.attachments.map((attachment, index) => (
            <span
              key={`${attachment.attachmentId ?? attachment.filename ?? index}`}
              className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-1 text-caption text-muted-foreground"
            >
              <Paperclip size={11} /> {attachment.filename || "attachment"}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function GmailSnippetList({ messages }: { messages: GmailMessageSummary[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="mb-2 text-micro font-semibold uppercase tracking-wide text-faint">
        Thread snippets
      </div>
      <div className="space-y-1.5">
        {messages.map((message, index) => (
          <div
            key={`${message.id ?? index}`}
            className="rounded-lg bg-raised/60 px-2 py-1.5 text-caption"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-fg">
                {messageSenderDisplay(message)}
              </span>
              <span className="font-mono text-faint">
                {message.localDate || ""}
              </span>
            </div>
            {message.snippet && (
              <div className="mt-0.5 text-muted-foreground">
                {message.snippet}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function GmailLabelList({
  labels,
  labelIds,
}: {
  labels: string[];
  labelIds?: string[] | undefined;
}) {
  const descriptors = gmailLabelDescriptors(labels, labelIds, {
    includeMailbox: true,
    includeCustom: true,
  });
  if (descriptors.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {descriptors.slice(0, 10).map((descriptor) => (
        <GmailLabelIcon key={descriptor.key} descriptor={descriptor} />
      ))}
    </div>
  );
}

function GmailCategoryIcons({ thread }: { thread: GmailThreadSummary }) {
  const descriptors = gmailLabelDescriptors(
    thread.labels ?? [],
    thread.labelIds,
    { includeMailbox: false, includeCustom: false },
  );
  if (thread.starred && !descriptors.some((d) => d.key === "STARRED"))
    descriptors.push({ key: "STARRED", title: "Starred", kind: "starred" });
  if (thread.important && !descriptors.some((d) => d.key === "IMPORTANT"))
    descriptors.push({
      key: "IMPORTANT",
      title: "Important",
      kind: "important",
    });
  if (descriptors.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {descriptors.slice(0, 5).map((descriptor) => (
        <GmailLabelIcon key={descriptor.key} descriptor={descriptor} compact />
      ))}
    </span>
  );
}

type GmailLabelDescriptor = { key: string; title: string; kind: string };

function GmailLabelIcon({
  descriptor,
  compact = false,
}: {
  descriptor: GmailLabelDescriptor;
  compact?: boolean;
}) {
  const className = compact
    ? "inline-flex size-4 items-center justify-center rounded-sm text-faint"
    : "inline-flex size-5 items-center justify-center rounded-md bg-raised text-faint";
  const iconClass = gmailLabelIconClass(descriptor.kind);
  return (
    <span title={descriptor.title} className={`${className} ${iconClass}`}>
      {gmailLabelIcon(descriptor.kind, compact ? 13 : 12)}
    </span>
  );
}

function GmailStatusIcon({ unread }: { unread?: boolean | undefined }) {
  return (
    <span
      title={unread ? "Unread" : "Read"}
      className={`mt-0.5 shrink-0 ${unread ? "text-primary" : "text-faint"}`}
    >
      {unread ? <Mail size={13} /> : <MailOpen size={13} />}
    </span>
  );
}

function gmailLabelDescriptors(
  labels: string[],
  labelIds: string[] | undefined,
  options: { includeMailbox: boolean; includeCustom: boolean },
): GmailLabelDescriptor[] {
  const rawValues = unique([...labels, ...(labelIds ?? [])].filter(Boolean));
  const descriptors: GmailLabelDescriptor[] = [];
  const add = (key: string, title: string, kind: string) => {
    if (!descriptors.some((d) => d.key === key))
      descriptors.push({ key, title, kind });
  };

  for (const value of rawValues) {
    const key = normalizeGmailLabel(value);
    if (key === "CATEGORY_PERSONAL") add(key, "Personal", "personal");
    else if (key === "CATEGORY_SOCIAL") add(key, "Social", "social");
    else if (key === "CATEGORY_PROMOTIONS")
      add(key, "Promotions", "promotions");
    else if (key === "CATEGORY_UPDATES") add(key, "Updates", "updates");
    else if (key === "CATEGORY_FORUMS") add(key, "Forums", "forums");
    else if (key === "STARRED") add(key, "Starred", "starred");
    else if (key === "IMPORTANT") add(key, "Important", "important");
    else if (options.includeMailbox && key === "INBOX")
      add(key, "Inbox", "inbox");
    else if (options.includeMailbox && key === "SENT") add(key, "Sent", "sent");
    else if (options.includeMailbox && key === "DRAFT")
      add(key, "Draft", "draft");
    else if (options.includeMailbox && key === "SPAM") add(key, "Spam", "spam");
    else if (options.includeMailbox && key === "TRASH")
      add(key, "Trash", "trash");
    else if (options.includeMailbox && key === "UNREAD") continue;
    else if (options.includeCustom && !isHiddenGmailLabel(key))
      add(key, value, "custom");
  }

  return descriptors;
}

function gmailLabelIcon(kind: string, size: number) {
  if (kind === "personal") return <UserRound size={size} />;
  if (kind === "social") return <Users size={size} />;
  if (kind === "promotions") return <Megaphone size={size} />;
  if (kind === "updates") return <Bell size={size} />;
  if (kind === "forums") return <MessageCircle size={size} />;
  if (kind === "starred") return <Star size={size} />;
  if (kind === "important") return <AlertCircle size={size} />;
  if (kind === "inbox") return <Inbox size={size} />;
  if (kind === "sent") return <Send size={size} />;
  if (kind === "draft") return <FileText size={size} />;
  if (kind === "trash") return <Trash2 size={size} />;
  if (kind === "spam") return <AlertCircle size={size} />;
  return <Tag size={size} />;
}

function gmailLabelIconClass(kind: string): string {
  if (kind === "starred") return "text-yellow-300";
  if (kind === "important" || kind === "spam") return "text-yellow-400";
  if (kind === "personal") return "text-sky-300";
  if (kind === "social") return "text-emerald-300";
  if (kind === "promotions") return "text-pink-300";
  if (kind === "updates") return "text-blue-300";
  if (kind === "forums") return "text-violet-300";
  return "text-faint";
}

function normalizeGmailLabel(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function isHiddenGmailLabel(key: string): boolean {
  return [
    "CHAT",
    "SENT",
    "INBOX",
    "DRAFT",
    "SPAM",
    "TRASH",
    "UNREAD",
    "IMPORTANT",
    "STARRED",
    "CATEGORY_PRIMARY",
  ].includes(key);
}

function senderDisplay(thread: GmailThreadSummary): string {
  const messages = thread.messages ?? [];
  const latest = messages[messages.length - 1];
  if (latest?.fromName?.trim()) return latest.fromName.trim();
  if (latest?.fromEmail?.trim()) return latest.fromEmail.trim();
  const parsed = parseDisplayAddress(thread.latestFrom ?? "");
  if (parsed) return parsed;
  const participant = thread.participants?.[0];
  return participant?.name || participant?.email || participant?.label || "—";
}

function messageSenderDisplay(message: GmailMessageSummary): string {
  if (message.fromName?.trim()) return message.fromName.trim();
  if (message.fromEmail?.trim()) return message.fromEmail.trim();
  return (
    parseDisplayAddress(message.from ?? "") || message.from || "Unknown sender"
  );
}

function parseDisplayAddress(value: string): string | null {
  const clean = value.trim();
  if (!clean) return null;
  const match = clean.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>/);
  const name = match?.[1]?.trim().replace(/^"|"$/g, "");
  const email =
    match?.[2]?.trim() ||
    clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  return name || email || clean;
}

function splitGmailLocalDate(value?: string | null): {
  date: string;
  time: string;
} {
  if (!value) return { date: "—", time: "" };
  const match = value.match(/^(.+?),\s*(\d{1,2}:\d{2})/);
  if (match) return { date: match[1] ?? value, time: match[2] ?? "" };
  return { date: value, time: "" };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function DriveDocumentCard({ payload }: { payload: DriveDocumentPayload }) {
  const file = payload.file;
  const text = payload.text ?? "";
  return (
    <ChatWideCard maxWidth={980}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-raised/40 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <FileText size={18} className="mt-0.5 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="text-body font-semibold text-fg">
              <ExternalTitle
                title={file?.name || "Drive document"}
                href={file?.webViewLink}
              />
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground">
              {file?.localModified && (
                <span>Modified {file.localModified}</span>
              )}
              {payload.exportMimeType && <span>{payload.exportMimeType}</span>}
              {payload.textCharCount !== undefined && (
                <span>
                  {payload.textCharCount.toLocaleString()} chars
                  {payload.truncated ? " · truncated" : ""}
                </span>
              )}
            </div>
          </div>
        </div>
        {file?.owners?.[0] && (
          <div className="text-right text-caption text-muted-foreground">
            {file.owners[0].displayName || file.owners[0].emailAddress}
          </div>
        )}
      </header>
      <div className="max-h-[520px] overflow-auto p-4">
        {text ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-body text-fg">
            {text}
          </pre>
        ) : (
          <div className="py-8 text-center text-muted-foreground">
            No readable document text was returned.
          </div>
        )}
      </div>
    </ChatWideCard>
  );
}

function ExternalTitle({
  title,
  href,
}: {
  title: string;
  href?: string | null | undefined;
}) {
  if (!href) return <span className="text-fg">{title}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex min-w-0 items-center gap-1 font-medium text-primary hover:underline"
    >
      <span className="truncate">{title}</span>
      <ExternalLink size={12} className="shrink-0" />
    </a>
  );
}

function StatusIcon({ status }: { status?: string | null | undefined }) {
  const value = status || "unknown";
  const icon =
    value === "accepted" ? (
      <CheckCircle2 size={16} className="text-emerald-300" />
    ) : value === "declined" ? (
      <XCircle size={16} className="text-danger" />
    ) : value === "tentative" ? (
      <Clock size={16} className="text-yellow-300" />
    ) : (
      <CircleHelp size={16} className="text-faint" />
    );
  return (
    <span title={value} className="inline-flex justify-center">
      {icon}
    </span>
  );
}

function MeetingLinkIcon({ event }: { event: CalendarEvent }) {
  const link =
    event.conferenceLinks?.[0] ??
    (event.meet?.meetingUri
      ? {
          provider: "google-meet" as const,
          label: "Google Meet",
          uri: event.meet.meetingUri,
        }
      : null);
  if (!link?.uri) return <span className="text-faint">—</span>;
  return (
    <a
      href={link.uri}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open ${link.label ?? providerLabel(link.provider)}${link.source ? ` (${link.source})` : ""}`}
      className="inline-flex size-6 items-center justify-center rounded-md text-primary transition-colors hover:bg-raised hover:text-primary"
    >
      <ProviderIcon provider={link.provider} />
    </a>
  );
}

function ProviderIcon({ provider }: { provider?: ConferenceLink["provider"] }) {
  if (provider === "zoom")
    return <span className="text-caption font-bold">Z</span>;
  if (provider === "teams")
    return <span className="text-caption font-bold">T</span>;
  if (provider === "google-meet") return <Video size={15} />;
  return <Video size={15} />;
}

function providerLabel(provider?: ConferenceLink["provider"]): string {
  if (provider === "zoom") return "Zoom";
  if (provider === "teams") return "Microsoft Teams";
  if (provider === "google-meet") return "Google Meet";
  return "meeting link";
}

function MinutesIcon({ links }: { links: MinutesLink[] }) {
  if (links.length === 0)
    return (
      <span title="No minutes/transcript link found" className="text-faint">
        —
      </span>
    );
  const first = links[0]!;
  const title =
    links.length === 1
      ? `${first.label} (${first.source})`
      : `${links.length} minutes/transcript links`;
  if (!first.href)
    return (
      <span title={title} className="inline-flex justify-center text-primary">
        <FileText size={16} />
      </span>
    );
  return (
    <a
      href={first.href}
      target="_blank"
      rel="noreferrer noopener"
      title={title}
      className="inline-flex size-6 items-center justify-center rounded-md text-primary transition-colors hover:bg-raised hover:text-primary"
    >
      <FileText size={15} />
    </a>
  );
}

function AttendanceIcon({ records }: { records: MeetRecord[] }) {
  const sessionCount = records
    .flatMap((record) => record.participants ?? [])
    .flatMap((participant) => participant.participantSessions ?? []).length;
  const artifactCount = records.flatMap(
    (record) => record.artifacts ?? [],
  ).length;
  const artifactText = artifactCount
    ? `, ${artifactCount} Meet artifact(s)`
    : "";
  if (sessionCount > 0) {
    return (
      <span
        title={`${records.length} Meet record(s), ${sessionCount} participant session(s)${artifactText}`}
        className="inline-flex justify-center text-emerald-300"
      >
        <Users size={16} />
      </span>
    );
  }
  if (records.length > 0) {
    return (
      <span
        title={`${records.length} Meet record(s), no participant sessions${artifactText}`}
        className="inline-flex justify-center text-yellow-300"
      >
        <Users size={16} />
      </span>
    );
  }
  return (
    <span
      title="No matching Meet attendance record"
      className="inline-flex justify-center text-faint"
    >
      <Users size={16} />
    </span>
  );
}

function minutesLinksForEvent(event: CalendarEvent): MinutesLink[] {
  const links: MinutesLink[] = [];
  const add = (link: MinutesLink) => {
    const key = link.driveFileId || link.href || link.label;
    if (
      links.some(
        (existing) =>
          (existing.driveFileId || existing.href || existing.label) === key,
      )
    )
      return;
    links.push(link);
  };

  for (const attachment of event.attachments ?? []) {
    const label = attachment.title || "Calendar attachment";
    if (!isMinutesLike(label, attachment.mimeType)) continue;
    add({
      label,
      ...(attachment.fileUrl !== undefined ? { href: attachment.fileUrl } : {}),
      ...(attachment.fileId !== undefined
        ? { driveFileId: attachment.fileId }
        : {}),
      source: "Calendar attachment",
    });
  }

  for (const record of event.meetRecords ?? []) {
    for (const artifact of record.artifacts ?? []) {
      if (artifact.kind === "recording") continue;
      const hrefValue = artifact.webViewLink || artifact.exportUri;
      add({
        label:
          artifact.kind === "transcript"
            ? "Meet transcript / notes"
            : "Meet artifact",
        ...(hrefValue !== undefined ? { href: hrefValue } : {}),
        ...(artifact.driveFileId !== undefined
          ? { driveFileId: artifact.driveFileId }
          : {}),
        source: "Meet artifact",
      });
    }
  }

  return links;
}

function isMinutesLike(title: string, mimeType?: string | null): boolean {
  const haystack = `${title}\n${mimeType ?? ""}`.toLowerCase();
  return /minute|notes?|transcript|gemini|meeting/.test(haystack);
}

function LocationLine({ location }: { location: string }) {
  return (
    <div className="mt-0.5 truncate text-caption text-muted-foreground">
      <LinkifiedText text={location} />
    </div>
  );
}

function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>()]+)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (/^https?:\/\//.test(part)) {
          return (
            <a
              key={index}
              href={part}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline"
            >
              {part}
            </a>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

function timeRange(start?: string | null, end?: string | null): string {
  const s = timeOnly(start);
  const e = timeOnly(end);
  if (s && e) return `${s}–${e}`;
  return s || e || "—";
}

function timeOnly(value?: string | null): string | null {
  if (!value) return null;
  const match = value.match(/(?:,\s*)?(\d{2}:\d{2})(?::\d{2})?$/);
  return match?.[1] ?? value;
}

function rangeLabel(from?: string | null, to?: string | null): string {
  if (from && to) return `${from} – ${to}`;
  return from || to || "";
}

function parseJson(value: string): unknown {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
