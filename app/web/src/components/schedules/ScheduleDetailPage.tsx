import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Trash2 } from "lucide-react";
import type { SessionListItem } from "@assistant/shared";
import {
  formatScheduleInstant,
  nextOccurrencesAfter,
  scheduleTimingError,
  SCHEDULE_NO_FUTURE_OCCURRENCE,
  type ScheduleSummary,
  type ScheduleTimingInput,
  type ScheduleUserPatch,
} from "@assistant/shared/schedules";
import { PageHeader, type PageHeaderBack } from "../PageHeader.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Label } from "../ui/label.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { EmptyBox, ErrorNote, PaneLoading } from "../common/load.tsx";
import {
  scheduleMutationKey,
  type ScheduleAttempt,
} from "../../hooks/useAssistant.ts";
import { wireValueEqual } from "../../lib/wireValueEqual.ts";
import { SCHEDULES_PATH } from "../../hooks/useSessionRouting.ts";
import { useNow } from "../../hooks/useNow.ts";
import { sessionPath } from "../../lib/sessionRoutes.ts";
import {
  dataOf,
  errorOf,
  isPending,
  type LoadState,
} from "../../lib/loadState.ts";
import {
  describeScheduleTiming,
  inStoredZone,
  scheduleDraftPatch,
  scheduleDraftTimingError,
  scheduleFailureReason,
  type ScheduleHistoryEntry,
} from "../../lib/schedules.ts";
import {
  ScheduleDeleteDialog,
  type ScheduleDeleteTarget,
} from "./ScheduleDeleteDialog.tsx";
import {
  ScheduleTargetPicker,
  type ArchivedTargetsRead,
} from "./ScheduleTargetPicker.tsx";
import { ScheduleTimingFields } from "./ScheduleTimingFields.tsx";
import {
  openInApp,
  scheduleActorLabel,
  scheduleSessionIds,
  useScheduleControlClaims,
} from "./SchedulesPage.tsx";
import { useScheduleSessionTitles } from "./useScheduleSessionTitles.ts";
import { useScheduleOutcomes } from "./useScheduleOutcomes.ts";

/** A stored timing as the editor holds it: without its fixed zone. */
/**
 * The draft after a save of `sent` succeeded: the fields it sent drop out, and
 * a field the user changed again while it was pending stays (F102).
 */
function draftAfterSaved(
  draft: ScheduleUserPatch,
  sent: ScheduleUserPatch,
): ScheduleUserPatch {
  const next: ScheduleUserPatch = { ...draft };
  for (const field of Object.keys(sent) as (keyof ScheduleUserPatch)[])
    if (wireValueEqual(draft[field], sent[field])) delete next[field];
  return Object.keys(next).length === Object.keys(draft).length ? draft : next;
}

function timingInput(schedule: ScheduleSummary): ScheduleTimingInput {
  const { timeZone: _zone, ...input } = schedule.timing;
  return input as ScheduleTimingInput;
}

interface Props {
  back?: PageHeaderBack | undefined;
  id: string;
  /** The held summary, or undefined when the list does not hold it. */
  schedule: ScheduleSummary | undefined;
  /** The `schedules` topic has answered, so an absent id is really gone. */
  answered: boolean;
  history: ScheduleHistoryEntry | undefined;
  mutations: Record<string, LoadState<true>>;
  /** `scheduleAttempts`: what each key's latest write asked for. */
  attempts: Record<string, ScheduleAttempt>;
  /** A failure about this Schedule that outlived its control. */
  failure: string | undefined;
  liveSessions: readonly SessionListItem[];
  archived: ArchivedTargetsRead;
  onRequestArchived: () => void;
  onSave: (id: string, patch: ScheduleUserPatch) => void;
  onDelete: (id: string) => void;
  onOpenHistory: (id: string) => void;
  onCloseHistory: (id: string) => void;
  onRetryHistory: (id: string) => void;
  onOpen: (path: string) => void;
  onClaimControls: (keys: readonly string[]) => void;
}

/**
 * @component ScheduleDetailPage
 * @purpose One Schedule (`/schedules/:id`): its prompt, timing and target
 *   editor, the next occurrences, and its history (`docs/schedules.md`, Web).
 * @useWhen The Schedules route with an id.
 * @intent The draft holds only the fields the user touched; the rest follow
 *   the server, and Save sends only what differs (R4). A save's success drops
 *   only the fields it sent; a refused save keeps the draft, and a page
 *   reopened while its save is pending adopts that save, so a refusal puts
 *   the sent fields back under the error. Leaving discards the draft. The zone is
 *   fixed and shown by name (R2). Not found only once the list answered, and
 *   never during this page's own delete.
 */
