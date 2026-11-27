import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
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
} from "../../hooks/useAssistant.ts";
import { errorOf, isPending, type LoadState } from "../../lib/loadState.ts";
import {
  describeScheduleTiming,
  scheduleFailureReason,
  visibleSchedules,
  type ScheduleFilter,
} from "../../lib/schedules.ts";
import {
  ScheduleDeleteDialog,
  type ScheduleDeleteTarget,
} from "./ScheduleDeleteDialog.tsx";
import { useScheduleSessionTitles } from "./useScheduleSessionTitles.ts";

/** The approved U6 note, shown while Pause all is on. */
const SCHEDULES_PAUSED_NOTE =
  "Paused. No new occurrences are claimed: due times are recorded as missed and do not catch up on resume. An occurrence already claimed, including one that fell due just before pausing, may still be delivered.";

/** One grid for the column heads and every row, so the columns line up. */
const SCHEDULE_GRID = "grid w-full grid-cols-16 items-center gap-x-3";

/**
 * Follow an in-app link like the router does, leaving modified clicks (new
 * tab, new window) to the browser.
 */
export function openInApp(
  event: MouseEvent<HTMLAnchorElement>,
  path: string,
  onOpen: (path: string) => void,
) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onOpen(path);
}

/** The Next column (U8): Off, Done, a due time, or none. */
export function scheduleNextLabel(schedule: ScheduleSummary): string {
  if (schedule.doneAtMs !== undefined) return "Done";
  if (!schedule.enabled) return "Off";
  return schedule.nextDueAtMs !== undefined
    ? formatScheduleDue(schedule.nextDueAtMs, schedule.timing.timeZone)
    : "—";
}

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
 * @useWhen The Schedules route without an id, in the desktop main pane.
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
  onSetPaused,
  onSetEnabled,
  onDelete,
  onOpen,
  onClaimControls,
}: Props) {
  const scrollRef = useListScroll({ listKey: "schedules" });
  const [filter, setFilter] = useState<ScheduleFilter>("active");
  const [deleting, setDeleting] = useState<ScheduleDeleteTarget | null>(null);
  // The value the last Pause all click asked for: Try again repeats it, and
  // a refusal left from before this page opened is not repeated here.
  const [pauseAsked, setPauseAsked] = useState<boolean | null>(null);
  const rows = useMemo(
    () => visibleSchedules(schedules, filter),
    [schedules, filter],
  );
  const titleOf = useScheduleSessionTitles(
    useMemo(() => scheduleSessionIds(rows), [rows]),
  );

  useScheduleControlClaims(
    [
      SCHEDULES_PAUSE_KEY,
      ...rows.map((row) => scheduleMutationKey(row.id, "enabled")),
      ...(deleting ? [scheduleMutationKey(deleting.id, "delete")] : []),
    ],
    onClaimControls,
  );

  const pauseMutation = mutations[SCHEDULES_PAUSE_KEY];
  const pausePending = pauseMutation !== undefined && isPending(pauseMutation);
  const pauseError =
    pauseAsked !== null && pauseMutation && !pausePending
      ? errorOf(pauseMutation)
      : undefined;
  const askPause = useCallback(
    (next: boolean) => {
      setPauseAsked(next);
      onSetPaused(next);
    },
    [onSetPaused],
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
              onRetry={() => askPause(pauseAsked ?? !paused)}
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
                className={`${SCHEDULE_GRID} border-b border-border px-3 pb-1.5 text-xs text-muted-foreground`}
              >
                <span className="col-span-3">Name</span>
                <span className="col-span-2">Target</span>
                <span className="col-span-3">Timing</span>
                <span className="col-span-2">Next</span>
                <span className="col-span-2">Last</span>
                <span className="col-span-2">Created by</span>
                <span className="col-span-2">On</span>
              </div>
              {rows.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  titleOf={titleOf}
                  enabledMutation={
                    mutations[scheduleMutationKey(schedule.id, "enabled")]
                  }
                  onSetEnabled={onSetEnabled}
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
  enabledMutation,
  onSetEnabled,
  onAskDelete,
  onOpen,
}: {
  schedule: ScheduleSummary;
  titleOf: ReturnType<typeof useScheduleSessionTitles>;
  enabledMutation: LoadState<true> | undefined;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onAskDelete: (target: ScheduleDeleteTarget) => void;
  onOpen: (path: string) => void;
}) {
  // A refusal shows here only for a switch flipped while this row is shown.
  const [asked, setAsked] = useState<boolean | null>(null);
  const pending = enabledMutation !== undefined && isPending(enabledMutation);
  const error =
    asked !== null && enabledMutation && !pending
      ? errorOf(enabledMutation)
      : undefined;
  const flip = (enabled: boolean) => {
    setAsked(enabled);
    onSetEnabled(schedule.id, enabled);
  };
  const href = schedulePath(schedule.id);
  const last = schedule.lastOccurrence;
  const target = titleOf(schedule.target.sessionId);
  return (
    <ListRow
      interaction="content"
      rowProps={{ "data-list-row-id": schedule.id }}
    >
      <div className="flex w-full min-w-0 flex-col gap-1.5 py-1">
        <div className={`${SCHEDULE_GRID} text-sm`}>
          <a
            href={href}
            onClick={(event) => openInApp(event, href, onOpen)}
            className="col-span-3 truncate font-medium hover:underline"
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
            className={`col-span-2 truncate tabular-nums ${last?.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {last
              ? `${formatScheduleDue(last.dueAtMs, schedule.timing.timeZone)} ${last.state}`
              : "—"}
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
              aria-label="On"
              checked={schedule.enabled}
              disabled={pending}
              aria-busy={pending || undefined}
              onCheckedChange={(checked) => flip(checked)}
            />
            <IconButton
              label="Delete Schedule"
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
            onRetry={() => flip(asked ?? !schedule.enabled)}
            retryLabel="Try again"
          />
        ) : null}
      </div>
    </ListRow>
  );
}
