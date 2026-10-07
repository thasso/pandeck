import { Fragment, useState, type ReactNode } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  Clock,
  AlertCircle,
  Bell,
  FileText,
  Inbox,
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
import {
  ChatWideCard,
  EmptyRow,
  ExpandableRow,
  ExternalTitle,
  Panel,
} from "./ChatWideCard.tsx";
import { ErrorNote, Skeleton } from "./common/load.tsx";
import { LinkButton } from "./common/LinkButton.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
    <ChatWideCard
      icon={<CalendarDays className="size-4 text-primary" />}
      title="Calendar"
      description={payload.calendarSummary || "Primary calendar"}
      meta={
        <>
          <div>
            {payload.date || rangeLabel(payload.localFrom, payload.localTo)}
          </div>
          <div>
            {events.length} event{events.length === 1 ? "" : "s"}
          </div>
        </>
      }
    >
      <Table className="min-w-155">
        <TableHeader>
          <TableRow>
            <TableHead className="w-9" />
            <TableHead className="w-36">Time</TableHead>
            <TableHead>Event</TableHead>
            <TableHead
              className="w-10 text-center"
              title="Your response status"
            >
              ✓
            </TableHead>
            <TableHead className="w-10 text-center" title="Meeting link">
              <Video className="mx-auto size-3" />
            </TableHead>
            <TableHead
              className="w-10 text-center"
              title="Minutes/transcript link"
            >
              <FileText className="mx-auto size-3" />
            </TableHead>
            <TableHead
              className="w-10 text-center"
              title="Meet attendance info"
            >
              <Users className="mx-auto size-3" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event, index) => (
            <CalendarEventRow
              key={`${event.htmlLink ?? event.title ?? "event"}-${index}`}
              event={event}
            />
          ))}
          {events.length === 0 && (
            <EmptyRow span={7}>No calendar events found.</EmptyRow>
          )}
        </TableBody>
      </Table>
    </ChatWideCard>
  );
}

function CalendarEventRow({ event }: { event: CalendarEvent }) {
  const meetRecords = event.meetRecords ?? [];
  const minutesLinks = minutesLinksForEvent(event);
  const hasDetails = Boolean(
    event.description?.trim() ||
    meetRecords.length > 0 ||
    minutesLinks.length > 0,
  );
  return (
    <ExpandableRow
      expandLabel="Show description and attendance details"
      collapseLabel="Hide details"
      span={7}
      cells={
        <>
          <TableCell className="align-top font-mono">
            {timeRange(event.localStart, event.localEnd)}
            {event.duration && (
              <span className="text-muted-foreground"> · {event.duration}</span>
            )}
          </TableCell>
          <TableCell className="min-w-0 align-top whitespace-normal">
            <ExternalTitle
              title={event.title || "(untitled)"}
              href={event.htmlLink}
            />
            {event.location && <LocationLine location={event.location} />}
          </TableCell>
          <TableCell className="text-center align-top">
            <StatusIcon status={event.selfAttendee?.responseStatus} />
          </TableCell>
          <TableCell className="text-center align-top">
            <MeetingLinkIcon event={event} />
          </TableCell>
          <TableCell className="text-center align-top">
            <MinutesIcon links={minutesLinks} />
          </TableCell>
          <TableCell className="text-center align-top">
            <AttendanceIcon records={meetRecords} />
          </TableCell>
        </>
      }
      details={
        hasDetails ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Description">
              {event.description?.trim() ? (
                <div className="max-h-72 overflow-auto whitespace-pre-wrap">
                  <LinkifiedText text={event.description} />
                </div>
              ) : event.location ? (
                <LinkifiedText text={event.location} />
              ) : (
                <p className="text-muted-foreground">No description.</p>
              )}
            </Panel>
            <AttendancePanel
              records={meetRecords}
              minutesLinks={minutesLinks}
            />
          </div>
        ) : undefined
      }
    />
  );
}

