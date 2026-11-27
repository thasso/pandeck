import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { CalendarClock, Trash2 } from "lucide-react";
import {
  formatScheduleDue,
  type ScheduleActor,
  type ScheduleSummary,
} from "@assistant/shared/schedules";
import { PageHeader, type PageHeaderBack } from "../PageHeader.tsx";
import { ListRow } from "../common/ListRow.tsx";
import { IconButton } from "../common/IconButton.tsx";
import { EmptyBox, ErrorNote, PaneLoading } from "../common/load.tsx";
import { Label } from "../ui/label.tsx";
import { Switch } from "../ui/switch.tsx";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";
import { useListScroll } from "../../hooks/useListScroll.ts";
import { schedulePath } from "../../hooks/useSessionRouting.ts";
import {
  SCHEDULES_PAUSE_KEY,
  scheduleMutationKey,
  type ScheduleAttempt,
} from "../../hooks/useAssistant.ts";
import { isPending, type LoadState } from "../../lib/loadState.ts";
import { sessionPath } from "../../lib/sessionRoutes.ts";
import {
  describeScheduleTiming,
  scheduleFailureReason,
  scheduleNextLabel,
  visibleSchedules,
  type ScheduleFilter,
} from "../../lib/schedules.ts";
import {
  ScheduleDeleteDialog,
  type ScheduleDeleteTarget,
} from "./ScheduleDeleteDialog.tsx";
import { useScheduleSessionTitles } from "./useScheduleSessionTitles.ts";
import { useScheduleOutcomes } from "./useScheduleOutcomes.ts";
import { openInApp } from "./scheduleLinks.ts";

/** The approved U6 note, shown while Pause all is on. */
const SCHEDULES_PAUSED_NOTE =
  "Paused. No new occurrences are claimed: due times are recorded as missed and do not catch up on resume. An occurrence already claimed, including one that fell due just before pausing, may still be delivered.";

/**
 * One grid for the column heads and every row, so the columns line up. Below
 * `sm` a row wraps instead: the name on its own line, the other cells and the
 * controls wrapping under it, and the column heads are not drawn.
 */
const SCHEDULE_GRID =
  "flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 sm:grid sm:grid-cols-16";

/** The creator/controller label (U8): You, the session's title, or gone. */
export function scheduleActorLabel(
  actor: ScheduleActor,
  title: ReturnType<ReturnType<typeof useScheduleSessionTitles>>,
): string {
  if (actor.kind === "user") return "You";
  if (title?.existence === "missing") return "Deleted session";
  return title?.title ?? actor.sessionId;
}

/** Every session a list of Schedules names, for the title resolver. */
export function scheduleSessionIds(
  schedules: readonly ScheduleSummary[],
): string[] {
  const ids: string[] = [];
  for (const schedule of schedules) {
    ids.push(schedule.target.sessionId);
    if (schedule.createdBy.kind === "session")
      ids.push(schedule.createdBy.sessionId);
    if (schedule.lastOccurrence?.sessionId)
      ids.push(schedule.lastOccurrence.sessionId);
  }
  return ids;
}

/**
 * Report the controls a surface renders to the arrival rules, by mutation key
 * (`lib/messageArrival.ts`): a refusal for one of them is shown in place, any
 * other is announced. Released on unmount, so leaving releases them.
 */
export function useScheduleControlClaims(
  keys: readonly string[],
  onClaim: (keys: readonly string[]) => void,
) {
  const joined = keys.join("\n");
  useEffect(() => {
    onClaim(joined ? joined.split("\n") : []);
  }, [joined, onClaim]);
  useEffect(() => () => onClaim([]), [onClaim]);
}

interface Props {
  back?: PageHeaderBack | undefined;
  schedules: readonly ScheduleSummary[];
  /** The `schedules` topic has answered: an empty list is then really empty. */
  answered: boolean;
  /** The collection's condition (`Failed to list Schedules: …`). */
  listError: string | null;
  onRetry: () => void;
  paused: boolean;
  /** `scheduleMutations`, by `scheduleMutationKey`/`SCHEDULES_PAUSE_KEY`. */
  mutations: Record<string, LoadState<true>>;
  /** `scheduleAttempts`: what each key's latest write asked for. */
  attempts: Record<string, ScheduleAttempt>;
  onSetPaused: (paused: boolean) => void;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onOpen: (path: string) => void;
  onClaimControls: (keys: readonly string[]) => void;
}

/**
 * @component SchedulesPage
 * @purpose The Schedules index (`/schedules`): every live Schedule, Active or
 *   Done, with on/off, delete and Pause all (`docs/schedules.md`, Web).
 * @useWhen The Schedules route without an id, on every layout: a phone shows
 *   this page too, not the section's browser.
 * @intent The list is the `schedules` topic itself; it is empty only once the
 *   topic answered. A write's refusal shows on the control that sent it while
 *   that control is on screen, which the page reports as its claims; the
 *   delete dialog is the page's, so the row's optimistic removal keeps it.
 */
