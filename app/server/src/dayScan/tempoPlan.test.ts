import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  beginExecuting,
  cancelProposal,
  declineProposal,
  finishExecuting,
  getProposal,
  markUserEdited,
  requestApproval,
  resetTempoPlanStoreForTests,
  upsertProposal,
} from "../db/tempoPlanStore.ts";
import {
  reconcileAgainstWorklogs,
  renderTempoPlan,
  type ObservedWorklog,
} from "./tempoPlan.ts";
import type { TempoProposalRow } from "../db/tempoPlanStore.ts";

const DATE = "2026-07-13";
beforeEach(() => resetTempoPlanStoreForTests());
afterEach(() => resetTempoPlanStoreForTests());

function seed(id: string): TempoProposalRow {
  return upsertProposal({
    id,
    date: DATE,
    issueKey: "WEB-1",
    startTime: "09:00",
    durationSeconds: 3600,
    activityKey: "dev",
    description: "work",
  });
}

test("exactly one transition wins: approve and cancel race from pending-approval", () => {
  seed("r1");
  requestApproval("r1", "prop-1");
  const approved = beginExecuting("r1");
  const cancelled = cancelProposal("r1");
  assert.equal(approved, true, "the approve won the CAS");
  assert.equal(
    cancelled,
    false,
    "cancel loses once the row left pending-approval",
  );
  assert.equal(getProposal("r1")?.status, "executing");
});

test("cancellation is refused once executing", () => {
  seed("r2");
  requestApproval("r2", null);
  assert.equal(beginExecuting("r2"), true);
  assert.equal(cancelProposal("r2"), false, "no cancel from executing");
  assert.equal(finishExecuting("r2", "executed", "W-99", "res-1"), true);
  const row = getProposal("r2")!;
  assert.equal(row.status, "executed");
  assert.equal(row.resultWorklogId, "W-99");
});

test("a re-run preserves user-edited and dropped rows by id", () => {
  seed("r3");
  markUserEdited("r3", { durationSeconds: 1800 });
  // Collection re-runs and re-proposes the same row id with fresh values.
  const after = upsertProposal({
    id: "r3",
    date: DATE,
    issueKey: "WEB-1",
    durationSeconds: 3600,
  });
  assert.equal(
    after.status,
    "user-edited",
    "the user's edit survives the re-run",
  );
  assert.equal(
    after.durationSeconds,
    1800,
    "user value preserved, not overwritten",
  );
});

test("dropping a row makes it non-executable (proactive invalidation wins from pending)", () => {
  seed("r4");
  requestApproval("r4", null);
  assert.equal(cancelProposal("r4"), true);
  assert.equal(
    beginExecuting("r4"),
    false,
    "a cancelled row can never execute",
  );
  assert.equal(getProposal("r4")?.status, "cancelled");
});

test("declining a row is terminal, refused once executing, and preserved by a re-run (Task 144)", () => {
  seed("d1");
  requestApproval("d1", null);
  assert.equal(
    declineProposal("d1"),
    true,
    "decline wins from pending-approval",
  );
  assert.equal(beginExecuting("d1"), false, "a declined row can never execute");
  assert.equal(getProposal("d1")?.status, "declined");
  // A later collection re-run must not re-propose a declined row.
  const after = upsertProposal({
    id: "d1",
    date: DATE,
    issueKey: "WEB-1",
    durationSeconds: 7200,
  });
  assert.equal(after.status, "declined", "declined survives the re-run");
  assert.equal(
    after.durationSeconds,
    3600,
    "declined row values are not clobbered",
  );

  // Decline is refused once executing (an external Tempo write may be in flight).
  seed("d2");
  requestApproval("d2", null);
  assert.equal(beginExecuting("d2"), true);
  assert.equal(declineProposal("d2"), false, "no decline from executing");
});

test("reconcile matches by durable clientId first, then field-tuple fallback", () => {
  const rows: TempoProposalRow[] = [
    {
      ...seed("A"),
      issueKey: "WEB-1",
      startTime: "09:00",
      durationSeconds: 3600,
    },
    upsertProposal({
      id: "B",
      date: DATE,
      issueKey: "WEB-2",
      startTime: "11:00",
      durationSeconds: 1800,
    }),
  ];
  const worklogs: ObservedWorklog[] = [
    {
      worklogId: "W-A",
      clientId: "A",
      issueKey: "WEB-1",
      date: DATE,
      startTime: "09:00",
      durationSeconds: 3600,
    },
    {
      worklogId: "W-B",
      issueKey: "WEB-2",
      date: DATE,
      startTime: "11:00",
      durationSeconds: 1800,
    }, // no clientId echoed
  ];
  const matches = reconcileAgainstWorklogs(rows, worklogs);
  assert.deepEqual(
    matches.find((m) => m.rowId === "A"),
    { rowId: "A", worklogId: "W-A", via: "clientId" },
  );
  assert.deepEqual(
    matches.find((m) => m.rowId === "B"),
    { rowId: "B", worklogId: "W-B", via: "field-tuple" },
  );
});

test("projection hides dropped/cancelled rows and totals the rest", () => {
  seed("r5");
  const md = renderTempoPlan([
    getProposal("r5")!,
    { ...getProposal("r5")!, id: "r6", status: "cancelled" },
  ]);
  assert.match(md, /WEB-1/);
  assert.match(md, /Total: 1h/);
  assert.equal(md.split("WEB-1").length - 1, 1, "cancelled row not rendered");
});
