/**
 * Task 99: adaptive observation scheduling + maintenance. Isolated temp DB, fake
 * clocks, injected fake processor runner (no provider calls).
 *   pnpm --filter @assistant/server test src/memory/memoryScheduler.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "memory-scheduler-test-"));
process.env.ASSISTANT_CWD = tmp;

const sched = await import("./memoryScheduler.ts");
const proc = await import("./memoryProcessor.ts");
const svc = await import("./memoryService.ts");
const { memoryObservationStore } =
  await import("../db/memoryObservationStore.ts");
const { memoryStore } = await import("../db/memoryStore.ts");
const { updateSettings, getSettings } = await import("../settings.ts");
const { getDb, closeDb } = await import("../db/index.ts");

let nowMs = 1_700_000_000_000;
sched.setMemorySchedulerClockForTests(() => nowMs);
proc.setMemoryProcessorClockForTests(() => nowMs);
svc.setMemoryClockForTests(() => nowMs);

let runCalls = 0;
proc.setMemoryProcessorRunnerForTests({
  run: async () => {
    runCalls += 1;
    return { text: JSON.stringify({ operations: [] }) };
  },
});

async function settle(): Promise<void> {
  // let the fire-and-forget flush promises resolve.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function setMode(mode: "off" | "adaptive" | "every-turn"): void {
  updateSettings({
    memory: {
      ...getSettings().memory,
      loadingEnabled: true,
      learningMode: mode,
    },
  });
}

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM memory_cards");
  db.exec("DELETE FROM memory_observations");
  db.exec("DELETE FROM memory_processor_runs");
  nowMs = 1_700_000_000_000;
  runCalls = 0;
  setMode("adaptive");
});

afterAll(() => {
  sched.setMemorySchedulerClockForTests(() => Date.now());
  proc.resetMemoryProcessorRunnerForTests();
  proc.resetMemoryProcessorClockForTests();
  svc.resetMemoryClockForTests();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("ordinary adaptive turns do not cause a per-turn processor call", async () => {
  for (let i = 0; i < 3; i += 1) {
    sched.memoryScheduler.observeTurn({
      sessionId: "s1",
      userTurnId: `t${i}`,
      persona: "assistant",
      humanText: `just a normal question ${i}`,
    });
  }
  await settle();
  assert.equal(
    runCalls,
    0,
    "low-signal adaptive turns batch, no immediate call",
  );
  assert.equal(
    memoryObservationStore.pendingCount(),
    3,
    "observations enqueued",
  );
});

test("high-signal adaptive turns process promptly", async () => {
  sched.memoryScheduler.observeTurn({
    sessionId: "s1",
    userTurnId: "t-hs",
    persona: "personal-assistant",
    humanText: "Please remember that I prefer dark mode",
  });
  await settle();
  assert.equal(runCalls, 1, "high-signal triggers an immediate flush");
});

test("adaptive batches flush at the turn threshold", async () => {
  for (let i = 0; i < 5; i += 1) {
    sched.memoryScheduler.observeTurn({
      sessionId: "s1",
      userTurnId: `b${i}`,
      persona: "assistant",
      humanText: `neutral statement ${i}`,
    });
  }
  await settle();
  assert.equal(runCalls, 1, "reaching the threshold flushes once");
});

test("off mode enqueues nothing and never calls the processor", async () => {
  setMode("off");
  sched.memoryScheduler.observeTurn({
    sessionId: "s1",
    userTurnId: "o1",
    persona: "assistant",
    humanText: "please remember I like tea",
  });
  await settle();
  assert.equal(runCalls, 0);
  assert.equal(
    memoryObservationStore.pendingCount(),
    0,
    "off retains no observation text",
  );
});

test("every-turn processes each eligible exchange", async () => {
  setMode("every-turn");
  for (let i = 0; i < 3; i += 1) {
    sched.memoryScheduler.observeTurn({
      sessionId: "s1",
      userTurnId: `e${i}`,
      persona: "assistant",
      humanText: `neutral ${i}`,
    });
    await settle();
  }
  assert.equal(runCalls, 3, "one bounded run per eligible exchange");
});

test("observeTurn scopes to a Task-derived project (no standalone session→project link) (exchange 13)", async () => {
  const { createTask, linkSessionToTask } = await import("../tasks.ts");
  const task = createTask({
    title: "Ship the memory epic",
    projectId: "acme",
    source: { createdBy: "user" },
  });
  linkSessionToTask(task.id, {
    sessionId: "s-task-derived",
    origin: "task-start",
  });

  sched.memoryScheduler.observeTurn({
    sessionId: "s-task-derived",
    userTurnId: "td1",
    persona: "personal-assistant",
    humanText: "just a normal note",
  });
  const obs = memoryObservationStore.find("s-task-derived", "td1");
  assert.equal(
    obs?.projectId,
    "acme",
    "the observation was scoped via the shared resolveSessionProject, not a direct sessionProjectOf lookup",
  );
});

test("Developer/Workshop ordinary turns enqueue nothing", async () => {
  sched.memoryScheduler.observeTurn({
    sessionId: "s1",
    userTurnId: "d1",
    persona: "developer",
    humanText: "please remember to use tabs",
  });
  sched.memoryScheduler.observeTurn({
    sessionId: "s1",
    userTurnId: "w1",
    persona: "workshop",
    humanText: "always prefer this pattern",
  });
  await settle();
  assert.equal(
    memoryObservationStore.pendingCount(),
    0,
    "coding personas are not capture-eligible",
  );
  assert.equal(runCalls, 0);
});

test("budget exhaustion defers work until reset rather than dropping it", async () => {
  setMode("every-turn");
  // Drain the 12/hr ceiling.
  for (let i = 0; i < 12; i += 1) {
    sched.memoryScheduler.observeTurn({
      sessionId: "s1",
      userTurnId: `x${i}`,
      persona: "assistant",
      humanText: `neutral fact ${i}`,
    });
    await settle();
  }
  assert.equal(runCalls, 12, "ceiling number of runs");
  // The 13th turn's flush is blocked before the runner and the observation is deferred.
  sched.memoryScheduler.observeTurn({
    sessionId: "s1",
    userTurnId: "x-over",
    persona: "assistant",
    humanText: "one more",
  });
  await settle();
  assert.equal(runCalls, 12, "runner not invoked once the ceiling is reached");
  assert.ok(
    memoryObservationStore.pendingCount() >= 1,
    "deferred observation stays pending (not dropped)",
  );
});

test("expiry runs even with the processor disabled or capped", () => {
  const day = 86_400_000;
  memoryStore.insert({
    id: "mem_exp",
    text: "In Tokyo this week",
    kind: "working",
    scope: {},
    temporal: { mode: "window", validUntilMs: nowMs - 1 },
    observedAtMs: nowMs,
    createdAt: nowMs,
    updatedAt: nowMs,
    sourceKind: "manual",
  });
  memoryStore.insert({
    id: "mem_keep",
    text: "Prefers metric",
    kind: "preference",
    scope: {},
    temporal: { mode: "persistent" },
    observedAtMs: nowMs,
    createdAt: nowMs,
    updatedAt: nowMs,
    sourceKind: "manual",
  });
  const result = sched.memoryScheduler.runMaintenance(nowMs + day);
  assert.equal(
    result.expired,
    1,
    "deterministic expiry archived the ended window",
  );
  assert.equal(memoryStore.get("mem_exp")!.state, "archived");
  assert.equal(memoryStore.get("mem_keep")!.state, "active");
});

test("recover returns stale processing claims to pending", () => {
  const obs = memoryObservationStore.enqueue({
    sessionId: "s1",
    userTurnId: "r1",
    humanText: "x",
    sourceTimestampMs: nowMs,
    timezone: "UTC",
    createdAt: nowMs,
  });
  memoryObservationStore.claim([obs.id], nowMs - 20 * 60_000); // claimed 20 min ago
  const recovered = sched.memoryScheduler.recover(nowMs);
  assert.equal(recovered, 1);
  assert.equal(memoryObservationStore.get(obs.id)!.state, "pending");
});
