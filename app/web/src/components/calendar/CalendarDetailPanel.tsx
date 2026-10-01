import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  Clock,
  CornerDownRight,
  ExternalLink,
  FileText,
  ListChecks,
  MapPin,
  MessageSquarePlus,
  MessagesSquare,
  Sparkles,
  Timer,
  Users,
  Video,
} from "lucide-react";
import type {
  CalendarConferenceLink,
  CalendarDayRunHealth,
  CalendarDayScanProgress,
  CalendarDayState,
  CalendarDayTaskRef,
  CalendarEventDto,
  CalendarScanOutcome,
  CalendarScanSource,
  CalendarScanStep,
} from "@assistant/shared";
import type { CalendarController } from "../../hooks/useCalendar.ts";
import {
  minutesSummaryLabel,
  sourceHealthLabel,
  summarizeDayHealth,
} from "../../lib/dayHealth.ts";
import {
  dataOf,
  errorOf,
  hasData,
  isInitialLoad,
  type LoadState,
} from "../../lib/loadState.ts";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
  Spinner,
} from "../ui/load.tsx";
import { Markdown } from "../Markdown.tsx";
import {
  Inspector,
  InspectorSection,
  type InspectorAction,
} from "../shell/Inspector.tsx";
import { hm } from "./calendarDates.ts";
import { useUserTimeZone } from "../../hooks/useUserTimeZone.ts";
import { TempoPlanCard } from "./TempoPlanCard.tsx";

interface CalendarDetailPanelProps {
  calendar: CalendarController;
  /** True when a session is bound to the day. */
  hasDaySession: boolean;
  /** Open the day's bound chat session (only meaningful when hasDaySession). */
  onOpenDaySession: () => void;
  /** Start a fresh chat for the day. */
  onNewSession: () => void;
  /** Open the day session seeded to log the user's own time in Tempo. */
  onLogTime: (date: string) => void;
  /** Open the generated daily-summary KB entry (only when a report exists). */
  onOpenReport: (entryId: string) => void;
  /** Live scan-workflow progress for the selected day (Task 162), if a scan is running/recent. */
  scanProgress: CalendarDayScanProgress | null;
  onScan: (date: string) => void;
  onOpenTask: (id: string) => void;
}

const OUTCOME_LABEL: Record<CalendarScanOutcome, string> = {
  actions_found: "Actions found",
  no_actions: "No actions",
  unclear: "Unclear",
  error: "Error",
};

const STATUS_LABEL: Record<string, string> = {
  task: "To do",
  doing: "Doing",
  done: "Done",
};

