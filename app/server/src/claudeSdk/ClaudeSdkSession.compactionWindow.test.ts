/**
 * The Claude compaction window (`docs/compaction-window.md`): a query starts
 * with the stored window, a running or retained process keeps the window it
 * started with (nothing is sent live), the next start applies a change, and
 * the agent's lowering checks run against the running process, known in its
 * own epoch, and against what the next process would use.
 *   pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.compactionWindow.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type {
  ClaudeQuery,
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";

const dataDir = mkdtempSync(join(tmpdir(), "claude-compaction-window-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { ClaudeSdkSession } = await import("../test/claudeSdkSession.ts");
const { CLAUDE_AUTO_COMPACT_WINDOW_ENV } = await import("./options.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { backgroundWorkStore } = await import("../db/backgroundWorkStore.ts");
const { updateSettings } = await import("../settings.ts");
const { sessionSkills } = await import("../sessionSkills.ts");
const { inProcessWorkerEnginesForTests } =
  await import("../workers/inProcessWorker.ts");

const ENV_BEFORE = process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV];
afterEach(() => {
  vi.useRealTimers();
  if (ENV_BEFORE === undefined)
    delete process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV];
  else process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV] = ENV_BEFORE;
});

class OutputQueue implements AsyncIterable<ClaudeSdkMessage> {
  private readonly values: ClaudeSdkMessage[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<ClaudeSdkMessage>) => void
  > = [];
  private closed = false;

  emit(message: ClaudeSdkMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.values.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type Usage = Awaited<ReturnType<NonNullable<ClaudeQuery["getContextUsage"]>>>;

/**
 * A query whose threshold follows its START settings only, like the CLI:
 * `applyFlagSettings` is recorded and has no effect. `summary` intercepts the
 * agent path's summary reads only; the result-time refresh is never held.
 */
class FakeQuery implements ClaudeQuery {
  readonly output = new OutputQueue();
  readonly inputs: ClaudeSdkUserMessage[] = [];
  readonly flagCalls: Record<string, unknown>[] = [];
  readonly usageReads: string[] = [];
  enabled = true;
  closeCalls = 0;
  summary?: (usage: Usage) => Promise<Usage>;

  constructor(readonly params: ClaudeQueryParams) {
    void this.consumeInput();
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return this.output[Symbol.asyncIterator]();
  }

  close(): void {
    this.closeCalls += 1;
    this.output.close();
  }

  async interrupt(): Promise<void> {}
  async stopTask(): Promise<void> {}

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    this.flagCalls.push(settings);
  }

  async getContextUsage(opts?: { detail?: "summary" | "full" }) {
    const detail = opts?.detail ?? "full";
    this.usageReads.push(detail);
    const settings = this.params.options?.settings as
      { autoCompactWindow?: number } | undefined;
    const window = Math.min(
      settings?.autoCompactWindow ?? 1_000_000,
      1_000_000,
    );
    const usage: Usage = {
      mcpTools: [],
      autoCompactThreshold: window - 33_000,
      isAutoCompactEnabled: this.enabled,
    };
    return detail === "summary" && this.summary ? this.summary(usage) : usage;
  }

  private async consumeInput(): Promise<void> {
    if (typeof this.params.prompt === "string") return;
    for await (const message of this.params.prompt) this.inputs.push(message);
  }
}

function result(uuid: string): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "provider-window",
    uuid,
    is_error: false,
    result: "done",
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: {},
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    stop_reason: null,
  } as unknown as ClaudeSdkMessage;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