/** One participant and the sessions they joined. */
function ParticipantItem({ participant }: { participant: MeetParticipant }) {
  return (
    <Item variant="muted" size="xs">
      <ItemContent>
        <ItemTitle>
          {participant.displayName ||
            participant.signedInUser?.displayName ||
            participant.signedInUser?.user ||
            "Participant"}
        </ItemTitle>
        <ItemDescription>
          {participant.participantSessions?.length
            ? participant.participantSessions
                .map(
                  (s) =>
                    `${timeRange(s.localStart, s.localEnd)}${s.duration ? ` (${s.duration})` : ""}`,
                )
                .join(", ")
            : "No session details"}
        </ItemDescription>
      </ItemContent>
    </Item>
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
    <Panel
      title="Meet attendance"
      meta={
        records.length > 0 ? (
          <span>
            {records.length} record{records.length === 1 ? "" : "s"} ·{" "}
            {sessionCount} session{sessionCount === 1 ? "" : "s"} ·{" "}
            {artifactCount} artifact{artifactCount === 1 ? "" : "s"}
          </span>
        ) : null
      }
    >
      <MinutesLinksList links={minutesLinks} />
      {records.length === 0 ? (
        <p className="text-muted-foreground">
          No matching Meet attendance record.
        </p>
      ) : (
        <div className="flex max-h-72 flex-col gap-2 overflow-auto">
          {records.map((record, index) => (
            <div
              key={`${record.name ?? "record"}-${index}`}
              className="flex flex-col gap-1"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-muted-foreground">
                  {timeRange(record.localStart, record.localEnd)}
                </span>
                {record.meetingUri && (
                  <a
                    href={record.meetingUri}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <Video className="size-3" /> Meet
                  </a>
                )}
              </div>
              {(record.participants ?? []).map((participant, pIndex) => (
                <ParticipantItem
                  key={`${participant.displayName ?? participant.signedInUser?.user ?? "participant"}-${pIndex}`}
                  participant={participant}
                />
              ))}
              <ArtifactList
                artifacts={record.artifacts ?? []}
                errors={record.artifactErrors ?? []}
              />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function MeetCard({ payload }: { payload: MeetPayload }) {
  const records = payload.records ?? [];
  return (
    <ChatWideCard
      icon={<Video className="size-4 text-primary" />}
      title="Google Meet records"
      description="Conference records and participant sessions"
      meta={
        <>
          <div>{payload.date || rangeLabel(payload.from, payload.to)}</div>
          <div>
            {records.length} record{records.length === 1 ? "" : "s"}
          </div>
        </>
      }
    >
      <CardContent className="grid gap-3 md:grid-cols-2">
        {records.map((record, index) => (
          <Card key={`${record.name ?? "meet"}-${index}`} size="sm">
            <CardHeader>
              <CardDescription className="font-mono">
                {timeRange(record.localStart, record.localEnd)}
              </CardDescription>
              <CardTitle>
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
              </CardTitle>
              {record.meetingUri && (
                <CardAction>
                  <LinkButton
                    variant="outline"
                    size="sm"
                    href={record.meetingUri}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Meet
                  </LinkButton>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  <Users />
                  {record.participantCount ??
                    record.participants?.length ??
                    0}{" "}
                  participants
                </Badge>
                {record.meetingCode && (
                  <Badge variant="secondary" className="font-mono">
                    {record.meetingCode}
                  </Badge>
                )}
                {record.calendarMatches?.[0]?.overlap && (
                  <Badge variant="secondary">
                    <Clock /> {record.calendarMatches[0].overlap} overlap
                  </Badge>
                )}
                {(record.artifactSummary?.total ?? 0) > 0 && (
                  <Badge variant="secondary">
                    <FileText /> {artifactSummaryLabel(record)}
                  </Badge>
                )}
              </div>
              <ItemGroup className="gap-1.5">
                {(record.participants ?? [])
                  .slice(0, 6)
                  .map((participant, pIndex) => (
                    <ParticipantItem
                      key={`${participant.displayName ?? "participant"}-${pIndex}`}
                      participant={participant}
                    />
                  ))}
              </ItemGroup>
              {(record.participants?.length ?? 0) > 6 && (
                <p className="text-muted-foreground">
                  +{(record.participants?.length ?? 0) - 6} more participants
                </p>
              )}
              <ArtifactList
                artifacts={record.artifacts ?? []}
                errors={record.artifactErrors ?? []}
              />
            </CardContent>
          </Card>
        ))}
        {records.length === 0 && (
          <p className="p-6 text-center text-muted-foreground">
            No Meet records found.
          </p>
        )}
      </CardContent>
    </ChatWideCard>
  );
}

function MinutesLinksList({ links }: { links: MinutesLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        Minutes / transcripts
      </p>
      {links.map((link, index) => (
        <Item
          key={`${link.driveFileId ?? link.href ?? link.label}-${index}`}
          variant="muted"
          size="xs"
        >
          <ItemMedia variant="icon">
            <FileText className="text-primary" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full">
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
            </ItemTitle>
            {link.driveFileId && (
              <DrivePreviewButton fileId={link.driveFileId} />
            )}
          </ItemContent>
          <ItemActions>
            <Badge variant="outline">{link.source}</Badge>
          </ItemActions>
        </Item>
      ))}
      <p className="text-xs text-muted-foreground">
        Preview loads here only in the browser; it is not sent to the assistant
        context.
      </p>
    </div>
  );
}

function ArtifactList({
  artifacts,
  errors,
}: {
  artifacts: MeetArtifact[];
  errors: string[];
}) {
  if (artifacts.length === 0 && errors.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {artifacts.length > 0 && (
        <p className="text-xs font-medium text-muted-foreground">Artifacts</p>
      )}
      {artifacts.map((artifact, index) => {
        const label =
          artifact.kind === "recording" ? "Recording" : "Transcript / notes";
        const href = artifact.webViewLink || artifact.exportUri || undefined;
        return (
          <Item
            key={`${artifact.kind ?? "artifact"}-${artifact.driveFileId ?? index}`}
            variant="outline"
            size="xs"
          >
            <ItemMedia variant="icon">
              <FileText className="text-primary" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle>
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
              </ItemTitle>
              <ItemDescription>
                {timeRange(artifact.localStart, artifact.localEnd)}
                {artifact.entryCount !== undefined &&
                artifact.entryCount !== null
                  ? ` · ${artifact.entryCount} entries`
                  : ""}
                {artifact.driveFileId ? " · Drive doc available" : ""}
              </ItemDescription>
              {artifact.driveFileId && (
                <DrivePreviewButton fileId={artifact.driveFileId} />
              )}
              {artifact.textPreview && (
                <p className="max-h-16 overflow-hidden whitespace-pre-wrap">
                  {artifact.textPreview}
                </p>
              )}
            </ItemContent>
            {artifact.state && (
              <ItemActions>
                <Badge variant="outline">{artifact.state}</Badge>
              </ItemActions>
            )}
          </Item>
        );
      })}
      {errors.map((error, index) => (
        <p key={index} className="text-muted-foreground">
          Artifact lookup: {error}
        </p>
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
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        size="xs"
        onClick={() => void loadPreview()}
        busy={loading}
      >
        {loading
          ? "Loading preview…"
          : preview && open
            ? "Hide preview"
            : preview
              ? "Show preview"
              : "Load preview"}
      </Button>
      {open && preview && (
        <div className="max-h-72 w-full overflow-auto rounded-lg border p-2">
          {preview.error ? (
            <p className="text-destructive">{preview.error}</p>
          ) : (
            <>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{preview.file?.name || "Drive document"}</span>
                <span>
                  {preview.textCharCount?.toLocaleString()} chars
                  {preview.truncated ? " · truncated" : ""}
                </span>
              </div>
              <pre className="font-sans whitespace-pre-wrap break-words">
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
    <ChatWideCard
      maxWidth={1180}
      icon={<Mail className="size-4 shrink-0 text-primary" />}
      title="Gmail search"
      description={
        <span className="font-mono">{payload.query || "in:inbox"}</span>
      }
      meta={
        <>
          <div>
            {threads.length} thread{threads.length === 1 ? "" : "s"}
          </div>
          {payload.resultSizeEstimate !== undefined &&
            payload.resultSizeEstimate !== null && (
              <div>estimate {payload.resultSizeEstimate}</div>
            )}
        </>
      }
    >
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-9" aria-label="Expand" />
            <TableHead className="w-26">Date</TableHead>
            <TableHead className="w-42">From</TableHead>
            <TableHead>Thread</TableHead>
            <TableHead className="w-14 text-center" title="Messages">
              #
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {threads.map((thread) => (
            <GmailThreadRow key={thread.id} thread={thread} />
          ))}
          {threads.length === 0 && (
            <EmptyRow span={5}>No Gmail threads found.</EmptyRow>
          )}
        </TableBody>
      </Table>
      <CardFooter className="text-xs text-muted-foreground">
        Search results contain metadata and snippets only. Expanding a thread
        loads the email body in your browser without adding it to assistant
        context.
      </CardFooter>
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
    <ExpandableRow
      expandLabel="Read thread"
      collapseLabel="Collapse thread"
      span={5}
      open={open}
      onOpenChange={() => void toggleThread()}
      busy={loading}
      cells={
        <>
          <TableCell className="align-top">
            <div className="flex min-w-0 items-start gap-1.5">
              <GmailStatusIcon unread={thread.unread} />
              <div className="min-w-0 font-mono text-muted-foreground">
                <div className="truncate">{latest.date}</div>
                <div className="truncate">{latest.time}</div>
              </div>
            </div>
          </TableCell>
          <TableCell className="align-top text-muted-foreground">
            <div className="truncate" title={sender}>
              {sender}
            </div>
          </TableCell>
          <TableCell className="min-w-0 align-top whitespace-normal">
            <div className="flex min-w-0 items-center gap-2">
              <ExternalTitle
                title={thread.subject || "(no subject)"}
                href={thread.gmailUrl}
              />
              <GmailCategoryIcons thread={thread} />
            </div>
            {thread.snippet && (
              <p className="mt-1 line-clamp-2 text-muted-foreground">
                {thread.snippet}
              </p>
            )}
          </TableCell>
          <TableCell className="text-center align-top text-muted-foreground">
            {thread.messageCount ?? 0}
          </TableCell>
        </>
      }
      details={
        loading ? (
          // R4: the message rows this expands into, at their height, so the
          // table does not jump when the body lands.
          <div
            role="status"
            aria-label="Loading Gmail thread"
            className="flex flex-col gap-2 rounded-xl border p-4"
          >
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : preview?.error ? (
          <ErrorNote message={preview.error} />
        ) : preview ? (
          <GmailThreadCard payload={preview} embedded />
        ) : (
          <GmailSnippetList messages={thread.messages ?? []} />
        )
      }
    />
  );
}

function GmailThreadCard({
  payload,
  embedded = false,
}: {
  payload: GmailThreadPayload;
  embedded?: boolean;
}) {
  const messages = payload.messages ?? [];
  const count = messages.length || payload.messageCount || 0;
  const header = {
    icon: payload.unread ? (
      <Mail className="size-4 shrink-0 text-primary" />
    ) : (
      <MailOpen className="size-4 shrink-0 text-muted-foreground" />
    ),
    title: (
      <ExternalTitle
        title={payload.subject || "(no subject)"}
        href={payload.gmailUrl}
      />
    ),
    description: (
      <>
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          <span>{payload.unread ? "Unread" : "Read"}</span>
          <span>
            {count} message{count === 1 ? "" : "s"}
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
        </span>
        {payload.labels?.length ? (
          <GmailLabelList labels={payload.labels} labelIds={payload.labelIds} />
        ) : null}
      </>
    ),
    meta: payload.participants?.length ? (
      <span className="block max-w-72">
        {payload.participants
          .map((p) => p.name || p.email || p.label)
          .filter(Boolean)
          .slice(0, 4)
          .join(", ")}
      </span>
    ) : null,
  };
  const body = (
    <CardContent className="flex max-h-155 flex-col gap-3 overflow-auto">
      {messages.map((message, index) => (
        <GmailMessageArticle key={message.id ?? index} message={message} />
      ))}
      {messages.length === 0 && (
        <p className="py-8 text-center text-muted-foreground">
          No readable messages returned.
        </p>
      )}
    </CardContent>
  );
  if (embedded)
    return (
      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle className="flex min-w-0 items-center gap-2">
            {header.icon}
            {header.title}
          </CardTitle>
          <CardDescription>{header.description}</CardDescription>
          {header.meta ? (
            <CardAction className="text-right text-muted-foreground">
              {header.meta}
            </CardAction>
          ) : null}
        </CardHeader>
        {body}
      </Card>
    );
  return (
    <ChatWideCard maxWidth={980} {...header}>
      {body}
    </ChatWideCard>
  );
}

function GmailMessageCard({
  message,
}: {
  message?: GmailFullMessage | undefined;
}) {
  if (!message) return null;
  return (
    <ChatWideCard
      maxWidth={900}
      icon={<Mail className="size-4 shrink-0 text-primary" />}
      title="Email"
    >
      <CardContent>
        <GmailMessageArticle message={message} />
      </CardContent>
    </ChatWideCard>
  );
}

function GmailMessageArticle({ message }: { message: GmailFullMessage }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{messageSenderDisplay(message)}</CardTitle>
        <CardDescription>
          {message.localDate || ""}
          {message.to ? ` · to ${message.to}` : ""}
        </CardDescription>
        <CardAction>
          <Badge variant={message.unread ? "default" : "secondary"}>
            {message.unread ? "Unread" : "Read"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {message.text ? (
          <pre className="font-sans whitespace-pre-wrap break-words">
            {message.text}
          </pre>
        ) : (
          <p className="text-muted-foreground">No readable body text.</p>
        )}
        {message.truncated && (
          <p className="text-muted-foreground">Message truncated.</p>
        )}
        {message.attachments?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {message.attachments.map((attachment, index) => (
              <Badge
                key={`${attachment.attachmentId ?? attachment.filename ?? index}`}
                variant="secondary"
              >
                <Paperclip /> {attachment.filename || "attachment"}
              </Badge>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function GmailSnippetList({ messages }: { messages: GmailMessageSummary[] }) {
  if (messages.length === 0) return null;
  return (
    <Panel title="Thread snippets">
      <ItemGroup className="gap-1.5">
        {messages.map((message, index) => (
          <Item key={`${message.id ?? index}`} variant="muted" size="xs">
            <ItemContent>
              <ItemTitle>{messageSenderDisplay(message)}</ItemTitle>
              {message.snippet && (
                <ItemDescription>{message.snippet}</ItemDescription>
              )}
            </ItemContent>
            <ItemActions className="font-mono text-muted-foreground">
              {message.localDate || ""}
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </Panel>
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
  return (
    <span
      title={descriptor.title}
      className={`inline-flex items-center justify-center ${compact ? "size-4" : "size-5 rounded-md bg-muted"} ${gmailLabelIconClass(descriptor.kind)}`}
    >
      {gmailLabelIcon(descriptor.kind, compact ? 13 : 12)}
    </span>
  );
}

function GmailStatusIcon({ unread }: { unread?: boolean | undefined }) {
  return (
    <span
      title={unread ? "Unread" : "Read"}
      className={`mt-0.5 shrink-0 ${unread ? "text-primary" : "text-muted-foreground"}`}
    >
      {unread ? (
        <Mail className="size-3.5" />
      ) : (
        <MailOpen className="size-3.5" />
      )}
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
  if (kind === "starred" || kind === "important" || kind === "spam")
    return "text-warning";
  if (["personal", "social", "promotions", "updates", "forums"].includes(kind))
    return "text-primary";
  return "text-muted-foreground";
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
    <ChatWideCard
      maxWidth={980}
      icon={<FileText className="size-4 shrink-0 text-primary" />}
      title={
        <ExternalTitle
          title={file?.name || "Drive document"}
          href={file?.webViewLink}
        />
      }
      description={
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {file?.localModified && <span>Modified {file.localModified}</span>}
          {payload.exportMimeType && <span>{payload.exportMimeType}</span>}
          {payload.textCharCount !== undefined && (
            <span>
              {payload.textCharCount.toLocaleString()} chars
              {payload.truncated ? " · truncated" : ""}
            </span>
          )}
        </span>
      }
      meta={
        file?.owners?.[0]
          ? file.owners[0].displayName || file.owners[0].emailAddress
          : null
      }
    >
      <CardContent className="max-h-130 overflow-auto">
        {text ? (
          <pre className="font-sans whitespace-pre-wrap break-words">
            {text}
          </pre>
        ) : (
          <p className="py-8 text-center text-muted-foreground">
            No readable document text was returned.
          </p>
        )}
      </CardContent>
    </ChatWideCard>
  );
}

function StatusIcon({ status }: { status?: string | null | undefined }) {
  const value = status || "unknown";
  const icon =
    value === "accepted" ? (
      <CheckCircle2 className="size-4 text-success" />
    ) : value === "declined" ? (
      <XCircle className="size-4 text-destructive" />
    ) : value === "tentative" ? (
      <Clock className="size-4 text-warning" />
    ) : (
      <CircleHelp className="size-4 text-muted-foreground" />
    );
  return (
    <span title={value} className="inline-flex justify-center">
      {icon}
    </span>
  );
}

/** An icon that opens an external link, named by its tooltip. */
function IconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <LinkButton
      variant="ghost"
      size="icon-xs"
      label={label}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </LinkButton>
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
  if (!link?.uri) return <span className="text-muted-foreground">—</span>;
  return (
    <IconLink
      href={link.uri}
      label={`Open ${link.label ?? providerLabel(link.provider)}${link.source ? ` (${link.source})` : ""}`}
    >
      <ProviderIcon provider={link.provider} />
    </IconLink>
  );
}

function ProviderIcon({ provider }: { provider?: ConferenceLink["provider"] }) {
  if (provider === "zoom") return <span className="font-bold">Z</span>;
  if (provider === "teams") return <span className="font-bold">T</span>;
  return <Video />;
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
      <span
        title="No minutes/transcript link found"
        className="text-muted-foreground"
      >
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
        <FileText className="size-4" />
      </span>
    );
  return (
    <IconLink href={first.href} label={title}>
      <FileText />
    </IconLink>
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
        className="inline-flex justify-center text-success"
      >
        <Users className="size-4" />
      </span>
    );
  }
  if (records.length > 0) {
    return (
      <span
        title={`${records.length} Meet record(s), no participant sessions${artifactText}`}
        className="inline-flex justify-center text-warning"
      >
        <Users className="size-4" />
      </span>
    );
  }
  return (
    <span
      title="No matching Meet attendance record"
      className="inline-flex justify-center text-muted-foreground"
    >
      <Users className="size-4" />
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
    <div className="mt-0.5 truncate text-muted-foreground">
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
