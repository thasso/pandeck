/**
 * Schedules, claims and log reads for the scheduled prompts lane tests
 * (`src/schedules/scheduledPromptsLane*.test.ts`), with the slots a test
 * uses to act between the walk's steps.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { ScheduleTiming } from "@assistant/shared/schedules";
import type { PromptOrigin } from "@assistant/shared/session";
import {
  scheduleStore,
  type ScheduleCreateInput,
  type ScheduleOccurrenceRecord,
} from "../db/scheduleStore.ts";
import {
  forgetScheduledAppendsForTests,
  scheduledPromptKey,
} from "../schedules/scheduledPrompts.ts";
import { canonicalSessionLogPath } from "../sessionStorage.ts";
import type { FakeRuntimeDriver } from "./fakeRuntimeDriver.ts";
import {
  DEC1,
  GRACE,
  MINUTE,
  until,
  type fixture,
} from "./scheduledPromptLane.ts";

let seq = 0;
/** A daily 09:00 UTC Schedule for `sessionId`, cursor `DEC1`. */
export function schedule(
  sessionId: string,
  patch: Partial<ScheduleCreateInput> = {},
): string {
  seq += 1;
  const timing: ScheduleTiming = {
    kind: "daily",
    time: "09:00",
    timeZone: "UTC",
  };
  return scheduleStore.create(
    {
      name: `Check ${seq}`,
      prompt: `Scheduled prompt ${seq}`,
      timing,
      target: { kind: "session", sessionId },
      createdBy: { kind: "session", sessionId },
      cardless: true,
      ...patch,
    },
    DEC1 - 60 * MINUTE,
  ).id;
}

/** Claim a Schedule's due time `dueAtMs` now (as the clock would). */
export function claim(
  scheduleId: string,
  dueAtMs = DEC1,
): ScheduleOccurrenceRecord {
  const claimed = scheduleStore.claimDue(scheduleId, dueAtMs, GRACE).claimed;
  assert.ok(claimed, `claimed ${scheduleId} at ${dueAtMs}`);
  return claimed;
}

/** A new Schedule for `sessionId` with its DEC1 occurrence claimed. */
export function owed(
  sessionId: string,
  patch: Partial<ScheduleCreateInput> = {},
): { scheduleId: string; occurrence: ScheduleOccurrenceRecord } {
  const scheduleId = schedule(sessionId, patch);
  return { scheduleId, occurrence: claim(scheduleId) };
}

export function row(id: string): ScheduleOccurrenceRecord {
  const found = scheduleStore.getOccurrence(id);
  assert.ok(found, `occurrence ${id}`);
  return found;
}

interface LoggedUser {
  clientRequestId?: string;
  origin: PromptOrigin;
  content: Array<{ type: string; text?: string }>;
}

/** The user entries of a session's canonical log, in order. */
export function userEntries(sessionId: string): LoggedUser[] {
  let raw: string;
  try {
    raw = readFileSync(canonicalSessionLogPath(sessionId), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.type === "message" && entry.role === "user")
    .map((entry) => entry as unknown as LoggedUser);
}

export function keyed(sessionId: string, occurrenceId: string): LoggedUser[] {
  const key = scheduledPromptKey(occurrenceId);
  return userEntries(sessionId).filter((e) => e.clientRequestId === key);
}

/**
 * Drive one real delivery whose every `delivered` settle fails, as a crash
 * between the append and the settle would leave it, then forget this
 * process's append records as a restart does: the row is `claimed` and
 * attempted, and only the canonical log holds its key.
 */
export async function appendedThenRestarted(
  f: ReturnType<typeof fixture>,
  occurrence: ScheduleOccurrenceRecord,
): Promise<void> {
  const original = scheduleStore.settleOccurrence.bind(scheduleStore);
  const spy = vi
    .spyOn(scheduleStore, "settleOccurrence")
    .mockImplementation((id, ...rest) => {
      if (id === occurrence.id) throw new Error("settle lost in the crash");
      return original(id, ...rest);
    });
  const before = f.driver.promptTexts.length;
  await f.scheduler.wake(f.id);
  await until(
    () => f.driver.promptTexts.length === before + 1 && !f.driver.isRunning,
  );
  await until(() => spy.mock.calls.length >= 2);
  spy.mockRestore();
  forgetScheduledAppendsForTests();
  assert.equal(row(occurrence.id).state, "claimed");
  assert.ok(row(occurrence.id).attemptedAtMs !== undefined);
  assert.equal(keyed(f.id, occurrence.id).length, 1);
}

/**
 * Wrap `markAttempted` so `during` runs right after a successful mark, inside
 * `admit`, before the strict restore: the only synchronous slot there is.
 */
export function afterMark(during: () => void): void {
  const original = scheduleStore.markAttempted.bind(scheduleStore);
  vi.spyOn(scheduleStore, "markAttempted").mockImplementation((...args) => {
    const marked = original(...args);
    if (marked) during();
    return marked;
  });
}

/**
 * Hide an attempt from the walk's read only, so its pre-retry evidence check
 * is skipped and the outcome of this run is what gets classified.
 */
export function hideAttempt(occurrenceId: string): void {
  const original = scheduleStore.getOccurrence.bind(scheduleStore);
  let once = true;
  vi.spyOn(scheduleStore, "getOccurrence").mockImplementation((id) => {
    const found = original(id);
    if (!once || id !== occurrenceId || !found) return found;
    once = false;
    const { attemptedAtMs: _attempted, ...rest } = found;
    return rest;
  });
}

/** Run `during` after the facade's last await, just before `admit`. */
export function beforeAdmit(
  driver: FakeRuntimeDriver,
  during: () => void,
): void {
  let once = true;
  Object.assign(driver, {
    modelSelection: () => {
      if (once) {
        once = false;
        during();
      }
      return {};
    },
  });
}
