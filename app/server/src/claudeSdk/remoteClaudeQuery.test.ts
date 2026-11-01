/**
 * Live Claude queries hosted by the in-process Worker (`remoteClaudeQuery.ts`,
 * `claudeEngineHosted.ts`), over the real codec with fake SDK seams: what
 * crosses the wire, the order the server sees, controls, failures, and that
 * no engine outlives its query.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/claudeSdk/remoteClaudeQuery.test.ts`
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, test } from "vitest";
import type { Payload } from "../workerProtocol/codec.ts";
import type {
  ClaudeQuery,
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";

const dataDir = mkdtempSync(join(tmpdir(), "claude-hosted-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;
const SENTINEL = "hosted-credential-sentinel";
const savedApiKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = SENTINEL;
afterAll(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
});

const { ClaudeSdkSession } = await import("../test/claudeSdkSession.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { updateSettings } = await import("../settings.ts");
const profiles = await import("../credentialProfiles.ts");
const { childProcessEnv } = await import("../subprocessEnv.ts");
const {
  answerNextInProcessWorkerCallForTests,
  inProcessWorkerEnginesForTests,
  inProcessWorkerServedMethodForTests,
} = await import("../workers/inProcessWorker.ts");
const { registerSessionHooks } = await import("../workers/sessionHookHost.ts");
const { registerAppToolSession } = await import("../workers/appToolHost.ts");
const { defineAgentTool } = await import("../mcp/tool.ts");
const { ENGINE_METHODS, decodeEngineOpen } =
  await import("../workerProtocol/engineMethods.ts");
const { buildClaudeSdkQueryOptions, claudeQueryOpenSpec } =
  await import("./options.ts");
const { registerClaudeHostedSession } = await import("./claudeEngineHosted.ts");
const { openHostedClaudeQuery } = await import("./remoteClaudeQuery.ts");
type ClaudeSessionToolServer =
  import("./toolServer.ts").ClaudeSessionToolServer;
type AppToolExecutor = import("../mcp/tool.ts").AppToolExecutor;

updateSettings({
  backgroundWork: {
    enabled: true,
    ownerSessionCap: 20,
    taskLifetimeMinutes: 60,
    claudeEmptyHostGraceSeconds: 30,
  },
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

/** A session's fake query: an MCP client on its `pa` server, if mounted. */
class FakeQuery implements ClaudeQuery {
  readonly output = new OutputQueue();
  readonly inputs: ClaudeSdkUserMessage[] = [];
  closeCalls = 0;
  abortObserved = false;
  listChanged = 0;
  private client: Promise<Client> | undefined;

  constructor(readonly params: ClaudeQueryParams) {
    params.options?.abortController?.signal.addEventListener("abort", () => {
      this.abortObserved = true;
      this.output.close();
    });
    void this.consumeInput();
  }

  get env(): Record<string, string | undefined> {
    return this.params.options?.env ?? {};
  }

  /** Connect as the CLI does to the mounted `pa` server. */
  mcp(): Promise<Client> {
    this.client ??= (async () => {
      const pa = (
        this.params.options?.mcpServers as
          | Record<string, { instance: Parameters<typeof connect>[0] }>
          | undefined
      )?.pa;
      assert.ok(pa, "the session's tool server is mounted");
      const client = new Client({ name: "fake-cli", version: "0.0.0" });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.listChanged += 1;
      });
      await connect(pa.instance, client);
      return client;
    })();
    return this.client;
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return this.output[Symbol.asyncIterator]();
  }

  close(): void {
    this.closeCalls += 1;
    this.output.close();
    void this.client?.then((client) => client.close());
  }

  async interrupt(): Promise<void> {}

  private async consumeInput(): Promise<void> {
    if (typeof this.params.prompt === "string") return;
    for await (const message of this.params.prompt) this.inputs.push(message);
  }
}

async function connect(
  server: { connect(transport: InMemoryTransport): Promise<void> },
  client: Client,
): Promise<void> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
}

function result(uuid: string): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "provider-hosted",
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
    },
    modelUsage: {},
    permission_denials: [],
    stop_reason: null,
  } as unknown as ClaudeSdkMessage;
}

