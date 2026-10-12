/**
 * The manual Sessions inbox order (0075): a drop's positions reach the
 * session and run rows, all of them or none, and never move `updatedAt`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "inbox-position-test-"));
process.env.ASSISTANT_CWD = tmp;

const { setInboxPositions } = await import("./inboxPositionStore.ts");
const { sessionStore } = await import("./sessionStore.ts");
const workflowStore = await import("./workflowStore.ts");
const { workflowRunSummaryOf } = await import("../workflowRuns.ts");
const { parseInboxPlacement } = await import("../inboxPositions.ts");
const { closeDb } = await import("./index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function newSession(id: string) {
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    createdAt: 1_000,
    updatedAt: 2_000,
    messageCount: 2,
  });
}

function newRun() {
  return workflowStore.createRun({
    taskId: 1,
    recipeId: "code-delivery",
    recipeVersion: 1,
    maxIterations: 2,
    maxReviewPasses: 1,
    actor: { kind: "user" },
  });
}

test("a session and a run take their dragged positions together", () => {
  newSession("placed-session");
  const run = newRun();
  assert.equal(sessionStore.get("placed-session")?.inboxPosition, undefined);
  assert.equal(workflowRunSummaryOf(run).inboxPosition, undefined);

  assert.equal(
    setInboxPositions({
      sessions: [{ id: "placed-session", position: 1_500.25 }],
      runs: [{ id: run.id, position: 1_200.5 }],
    }),
    true,
  );
  const stored = sessionStore.get("placed-session");
  assert.equal(stored?.inboxPosition, 1_500.25);
  assert.equal(stored?.updatedAt, 2_000, "placing a card is not activity");
  const placedRun = workflowStore.getRun(run.id)!;
  assert.equal(workflowRunSummaryOf(placedRun).inboxPosition, 1_200.5);
  assert.equal(placedRun.updatedAt, run.updatedAt);
});

test("one missing row refuses the whole placement", () => {
  newSession("kept-session");
  setInboxPositions({
    sessions: [{ id: "kept-session", position: 10 }],
    runs: [],
  });
  assert.equal(
    setInboxPositions({
      sessions: [
        { id: "kept-session", position: 20 },
        { id: "never-existed", position: 30 },
      ],
      runs: [],
    }),
    false,
  );
  assert.equal(sessionStore.get("kept-session")?.inboxPosition, 10);

  assert.equal(
    setInboxPositions({
      sessions: [{ id: "kept-session", position: 40 }],
      runs: [{ id: 999_999, position: 50 }],
    }),
    false,
  );
  assert.equal(sessionStore.get("kept-session")?.inboxPosition, 10);
});

test("a metadata upsert leaves the dragged position alone", () => {
  newSession("upserted-session");
  setInboxPositions({
    sessions: [{ id: "upserted-session", position: 77 }],
    runs: [],
  });
  sessionStore.upsert({
    id: "upserted-session",
    harness: "pi",
    agentType: "assistant",
    title: "Renamed",
    updatedAt: 3_000,
  });
  assert.equal(sessionStore.get("upserted-session")?.inboxPosition, 77);
});

test("the command's entries become one placement, the last entry winning", () => {
  assert.deepEqual(
    parseInboxPlacement([
      { kind: "session", id: "a", position: 1 },
      { kind: "run", runId: "12", position: 2 },
      { kind: "session", id: "a", position: 3 },
    ]),
    {
      sessions: [{ id: "a", position: 3 }],
      runs: [{ id: 12, position: 2 }],
    },
  );
  assert.deepEqual(
    parseInboxPlacement([{ kind: "run", runId: "r1", position: 2 }]),
    { error: 'workflow run "r1" does not exist' },
  );
});
