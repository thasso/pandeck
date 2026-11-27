/**
 * The user's writes and reads of Schedules from the web (`docs/schedules.md`,
 * Web and "Who may change what"): edit, on/off, delete, Pause all and the
 * history read. A user write needs no card and has no cardless limit; an edit
 * or on/off moves `controlledBy` to the user and keeps `createdBy` as history.
 *
 * This is the USER's policy, kept apart from the agent tools'
 * (`tools/schedules/scheduleTools.ts`): the two share only the store, its
 * cutovers and the one timing guard. Every write reads, validates and calls the
 * store in one synchronous block, so nothing lands between the check and the
 * write. A refusal throws, before any effect.
 */
// The admission resolver registers when this module loads, so a disable that
// ends an attempted occurrence never runs without it.
import "./scheduledPrompts.ts";
import {
  scheduleTimingError,
  scheduleTimingFutureError,
  type ScheduleActor,
  type ScheduleOccurrenceSummary,
  type ScheduleSummary,
  type ScheduleTiming,
  type ScheduleTimingInput,
  type ScheduleUserPatch,
} from "@assistant/shared/schedules";
import { scheduleStore, type ScheduleUpdate } from "../db/scheduleStore.ts";
import { hub } from "../hub.ts";
import { isPermanentAssistantSession } from "../permanentAssistant.ts";
import { sessionListHiddenProbe } from "../permanentAssistantVisibility.ts";
import { getSettings } from "../settings.ts";
import { saveSettings } from "../settingsService.ts";

/** How many of the newest occurrences the history read answers (U7). */
export const SCHEDULE_USER_HISTORY_LIMIT = 50;

const MINUTE_MS = 60_000;
const USER: ScheduleActor = { kind: "user" };

/** One authoritative Schedule and its state revision as of the write. */
interface ScheduleUserSaved {
  item: ScheduleSummary;
  revision: number;
}

/** A live Schedule's newest occurrences, read in one step with its revision. */
type ScheduleUserHistory =
  { items: ScheduleOccurrenceSummary[]; revision: number } | { items: null };

function graceMs(): number {
  return getSettings().schedules.graceWindowMinutes * MINUTE_MS;
}

function saved(item: ScheduleSummary | undefined, id: string) {
  if (!item) throw new Error(`Schedule not found: ${id}`);
  const revision = scheduleStore.revision(id);
  if (revision === undefined) throw new Error(`Schedule not found: ${id}`);
  return { item, revision };
}

/**
 * A supplied timing in the Schedule's STORED zone, valid and with a future
 * occurrence; a timing equal to a spent stored one is refused the same way.
 */
function userTiming(
  input: ScheduleTimingInput,
  timeZone: string,
  nowMs: number,
): ScheduleTiming {
  // The stored zone wins over anything the input carries.
  const timing = { ...input, timeZone } as ScheduleTiming;
  const reason =
    scheduleTimingError(timing) ?? scheduleTimingFutureError(timing, nowMs);
  if (reason) throw new Error(reason);
  return timing;
}

/**
 * Refuse a target the user may not schedule into (U4): any session the user
 * can see, archived included, except the Personal Assistant singleton.
 *
 * "Can see" is the PUBLIC session list, the picker's source: `hub.listSessions`
 * is the internal list and still returns the rows `sessionListHiddenProbe`
 * hides (a rotated Personal Assistant predecessor, a minted but unbound one),
 * which the singleton check alone does not catch.
 */
function assertUserTarget(sessionId: string): void {
  if (isPermanentAssistantSession(sessionId))
    throw new Error("The Personal Assistant can't be a Schedule target");
  const [row] = hub.listSessions({
    includeArchived: true,
    onlyIds: new Set([sessionId]),
  });
  if (!row || sessionListHiddenProbe()(row))
    throw new Error(`Session not found: ${sessionId}`);
}

/**
 * Apply the fields the user changed. Each supplied timing is checked before
 * anything is written or cut over; an unchanged target is not checked again.
 * The store settles the old definition's due times first (its edit cutover).
 */
export function updateScheduleAsUser(
  id: string,
  patch: ScheduleUserPatch,
  nowMs = Date.now(),
): ScheduleUserSaved {
  const stored = scheduleStore.get(id);
  if (!stored) throw new Error(`Schedule not found: ${id}`);
  const update: ScheduleUpdate = { controlledBy: USER };
  if (patch.prompt !== undefined) update.prompt = patch.prompt;
  if (patch.timing !== undefined)
    update.timing = userTiming(patch.timing, stored.timing.timeZone, nowMs);
  if (
    patch.targetSessionId !== undefined &&
    patch.targetSessionId !== stored.target.sessionId
  ) {
    assertUserTarget(patch.targetSessionId);
    update.target = { kind: "session", sessionId: patch.targetSessionId };
  }
  return saved(
    scheduleStore.update(id, update, { graceMs: graceMs() }, nowMs),
    id,
  );
}

/**
 * The user's on/off: an edit, so control moves to the user even when the
 * enabled state stays. Every path answers with the authoritative Schedule.
 */
export function setScheduleEnabledAsUser(
  id: string,
  enabled: boolean,
  nowMs = Date.now(),
): ScheduleUserSaved {
  return saved(
    scheduleStore.setEnabled(
      id,
      enabled,
      nowMs,
      { graceMs: graceMs() },
      { controlledBy: USER },
    ),
    id,
  );
}

/** Delete a Schedule and its history. */
export function deleteScheduleAsUser(id: string, nowMs = Date.now()): void {
  if (!scheduleStore.delete(id, nowMs))
    throw new Error(`Schedule not found: ${id}`);
}

/** The newest occurrences of a live Schedule, or `items: null` once it is gone. */
export function scheduleHistoryForUser(id: string): ScheduleUserHistory {
  if (!scheduleStore.get(id)) return { items: null };
  const revision = scheduleStore.revision(id);
  if (revision === undefined) return { items: null };
  return {
    items: scheduleStore.history(id).slice(0, SCHEDULE_USER_HISTORY_LIMIT),
    revision,
  };
}

/**
 * Pause all, merged into the CURRENT stored Schedules section: the read and
 * the start of the save happen in one tick, and `saveSettings` reaches its
 * synchronous write before its first await, so a grace window or limit saved
 * meanwhile survives and the store's switch settles under the current grace.
 * Resolves once the save has completed and been announced; rejects with the
 * save's own error, a "Settings saved, but …" effect failure included.
 */
export async function setSchedulesPausedAsUser(
  paused: boolean,
  save: typeof saveSettings = saveSettings,
): Promise<void> {
  const current = getSettings().schedules;
  await save({ schedules: { ...current, paused } });
}
