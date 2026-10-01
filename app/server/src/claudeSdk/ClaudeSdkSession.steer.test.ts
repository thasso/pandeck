/**
 * Steering a running Claude turn.
 *   pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.steer.test.ts
 *
 * A message written into the CLI's input queue mid-turn is folded in at the
 * next tool step, or — when the turn has no step left — run as the next turn
 * right after the reply. The session answers the sender only once the CLI has
 * decided, keeps a late one inside the same run, and withdraws what is still
 * queued when the turn is stopped.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AdapterEvent } from "../session/adapters/contract.ts";
import type {
  ClaudeQuery,
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";

const dataDir = mkdtempSync(join(tmpdir(), "claude-steer-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { ClaudeSdkSession } = await import("./ClaudeSdkSession.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { SessionRuntime } = await import("../session/runtime/runtime.ts");
const { SessionLogStore } = await import("../session/log/store.ts");
const { promptRuntimeSessionWithRuntime } =
  await import("../session/runtimePrompt.ts");

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

class FakeQuery implements ClaudeQuery {
  readonly output = new OutputQueue();
  readonly inputs: ClaudeSdkUserMessage[] = [];
  readonly cancelled: string[] = [];
  readonly calls: string[] = [];
  closeCalls = 0;

  constructor(readonly params: ClaudeQueryParams) {
    params.options?.abortController?.signal.addEventListener("abort", () =>
      this.output.close(),
    );
    void this.consumeInput();
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return this.output[Symbol.asyncIterator]();
  }

  close(): void {
    this.closeCalls += 1;
    this.output.close();
  }

  /** How many inputs the CLI had been given when each interrupt arrived. */
  readonly inputsAtInterrupt: number[] = [];

  async interrupt(): Promise<void> {
    this.calls.push("interrupt");
    this.inputsAtInterrupt.push(this.inputs.length);
  }

  /** Set to hold every cancel answer until the test releases it. */
  cancelGate: Promise<void> | undefined;
  /** What the CLI answers a drop: `false` = it had already taken the message. */
  cancelAnswer = true;

  async cancelAsyncMessage(uuid: string): Promise<boolean> {
    this.calls.push(`cancel:${uuid}`);
    await this.cancelGate;
    this.calls.push(`cancelled:${uuid}`);
    this.cancelled.push(uuid);
    return this.cancelAnswer;
  }

  async setModel(): Promise<void> {}
  async setMaxThinkingTokens(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}

  private async consumeInput(): Promise<void> {
    if (typeof this.params.prompt === "string") return;
    for await (const message of this.params.prompt) this.inputs.push(message);
  }
}

function result(uuid: string, consumed?: string[]): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "provider-steer",
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
    ...(consumed ? { user_message_uuids: consumed } : {}),
  } as unknown as ClaudeSdkMessage;
}

function started(uuid: string): ClaudeSdkMessage {
  return {
    type: "command_lifecycle",
    command_uuid: uuid,
    state: "started",
    uuid: `lifecycle-${uuid}`,
    session_id: "provider-steer",
  } as unknown as ClaudeSdkMessage;
}