function note(uuid: string): ClaudeSdkMessage {
  return {
    type: "system",
    subtype: "status",
    status: null,
    uuid,
    session_id: "provider-hosted",
  } as unknown as ClaudeSdkMessage;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

const opens = () => inProcessWorkerServedMethodForTests(ENGINE_METHODS.open);

let serial = 0;

function makeSession(
  options: {
    credentialProfileId?: string;
    seam?: ClaudeSdkSeam | (() => Promise<ClaudeSdkSeam>);
  } = {},
): {
  session: InstanceType<typeof ClaudeSdkSession>;
  queries: FakeQuery[];
} {
  serial += 1;
  const id = `claude-hosted-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
    ...(options.credentialProfileId
      ? { credentialProfileId: options.credentialProfileId }
      : {}),
  });
  const queries: FakeQuery[] = [];
  const fakeSeam: ClaudeSdkSeam = {
    query(params) {
      const query = new FakeQuery(params);
      queries.push(query);
      return query;
    },
  };
  const seam = options.seam ?? fakeSeam;
  return {
    session: new ClaudeSdkSession(id, {
      seam: typeof seam === "function" ? seam : async () => seam,
      title: "Hosted",
      agentType: "developer",
      ...(options.credentialProfileId
        ? { credentialProfileId: options.credentialProfileId }
        : {}),
    }),
    queries,
  };
}

function claudeProfile(name: string): string {
  return profiles.createCredentialProfile({ name, provider: "claude" }).id;
}

test("each turn opens one engine that ends with its query; the next prompt and an account switch follow an ordinary close", async () => {
  const a = claudeProfile("Hosted A");
  const b = claudeProfile("Hosted B");
  const { session, queries } = makeSession({ credentialProfileId: a });
  try {
    const adapter = session.createRuntimeAdapter();
    const before = opens();
    const first = adapter.prompt("first");
    await until(() => queries.length === 1);
    assert.equal(opens() - before, 1);
    assert.equal(inProcessWorkerEnginesForTests(), 1);
    queries[0]!.output.emit(result("hosted-first"));
    await first;
    await until(() => inProcessWorkerEnginesForTests() === 0);
    assert.equal(queries[0]!.closeCalls, 1, "closed once, at its result");

    const second = adapter.prompt("second");
    await until(() => queries.length === 2);
    assert.equal(opens() - before, 2);
    queries[1]!.output.emit(result("hosted-second"));
    assert.equal((await second).stopReason, "end");
    await until(() => inProcessWorkerEnginesForTests() === 0);
    assert.equal(queries[1]!.closeCalls, 1);

    // The provider transcript the switch moves to the next account.
    const project = join(profiles.claudeConfigDir(a), "projects", "hosted");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "provider-hosted.jsonl"), "{}\n");
    await session.switchAccount(b, () => {});
    assert.equal(session.credentialProfileId, b);
    const third = adapter.prompt("third");
    await until(() => queries.length === 3);
    assert.equal(
      queries[2]!.env.CLAUDE_CONFIG_DIR,
      profiles.claudeConfigDir(b),
    );
    queries[2]!.output.emit(result("hosted-third"));
    await third;
  } finally {
    session.dispose();
    profiles.setCredentialProfileEnabled(a, false);
    profiles.setCredentialProfileEnabled(b, false);
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

test("a retained query's engine is disposed with its session", async () => {
  const { session, queries } = makeSession();
  void session.createRuntimeAdapter().prompt("held");
  await until(() => queries.length === 1);
  assert.equal(inProcessWorkerEnginesForTests(), 1);
  session.dispose();
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

test.each([
  ["no profile", undefined],
  ["the default profile", "claude-default"],
  ["a named profile", "named"],
] as const)(
  "the child environment is built on the Worker, and no credential crosses the wire (%s)",
  async (_label, profile) => {
    const profileId =
      profile === "named" ? claudeProfile("Hosted env") : profile;
    const { session, queries } = makeSession(
      profileId ? { credentialProfileId: profileId } : {},
    );
    let sent: Payload | undefined;
    const disarm = answerNextInProcessWorkerCallForTests(
      ENGINE_METHODS.open,
      (payload, signal, real) => {
        sent = payload;
        return real(payload, signal);
      },
    );
    try {
      const turn = session.createRuntimeAdapter().prompt("env");
      await until(() => queries.length === 1);
      assert.ok(sent);
      assert.ok(!JSON.stringify(sent).includes(SENTINEL));
      const spec = decodeEngineOpen(sent).spec as {
        env: { profile?: { configDir?: string } };
      };
      if (profile === "named")
        assert.deepEqual(spec.env.profile, {
          configDir: profiles.claudeConfigDir(profileId!),
        });

      const env = queries[0]!.env;
      const tmp = env.TMPDIR!;
      assert.equal(env.CLAUDE_CODE_TMPDIR, tmp);
      // Today's server-built environment, as the builder bounds it.
      const expected = buildClaudeSdkQueryOptions({
        cwd: dataDir,
        modelId: "sonnet",
        thinkingLevel: "medium",
        abortController: new AbortController(),
        env: {
          ...(profileId
            ? profiles.claudeProfileEnvironment(profileId)
            : childProcessEnv()),
          TMPDIR: tmp,
          CLAUDE_CODE_TMPDIR: tmp,
        },
      }).env;
      assert.deepEqual(env, expected);
      assert.equal(env.ANTHROPIC_API_KEY, profileId ? undefined : SENTINEL);
      queries[0]!.output.emit(result("hosted-env"));
      await turn;
    } finally {
      disarm();
      session.dispose();
      if (profile === "named")
        profiles.setCredentialProfileEnabled(profileId!, false);
    }
  },
);

/** One hosted query opened directly, on a session binding of its own. */
async function openDirect(
  query: (params: ClaudeQueryParams) => ClaudeQuery,
  options: {
    hooksEpoch?: string;
    toolServer?: ClaudeSessionToolServer;
    abort?: AbortController;
  } = {},
) {
  serial += 1;
  const sessionId = `claude-hosted-direct-${serial}`;
  const release = registerClaudeHostedSession(sessionId, {
    seam: async () => ({ query }),
    toolServer: () => options.toolServer,
  });
  const abort = options.abort ?? new AbortController();
  const handle = await openHostedClaudeQuery({
    prompt: (async function* () {})(),
    spec: claudeQueryOpenSpec({
      sessionId,
      cwd: dataDir,
      modelId: "sonnet",
      thinkingLevel: "medium",
      mountToolServer: options.toolServer !== undefined,
      ...(options.hooksEpoch !== undefined
        ? { sessionHooksEpoch: options.hooksEpoch }
        : {}),
    }),
    signal: abort.signal,
  });
  return { sessionId, handle, abort, release };
}

function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

test("messages arrive in order, and the handle has exactly the hosted query's controls", async () => {
  const held = gate();
  const models: Array<string | undefined> = [];
  const { handle, release } = await openDirect(() => ({
    async *[Symbol.asyncIterator]() {
      yield note("m1");
      await held.wait;
      yield note("m2");
      yield note("m3");
    },
    async setModel(model?: string) {
      models.push(model);
    },
    async interrupt() {
      throw new Error("interrupt refused");
    },
    async getContextUsage() {
      return { totalTokens: 7 } as never;
    },
  }));
  try {
    assert.equal(handle.supportedCommands, undefined);
    assert.equal(handle.setMaxThinkingTokens, undefined);
    assert.equal(handle.close, undefined);
    const seen: string[] = [];
    const drained = (async () => {
      for await (const message of handle)
        seen.push((message as { uuid: string }).uuid);
    })();
    await until(() => seen.length === 1);
    await handle.setModel!("claude-opus-5-5");
    await handle.setModel!();
    assert.deepEqual(models, ["claude-opus-5-5", undefined]);
    await assert.rejects(handle.interrupt!(), /interrupt refused/);
    assert.deepEqual(await handle.getContextUsage!(), { totalTokens: 7 });
    held.open();
    await drained;
    assert.deepEqual(seen, ["m1", "m2", "m3"]);
  } finally {
    release();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

/** What the handle holds now, received and not yet handed out. */
function takeReceived(
  iterator: AsyncIterator<ClaudeSdkMessage>,
  max: number,
): Promise<string[]> {
  const pending = Symbol("pending");
  return (async () => {
    const taken: string[] = [];
    while (taken.length < max) {
      const next = await Promise.race([
        iterator.next(),
        Promise.resolve(pending),
      ]);
      if (next === pending || next.done) break;
      taken.push((next.value as { uuid: string }).uuid);
    }
    return taken;
  })();
}

test("a hosted query's hook and app-tool calls reach the server after every item it emitted before them", async () => {
  let executor: AppToolExecutor | undefined;
  const toolServer = {
    server: {},
    bindExecutor(next: AppToolExecutor) {
      executor = next;
      return () => {
        if (executor === next) executor = undefined;
      };
    },
  } as unknown as ClaudeSessionToolServer;
  const done = gate();
  const calls: string[] = [];
  const { sessionId, handle, release } = await openDirect(
    (params) => ({
      // As the CLI does: it yields messages, then calls a hook or a tool.
      async *[Symbol.asyncIterator]() {
        yield note("first");
        for (const uuid of ["a1", "a2", "a3"]) yield note(uuid);
        const verdict = await params.options!.canUseTool!("Read", {}, {
          signal: new AbortController().signal,
          toolUseID: "probe-verdict",
        } as never);
        calls.push(verdict?.behavior ?? "none");
        for (const uuid of ["b1", "b2"]) yield note(uuid);
        const called = await executor!(
          "probe",
          {},
          { toolCallId: "probe-call" },
        );
        calls.push(JSON.stringify(called.content));
        await done.wait;
      },
    }),
    { hooksEpoch: "epoch-ordered", toolServer },
  );
  const iterator = handle[Symbol.asyncIterator]();
  let atVerdict: Promise<string[]> | undefined;
  let atTool: Promise<string[]> | undefined;
  const unhook = registerSessionHooks(sessionId, {
    canUseTool() {
      atVerdict = takeReceived(iterator, 3);
      return { behavior: "allow" };
    },
    preToolUse: async () => ({ allowed: true }),
    stop() {},
    postCompact() {},
  });
  const probe = defineAgentTool({
    name: "probe",
    label: "Probe",
    description: "probe",
    parameters: { type: "object", properties: {} },
    async execute() {
      atTool = takeReceived(iterator, 2);
      return { content: [{ type: "text", text: "probed" }] };
    },
  });
  const untool = registerAppToolSession(sessionId, {
    resolve: () => probe,
    session: () => ({}) as never,
  });
  try {
    // The consumer takes the first message, then nothing until the calls.
    assert.equal(
      ((await iterator.next()).value as { uuid: string }).uuid,
      "first",
    );
    await until(() => calls.length === 2);
    assert.deepEqual(calls, [
      "allow",
      JSON.stringify([{ type: "text", text: "probed" }]),
    ]);
    assert.deepEqual(await atVerdict, ["a1", "a2", "a3"]);
    assert.deepEqual(await atTool, ["b1", "b2"]);
    done.open();
    assert.equal((await iterator.next()).done, true);
  } finally {
    unhook();
    untool();
    release();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
  assert.equal(executor, undefined, "the ended engine released the slot");
});

test("a second epoch serves the session's tools through its own engine, and list_changed reaches it", async () => {
  const { session, queries } = makeSession();
  try {
    const adapter = session.createRuntimeAdapter();
    const before = opens();
    const first = adapter.prompt("first epoch");
    await until(() => queries.length === 1);
    const called = await (
      await queries[0]!.mcp()
    ).callTool({ name: "current_time", arguments: {} });
    assert.notEqual(called.isError, true);
    queries[0]!.output.emit(result("epoch-one"));
    await first;
    await until(() => inProcessWorkerEnginesForTests() === 0);

    const second = adapter.prompt("second epoch");
    await until(() => queries.length === 2);
    assert.equal(opens() - before, 2);
    assert.equal(inProcessWorkerEnginesForTests(), 1);
    const client = await queries[1]!.mcp();
    const again = await client.callTool({
      name: "current_time",
      arguments: {},
    });
    assert.notEqual(again.isError, true);
    session.setMode("plan");
    await until(() => queries[1]!.listChanged === 1);
    queries[1]!.output.emit(result("epoch-two"));
    await second;
  } finally {
    session.dispose();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

test("a standalone /compact opens one engine and reports the summary its hook captured before any message", async () => {
  const summary = "## Summary\n\nHosted.";
  const before = opens();
  serial += 1;
  const session = new ClaudeSdkSession(`claude-hosted-compact-${serial}`, {
    seam: async () => ({
      query(params) {
        const hooks = params.options?.hooks?.PostCompact ?? [];
        return {
          async *[Symbol.asyncIterator]() {
            for (const matcher of hooks)
              for (const hook of matcher.hooks)
                await hook(
                  {
                    hook_event_name: "PostCompact",
                    compact_summary: summary,
                  } as never,
                  undefined,
                  { signal: new AbortController().signal },
                );
            yield {
              type: "system",
              subtype: "compact_boundary",
              session_id: "provider-hosted",
              uuid: "boundary",
              compact_metadata: { trigger: "manual", pre_tokens: 10 },
            } as unknown as ClaudeSdkMessage;
            yield result("compacted");
          },
        };
      },
    }),
    providerSessionId: "provider-hosted",
    title: "Hosted compact",
    agentType: "workshop",
  });
  try {
    const outcome = await session.compactContext();
    assert.equal(opens() - before, 1);
    assert.equal(outcome.kind, "compacted");
    if (outcome.kind === "compacted") assert.equal(outcome.summary, summary);
  } finally {
    session.dispose();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

test("a Stop while a standalone /compact loads the SDK aborts the hosted query it then opens", async () => {
  const held = gate();
  let loads = 0;
  const queries: FakeQuery[] = [];
  const seam: ClaudeSdkSeam = {
    query(params) {
      const query = new FakeQuery(params);
      queries.push(query);
      return query;
    },
  };
  serial += 1;
  const session = new ClaudeSdkSession(`claude-hosted-compact-${serial}`, {
    // The session's own load, which the test holds, then the Worker's.
    seam: async () => {
      loads += 1;
      if (loads === 1) await held.wait;
      return seam;
    },
    providerSessionId: "provider-hosted",
    title: "Hosted compact",
    agentType: "workshop",
  });
  const before = opens();
  try {
    session.beginSyntheticTool("/compact", {
      command: "/compact",
      rawArgs: "",
    });
    const compacting = session.compactContext().then(
      () => undefined,
      (error: unknown) => error,
    );
    await until(() => loads === 1);
    session.abort();
    held.open();
    await until(() => queries.length === 1);
    await until(() => queries[0]!.abortObserved);
    const error = await compacting;
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Compaction was stopped.");
    assert.equal(opens() - before, 1);
    await until(() => inProcessWorkerEnginesForTests() === 0);
  } finally {
    queries[0]?.output.close();
    session.dispose();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

test.each([
  [
    "a throwing query",
    (): ClaudeQuery => {
      throw new Error("query construction failed");
    },
  ],
  [
    "a failing iterator",
    (): ClaudeQuery => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("the stream broke")),
      }),
    }),
  ],
] as const)(
  "%s fails the turn with its own message and leaves no engine",
  async (label, query) => {
    const { session } = makeSession({ seam: { query } });
    try {
      const outcome = await session.createRuntimeAdapter().prompt("fail");
      assert.equal(outcome.stopReason, "error");
      assert.equal(
        outcome.errorMessage,
        label === "a throwing query"
          ? "query construction failed"
          : "the stream broke",
      );
      await until(() => inProcessWorkerEnginesForTests() === 0);
    } finally {
      session.dispose();
    }
  },
);

test("a Stop during the open leaves no turn and no engine, and the next prompt opens normally", async () => {
  const held = gate();
  let loads = 0;
  const queries: FakeQuery[] = [];
  const seam: ClaudeSdkSeam = {
    query(params) {
      const query = new FakeQuery(params);
      queries.push(query);
      return query;
    },
  };
  const { session } = makeSession({
    // The session's own load, then the Worker's, which the test holds once.
    seam: async () => {
      loads += 1;
      if (loads === 2) await held.wait;
      return seam;
    },
  });
  try {
    const adapter = session.createRuntimeAdapter();
    let sent: Payload | undefined;
    const disarm = answerNextInProcessWorkerCallForTests(
      ENGINE_METHODS.open,
      (payload, signal, real) => {
        sent = payload;
        return real(payload, signal);
      },
    );
    const stopped = adapter.prompt("stopped while opening");
    await until(() => loads === 2);
    disarm();
    const tmp = (
      decodeEngineOpen(sent!).spec as {
        env: { set: { TMPDIR: string } };
      }
    ).env.set.TMPDIR;
    assert.ok(existsSync(tmp));
    session.abort();
    held.open();
    await stopped;
    assert.equal(session.isRunning, false);
    await until(() => inProcessWorkerEnginesForTests() === 0);
    await until(() => !existsSync(tmp));
    assert.equal(queries[0]!.closeCalls, 1, "the discarded query closed once");

    const next = adapter.prompt("after the Stop");
    await until(() => queries.length === 2);
    queries[1]!.output.emit(result("after-stop"));
    assert.equal((await next).stopReason, "end");
  } finally {
    session.dispose();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

test("aborting the session's controller aborts the hosted query's", async () => {
  let observed: FakeQuery | undefined;
  const { handle, abort, release } = await openDirect((params) => {
    observed = new FakeQuery(params);
    return observed;
  });
  try {
    const drained = (async () => {
      for await (const _ of handle);
    })();
    await until(() => observed !== undefined);
    abort.abort();
    await until(() => observed!.abortObserved);
    await drained;
  } finally {
    release();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

test("a signal aborted before the open answered aborts the hosted query", async () => {
  let observed: FakeQuery | undefined;
  const abort = new AbortController();
  abort.abort();
  const { handle, release } = await openDirect(
    (params) => {
      observed = new FakeQuery(params);
      return observed;
    },
    { abort },
  );
  try {
    const drained = (async () => {
      for await (const _ of handle);
    })();
    await until(() => observed?.abortObserved === true);
    await drained;
  } finally {
    observed?.output.close();
    release();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});
