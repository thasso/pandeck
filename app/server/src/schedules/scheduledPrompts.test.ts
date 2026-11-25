/**
 * The scheduled-prompt header (`docs/schedules.md`, "What the user and the
 * model see"): the exact approved line, from the occurrence's frozen input.
 * And the admission resolver the store consults for attempted claimed rows,
 * registered by loading this module. The lane itself is covered through the
 * real scheduler in `scheduledPromptsLane.test.ts`.
 *   pnpm --filter @assistant/server test src/schedules/scheduledPrompts.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "vitest";
import type { ScheduleOccurrenceRecord } from "../db/scheduleStore.ts";
import { scheduleStore } from "../db/scheduleStore.ts";
import { canonicalSessionLogPath } from "../sessionStorage.ts";
import {
  resolveScheduledAdmission,
  scheduledPromptHeader,
  scheduledPromptKey,
} from "./scheduledPrompts.ts";

const occurrence = {
  scheduleId: "sch_12",
  name: "PR CI check",
  // Wed 25 Nov 2026 14:45Z, 15:45 in Berlin.
  dueAtMs: Date.UTC(2026, 10, 25, 14, 45),
  timeZone: "Europe/Berlin",
};

test("the header is the approved line, due in the frozen zone", () => {
  assert.equal(
    scheduledPromptHeader(occurrence),
    '⏰ Scheduled prompt "PR CI check" · schedule `sch_12` · due Wed 25 Nov 15:45 Europe/Berlin',
  );
  // The occurrence's own zone, never the reader's or the Schedule's current one.
  assert.equal(
    scheduledPromptHeader({ ...occurrence, timeZone: "America/New_York" }),
    '⏰ Scheduled prompt "PR CI check" · schedule `sch_12` · due Wed 25 Nov 09:45 America/New_York',
  );
});

test("the name's whitespace collapses into one line", () => {
  assert.equal(
    scheduledPromptHeader({ ...occurrence, name: "  PR\tCI\n\n  check \n" }),
    '⏰ Scheduled prompt "PR CI check" · schedule `sch_12` · due Wed 25 Nov 15:45 Europe/Berlin',
  );
});

const D10 =
  "delivery uncertain: the target session's transcript could not be read";

function attempted(sessionId: string, id: string): ScheduleOccurrenceRecord {
  return {
    id,
    scheduleId: "sch_1",
    name: "Check",
    prompt: "Check CI",
    target: { kind: "session", sessionId },
    dueAtMs: Date.UTC(2026, 10, 25, 9),
    timeZone: "UTC",
    state: "claimed",
    attemptedAtMs: Date.UTC(2026, 10, 25, 9, 1),
  } as ScheduleOccurrenceRecord;
}

function writeLog(sessionId: string, ...lines: string[]): string {
  const path = canonicalSessionLogPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  return path;
}

test("loading the module registers the admission resolver", () => {
  assert.equal(scheduleStore.hasAdmissionResolver(), true);
});

test("the resolver reads the target's canonical log by the occurrence's key", () => {
  const occurrence = attempted("resolver-present", "occ_41");
  const path = writeLog(
    "resolver-present",
    JSON.stringify({ v: 1, sessionId: "resolver-present", createdAt: "x" }),
    JSON.stringify({
      type: "message",
      role: "user",
      seq: 1,
      clientRequestId: scheduledPromptKey(occurrence.id),
      content: [],
    }),
  );
  try {
    assert.deepEqual(resolveScheduledAdmission(occurrence), {
      kind: "present",
      sessionId: "resolver-present",
    });
    // Another occurrence's key is not this one's evidence.
    assert.deepEqual(
      resolveScheduledAdmission(attempted("resolver-present", "occ_4")),
      { kind: "absent" },
    );
  } finally {
    rmSync(path);
  }
  assert.deepEqual(resolveScheduledAdmission(occurrence), { kind: "absent" });
});

test("an unreadable log is unknown, with the approved D10 text", () => {
  const path = canonicalSessionLogPath("resolver-unreadable");
  mkdirSync(path, { recursive: true });
  try {
    assert.deepEqual(
      resolveScheduledAdmission(attempted("resolver-unreadable", "occ_42")),
      { kind: "unknown", error: D10 },
    );
  } finally {
    rmSync(path, { recursive: true });
  }
});