async function until(check: () => boolean): Promise<void> {
  // Generous: a loaded CI runner can take far longer than a laptop to open a
  // session and reach its first provider write.
  for (let i = 0; i < 5_000; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

let serial = 0;
function makeHarness() {
  serial += 1;
  const id = `claude-steer-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "claude-sdk",
    agentType: "assistant",
  });
  const queries: FakeQuery[] = [];
  const seam: ClaudeSdkSeam = {
    query(params) {
      const query = new FakeQuery(params);
      queries.push(query);
      return query;
    },
  };
  const session = new ClaudeSdkSession(id, {
    seam: async () => seam,
    agentType: "assistant",
  });
  const events: AdapterEvent["type"][] = [];
  session.subscribeAdapterEvents((event) => events.push(event.type));
  return { session, queries, events, adapter: session.createRuntimeAdapter() };
}

/** Start a turn and hand it one steer; returns the steer's CLI uuid. */
async function steerIntoTurn(h: ReturnType<typeof makeHarness>) {
  const turn = h.adapter.prompt("first");
  await until(() => h.queries[0]?.inputs.length === 1);
  const steer = h.adapter.prompt("steer me", {
    steer: true,
    clientRequestId: "steer-1",
  });
  await until(() => h.queries[0]!.inputs.length === 2);
  const uuid = (h.queries[0]!.inputs[1] as { uuid?: string }).uuid;
  assert.ok(uuid, "a steer carries the uuid the CLI reports back");
  return { turn, steer, uuid, query: h.queries[0]! };
}

test("a steer the CLI dequeues mid-turn joins that turn", async () => {
  const h = makeHarness();
  assert.equal(h.session.canSteer, true);
  const { turn, steer, uuid, query } = await steerIntoTurn(h);

  query.output.emit(started(uuid));
  assert.deepEqual(await steer, { stopReason: "end", steerDelivery: "steer" });

  query.output.emit(result("r1", ["first-uuid", uuid]));
  await turn;
  assert.equal(query.closeCalls, 1, "the ordinary process still closes");
  assert.equal(h.events.filter((t) => t === "runCompleted").length, 1);
  h.session.dispose();
});

test("the result's consumed uuids settle a steer whose lifecycle frame is missing", async () => {
  const h = makeHarness();
  const { turn, steer, uuid, query } = await steerIntoTurn(h);

  query.output.emit(result("r1", ["first-uuid", uuid]));
  assert.deepEqual(await steer, { stopReason: "end", steerDelivery: "steer" });
  await turn;
  assert.equal(query.closeCalls, 1);
  h.session.dispose();
});

test("a steer the reply missed continues the same run as a follow-up", async () => {
  const h = makeHarness();
  const { turn, steer, uuid, query } = await steerIntoTurn(h);
  let turnSettled = false;
  void turn.then(() => (turnSettled = true));

  query.output.emit(result("r1", ["first-uuid"]));
  assert.deepEqual(await steer, {
    stopReason: "end",
    steerDelivery: "followUp",
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(turnSettled, false, "the run is not over: its next turn runs");
  assert.equal(query.closeCalls, 0, "the process that runs it stays open");
  assert.equal(h.session.isRunning, true);
  assert.deepEqual(
    h.events.filter((t) => t !== "passthrough"),
    ["messageStarted", "messageCompleted", "messageStarted"],
    "the reply is committed and the next message opens — no run boundary",
  );

  // The CLI now reports it dequeued the follow-up; that is not a second fold.
  query.output.emit(started(uuid));
  query.output.emit(result("r2", [uuid]));
  await turn;
  assert.equal(query.closeCalls, 1);
  assert.equal(h.events.filter((t) => t === "runCompleted").length, 1);
  h.session.dispose();
});

test("follow-ups the CLI runs one turn each keep the run open until the last", async () => {
  const h = makeHarness();
  const { turn, steer, uuid, query } = await steerIntoTurn(h);
  const second = h.adapter.prompt("and this", {
    steer: true,
    clientRequestId: "steer-2",
  });
  await until(() => query.inputs.length === 3);
  const secondUuid = (query.inputs[2] as { uuid?: string }).uuid!;
  let turnSettled = false;
  void turn.then(() => (turnSettled = true));

  query.output.emit(result("r1", ["first-uuid"]));
  assert.equal((await steer).steerDelivery, "followUp");
  assert.equal((await second).steerDelivery, "followUp");

  query.output.emit(result("r2", [uuid]));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(turnSettled, false, "the second follow-up has not run yet");
  assert.equal(query.closeCalls, 0);

  query.output.emit(result("r3", [secondUuid]));
  await turn;
  assert.equal(query.closeCalls, 1);
  assert.equal(h.events.filter((t) => t === "runCompleted").length, 1);
  h.session.dispose();
});

test("a result that names no consumed messages keeps no follow-up waiting", async () => {
  const h = makeHarness();
  const { turn, steer, query } = await steerIntoTurn(h);
  query.output.emit(result("r1", ["first-uuid"]));
  assert.equal((await steer).steerDelivery, "followUp");
  // An older CLI reports nothing to match against: the run ends here rather
  // than waiting forever on a turn it cannot recognise.
  query.output.emit(result("r2"));
  await turn;
  assert.equal(query.closeCalls, 1);
  h.session.dispose();
});

test("Stop withdraws a queued steer before it interrupts", async () => {
  const h = makeHarness();
  const { turn, steer, uuid, query } = await steerIntoTurn(h);

  h.session.abort();
  assert.deepEqual(
    await steer,
    { stopReason: "end", steerWithdrawn: true },
    "nothing was taken, and the sender is told it was withdrawn",
  );
  assert.deepEqual(query.cancelled, [uuid]);
  await turn;
  h.session.dispose();
});

test("a retained process interrupts only after the CLI confirmed the drop", async () => {
  const h = makeHarness();
  const { turn, steer, uuid, query } = await steerIntoTurn(h);
  let releaseCancel!: () => void;
  query.cancelGate = new Promise<void>((resolve) => (releaseCancel = resolve));
  // The retained (background-work) epoch is the one Stop interrupts rather
  // than kills; its admission is exercised elsewhere, only its identity here.
  const internals = h.session as unknown as {
    retainedEpochKey: string | undefined;
    queryEpochKey: string | undefined;
  };
  internals.retainedEpochKey = internals.queryEpochKey;

  h.session.abort();
  let answered = false;
  void steer.then(() => (answered = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(
    query.calls,
    [`cancel:${uuid}`],
    "no interrupt while the drop is unanswered",
  );
  assert.equal(answered, false, "nor an answer to the sender");
  releaseCancel();
  assert.deepEqual(await steer, { stopReason: "end", steerWithdrawn: true });
  await until(() => query.calls.includes("interrupt"));
  assert.deepEqual(query.calls, [
    `cancel:${uuid}`,
    `cancelled:${uuid}`,
    "interrupt",
  ]);
  await turn;
  internals.retainedEpochKey = undefined;
  query.output.close();
  h.session.dispose();
});

test("a prompt sent while a Stop waits on its drops reaches the CLI after that interrupt", async () => {
  const h = makeHarness();
  const { turn, uuid, query } = await steerIntoTurn(h);
  let releaseCancel!: () => void;
  query.cancelGate = new Promise<void>((resolve) => (releaseCancel = resolve));
  const internals = h.session as unknown as {
    retainedEpochKey: string | undefined;
    queryEpochKey: string | undefined;
  };
  internals.retainedEpochKey = internals.queryEpochKey;

  h.session.abort();
  await turn;
  // The idle edge the Stop produced is taken by the next message at once.
  const next = h.adapter.prompt("the next thing");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(query.inputs.length, 2, "it waits for the old interrupt");

  releaseCancel();
  await until(() => query.inputs.length === 3);
  assert.deepEqual(
    query.inputsAtInterrupt,
    [2],
    "the interrupt landed before the new message, so it cannot hit it",
  );
  assert.equal(query.calls[0], `cancel:${uuid}`);

  // The stopped turn's own result is discarded; the new turn's ends it.
  query.output.emit(result("stopped"));
  query.output.emit(result("next", []));
  await next;
  internals.retainedEpochKey = undefined;
  query.output.close();
  h.session.dispose();
});

test("a steer settled only by the result is recorded inside the run, before the reply", async () => {
  const h = makeHarness();
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const driver = h.session as unknown as Parameters<
    typeof promptRuntimeSessionWithRuntime
  >[1];
  const turn = promptRuntimeSessionWithRuntime(runtime, driver, "first");
  await until(() => h.queries[0]?.inputs.length === 1);
  const steer = promptRuntimeSessionWithRuntime(runtime, driver, "steer me", {
    steer: true,
    clientRequestId: "fold-by-result",
  });
  await until(() => h.queries[0]!.inputs.length === 2);
  const uuid = (h.queries[0]!.inputs[1] as { uuid?: string }).uuid!;

  // No lifecycle frame: only the result says the turn consumed it.
  h.queries[0]!.output.emit(result("r1", ["first-uuid", uuid]));
  await Promise.all([turn, steer]);

  const log = runtime.get(h.session.sessionId)!;
  const kinds = log
    .getSnapshot()
    .entries.map(
      (e) =>
        `${e.role}${e.role === "user" && e.delivery ? `:${e.delivery}` : ""}`,
    );
  assert.deepEqual(kinds, ["user", "user:steer", "assistant"]);
  h.session.dispose();
});

test("a drop the CLI refuses is uncertain, not withdrawn unread", async () => {
  const h = makeHarness();
  const { turn, steer, query } = await steerIntoTurn(h);
  query.cancelAnswer = false;
  h.session.abort();
  assert.deepEqual(await steer, {
    stopReason: "end",
    steerWithdrawn: true,
    steerUncertain: true,
  });
  await turn;
  h.session.dispose();
});

test("an ordinary process is killed only once the CLI answered the drop", async () => {
  const h = makeHarness();
  const { turn, steer, query } = await steerIntoTurn(h);
  let releaseCancel!: () => void;
  query.cancelGate = new Promise<void>((resolve) => (releaseCancel = resolve));

  h.session.abort();
  await turn;
  assert.equal(h.session.isRunning, false, "the Stop shows at once");
  // What the stopped turn still streams is nobody's turn.
  query.output.emit(result("late-result"));
  const next = h.adapter.prompt("after the stop");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(query.closeCalls, 0, "not killed before the answer");
  assert.equal(h.queries.length, 1, "and nothing new written meanwhile");

  releaseCancel();
  assert.deepEqual(await steer, { stopReason: "end", steerWithdrawn: true });
  await until(() => h.queries.length === 2);
  assert.equal(query.closeCalls, 1);
  assert.equal(query.inputs.length, 2, "the stopped process got nothing new");
  h.queries[1]!.output.emit(result("next"));
  await next;
  h.session.dispose();
});

test("steer-or-nothing is refused without writing to the CLI", async () => {
  const h = makeHarness();
  const turn = h.adapter.prompt("first");
  await until(() => h.queries[0]?.inputs.length === 1);
  const answer = await h.adapter.prompt("note", {
    steer: true,
    steerOnly: true,
  });
  assert.deepEqual(answer, { stopReason: "end", steered: false });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.queries[0]!.inputs.length, 1);
  h.queries[0]!.output.emit(result("r1"));
  await turn;
  h.session.dispose();
});

test("a steer with no running turn is refused", async () => {
  const h = makeHarness();
  const answer = await h.adapter.prompt("note", { steer: true });
  assert.deepEqual(answer, { stopReason: "end" });
  assert.equal(h.queries.length, 0, "no process was started for it");
  h.session.dispose();
});
