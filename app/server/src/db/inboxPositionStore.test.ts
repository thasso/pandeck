/**
 * The manual Sessions inbox order (0075, 0086): a drop's positions reach the
 * session, run and Initiative rows, all of them or none, and never move
 * `updatedAt` or an Initiative's attention.
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
const {
  createInitiative,
  initiativeRevisionIndex,
  readInitiative,
  settleInitiative,
  subscribeInitiativeChanges,
  updateInitiative,
} = await import("../initiatives.ts");
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

function revisionOf(id: number): number {
  return initiativeRevisionIndex().get(String(id))?.revision ?? -1;
}

function newInitiative(title: string): number {
  return createInitiative({ title }).initiative.id;
}

test("a mixed drop places a session, a run and Initiatives in one write, without waking them", () => {
  newSession("mixed-session");
  const run = newRun();
  const settled = newInitiative("Mixed settled");
  const raised = newInitiative("Mixed raised");
  settleInitiative(String(settled), 1);
  const before = {
    settled: {
      ...readInitiative(String(settled))!,
      revision: revisionOf(settled),
    },
    raised: {
      ...readInitiative(String(raised))!,
      revision: revisionOf(raised),
    },
  };
  const heard: string[] = [];
  const stop = subscribeInitiativeChanges((ids) => heard.push(...ids));
  try {
    assert.equal(
      setInboxPositions({
        sessions: [{ id: "mixed-session", position: 30 }],
        runs: [{ id: run.id, position: 20 }],
        initiatives: [
          { id: settled, position: 10 },
          { id: raised, position: 40 },
        ],
      }),
      true,
    );
  } finally {
    stop();
  }
  assert.deepEqual(heard.sort(), [String(settled), String(raised)].sort());
  assert.equal(sessionStore.get("mixed-session")?.inboxPosition, 30);
  assert.equal(
    workflowRunSummaryOf(workflowStore.getRun(run.id)!).inboxPosition,
    20,
  );
  for (const [key, id, position] of [
    ["settled", settled, 10],
    ["raised", raised, 40],
  ] as const) {
    const after = readInitiative(String(id))!;
    assert.equal(after.inboxPosition, position);
    assert.deepEqual(
      after.attention,
      before[key].attention,
      "placing is not activity",
    );
    assert.equal(after.updatedAt, before[key].updatedAt);
    assert.ok(
      revisionOf(id) > before[key].revision,
      "the placement is an event",
    );
  }

  // Activity later keeps the position the user gave the card.
  updateInitiative(String(settled), { title: "Mixed settled, renamed" });
  const woken = readInitiative(String(settled))!;
  assert.equal(woken.inboxPosition, 10);
  assert.ok(woken.attention!.revision > woken.attention!.settledRevision);
});

test("one missing Initiative refuses the whole mixed drop, and notifies nobody", () => {
  newSession("mixed-kept-session");
  const run = newRun();
  const kept = newInitiative("Mixed kept");
  setInboxPositions({
    sessions: [{ id: "mixed-kept-session", position: 1 }],
    runs: [{ id: run.id, position: 2 }],
    initiatives: [{ id: kept, position: 3 }],
  });
  const revision = revisionOf(kept);
  const heard: string[] = [];
  const stop = subscribeInitiativeChanges((ids) => heard.push(...ids));
  try {
    assert.equal(
      setInboxPositions({
        sessions: [{ id: "mixed-kept-session", position: 11 }],
        runs: [{ id: run.id, position: 12 }],
        initiatives: [
          { id: kept, position: 13 },
          { id: 999_999, position: 14 },
        ],
      }),
      false,
    );
  } finally {
    stop();
  }
  assert.deepEqual(heard, []);
  assert.equal(sessionStore.get("mixed-kept-session")?.inboxPosition, 1);
  assert.equal(
    workflowRunSummaryOf(workflowStore.getRun(run.id)!).inboxPosition,
    2,
  );
  assert.equal(readInitiative(String(kept))!.inboxPosition, 3);
  assert.equal(revisionOf(kept), revision);
});

test("the command's Initiative entries join the placement, and a bad id refuses it", () => {
  assert.deepEqual(
    parseInboxPlacement([
      { kind: "initiative", id: "7", position: 1 },
      { kind: "session", id: "a", position: 2 },
    ]),
    {
      sessions: [{ id: "a", position: 2 }],
      runs: [],
      initiatives: [{ id: 7, position: 1 }],
    },
  );
  assert.deepEqual(
    parseInboxPlacement([{ kind: "initiative", id: "x", position: 1 }]),
    { error: 'Initiative "x" does not exist' },
  );
});
