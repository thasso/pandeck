import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

const { DATA_DIR } = await import("./config.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { writeClaudeSdkRecord } =
  await import("./claudeSdk/claudeSdkRecords.ts");
const { linkSessionToObject } = await import("./db/sessionObjectStore.ts");
const {
  eagerTaskToolCosts,
  lifecycleStepsOf,
  measureTaskOverhead,
  PLANNING_EAGER_TASK_BYTES,
} = await import("./taskOverhead.ts");

const BEFORE_MS = Date.parse("2026-07-01T00:00:00Z");
const AFTER_MS = Date.parse("2026-09-01T00:00:00Z");

/** A pi assistant message: one provider call, with its own usage. */
function piCall(
  toolCalls: { name: string; arguments?: unknown }[],
  usage: { input: number; cacheRead?: number; cacheWrite?: number },
): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      usage: { cacheRead: 0, cacheWrite: 0, ...usage },
      content: toolCalls.map((call) => ({ type: "toolCall", ...call })),
    },
  });
}

function writePiSession(
  id: string,
  createdAtMs: number,
  lines: string[],
): void {
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    createdAt: createdAtMs,
    updatedAt: createdAtMs,
  });
  const dir = join(DATA_DIR, "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "native.jsonl"), `${lines.join("\n")}\n`);
}

test("a bookkeeping-only turn is charged one round trip and its continuation's input", () => {
  const id = `overhead-pi-${Date.now()}`;
  writePiSession(id, BEFORE_MS, [
    // Real work: a Task call riding along costs no extra round trip.
    piCall(
      [
        { name: "bash", arguments: { command: "ls" } },
        { name: "task_read", arguments: { id: "42" } },
      ],
      { input: 100 },
    ),
    piCall([], { input: 200 }),
    // Bookkeeping only: this turn bought the call below and nothing else.
    piCall(
      [
        {
          name: "task_manage",
          arguments: {
            operations: [{ operation: "update", id: "42", status: "done" }],
          },
        },
      ],
      { input: 300 },
    ),
    piCall([], { input: 400, cacheRead: 1_000, cacheWrite: 50 }),
  ]);
  linkSessionToObject(id, "task", "42", "initial-context");

  const report = measureTaskOverhead({
    beforeEndMs: BEFORE_MS + 1,
    afterStartMs: AFTER_MS,
    claudeProjectsDir: "",
  });
  const session = report.sessions.find((s) => s.sessionId === id);
  assert.ok(session, "the pi session was measured");
  assert.equal(session.source, "pi-native");
  assert.equal(session.providerCalls, 4);
  assert.equal(session.taskCalls, 2);
  assert.equal(session.bookkeepingRoundTrips, 1);
  assert.equal(session.processedInputTokens, 400 + 1_000 + 50);
  assert.equal(session.newInputTokens, 400 + 50);
  assert.equal(session.attributedContinuations, 1);
  assert.equal(session.taskAttached, true);
  assert.equal(session.attachedTaskId, "42");
  assert.equal(session.attachedTaskReads, 1);
  assert.equal(session.lifecycle.read, 1);
  assert.equal(session.lifecycle.done, 1);
});

test("Task calls before the first real tool call are the pre-work opening", () => {
  const id = `overhead-prework-${Date.now()}`;
  writePiSession(id, BEFORE_MS, [
    piCall([{ name: "task_read", arguments: { id: "7" } }], { input: 10 }),
    piCall([{ name: "task_read", arguments: { id: "7", comments: {} } }], {
      input: 20,
    }),
    piCall([{ name: "bash", arguments: { command: "ls" } }], { input: 30 }),
    piCall([{ name: "task_read", arguments: { id: "9" } }], { input: 40 }),
    piCall([], { input: 50 }),
  ]);
  linkSessionToObject(id, "task", "7", "initial-context");

  const report = measureTaskOverhead({
    beforeEndMs: BEFORE_MS + 1,
    afterStartMs: AFTER_MS,
    claudeProjectsDir: "",
  });
  const session = report.sessions.find((s) => s.sessionId === id);
  assert.ok(session);
  assert.equal(session.preWorkTaskCalls, 2);
  // Only the reads naming the attached Task itself, not the research read.
  assert.equal(session.attachedTaskReads, 2);
  assert.equal(session.taskCalls, 3);
  assert.equal(session.bookkeepingRoundTrips, 3);
});