export function SchedulesPage({
  back,
  schedules,
  answered,
  listError,
  onRetry,
  paused,
  mutations,
  attempts,
  onSetPaused,
  onSetEnabled,
  onDelete,
  onOpen,
  onClaimControls,
}: Props) {
  const scrollRef = useListScroll({ listKey: "schedules" });
  const [filter, setFilter] = useState<ScheduleFilter>("active");
  const [deleting, setDeleting] = useState<ScheduleDeleteTarget | null>(null);
  const onHeadId = useId();
  const rows = useMemo(
    () => visibleSchedules(schedules, filter),
    [schedules, filter],
  );
  const titleOf = useScheduleSessionTitles(
    useMemo(() => scheduleSessionIds(rows), [rows]),
  );

  // Pause all and every row's switch show their own write's outcome, adopted
  // when this page opens while that write is still pending.
  const outcomes = useScheduleOutcomes(
    useMemo(
      () => [
        SCHEDULES_PAUSE_KEY,
        ...rows.map((row) => scheduleMutationKey(row.id, "enabled")),
      ],
      [rows],
    ),
    mutations,
  );
  const { own, errorFor } = outcomes;
  useScheduleControlClaims(
    [
      ...outcomes.claims,
      ...(deleting ? [scheduleMutationKey(deleting.id, "delete")] : []),
    ],
    onClaimControls,
  );

  const pauseMutation = mutations[SCHEDULES_PAUSE_KEY];
  const pausePending = pauseMutation !== undefined && isPending(pauseMutation);
  const pauseError = errorFor(SCHEDULES_PAUSE_KEY);
  const pauseAttempt = attempts[SCHEDULES_PAUSE_KEY];
  const askPause = useCallback(
    (next: boolean) => {
      own(SCHEDULES_PAUSE_KEY);
      onSetPaused(next);
    },
    [own, onSetPaused],
  );
  const flip = useCallback(
    (id: string, enabled: boolean) => {
      own(scheduleMutationKey(id, "enabled"));
      onSetEnabled(id, enabled);
    },
    [own, onSetEnabled],
  );

  const deleteMutation = deleting
    ? mutations[scheduleMutationKey(deleting.id, "delete")]
    : undefined;
  // The dialog closes on the delete's success; a refusal keeps it open.
  useEffect(() => {
    if (deleting && deleteMutation?.status === "ready") setDeleting(null);
  }, [deleting, deleteMutation]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageHeader
        back={back}
        icon={<CalendarClock size={16} />}
        title="Schedules"
        actions={
          <div className="flex items-center gap-2">
            <Switch
              id="schedules-pause-all"
              checked={paused}
              disabled={pausePending}
              aria-busy={pausePending || undefined}
              onCheckedChange={(checked) => askPause(checked)}
            />
            <Label htmlFor="schedules-pause-all" className="text-sm">
              Pause all
            </Label>
          </div>
        }
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
          {pauseError ? (
            <ErrorNote
              message={`Couldn't change Pause all: ${scheduleFailureReason(pauseError)}`}
              onRetry={() =>
                askPause(
                  pauseAttempt?.kind === "pause"
                    ? pauseAttempt.paused
                    : !paused,
                )
              }
              retryLabel="Try again"
            />
          ) : null}
          {paused ? (
            <p className="text-sm text-muted-foreground">
              {SCHEDULES_PAUSED_NOTE}
            </p>
          ) : null}
          {listError ? (
            <ErrorNote message={listError} onRetry={onRetry} />
          ) : null}
          <ToggleGroup
            size="sm"
            variant="outline"
            aria-label="Schedules"
            value={[filter]}
            onValueChange={(next) => {
              const picked = next[0];
              if (picked === "active" || picked === "done") setFilter(picked);
            }}
          >
            <ToggleGroupItem value="active">Active</ToggleGroupItem>
            <ToggleGroupItem value="done">Done</ToggleGroupItem>
          </ToggleGroup>
          {!answered ? (
            listError ? null : (
              <PaneLoading className="flex-none p-6" />
            )
          ) : rows.length === 0 ? (
            <EmptyBox>
              {filter === "done"
                ? "No done Schedules."
                : "No Schedules. Agents create them for their sessions."}
            </EmptyBox>
          ) : (
            <div className="flex flex-col">
              <div
                className={`${SCHEDULE_GRID} hidden border-b border-border px-3 pb-1.5 text-xs text-muted-foreground sm:grid`}
              >
                <span className="col-span-3">Name</span>
                <span className="col-span-2">Target</span>
                <span className="col-span-3">Timing</span>
                <span className="col-span-2">Next</span>
                <span className="col-span-2">Last</span>
                <span className="col-span-2">Created by</span>
                <span id={onHeadId} className="col-span-2">
                  On
                </span>
              </div>
              {rows.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  titleOf={titleOf}
                  onHeadId={onHeadId}
                  enabledMutation={
                    mutations[scheduleMutationKey(schedule.id, "enabled")]
                  }
                  error={errorFor(scheduleMutationKey(schedule.id, "enabled"))}
                  attempt={
                    attempts[scheduleMutationKey(schedule.id, "enabled")]
                  }
                  onSetEnabled={flip}
                  onAskDelete={setDeleting}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {deleting ? (
        <ScheduleDeleteDialog
          target={deleting}
          mutation={deleteMutation}
          onConfirm={() => onDelete(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

function ScheduleRow({
  schedule,
  titleOf,
  onHeadId,
  enabledMutation,
  error,
  attempt,
  onSetEnabled,
  onAskDelete,
  onOpen,
}: {
  schedule: ScheduleSummary;
  titleOf: ReturnType<typeof useScheduleSessionTitles>;
  /** The On column head, which names every row's switch with its row. */
  onHeadId: string;
  enabledMutation: LoadState<true> | undefined;
  /** The refusal of the switch's write this page owns, if any. */
  error: string | undefined;
  /** What that write asked for: Try again repeats it. */
  attempt: ScheduleAttempt | undefined;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onAskDelete: (target: ScheduleDeleteTarget) => void;
  onOpen: (path: string) => void;
}) {
  const nameId = useId();
  const deleteId = useId();
  const pending = enabledMutation !== undefined && isPending(enabledMutation);
  const href = schedulePath(schedule.id);
  const last = schedule.lastOccurrence;
  const target = titleOf(schedule.target.sessionId);
  // The session the last occurrence went to, which a retarget since does not
  // change (AC1).
  const lastSession = last?.sessionId;
  const lastSessionLabel = lastSession
    ? titleOf(lastSession)?.existence === "missing"
      ? "Deleted session"
      : (titleOf(lastSession)?.title ?? lastSession)
    : undefined;
  return (
    <ListRow
      interaction="content"
      rowProps={{ "data-list-row-id": schedule.id }}
    >
      <div className="flex w-full min-w-0 flex-col gap-1.5 py-1">
        <div className={`${SCHEDULE_GRID} text-sm`}>
          <a
            id={nameId}
            href={href}
            onClick={(event) => openInApp(event, href, onOpen)}
            className="min-w-0 flex-1 basis-full truncate font-medium hover:underline sm:col-span-3 sm:basis-auto"
          >
            {schedule.name}
          </a>
          <span className="col-span-2 truncate">
            {target?.title ?? schedule.target.sessionId}
          </span>
          <span className="col-span-3 truncate text-muted-foreground">
            {describeScheduleTiming(schedule.timing)}
          </span>
          <span className="col-span-2 truncate tabular-nums">
            {scheduleNextLabel(schedule)}
          </span>
          <span
            className={`col-span-2 flex min-w-0 flex-col tabular-nums ${last?.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}
          >
            <span className="truncate">
              {last
                ? `${formatScheduleDue(last.dueAtMs, schedule.timing.timeZone)} ${last.state}`
                : "—"}
            </span>
            {lastSession && lastSessionLabel ? (
              lastSessionLabel === "Deleted session" ? (
                <span className="truncate">{lastSessionLabel}</span>
              ) : (
                <a
                  href={sessionPath(lastSession)}
                  onClick={(event) =>
                    openInApp(event, sessionPath(lastSession), onOpen)
                  }
                  className="truncate hover:underline"
                >
                  {lastSessionLabel}
                </a>
              )
            ) : null}
          </span>
          <span className="col-span-2 truncate text-muted-foreground">
            {scheduleActorLabel(
              schedule.createdBy,
              schedule.createdBy.kind === "session"
                ? titleOf(schedule.createdBy.sessionId)
                : undefined,
            )}
          </span>
          <span className="col-span-2 flex items-center justify-between gap-1">
            <Switch
              size="sm"
              aria-labelledby={`${nameId} ${onHeadId}`}
              checked={schedule.enabled}
              disabled={pending}
              aria-busy={pending || undefined}
              onCheckedChange={(checked) => onSetEnabled(schedule.id, checked)}
            />
            <IconButton
              id={deleteId}
              label="Delete Schedule"
              aria-labelledby={`${deleteId} ${nameId}`}
              onClick={() =>
                onAskDelete({ id: schedule.id, name: schedule.name })
              }
            >
              <Trash2 />
            </IconButton>
          </span>
        </div>
        {error ? (
          <ErrorNote
            message={`Couldn't save: ${scheduleFailureReason(error)}`}
            onRetry={() =>
              onSetEnabled(
                schedule.id,
                attempt?.kind === "enabled"
                  ? attempt.enabled
                  : !schedule.enabled,
              )
            }
            retryLabel="Try again"
          />
        ) : null}
      </div>
    </ListRow>
  );
}