let serial = 0;
function makeHarness(stored?: number) {
  serial += 1;
  const id = `claude-window-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
  });
  if (stored !== undefined) sessionStore.setCompactionWindow(id, stored);
  const queries: FakeQuery[] = [];
  const seam: ClaudeSdkSeam = {
    query(params) {
      const query = new FakeQuery(params);
      queries.push(query);
      return query;
    },
  };
  const make = () =>
    new ClaudeSdkSession(id, {
      seam: async () => seam,
      agentType: "developer",
      modelId: "opus",
      providerSessionId: "provider-window",
    });
  return { id, session: make(), make, queries };
}

/** A harness whose first turn is running, and a recording `persist`. */
async function midTurn(stored?: number) {
  const harness = makeHarness(stored);
  const adapter = harness.session.createRuntimeAdapter();
  const turn = adapter.prompt("hello");
  await until(() => harness.queries.length === 1);
  const persisted: number[] = [];
  const persist = (tokens: number) => {
    persisted.push(tokens);
    sessionStore.setCompactionWindow(harness.id, tokens);
  };
  return {
    ...harness,
    adapter,
    turn,
    query: harness.queries[0]!,
    persisted,
    persist,
  };
}

/** Starts a background shell in the running turn, so its process is kept. */
async function startBackgroundShell(query: FakeQuery): Promise<void> {
  const pre = query.params.options?.hooks?.PreToolUse?.[0]?.hooks[0];
  assert.ok(pre);
  await pre(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-window",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 300", run_in_background: true },
      tool_use_id: "tool-bg-1",
    },
    "tool-bg-1",
    { signal: new AbortController().signal },
  );
  query.output.emit({
    type: "system",
    subtype: "task_started",
    task_id: "vendor-1",
    tool_use_id: "tool-bg-1",
    description: "sleep",
    task_type: "shell",
    uuid: "started-1",
    session_id: "provider-window",
  } as unknown as ClaudeSdkMessage);
}

function completeBackgroundShell(query: FakeQuery): void {
  query.output.emit({
    type: "system",
    subtype: "task_notification",
    task_id: "vendor-1",
    tool_use_id: "tool-bg-1",
    status: "completed",
    output_file: "",
    summary: "done",
    uuid: "completed-1",
    session_id: "provider-window",
  } as unknown as ClaudeSdkMessage);
}

async function retainedWindow(stored?: number) {
  enableBackgroundWork();
  const harness = await midTurn(stored);
  await startBackgroundShell(harness.query);
  harness.query.output.emit(result("retained-first"));
  await harness.turn;
  return harness;
}

async function disposeRetained(
  harness: Awaited<ReturnType<typeof retainedWindow>>,
) {
  vi.useRealTimers();
  if (harness.query.closeCalls > 0)
    await until(() => !backgroundWorkStore.hostForOwner(harness.id));
  harness.session.dispose();
}

async function storeWindow(
  harness: ReturnType<typeof makeHarness>,
  tokens: number | null,
) {
  sessionStore.setCompactionWindow(harness.id, tokens);
  return harness.session.applyCompactionWindow(tokens);
}

function enableBackgroundWork(): void {
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
}

const startWindow = (query: FakeQuery) =>
  (query.params.options?.settings as { autoCompactWindow?: number } | undefined)
    ?.autoCompactWindow;

const { buildSessionState } = await import("../sessionState.ts");

const window = (session: InstanceType<typeof ClaudeSdkSession>) =>
  buildSessionState(session.id, session.nativeFacts()).compactionWindow;

test("a query starts with the stored window and confirms it", async () => {
  const { session, queries } = makeHarness(200_000);
  assert.deepEqual(window(session), {
    applied: "pending",
    pendingReason: "next-turn",
    tokens: 200_000,
    range: { min: 100_000, max: 1_000_000 },
    effectiveTokens: 200_000,
  });
  const turn = session.createRuntimeAdapter().prompt("hello");
  await until(() => queries.length === 1);
  assert.equal(startWindow(queries[0]!), 200_000);
  assert.equal(window(session)?.applied, "confirmed");
  assert.equal(window(session)?.appliedTokens, 200_000);
  queries[0]!.output.emit(result("r1"));
  await turn;
  assert.equal(
    window(session)?.providerTrigger,
    167_000,
    "the last report is kept for the next start",
  );
  assert.equal(window(session)?.pendingReason, "next-turn");
  session.dispose();
});

test("a change during a running turn is stored, never sent, and applies at the next start", async () => {
  const { id, session, queries } = makeHarness();
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("first");
  await until(() => queries.length === 1);
  assert.equal(startWindow(queries[0]!), undefined);
  assert.equal(window(session)?.applied, "confirmed");
  assert.equal(window(session)?.appliedTokens, null);

  sessionStore.setCompactionWindow(id, 150_000);
  assert.deepEqual(await session.applyCompactionWindow(150_000), {
    pendingReason: "process-restart",
  });
  assert.equal(window(session)?.applied, "pending");
  assert.equal(window(session)?.pendingReason, "process-restart");
  queries[0]!.output.emit(result("r1"));
  await first;

  const second = adapter.prompt("second");
  await until(() => queries.length === 2);
  assert.equal(startWindow(queries[1]!), 150_000);
  assert.equal(window(session)?.applied, "confirmed");
  assert.equal(window(session)?.appliedTokens, 150_000);
  queries[1]!.output.emit(result("r2"));
  await second;
  assert.deepEqual(
    queries.flatMap((query) => query.flagCalls),
    [],
    "nothing reaches a running process",
  );
  session.dispose();
});

test("a background-retained process keeps its window across turns; a restart applies the stored one", async () => {
  enableBackgroundWork();
  const { id, session, make, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("start background work");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await startBackgroundShell(query);
  query.output.emit(result("r1"));
  await first;

  sessionStore.setCompactionWindow(id, 100_000);
  assert.deepEqual(await session.applyCompactionWindow(100_000), {
    pendingReason: "process-restart",
  });
  const second = adapter.prompt("status please");
  await until(() => query.inputs.length === 2);
  query.output.emit(result("r2"));
  await second;
  assert.equal(queries.length, 1, "the retained process took the turn");
  assert.equal(window(session)?.pendingReason, "process-restart");
  assert.equal(window(session)?.providerTrigger, 967_000);
  assert.deepEqual(query.flagCalls, []);
  session.dispose();

  // A restart (or resume) builds the next process from the row.
  const restarted = make();
  const third = restarted.createRuntimeAdapter().prompt("after restart");
  await until(() => queries.length === 2);
  assert.equal(startWindow(queries[1]!), 100_000);
  assert.equal(window(restarted)?.applied, "confirmed");
  queries[1]!.output.emit(result("r3"));
  await third;
  restarted.dispose();
});

test("a pending start-time setting closes immediately after the last task and the next turn starts fresh", async () => {
  const h = await retainedWindow();
  try {
    assert.deepEqual(await storeWindow(h, 100_000), {
      pendingReason: "process-restart",
    });
    assert.equal(
      h.query.closeCalls,
      0,
      "active background work keeps its host",
    );
    completeBackgroundShell(h.query);
    await until(() => h.query.closeCalls === 1);
    assert.equal(window(h.session)?.pendingReason, "next-turn");
    const next = h.adapter.prompt("use the stored window");
    await until(() => h.queries.length === 2);
    assert.equal(startWindow(h.queries[1]!), 100_000);
    assert.equal(window(h.session)?.applied, "confirmed");
    h.queries[1]!.output.emit(result("fresh-window"));
    await next;
    assert.equal(h.query.closeCalls, 1, "reentrant turn-end checks close once");
  } finally {
    await disposeRetained(h);
  }
});

test("last-task completion during a turn waits for that turn's boundary", async () => {
  const h = await retainedWindow();
  try {
    const next = h.adapter.prompt("still running");
    await until(() => h.query.inputs.length === 2);
    await storeWindow(h, 100_000);
    completeBackgroundShell(h.query);
    await until(
      () =>
        backgroundWorkStore.listItems({ ownerSessionId: h.id })[0]?.state ===
        "completed",
    );
    assert.equal(h.query.closeCalls, 0, "the open turn keeps the empty host");
    h.query.output.emit(result("running-finished"));
    await next;
    assert.equal(h.query.closeCalls, 1);
    assert.equal(window(h.session)?.pendingReason, "next-turn");
    assert.equal(h.queries.length, 1);
  } finally {
    await disposeRetained(h);
  }
});

test("a setting changed during empty-host grace cancels the timer and closes now", async () => {
  const h = await retainedWindow();
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    completeBackgroundShell(h.query);
    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(h.query.closeCalls, 0);
    assert.deepEqual(await storeWindow(h, 100_000), {
      pendingReason: "next-turn",
    });
    assert.equal(h.query.closeCalls, 1);
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(h.query.closeCalls, 1, "the old grace cannot close it twice");
    assert.equal(window(h.session)?.pendingReason, "next-turn");
  } finally {
    await disposeRetained(h);
  }
});

for (const revert of [false, true]) {
  test(`an empty host keeps frozen grace with ${revert ? "a setting reverted to its epoch value" : "no pending setting"}`, async () => {
    const h = await retainedWindow(200_000);
    try {
      if (revert) {
        await storeWindow(h, 100_000);
        assert.deepEqual(await storeWindow(h, 200_000), {});
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      completeBackgroundShell(h.query);
      await vi.advanceTimersByTimeAsync(29_999);
      assert.equal(h.query.closeCalls, 0);
      assert.equal(window(h.session)?.applied, "confirmed");
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(h.query.closeCalls, 1);
    } finally {
      await disposeRetained(h);
    }
  });
}

test("a restart does not skip missing-task reconciliation grace", async () => {
  const h = await retainedWindow();
  try {
    await storeWindow(h, 100_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.query.output.emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "missing-task",
      session_id: "provider-window",
    } as unknown as ClaudeSdkMessage);
    await vi.advanceTimersByTimeAsync(29_999);
    assert.equal(h.query.closeCalls, 0, "absence is not terminal evidence yet");
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(h.query.closeCalls, 1);
  } finally {
    await disposeRetained(h);
  }
});

test("a start-time change waits for retained compaction to finish", async () => {
  const h = await retainedWindow();
  try {
    completeBackgroundShell(h.query);
    const compact = h.session.compactContext();
    await until(() => h.query.inputs.length === 2);
    await storeWindow(h, 100_000);
    assert.equal(h.query.closeCalls, 0, "compaction keeps the process open");
    h.query.output.emit(result("compact-finished"));
    await compact;
    assert.equal(h.query.closeCalls, 1);
    assert.equal(window(h.session)?.pendingReason, "next-turn");
  } finally {
    await disposeRetained(h);
  }
});

test("a start-time change waits for a delayed Stop interrupt and closes when it settles", async () => {
  const h = await retainedWindow();
  const interrupted = deferred<void>();
  try {
    const next = h.adapter.prompt("stop this turn");
    await until(() => h.query.inputs.length === 2);
    h.query.interrupt = () => interrupted.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.session.abort();
    await next;
    completeBackgroundShell(h.query);
    await storeWindow(h, 100_000);
    // A timely acknowledgement arrives before the active Stop's four-second bound.
    await vi.advanceTimersByTimeAsync(3_999);
    assert.equal(h.query.closeCalls, 0, "Stop owns the process until its ack");
    interrupted.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(h.query.closeCalls, 1);
    assert.equal(window(h.session)?.pendingReason, "next-turn");
  } finally {
    interrupted.resolve(undefined);
    await disposeRetained(h);
  }
});

for (const pending of [false, true]) {
  test(`an unanswered Stop quarantines its empty host and retires it ${pending ? "for the pending restart" : "after ordinary grace"}`, async () => {
    await until(() => inProcessWorkerEnginesForTests() === 0);
    const h = await retainedWindow();
    const interrupted = deferred<void>();
    try {
      const next = h.adapter.prompt("Stop will not answer");
      await until(() => h.query.inputs.length === 2);
      h.query.interrupt = () => interrupted.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      h.session.abort();
      await next;
      h.query.output.emit(result("stopped-without-ack"));
      completeBackgroundShell(h.query);
      if (pending) await storeWindow(h, 100_000);
      await vi.advanceTimersByTimeAsync(3_999);
      assert.equal(h.query.closeCalls, 0, "an active Stop still owns the host");
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(h.query.closeCalls, pending ? 1 : 0);
      if (!pending) {
        await vi.advanceTimersByTimeAsync(29_999);
        assert.equal(
          h.query.closeCalls,
          0,
          "failed Stop still keeps normal grace",
        );
        await vi.advanceTimersByTimeAsync(1);
      }
      assert.equal(
        h.query.closeCalls,
        1,
        "unconfirmed Stop cannot retain an empty host forever",
      );
      assert.equal(window(h.session)?.pendingReason, "next-turn");
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(
        inProcessWorkerEnginesForTests(),
        0,
        "retirement releases the abandoned control's Worker engine",
      );
      vi.useRealTimers();
      const fresh = h.adapter.prompt("only a fresh process may take this");
      await until(() => h.queries.length === 2);
      assert.equal(startWindow(h.queries[1]!), pending ? 100_000 : undefined);
      interrupted.resolve(undefined);
      await Promise.resolve();
      assert.equal(
        h.queries[1]!.closeCalls,
        0,
        "old acknowledgement cannot close the fresh epoch",
      );
      h.queries[1]!.output.emit(result("fresh-after-unconfirmed-stop"));
      await fresh;
    } finally {
      interrupted.resolve(undefined);
      await disposeRetained(h);
    }
  });
}

test("a failed Stop keeps active work but refuses all new input on the quarantined epoch", async () => {
  const { runCompactForHost } = await import("../hostSlashCommands.ts");
  const h = await retainedWindow();
  const interrupted = deferred<void>();
  try {
    const next = h.adapter.prompt("Stop with active background work");
    await until(() => h.query.inputs.length === 2);
    h.query.interrupt = () => interrupted.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.session.abort();
    await next;
    h.query.output.emit(result("stopped-with-active-work"));
    await storeWindow(h, 100_000);
    await vi.advanceTimersByTimeAsync(999);
    const refused = h.adapter.prompt("must not reach the unconfirmed process");
    await vi.advanceTimersByTimeAsync(3_001);
    assert.equal(
      h.query.closeCalls,
      0,
      "background work outlives an unanswered Stop",
    );
    assert.equal(
      h.query.inputs.length,
      2,
      "no prompt reaches the quarantined CLI",
    );
    await refused;
    assert.equal(h.session.isRunning, false);
    vi.useRealTimers();
    await runCompactForHost(h.session, "");
    assert.equal(
      h.session.isRunning,
      false,
      "refused compaction settles its synthetic turn",
    );
    assert.equal(
      h.query.inputs.length,
      2,
      "no /compact reaches the quarantined CLI",
    );
    // A late acknowledgement must not revive this process even before it closes.
    interrupted.resolve(undefined);
    await h.adapter.prompt("late acknowledgement still cannot permit reuse");
    assert.equal(h.query.inputs.length, 2);
    h.query.output.emit({
      type: "system",
      subtype: "session_state_changed",
      state: "running",
      uuid: "quarantined-provider-turn",
      session_id: "provider-window",
    } as unknown as ClaudeSdkMessage);
    // A terminal frame after the attempted provider wake proves it was consumed.
    completeBackgroundShell(h.query);
    await until(() => h.query.closeCalls === 1);
    assert.equal(
      h.session.isRunning,
      false,
      "provider work cannot reopen a quarantined turn",
    );
    assert.equal(window(h.session)?.pendingReason, "next-turn");
  } finally {
    interrupted.resolve(undefined);
    await disposeRetained(h);
  }
});

test("an old quarantined Stop's late acknowledgement cannot clear a fresh epoch's Stop", async () => {
  const h = await retainedWindow();
  const oldStop = deferred<void>();
  const freshStop = deferred<void>();
  try {
    const stopped = h.adapter.prompt("old Stop");
    await until(() => h.query.inputs.length === 2);
    h.query.interrupt = () => oldStop.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.session.abort();
    await stopped;
    h.query.output.emit(result("old-quarantined-stop"));
    completeBackgroundShell(h.query);
    await storeWindow(h, 100_000);
    await vi.advanceTimersByTimeAsync(4_000);
    assert.equal(h.query.closeCalls, 1);
    vi.useRealTimers();
    const fresh = h.adapter.prompt("fresh background work");
    await until(() => h.queries.length === 2);
    const query = h.queries[1]!;
    await startBackgroundShell(query);
    query.output.emit(result("fresh-background-work"));
    await fresh;
    const freshTurn = h.adapter.prompt("fresh Stop");
    await until(() => query.inputs.length === 2);
    query.interrupt = () => freshStop.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.session.abort();
    await freshTurn;
    completeBackgroundShell(query);
    await storeWindow(h, 200_000);
    oldStop.resolve(undefined);
    await vi.advanceTimersByTimeAsync(3_999);
    assert.equal(query.closeCalls, 0, "the fresh Stop still owns its epoch");
    freshStop.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(query.closeCalls, 1);
  } finally {
    oldStop.resolve(undefined);
    freshStop.resolve(undefined);
    await disposeRetained(h);
  }
});

for (const firstAcknowledgesFirst of [false, true]) {
  test(`superseded Stops protect an epoch until both acknowledge, ${firstAcknowledgesFirst ? "first" : "last"} Stop acknowledges first`, async () => {
    const h = await retainedWindow();
    const first = deferred<void>();
    const second = deferred<void>();
    try {
      const next = h.adapter.prompt("first Stop");
      await until(() => h.query.inputs.length === 2);
      h.query.interrupt = () => first.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      h.session.abort();
      await next;
      await vi.advanceTimersByTimeAsync(0);
      const { toolId } = h.session.beginSyntheticTool("/compact", {
        command: "/compact",
      });
      h.query.interrupt = () => second.promise;
      h.session.abort();
      h.session.finishSyntheticTool(toolId, "stopped", true);
      await vi.advanceTimersByTimeAsync(0);
      completeBackgroundShell(h.query);
      await storeWindow(h, 100_000);
      (firstAcknowledgesFirst ? first : second).resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(
        h.query.closeCalls,
        0,
        "one acknowledgement cannot clear the other Stop",
      );
      (firstAcknowledgesFirst ? second : first).resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(h.query.closeCalls, 1);
    } finally {
      first.resolve(undefined);
      second.resolve(undefined);
      await disposeRetained(h);
    }
  });
}

test("a second Stop during synthetic compaction's Stop wait settles without dispatching /compact", async () => {
  const { runCompactForHost } = await import("../hostSlashCommands.ts");
  const h = await retainedWindow();
  const first = deferred<void>();
  let compact: Promise<void> | undefined;
  const entered = vi.spyOn(h.session, "compactContext");
  try {
    const next = h.adapter.prompt("Stop before synthetic compaction");
    await until(() => h.query.inputs.length === 2);
    h.query.interrupt = () => first.promise;
    h.session.abort();
    await next;
    h.query.output.emit(result("stopped-before-synthetic-compact"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let settled = false;
    compact = runCompactForHost(h.session, "").then(() => {
      settled = true;
    });
    await until(() => entered.mock.calls.length === 1);
    h.query.interrupt = async () => {};
    h.session.abort();
    first.resolve(undefined);
    await until(() => settled);
    assert.equal(
      h.session.isRunning,
      false,
      "the canceled synthetic turn settles",
    );
    assert.equal(
      h.query.inputs.length,
      2,
      "canceled compaction never enters the queue",
    );
  } finally {
    first.resolve(undefined);
    h.session.abort();
    await compact;
    entered.mockRestore();
    await disposeRetained(h);
  }
});

test("an aborted compaction wait cannot clear its successor's reservation", async () => {
  const h = await retainedWindow();
  const interrupted = deferred<void>();
  let oldCompact: Promise<unknown> | undefined;
  let newCompact: Promise<unknown> | undefined;
  try {
    const next = h.adapter.prompt("Stop before competing compactions");
    await until(() => h.query.inputs.length === 2);
    h.query.interrupt = () => interrupted.promise;
    h.session.abort();
    await next;
    h.query.output.emit(result("stopped-before-competing-compacts"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const { toolId } = h.session.beginSyntheticTool("/compact", {
      command: "/compact",
    });
    oldCompact = h.session.compactContext().then(
      () => "completed",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    h.query.interrupt = async () => {};
    h.session.abort();
    h.query.output.emit(result("second-stop-before-successor"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    newCompact = h.session.compactContext().then(
      (outcome) => outcome,
      (error: unknown) => error,
    );
    interrupted.resolve(undefined);
    assert.equal(await oldCompact, "Compaction was stopped.");
    await until(() => h.query.inputs.length === 3);
    await assert.rejects(h.session.compactContext(), /already running/);
    h.query.output.emit(result("successor-compact-result"));
    assert.equal(((await newCompact) as { kind?: string }).kind, "skipped");
    h.session.finishSyntheticTool(toolId, "settled", false);
    assert.equal(h.session.isRunning, false);
  } finally {
    interrupted.resolve(undefined);
    h.session.abort();
    await oldCompact;
    await newCompact?.catch(() => undefined);
    await disposeRetained(h);
  }
});

test("a start-time change cannot close a provider turn awaiting admission", async () => {
  const runtimePrompt = await import("../session/runtimePrompt.ts");
  const admitted = deferred<() => void>();
  const admit = vi
    .spyOn(runtimePrompt, "beginRuntimeProviderTurn")
    .mockImplementation(() => admitted.promise);
  const h = await retainedWindow();
  try {
    completeBackgroundShell(h.query);
    h.query.output.emit({
      type: "system",
      subtype: "session_state_changed",
      state: "running",
      uuid: "provider-turn-start",
      session_id: "provider-window",
    } as unknown as ClaudeSdkMessage);
    await until(() => admit.mock.calls.length === 1);
    await storeWindow(h, 100_000);
    assert.equal(
      h.query.closeCalls,
      0,
      "admission owns the epoch before running",
    );
    admitted.resolve(() => {});
    await until(() => h.session.isRunning);
    h.query.output.emit(result("provider-turn-finished"));
    await until(() => h.query.closeCalls === 1);
  } finally {
    admitted.resolve(() => {});
    admit.mockRestore();
    await disposeRetained(h);
  }
});

test("compaction awaiting Stop owns the epoch when Stop acknowledges", async () => {
  const h = await retainedWindow();
  const interrupted = deferred<void>();
  try {
    const next = h.adapter.prompt("stop before compacting");
    await until(() => h.query.inputs.length === 2);
    h.query.interrupt = () => interrupted.promise;
    h.session.abort();
    await next;
    // Retire the aborted result before requesting manual compaction.
    h.query.output.emit(result("stopped-before-compact"));
    completeBackgroundShell(h.query);
    await until(
      () =>
        backgroundWorkStore.listItems({ ownerSessionId: h.id })[0]?.state ===
        "completed",
    );
    await storeWindow(h, 100_000);
    const compact = h.session.compactContext();
    await assert.rejects(h.session.compactContext(), /already running/);
    await assert.rejects(h.session.clearContext(), /compaction is running/);
    interrupted.resolve(undefined);
    await until(() => h.query.inputs.length === 3);
    assert.equal(
      h.query.closeCalls,
      0,
      "compaction's Stop wait kept the epoch",
    );
    h.query.output.emit(result("compact-after-stop"));
    await compact;
    assert.equal(h.query.closeCalls, 1);
  } finally {
    interrupted.resolve(undefined);
    await disposeRetained(h);
  }
});

test("an unbound start keeps the inherited variable without a stored window and drops it with one", async () => {
  process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV] = "150000";
  const { id, session, queries } = makeHarness();
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("first");
  await until(() => queries.length === 1);
  assert.equal(
    queries[0]!.params.options?.env?.[CLAUDE_AUTO_COMPACT_WINDOW_ENV],
    "150000",
  );
  assert.equal(window(session)?.appliedTokens, null);
  queries[0]!.output.emit(result("r1"));
  await first;

  sessionStore.setCompactionWindow(id, 100_000);
  const second = adapter.prompt("second");
  await until(() => queries.length === 2);
  assert.equal(
    Object.hasOwn(
      queries[1]!.params.options?.env ?? {},
      CLAUDE_AUTO_COMPACT_WINDOW_ENV,
    ),
    false,
  );
  assert.equal(startWindow(queries[1]!), 100_000);
  queries[1]!.output.emit(result("r2"));
  await second;
  session.dispose();
});

test("a stored window above the model's range is clamped at start", async () => {
  const { session, queries } = makeHarness(150_000);
  await session.setModel("sonnet");
  assert.equal(window(session)?.effectiveTokens, 150_000);
  session.dispose();
  const { session: big, queries: bigQueries } = makeHarness(900_000);
  await big.setModel("sonnet");
  assert.equal(window(big)?.effectiveTokens, 200_000);
  const turn = big.createRuntimeAdapter().prompt("hello");
  await until(() => bigQueries.length === 1);
  assert.equal(startWindow(bigQueries[0]!), 200_000);
  bigQueries[0]!.output.emit(result("r1"));
  await turn;
  big.dispose();
  assert.equal(queries.length, 0);
});

test("agent lowering, first turn with nothing stored: one summary read, then floor, range and the reported threshold", async () => {
  const { id, session, adapter, turn, query, queries, persisted, persist } =
    await midTurn();
  // With no stored window the threshold read now (967 000) bounds it.
  const tooHigh = await session.lowerCompactionWindow(980_000, persist);
  assert.equal(!tooHigh.ok && tooHigh.largestAcceptable, 979_999);
  for (const tokens of [90_000, 1_200_000]) {
    const outcome = await session.lowerCompactionWindow(tokens, persist);
    assert.equal(outcome.ok, false, `${tokens} is refused`);
  }
  assert.deepEqual(await session.lowerCompactionWindow(400_000, persist), {
    ok: true,
    previous: null,
    applied: 400_000,
    pendingReason: "process-restart",
  });
  // Now the stored window bounds it.
  const raise = await session.lowerCompactionWindow(400_000, persist);
  assert.equal(!raise.ok && raise.largestAcceptable, 399_999);
  const failed = await session.lowerCompactionWindow(300_000, () => {
    throw new Error("disk full");
  });
  assert.match(!failed.ok ? failed.message : "", /disk full/);
  assert.deepEqual(
    query.usageReads,
    ["summary"],
    "one read for the epoch, never repeated",
  );
  assert.deepEqual(persisted, [400_000]);
  assert.equal(window(session)?.pendingReason, "process-restart");

  query.output.emit(result("r1"));
  await turn;
  const next = adapter.prompt("next");
  await until(() => queries.length === 2);
  assert.equal(startWindow(queries[1]!), 400_000);
  queries[1]!.output.emit(result("r2"));
  await next;
  assert.equal(sessionStore.get(id)?.compactionWindow, 400_000);
  assert.deepEqual(
    queries.flatMap((each) => each.flagCalls),
    [],
  );
  session.dispose();
});

test("agent lowering, stored start: the switch is still read, and the stored value bounds it", async () => {
  const { id, session, turn, query, persisted, persist } =
    await midTurn(300_000);
  const same = await session.lowerCompactionWindow(300_000, persist);
  assert.equal(!same.ok && same.largestAcceptable, 299_999);
  assert.deepEqual(query.usageReads, ["summary"]);
  assert.deepEqual(persisted, []);
  assert.deepEqual(await session.lowerCompactionWindow(200_000, persist), {
    ok: true,
    previous: 300_000,
    applied: 200_000,
    pendingReason: "process-restart",
  });
  assert.equal(sessionStore.get(id)?.compactionWindow, 200_000);
  query.output.emit(result("r1"));
  await turn;
  session.dispose();
});

test("agent lowering, stored start with the provider's compaction off: refused after the read", async () => {
  const { id, session, turn, query, persisted, persist } =
    await midTurn(300_000);
  query.enabled = false;
  const first = await session.lowerCompactionWindow(200_000, persist);
  assert.match(!first.ok ? first.message : "", /turned off/);
  const again = await session.lowerCompactionWindow(200_000, persist);
  assert.match(!again.ok ? again.message : "", /turned off/);
  assert.deepEqual(query.usageReads, ["summary"], "known off is not re-read");
  assert.deepEqual(persisted, []);
  assert.equal(sessionStore.get(id)?.compactionWindow, 300_000);
  assert.deepEqual(query.flagCalls, []);
  query.output.emit(result("r1"));
  await turn;
  session.dispose();
});

test("agent lowering: a failed read refuses even after another report for the epoch arrived", async () => {
  const { id, session, turn, query, persisted, persist } = await midTurn();
  const held = deferred<Usage>();
  query.summary = () => held.promise;
  const outcome = session.lowerCompactionWindow(400_000, persist);
  await until(() => query.usageReads.includes("summary"));
  query.output.emit(result("r1"));
  await until(() => query.usageReads.includes("full"));
  held.reject(new Error("control channel closed"));
  const refused = await outcome;
  assert.match(!refused.ok ? refused.message : "", /Could not read/);
  await turn;
  assert.deepEqual(persisted, []);
  assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
  session.dispose();
});

test("agent lowering: a read that never answers refuses at its bound", async () => {
  const { id, session, turn, query, persisted, persist } = await midTurn();
  query.summary = () => new Promise<Usage>(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const outcome = session.lowerCompactionWindow(400_000, persist);
    await vi.advanceTimersByTimeAsync(10_001);
    const refused = await outcome;
    assert.match(!refused.ok ? refused.message : "", /Could not read/);
  } finally {
    vi.useRealTimers();
  }
  assert.deepEqual(persisted, []);
  assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
  query.output.emit(result("r1"));
  await turn;
  session.dispose();
});

test("agent lowering: a read that answers after its process ended refuses, despite the ended report", async () => {
  const { id, session, turn, query, persisted, persist } = await midTurn();
  const held = deferred<Usage>();
  query.summary = () => held.promise;
  const outcome = session.lowerCompactionWindow(400_000, persist);
  await until(() => query.usageReads.includes("summary"));
  query.output.emit(result("r1"));
  await turn;
  assert.equal(
    window(session)?.providerTrigger,
    967_000,
    "the ended epoch's report is saved",
  );
  held.resolve({
    mcpTools: [],
    autoCompactThreshold: 967_000,
    isAutoCompactEnabled: true,
  });
  const refused = await outcome;
  assert.match(!refused.ok ? refused.message : "", /changed while checking/);
  assert.deepEqual(persisted, []);
  assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
  session.dispose();
});

test("agent lowering: a read that answers after a replacement process started refuses", async () => {
  const { id, session, adapter, turn, query, queries, persisted, persist } =
    await midTurn(300_000);
  const held = deferred<Usage>();
  query.summary = () => held.promise;
  const outcome = session.lowerCompactionWindow(200_000, persist);
  await until(() => query.usageReads.includes("summary"));
  query.output.emit(result("r1"));
  await turn;
  const next = adapter.prompt("next");
  await until(() => queries.length === 2);
  assert.equal(startWindow(queries[1]!), 300_000);
  held.resolve({
    mcpTools: [],
    autoCompactThreshold: 267_000,
    isAutoCompactEnabled: true,
  });
  const refused = await outcome;
  assert.match(!refused.ok ? refused.message : "", /changed while checking/);
  assert.deepEqual(persisted, []);
  assert.equal(sessionStore.get(id)?.compactionWindow, 300_000);
  assert.deepEqual(queries[1]!.usageReads, []);
  queries[1]!.output.emit(result("r2"));
  await next;
  assert.deepEqual(
    queries.flatMap((each) => each.flagCalls),
    [],
  );
  session.dispose();
});

test("agent lowering: a read missing the switch, or the threshold of a no-value start, refuses", async () => {
  for (const missing of ["isAutoCompactEnabled", "autoCompactThreshold"]) {
    const { id, session, turn, query, persisted, persist } = await midTurn();
    query.summary = async (usage) => {
      const partial: Record<string, unknown> = { ...usage };
      delete partial[missing];
      return partial as Usage;
    };
    const refused = await session.lowerCompactionWindow(400_000, persist);
    assert.match(
      !refused.ok ? refused.message : "",
      /Could not read/,
      `without ${missing}`,
    );
    assert.deepEqual(persisted, []);
    assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
    query.output.emit(result("r1"));
    await turn;
    session.dispose();
  }
});

test("agent lowering: partial reads never add up to an answer", async () => {
  const { id, session, turn, query, persisted, persist } = await midTurn();
  const replies: Array<Partial<Usage>> = [
    { mcpTools: [], isAutoCompactEnabled: true },
    { mcpTools: [], autoCompactThreshold: 967_000 },
  ];
  query.summary = async () => replies.shift() as Usage;
  for (const attempt of ["switch only", "threshold only"]) {
    const refused = await session.lowerCompactionWindow(400_000, persist);
    assert.match(!refused.ok ? refused.message : "", /Could not read/, attempt);
  }
  assert.deepEqual(query.usageReads, ["summary", "summary"]);
  assert.deepEqual(persisted, []);
  assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
  query.output.emit(result("r1"));
  await turn;
  session.dispose();
});

test("agent lowering: an empty read refuses even when the epoch reported fully meanwhile", async () => {
  enableBackgroundWork();
  const { id, session, turn, query, persisted, persist } = await midTurn();
  await sessionSkills(session.id, session.agentType);
  await startBackgroundShell(query);
  const held = deferred<Usage>();
  query.summary = () => held.promise;
  const outcome = session.lowerCompactionWindow(400_000, persist);
  await until(() => query.usageReads.includes("summary"));
  query.output.emit(result("r1"));
  await turn;
  assert.equal(
    window(session)?.providerTrigger,
    967_000,
    "the retained epoch reported in full",
  );
  held.resolve({ mcpTools: [] });
  const refused = await outcome;
  assert.match(!refused.ok ? refused.message : "", /Could not read/);
  assert.deepEqual(persisted, []);
  assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
  session.dispose();
});

test("agent lowering: a pending stored raise never lifts the running window's bound", async () => {
  const { id, session, turn, query, persisted, persist } =
    await midTurn(200_000);
  // The process runs with 200 000; the user then stored a raise to 500 000.
  sessionStore.setCompactionWindow(id, 500_000);
  const raise = await session.lowerCompactionWindow(400_000, persist);
  assert.equal(!raise.ok && raise.largestAcceptable, 199_999);
  assert.deepEqual(persisted, []);
  assert.equal(sessionStore.get(id)?.compactionWindow, 500_000);
  const lower = await session.lowerCompactionWindow(150_000, persist);
  assert.equal(lower.ok, true);
  assert.deepEqual(persisted, [150_000]);
  assert.deepEqual(query.usageReads, ["summary"]);
  query.output.emit(result("r1"));
  await turn;
  session.dispose();
});

test("agent lowering on a retained process uses its epoch's report; reported off refuses with no read", async () => {
  enableBackgroundWork();
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const turn = session.createRuntimeAdapter().prompt("start background work");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await startBackgroundShell(query);
  query.enabled = false;
  query.output.emit(result("r1"));
  await turn;
  assert.equal(window(session)?.disabled, true);
  const persisted: number[] = [];
  const outcome = await session.lowerCompactionWindow(150_000, (tokens) =>
    persisted.push(tokens),
  );
  assert.match(!outcome.ok ? outcome.message : "", /turned off/);
  assert.deepEqual(query.usageReads, ["full"]);
  assert.deepEqual(persisted, []);
  session.dispose();
});

test("agent lowering with no running process refuses without reading", async () => {
  const { session, turn, query, persisted, persist } = await midTurn();
  query.output.emit(result("r1"));
  await turn;
  const outcome = await session.lowerCompactionWindow(400_000, persist);
  assert.match(!outcome.ok ? outcome.message : "", /during a turn/);
  assert.deepEqual(query.usageReads, ["full"]);
  assert.deepEqual(persisted, []);
  session.dispose();
});

test("the standalone /compact query starts with the stored window too", async () => {
  const { session, queries } = makeHarness(120_000);
  session.beginSyntheticTool("/compact", { command: "/compact", rawArgs: "" });
  const compact = session.compactContext().catch(() => undefined);
  await until(() => queries.length === 1);
  assert.equal(startWindow(queries[0]!), 120_000);
  assert.equal(
    window(session)?.pendingReason,
    "next-turn",
    "the /compact query is not a session epoch",
  );
  queries[0]!.output.emit(result("compact"));
  queries[0]!.output.close();
  await compact;
  session.dispose();
});
