import assert from "node:assert/strict";
import { test } from "vitest";
import { validateClientMessage } from "./validateClientMessage.ts";

for (const type of [
  "resumeWorkflowRun",
  "cancelWorkflowRun",
  "retryWorkflowRun",
  "rebaseAndReviewWorkflowRun",
] as const) {
  test(`${type} requires a string run id`, () => {
    assert.equal(validateClientMessage({ type, runId: "7" }).ok, true);
    assert.equal(validateClientMessage({ type, runId: 7 }).ok, false);
    assert.equal(validateClientMessage({ type }).ok, false);
  });
}

test("deleteWorkflowRun requires explicit boolean cleanup choices", () => {
  assert.equal(
    validateClientMessage({
      type: "deleteWorkflowRun",
      runId: "7",
      deleteWorktree: true,
      archiveSessions: false,
    }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({ type: "deleteWorkflowRun", runId: "7" }).ok,
    false,
  );
  assert.equal(
    validateClientMessage({
      type: "deleteWorkflowRun",
      runId: "7",
      deleteWorktree: "yes",
      archiveSessions: false,
    }).ok,
    false,
  );
});

test("pauseWorkflowRun accepts only an optional string reason", () => {
  assert.equal(
    validateClientMessage({ type: "pauseWorkflowRun", runId: "7" }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({
      type: "pauseWorkflowRun",
      runId: "7",
      reason: "look first",
    }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({
      type: "pauseWorkflowRun",
      runId: "7",
      reason: 1,
    }).ok,
    false,
  );
});
