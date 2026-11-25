/**
 * The scheduled-prompt header (`docs/schedules.md`, "What the user and the
 * model see"): the exact approved line, from the occurrence's frozen input.
 *   pnpm --filter @assistant/server test src/schedules/scheduledPrompts.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { scheduledPromptHeader } from "./scheduledPrompts.ts";

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
