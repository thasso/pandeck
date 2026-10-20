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

const { ClaudeSdkSession } = await import("./ClaudeSdkSession.ts");
const { CLAUDE_AUTO_COMPACT_WINDOW_ENV } = await import("./options.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { updateSettings } = await import("../settings.ts");
const { sessionSkills } = await import("../sessionSkills.ts");

const ENV_BEFORE = process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV];
afterEach(() => {
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
  summary?: (usage: Usage) => Promise<Usage>;

  constructor(readonly params: ClaudeQueryParams) {
    void this.consumeInput();
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return this.output[Symbol.asyncIterator]();
  }

  close(): void {
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

const window = (session: InstanceType<typeof ClaudeSdkSession>) =>
  session.state().compactionWindow;

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