export function ScheduleDetailPage({
  back,
  id,
  schedule,
  answered,
  history,
  mutations,
  attempts,
  failure,
  liveSessions,
  archived,
  onRequestArchived,
  onSave,
  onDelete,
  onOpenHistory,
  onCloseHistory,
  onRetryHistory,
  onOpen,
  onClaimControls,
}: Props) {
  const [draft, setDraft] = useState<ScheduleUserPatch>({});
  const [deleting, setDeleting] = useState<ScheduleDeleteTarget | null>(null);

  const updateKey = scheduleMutationKey(id, "update");
  const deleteKey = scheduleMutationKey(id, "delete");
  const updateMutation = mutations[updateKey];
  const deleteMutation = mutations[deleteKey];
  const deletePending =
    deleteMutation !== undefined && isPending(deleteMutation);

  // The last summary seen: the optimistic removal of this page's own pending
  // delete must not flash not-found while the refusal may still restore it.
  const lastSeen = useRef(schedule);
  if (schedule) lastSeen.current = schedule;
  // The history read answering `null` says the Schedule is gone even before
  // the topic's delete arrives (H7).
  const gone = history?.load.status === "ready" && history.load.data === null;
  const shown =
    schedule && !gone
      ? schedule
      : deletePending || deleting
        ? lastSeen.current
        : undefined;

  useEffect(() => {
    onOpenHistory(id);
    return () => onCloseHistory(id);
  }, [id, onOpenHistory, onCloseHistory]);

  const outcomes = useScheduleOutcomes(
    useMemo(() => [updateKey], [updateKey]),
    mutations,
  );
  const { own, owns, errorFor } = outcomes;
  useScheduleControlClaims(
    [...outcomes.claims, ...(deleting ? [deleteKey] : [])],
    onClaimControls,
  );

  // An owned save's outcome, once each: success drops the fields it sent (the
  // summary now carries them) and keeps any edited since; a refusal keeps the
  // draft, and puts back what it sent where the draft no longer holds it.
  const updateAttempt = attempts[updateKey];
  const settledSave = useRef(updateMutation);
  useEffect(() => {
    if (settledSave.current === updateMutation) return;
    settledSave.current = updateMutation;
    if (!owns.has(updateKey) || !updateMutation || isPending(updateMutation))
      return;
    const sent = updateAttempt?.kind === "update" ? updateAttempt.patch : {};
    if (updateMutation.status === "ready")
      setDraft((current) => draftAfterSaved(current, sent));
    else if (updateMutation.status === "error")
      setDraft((current) => ({ ...sent, ...current }));
  }, [owns, updateKey, updateMutation, updateAttempt]);

  // The delete's success leaves for the index.
  useEffect(() => {
    if (deleting && deleteMutation?.status === "ready") {
      setDeleting(null);
      onOpen(SCHEDULES_PATH);
    }
  }, [deleting, deleteMutation, onOpen]);

  const titleOf = useScheduleSessionTitles(
    useMemo(
      () => [
        ...(shown ? scheduleSessionIds([shown]) : []),
        ...(draft.targetSessionId ? [draft.targetSessionId] : []),
        ...(dataOf(history?.load ?? { status: "idle" })?.flatMap((entry) =>
          entry.sessionId ? [entry.sessionId] : [],
        ) ?? []),
      ],
      [shown, draft.targetSessionId, history?.load],
    ),
  );

  const patch = useMemo(
    () => (shown ? scheduleDraftPatch(shown, draft) : {}),
    [shown, draft],
  );
  const draftTiming = draft.timing ?? (shown ? timingInput(shown) : undefined);
  // Minute ticks: the preview and the no-future check move with the clock.
  const nowMs = useNow(60_000);
  const timingInvalid =
    shown !== undefined &&
    draft.timing !== undefined &&
    scheduleTimingError(inStoredZone(draft.timing, shown)) !== null;
  const timingError = shown
    ? scheduleDraftTimingError(shown, patch, nowMs)
    : null;
  const previewTiming =
    shown && draftTiming ? inStoredZone(draftTiming, shown) : undefined;
  const preview =
    previewTiming && scheduleTimingError(previewTiming) === null
      ? nextOccurrencesAfter(previewTiming, nowMs, 3)
      : [];

  const save = useCallback(() => {
    if (Object.keys(patch).length === 0) return;
    own(updateKey);
    onSave(id, patch);
  }, [id, patch, onSave, own, updateKey]);

  if (!shown) {
    if (!answered && !gone) return <PaneLoading />;
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PageHeader
          back={back}
          icon={<CalendarClock size={16} />}
          title="Schedules"
        />
        <div className="p-4">
          <EmptyBox
            action={
              <Button
                size="sm"
                variant="outline"
                render={
                  <a
                    href={SCHEDULES_PATH}
                    onClick={(event) =>
                      openInApp(event, SCHEDULES_PATH, onOpen)
                    }
                  />
                }
              >
                Back to Schedules
              </Button>
            }
          >
            Schedule not found
          </EmptyBox>
        </div>
      </div>
    );
  }

  const zone = shown.timing.timeZone;
  const savePending = updateMutation !== undefined && isPending(updateMutation);
  const saveError = errorFor(updateKey);
  const dirty = Object.keys(draft).length > 0;
  const historyItems = history ? dataOf(history.load) : undefined;
  const historyError = history ? errorOf(history.load) : undefined;
  const section = "flex flex-col gap-2";
  const heading = "text-sm font-medium";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageHeader
        back={back}
        icon={<CalendarClock size={16} />}
        title={shown.name}
        subtitle={describeScheduleTiming(shown.timing)}
        actions={
          <div className="flex items-center gap-2">
            {shown.doneAtMs !== undefined ? (
              <Badge variant="secondary">Done</Badge>
            ) : !shown.enabled ? (
              <Badge variant="secondary">Off</Badge>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDeleting({ id: shown.id, name: shown.name })}
            >
              <Trash2 />
              Delete Schedule
            </Button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {failure ? <ErrorNote message={failure} /> : null}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div className="flex flex-col">
              <dt className="text-xs text-muted-foreground">Time zone</dt>
              <dd>{zone}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-xs text-muted-foreground">Created by</dt>
              <dd className="truncate">
                {scheduleActorLabel(
                  shown.createdBy,
                  shown.createdBy.kind === "session"
                    ? titleOf(shown.createdBy.sessionId)
                    : undefined,
                )}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-xs text-muted-foreground">Controlled by</dt>
              <dd className="truncate">
                {scheduleActorLabel(
                  shown.controlledBy,
                  shown.controlledBy.kind === "session"
                    ? titleOf(shown.controlledBy.sessionId)
                    : undefined,
                )}
              </dd>
            </div>
          </dl>

          <section className={section}>
            <Label htmlFor="schedule-prompt" className={heading}>
              Prompt
            </Label>
            <Textarea
              id="schedule-prompt"
              rows={5}
              value={draft.prompt ?? shown.prompt}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  prompt: event.target.value,
                }))
              }
            />
          </section>

          <section className={section} aria-labelledby="schedule-timing">
            <h2 id="schedule-timing" className={heading}>
              Timing
            </h2>
            <ScheduleTimingFields
              value={draftTiming!}
              invalid={timingInvalid || timingError !== null}
              describedBy={timingError ? "schedule-timing-error" : undefined}
              onChange={(timing) =>
                setDraft((current) => ({ ...current, timing }))
              }
            />
            {timingError ? (
              <p
                id="schedule-timing-error"
                className="text-sm text-destructive"
              >
                {timingError}
              </p>
            ) : null}
          </section>

          <section className={section}>
            <h2 id="schedule-target" className={heading}>
              Target
            </h2>
            <ScheduleTargetPicker
              labelId="schedule-target"
              value={draft.targetSessionId ?? shown.target.sessionId}
              live={liveSessions}
              archived={archived}
              titleOf={titleOf}
              onRequestArchived={onRequestArchived}
              onChange={(targetSessionId) =>
                setDraft((current) => ({ ...current, targetSessionId }))
              }
            />
          </section>

          <div className="flex flex-col gap-2">
            {saveError ? (
              <ErrorNote
                message={`Couldn't save: ${scheduleFailureReason(saveError)}`}
                onRetry={save}
                retryLabel="Try again"
              />
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!dirty || savePending}
                onClick={() => setDraft({})}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                busy={savePending}
                disabled={
                  Object.keys(patch).length === 0 ||
                  timingInvalid ||
                  timingError !== null
                }
                onClick={save}
              >
                Save
              </Button>
            </div>
          </div>

          <section className={section}>
            <h2 className={heading}>Next occurrences</h2>
            {preview.length === 0 ? (
              timingInvalid ? null : (
                <p className="text-sm text-muted-foreground">
                  {SCHEDULE_NO_FUTURE_OCCURRENCE}
                </p>
              )
            ) : (
              <ul className="flex flex-col gap-1 text-sm tabular-nums">
                {preview.map((at) => (
                  <li key={at}>{formatScheduleInstant(at, zone)}</li>
                ))}
              </ul>
            )}
          </section>

          <section className={section}>
            <h2 className={heading}>History</h2>
            {historyError ? (
              <ErrorNote
                message={`Couldn't load history: ${historyError}`}
                onRetry={() => onRetryHistory(id)}
              />
            ) : null}
            {historyItems === undefined || historyItems === null ? (
              historyError ? null : (
                <PaneLoading className="flex-none p-3" />
              )
            ) : historyItems.length === 0 ? (
              <EmptyBox variant="inline">No occurrences yet.</EmptyBox>
            ) : (
              <ul className="flex flex-col text-sm">
                {historyItems.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-baseline gap-x-3 border-b border-border/60 py-1.5"
                  >
                    <span className="tabular-nums">
                      {formatScheduleInstant(entry.dueAtMs, zone)}
                    </span>
                    <span
                      className={
                        entry.state === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      {entry.state}
                    </span>
                    {entry.sessionId ? (
                      <a
                        href={sessionPath(entry.sessionId)}
                        onClick={(event) =>
                          openInApp(
                            event,
                            sessionPath(entry.sessionId!),
                            onOpen,
                          )
                        }
                        className="truncate hover:underline"
                      >
                        {titleOf(entry.sessionId)?.title ?? entry.sessionId}
                      </a>
                    ) : null}
                    {entry.error ? (
                      <span className="w-full text-muted-foreground">
                        {entry.error}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
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
