import assert from "node:assert/strict";
import { test } from "vitest";
import { validateClientMessage } from "./validateClientMessage.ts";

/**
 * `settleSession` must STATE what the clicked row showed (Task-674). The
 * revision is required at the wire, not defaulted: `sessionStore.setSettled`
 * reads an absent one as "acknowledge whatever the server holds now", which is
 * a privilege only a server-side settlement may take — a client that simply
 * omitted the field would be able to hide an outcome it never rendered.
 *   pnpm --filter @assistant/server test src/settleSessionMessage.test.ts
 */
test("settleSession requires the observed attention revision", () => {
  assert.equal(
    validateClientMessage({
      type: "settleSession",
      id: "s-1",
      throughRevision: 0,
    }).ok,
    true,
    "a row that never had an outcome observed revision 0",
  );
  assert.equal(
    validateClientMessage({
      type: "settleSession",
      id: "s-1",
      settled: false,
      throughRevision: 4,
    }).ok,
    true,
    "unsettling carries it too, so one shape covers both directions",
  );

  assert.equal(
    validateClientMessage({ type: "settleSession", id: "s-1" }).ok,
    false,
    "omitting it is refused rather than treated as an unbounded acknowledgement",
  );
});

test("settleSession refuses a revision that is not a count", () => {
  for (const throughRevision of [-1, 1.5, "2", null, Number.NaN, Infinity]) {
    assert.equal(
      validateClientMessage({
        type: "settleSession",
        id: "s-1",
        throughRevision,
      }).ok,
      false,
      `${String(throughRevision)} is not a revision`,
    );
  }
});

/** The same contract for a Workflow Run's Settle (Task-677). */
test("settleWorkflowRun requires the observed attention revision", () => {
  assert.equal(
    validateClientMessage({
      type: "settleWorkflowRun",
      runId: "12",
      throughRevision: 0,
    }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({ type: "settleWorkflowRun", runId: "12" }).ok,
    false,
    "omitting it is refused rather than treated as an unbounded acknowledgement",
  );
  assert.equal(
    validateClientMessage({
      type: "settleWorkflowRun",
      runId: "12",
      throughRevision: -1,
    }).ok,
    false,
  );
});