function durationLabel(start: string | null, end: string | null): string {
  if (!start || !end) return "";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function CalendarDetailPanel({
  calendar,
  hasDaySession,
  onOpenDaySession,
  onNewSession,
  onLogTime,
  onOpenReport,
  scanProgress,
  onScan,
  onOpenTask,
}: CalendarDetailPanelProps) {
  const { selectedDate, selectedEvent, day, dayState } = calendar;
  const googleConfigured = dayState?.googleConfigured ?? true;
  // A day that fails to load says so (R2): the old code caught the failure into
  // a null read-model, which the panel then drew as a day with nothing on it.
  const dayError = errorOf(day);

  // The scan runs deterministically server-side (collection + synthesis); poll
  // the day read-model until the committed run advances, then stop. The polling
  // and the stop condition live in effects that read the FRESH `dayState` each
  // render — a captured interval closure would see a frozen `dayState` (the
  // controller object is recreated every render) and spin until the deadline.
  const { refreshDay } = calendar;
  const [scanning, setScanning] = useState(false);
  const scanRef = useRef<{ asOf: string | null; until: number } | null>(null);
  const handleScan = (date: string) => {
    onScan(date);
    scanRef.current = {
      asOf: dayState?.run?.asOf ?? null,
      until: Date.now() + 90_000,
    };
    setScanning(true);
    refreshDay();
  };

  useEffect(() => {
    if (!scanning) return;
    const timer = setInterval(() => {
      if (scanRef.current && Date.now() > scanRef.current.until) {
        setScanning(false);
        return;
      }
      refreshDay();
    }, 4000);
    return () => clearInterval(timer);
  }, [scanning, refreshDay]);

  // Fresh-state stop: once the newly committed run's asOf differs from the one
  // captured at scan start (or the deadline passed), the scan is done.
  useEffect(() => {
    if (!scanning) return;
    const start = scanRef.current;
    const asOf = dayState?.run?.asOf ?? null;
    if (!start || (asOf && asOf !== start.asOf) || Date.now() > start.until)
      setScanning(false);
  }, [scanning, dayState]);

  // When the live workflow reports the scan has settled, pull the freshly
  // committed report immediately instead of waiting for the next poll tick.
  const scanSettled = scanProgress ? !scanProgress.active : false;
  useEffect(() => {
    if (scanSettled) refreshDay();
  }, [scanSettled, refreshDay]);

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

  const scope = `calendar:${selectedDate}`;
  const health = summarizeDayHealth(dayState?.run ?? null);
  const tempoRows = dayState?.tempo ?? [];
  const sources = dayState?.sources ?? [];
  const showWorkflow =
    !!scanProgress &&
    (scanProgress.active ||
      scanProgress.steps.some((s) => s.status === "failed"));

  const actions: InspectorAction[] = [
    {
      key: "scan",
      icon: scanning ? <Spinner /> : <Sparkles size={15} />,
      label: scanning
        ? "Scanning…"
        : dayState?.run
          ? "Re-scan the day"
          : "Scan the day",
      onRun: () => {
        if (!scanning && googleConfigured) handleScan(selectedDate);
      },
    },
    ...(dayState?.summary
      ? [
          {
            key: "report",
            icon: <FileText size={15} />,
            label: "Open day report",
            onRun: () => onOpenReport(dayState.summary!.entryId),
          },
        ]
      : []),
    {
      key: "logtime",
      icon: <Timer size={15} />,
      label: "Log my time",
      onRun: () => onLogTime(selectedDate),
    },
    ...(hasDaySession
      ? [
          {
            key: "open",
            icon: <MessagesSquare size={15} />,
            label: "Open day session",
            onRun: onOpenDaySession,
          },
        ]
      : []),
    {
      key: "new",
      icon: <MessageSquarePlus size={15} />,
      label: "New session",
      onRun: onNewSession,
    },
  ];

  return (
    <Inspector relations={[]} actions={actions} sectionStorageScope={scope}>
      {!googleConfigured && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-2 text-caption text-yellow-700 dark:text-yellow-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            Connect Google Workspace in Settings → Google to scan meeting
            minutes.
          </span>
        </div>
      )}

      {dayError ? (
        <ErrorNote
          className="mb-3"
          message={`Could not load this day: ${dayError}`}
          onRetry={calendar.refreshDay}
        />
      ) : day.status === "refreshing" ? (
        <div className="mb-2 flex justify-end">
          <RefreshIndicator label="Refreshing the day" />
        </div>
      ) : null}

      <div className="space-y-4">
        {showWorkflow && (
          <InspectorSection
            id="workflow"
            storageScope={scope}
            title="Workflow"
            icon={
              scanProgress!.active ? (
                <Spinner size="sm" />
              ) : (
                <AlertTriangle size={13} className="text-danger" />
              )
            }
          >
            <ScanWorkflow progress={scanProgress!} />
          </InspectorSection>
        )}

        {dayState?.run && (
          <InspectorSection
            id="health"
            storageScope={scope}
            title="Data health"
            icon={<Activity size={13} />}
            summary={health?.headline}
          >
            <DayHealthRows run={dayState.run} />
          </InspectorSection>
        )}

        {tempoRows.length > 0 && (
          <InspectorSection
            id="tempo"
            storageScope={scope}
            title="Tempo"
            icon={<Clock size={13} />}
            summary={`${tempoRows.length}`}
          >
            <TempoPlanCard
              date={selectedDate}
              rows={tempoRows}
              onChanged={() => calendar.refreshDay()}
            />
          </InspectorSection>
        )}

        <InspectorSection
          id="report"
          storageScope={scope}
          title="Day report"
          icon={<FileText size={13} />}
          summary={
            dayState?.summary?.updatedAt
              ? relativeTime(dayState.summary.updatedAt)
              : undefined
          }
        >
          <DayReport day={day} scanning={scanning} />
        </InspectorSection>

        {sources.length > 0 && (
          <InspectorSection
            id="sources"
            storageScope={scope}
            title="Scanned sources"
            icon={<ListChecks size={13} />}
            summary={`${sources.length}`}
          >
            <SourceTree sources={sources} onOpenTask={onOpenTask} />
          </InspectorSection>
        )}
      </div>
    </Inspector>
  );
}

