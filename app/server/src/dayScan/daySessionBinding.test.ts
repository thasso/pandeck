/**
 * Regression test for the calendar day-session binding resolution (Task 171).
 *
 * The bug: `resolveDaySessionId` destructively cleared a durable binding on ANY
 * `sessionStore.get` miss, so a resumable pi session read before boot-time
 * metadata repair permanently lost its binding — the calendar then offered no
 * "Open day session" action even though the `Calendar · <date>` session existed.
 *
 * Roots the data dir at a temp folder (ASSISTANT_CWD, honored by config.ts)
 * BEFORE importing the store/resolver, so the SQLite DB and the binding file are
 * isolated.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ASSISTANT_CWD = mkdtempSync(
  join(tmpdir(), "day-session-binding-test-"),
);

const { sessionStore } = await import("../db/sessionStore.ts");
const { getDaySessionId, setDaySessionId, daySessionTitle } =
  await import("../calendarDaySessions.ts");
const { resolveDaySessionId } = await import("./dayState.ts");

function seedDaySession(date: string): string {
  const id = `pi-${date}-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: daySessionTitle(date),
    createdAt: now,
    updatedAt: now,
    messageCount: 2,
  });
  return id;
}

test("a valid binding resolves to its session", () => {
  const date = "2026-08-01";
  const id = seedDaySession(date);
  setDaySessionId(date, id);
  assert.equal(resolveDaySessionId(date), id);
});

test("self-heals a lost binding from the titled session (the 2026-07-23 bug)", () => {
  const date = "2026-08-02";
  const id = seedDaySession(date);
  // No binding recorded (it was destructively cleared earlier).
  assert.equal(getDaySessionId(date), null);
  assert.equal(
    resolveDaySessionId(date),
    id,
    "recovers the session by its Calendar · <date> title",
  );
  assert.equal(
    getDaySessionId(date),
    id,
    "and rebinds it so later reads are cheap",
  );
});

test("an unknown binding id is NOT destroyed on a plain miss", () => {
  const date = "2026-08-03";
  setDaySessionId(date, "pi-unknown-not-yet-repaired");
  assert.equal(
    resolveDaySessionId(date),
    null,
    "reports no session (nothing found)",
  );
  assert.equal(
    getDaySessionId(date),
    "pi-unknown-not-yet-repaired",
    "but keeps the binding for a later repair",
  );
});

test("a definitively deleted binding is cleared", () => {
  const date = "2026-08-04";
  const id = seedDaySession(date);
  setDaySessionId(date, id);
  sessionStore.remove(id); // soft-delete (tombstone)
  assert.equal(resolveDaySessionId(date), null);
  assert.equal(getDaySessionId(date), null, "the dead binding is dropped");
});