for (const format of ["legacy", "split"] as const)
  test(`a ${format} Claude store session contributes calls but never a guessed round trip`, () => {
    const id = `overhead-claude-${format}-${Date.now()}`;
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      title: id,
      createdAt: BEFORE_MS,
      updatedAt: BEFORE_MS,
      providerSessionId: `${id}-provider`,
    });
    const entries = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "mcp__pa__task_read",
            input: { id: "5" },
          },
          { type: "toolCall", name: "Bash", input: { command: "ls" } },
        ],
      },
    ];
    const dir = join(DATA_DIR, "claude-sdk");
    mkdirSync(dir, { recursive: true });
    if (format === "legacy")
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, entries }));
    else
      writeClaudeSdkRecord(
        dir,
        { id, title: id, createdAt: BEFORE_MS, updatedAt: BEFORE_MS },
        entries as never,
        undefined,
      );
    linkSessionToObject(id, "task", "5", "initial-context");

    const report = measureTaskOverhead({
      beforeEndMs: BEFORE_MS + 1,
      afterStartMs: AFTER_MS,
      claudeProjectsDir: "",
    });
    const session = report.sessions.find((s) => s.sessionId === id);
    assert.ok(session);
    assert.equal(session.source, "claude-store");
    assert.equal(session.taskCalls, 1);
    assert.equal(session.attachedTaskReads, 1);
    assert.equal(session.providerCalls, undefined);
    assert.equal(session.bookkeepingRoundTrips, undefined);
    assert.equal(session.preWorkTaskCalls, undefined);

    const before = report.windows.find((w) => w.window === "before");
    assert.ok(before);
    // It counts toward the call cohort and not toward the round-trip cohort.
    assert.ok(
      before.taskAttachedSessions > before.perAttachedSession.measuredSessions,
    );
  });

test("a batched closeout is one call carrying several lifecycle steps", () => {
  const steps = lifecycleStepsOf("task_manage", {
    operations: [
      {
        operation: "update",
        id: "42",
        status: "done",
        descriptionEdits: [{ oldText: "a", newText: "b" }],
        comment: "shipped",
      },
    ],
  });
  assert.deepEqual([...steps].sort(), ["comment", "describe", "done"]);
  assert.deepEqual(lifecycleStepsOf("mcp__pa__task_read", { id: "1" }), [
    "read",
  ]);
  assert.deepEqual(lifecycleStepsOf("task_comment", { taskId: "1" }), [
    "comment",
  ]);
  assert.deepEqual(lifecycleStepsOf("task_workflow_read", {}), ["workflow"]);
  assert.deepEqual(
    lifecycleStepsOf("task_manage", {
      operations: [{ operation: "update", id: "1", status: "todo" }],
    }),
    ["handback"],
  );
});

test("the eager Task tool block is measured per harness against the baseline", () => {
  const rows = eagerTaskToolCosts("developer");
  const names = new Set(rows.map((row) => row.tool));
  assert.deepEqual([...names].sort(), ["task_manage", "task_read"]);
  const total = (harness: "pi" | "claude"): number =>
    rows
      .filter((row) => row.harness === harness)
      .reduce((n, row) => n + row.chars, 0);
  // Claude pays the `mcp__pa__` prefix on every wire name and nothing else.
  assert.equal(total("claude") - total("pi"), "mcp__pa__".length * names.size);
  assert.ok(
    total("pi") < PLANNING_EAGER_TASK_BYTES,
    `eager Task tools grew past the planning baseline: ${total("pi")}`,
  );
});