/**
 * The "Day report" region. Its states are the day's, not the report's: THIS
 * day's own skeleton while the read-model loads (R3 — a day switch never leaves
 * yesterday's report under today's date), nothing at all when the failure is
 * already stated by the panel's `ErrorNote`, and the scan hint only once the
 * day has authoritatively answered without a report (R1).
 */
function DayReport({
  day,
  scanning,
}: {
  day: LoadState<CalendarDayState>;
  scanning: boolean;
}) {
  const summary = dataOf(day)?.summary;
  if (summary)
    return (
      <div className="rounded-xl border border-line bg-surface p-3 text-caption">
        <Markdown text={summary.markdown} />
      </div>
    );
  if (isInitialLoad(day))
    return (
      <div role="status" aria-label="Loading the day report">
        <Skeleton className="h-20 w-full" />
      </div>
    );
  if (errorOf(day) && !hasData(day)) return null;
  return (
    <EmptyBox>
      {scanning
        ? "Building the day report…"
        : "Scan this day to build a structured, attention-first day report."}
    </EmptyBox>
  );
}

/** Per-source health rows for the "Data health" section (from the run manifest). */
function DayHealthRows({ run }: { run: CalendarDayRunHealth }) {
  const minutesLabel = minutesSummaryLabel(run.minutes);
  return (
    <div className="flex flex-col gap-0.5">
      {run.sources.map((source) => (
        <div
          key={source.key}
          className="flex items-center gap-1.5 text-caption"
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              source.disposition === "skipped"
                ? "bg-line-strong"
                : source.result === "complete"
                  ? "bg-emerald-500"
                  : source.result === "partial"
                    ? "bg-yellow-500"
                    : "bg-red-500"
            }`}
          />
          <span className="min-w-0 flex-1 truncate text-fg">
            {source.label}
          </span>
          <span className="shrink-0 text-micro text-faint">
            {sourceHealthLabel(source)}
          </span>
        </div>
      ))}
      {minutesLabel && (
        <div className="mt-1 flex items-center gap-1.5 border-t border-line pt-1 text-caption">
          <FileText size={11} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate text-fg">Minutes</span>
          <span className="shrink-0 text-micro text-faint">{minutesLabel}</span>
        </div>
      )}
    </div>
  );
}

function ScanWorkflow({ progress }: { progress: CalendarDayScanProgress }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-caption font-medium text-fg">
        {progress.active ? (
          <Spinner size="sm" className="text-accent" />
        ) : (
          <CheckCircle2 size={13} className="text-muted" />
        )}
        {progress.active ? "Scanning the day…" : "Scan complete"}
      </div>
      <div className="mt-0.5 flex flex-col gap-1">
        {progress.steps.map((step) => (
          <ScanStepRow key={step.key} step={step} />
        ))}
      </div>
      {progress.error ? (
        <div className="mt-1 text-caption text-danger">{progress.error}</div>
      ) : null}
    </div>
  );
}

function ScanStepRow({ step }: { step: CalendarScanStep }) {
  const icon =
    step.status === "running" ? (
      <Spinner size="sm" className="text-accent" />
    ) : step.status === "done" ? (
      <CheckCircle2 size={12} className="text-emerald-500" />
    ) : step.status === "failed" ? (
      <AlertTriangle size={12} className="text-danger" />
    ) : (
      <span className="size-1.5 rounded-full bg-line-strong" />
    );
  const tone =
    step.status === "pending"
      ? "text-faint"
      : step.status === "failed"
        ? "text-danger"
        : "text-fg";
  return (
    <div className="flex items-center gap-1.5 text-caption">
      <span className="flex size-3 items-center justify-center">{icon}</span>
      <span className={tone}>{step.label}</span>
      {step.detail ? (
        <span className="ml-auto truncate text-micro text-faint">
          {step.detail}
        </span>
      ) : null}
    </div>
  );
}

function SourceTree({
  sources,
  onOpenTask,
}: {
  sources: CalendarScanSource[];
  onOpenTask: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {sources.map((source) => (
        <SourceNode
          key={source.sourceLink}
          source={source}
          onOpenTask={onOpenTask}
        />
      ))}
    </div>
  );
}

function SourceNode({
  source,
  onOpenTask,
}: {
  source: CalendarScanSource;
  onOpenTask: (id: string) => void;
}) {
  const tone =
    source.outcome === "error"
      ? "text-danger"
      : source.outcome === "actions_found"
        ? "text-accent"
        : "text-muted";
  return (
    <div className="rounded-lg border border-line bg-surface px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        {source.outcome === "error" ? (
          <AlertTriangle size={12} className="shrink-0 text-danger" />
        ) : (
          <CheckCircle2 size={12} className={`shrink-0 ${tone}`} />
        )}
        <a
          href={source.sourceLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-1 items-center gap-1 truncate text-caption text-fg hover:text-accent"
        >
          <span className="truncate">{source.title}</span>
          <ExternalLink size={10} className="shrink-0 text-faint" />
        </a>
        <span className={`shrink-0 text-micro ${tone}`}>
          {OUTCOME_LABEL[source.outcome]}
        </span>
      </div>
      {source.tasks.length > 0 ? (
        <div className="mt-1 flex flex-col gap-0.5 border-l border-line pl-2">
          {source.tasks.map((task) => (
            <TaskNode
              key={task.id}
              task={task}
              onOpen={() => onOpenTask(task.id)}
            />
          ))}
        </div>
      ) : source.outcome === "actions_found" ? (
        <div className="mt-1 pl-2 text-micro text-faint">
          Actions found — no linked tasks
        </div>
      ) : null}
    </div>
  );
}

function TaskNode({
  task,
  onOpen,
}: {
  task: CalendarDayTaskRef;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-raised"
    >
      <CornerDownRight size={11} className="shrink-0 text-faint" />
      <span
        className={`size-1.5 shrink-0 rounded-full ${task.status === "done" ? "bg-emerald-500" : task.status === "doing" ? "bg-accent" : "bg-line-strong"}`}
      />
      <span className="min-w-0 flex-1 truncate text-caption text-fg">
        {task.title}
      </span>
      <span className="shrink-0 text-micro text-faint">
        {STATUS_LABEL[task.status] ?? task.status}
      </span>
    </button>
  );
}

function EventDetail({ event }: { event: CalendarEventDto }) {
  const timeZone = useUserTimeZone();
  const duration = durationLabel(event.start, event.end);
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-1.5 text-caption text-fg">
        <CalendarClock size={13} className="shrink-0 text-muted" />
        <span className="tabular-nums">
          {event.allDay
            ? "All day"
            : `${hm(event.start, timeZone)} – ${hm(event.end, timeZone)}`}
        </span>
        {duration && !event.allDay && (
          <span className="text-muted">· {duration}</span>
        )}
        {event.selfResponse && event.selfResponse !== "accepted" && (
          <span className="ml-auto rounded bg-raised px-1.5 py-0.5 text-micro capitalize text-muted">
            {event.selfResponse}
          </span>
        )}
      </div>

      {event.location && (
        <div className="flex items-start gap-1.5 text-caption text-muted">
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
                  className={`min-w-0 truncate ${attendee.self ? "font-medium text-fg" : "text-muted"}`}
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
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words border-t border-line pt-2 text-caption text-muted">
          {event.description}
        </div>
      )}

      {event.htmlLink && (
        <a
          href={event.htmlLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-caption text-muted hover:text-accent"
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
        : "border-accent/40 text-accent hover:bg-accent-soft";
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
