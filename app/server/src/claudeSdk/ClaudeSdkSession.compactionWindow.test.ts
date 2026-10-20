/**
 * The Claude compaction window (`docs/compaction-window.md`): a query starts
 * with the stored window, a running or retained process keeps the window it
 * started with (nothing is sent live), the next start applies a change, and
 * the agent's lowering checks run against what the next process would use.
 *   pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.compactionWindow.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
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

/**
 * A query whose threshold follows its START settings only, like the CLI:
 * `applyFlagSettings` is recorded and has no effect.
 */
class FakeQuery implements ClaudeQuery {
  readonly output = new OutputQueue();
  readonly inputs: ClaudeSdkUserMessage[] = [];
  readonly flagCalls: Record<string, unknown>[] = [];
  enabled = true;

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

  async getContextUsage() {
    const settings = this.params.options?.settings as
      { autoCompactWindow?: number } | undefined;
    const window = Math.min(
      settings?.autoCompactWindow ?? 1_000_000,
      1_000_000,
    );
    return {
      mcpTools: [],
      autoCompactThreshold: window - 33_000,
      isAutoCompactEnabled: this.enabled,
    };
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
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
  const { id, session, make, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("start background work");
  await until(() => queries.length === 1);
  const query = queries[0]!;
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

test("agent lowering: provider switch, floor and range, then non-raising against the next start", async () => {
  const { id, session, queries } = makeHarness();
  const persisted: number[] = [];
  const persist = (tokens: number) => {
    persisted.push(tokens);
    sessionStore.setCompactionWindow(id, tokens);
  };
  const noReport = await session.lowerCompactionWindow(400_000, persist);
  assert.equal(noReport.ok, false);
  assert.match(!noReport.ok ? noReport.message : "", /not reported/);

  const turn = session.createRuntimeAdapter().prompt("hello");
  await until(() => queries.length === 1);
  queries[0]!.output.emit(result("r1"));
  await turn;

  for (const tokens of [90_000, 1_200_000]) {
    const outcome = await session.lowerCompactionWindow(tokens, persist);
    assert.equal(outcome.ok, false, `${tokens} is refused`);
  }
  // With no stored window the reported 967 000 threshold bounds it.
  const tooHigh = await session.lowerCompactionWindow(980_000, persist);
  assert.equal(!tooHigh.ok && tooHigh.largestAcceptable, 979_999);
  assert.deepEqual(await session.lowerCompactionWindow(400_000, persist), {
    ok: true,
    previous: null,
    applied: 400_000,
    pendingReason: "next-turn",
  });
  // Now the stored window bounds it.
  const raise = await session.lowerCompactionWindow(400_000, persist);
  assert.equal(!raise.ok && raise.largestAcceptable, 399_999);
  const failed = await session.lowerCompactionWindow(300_000, () => {
    throw new Error("disk full");
  });
  assert.equal(failed.ok, false);
  assert.match(!failed.ok ? failed.message : "", /disk full/);
  assert.deepEqual(persisted, [400_000]);
  assert.equal(sessionStore.get(id)?.compactionWindow, 400_000);
  assert.deepEqual(queries[0]!.flagCalls, []);
  session.dispose();
});

test("agent lowering: a pending stored raise never lifts the running window's bound", async () => {
  const { id, session, queries } = makeHarness(200_000);
  const turn = session.createRuntimeAdapter().prompt("hello");
  await until(() => queries.length === 1);
  queries[0]!.output.emit(result("r1"));
  await turn;
  // The process ran with 200 000; the user then stored a raise to 500 000.
  sessionStore.setCompactionWindow(id, 500_000);
  const persisted: number[] = [];
  const raise = await session.lowerCompactionWindow(400_000, (tokens) =>
    persisted.push(tokens),
  );
  assert.equal(raise.ok, false);
  assert.equal(!raise.ok && raise.largestAcceptable, 199_999);
  assert.equal(persisted.length, 0);
  assert.equal(sessionStore.get(id)?.compactionWindow, 500_000);
  const lower = await session.lowerCompactionWindow(150_000, (tokens) =>
    persisted.push(tokens),
  );
  assert.equal(lower.ok, true);
  assert.deepEqual(persisted, [150_000]);
  session.dispose();
});

test("agent lowering refuses when the provider reports compaction off", async () => {
  const { session, queries } = makeHarness();
  const turn = session.createRuntimeAdapter().prompt("hello");
  await until(() => queries.length === 1);
  queries[0]!.enabled = false;
  queries[0]!.output.emit(result("r1"));
  await turn;
  assert.equal(window(session)?.disabled, true);
  const outcome = await session.lowerCompactionWindow(90_000, () => {});
  assert.match(!outcome.ok ? outcome.message : "", /turned off/);
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
