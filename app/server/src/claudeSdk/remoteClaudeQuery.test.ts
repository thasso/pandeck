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
// Synthetic fixture values; not real credentials.
const CLAUDE_ACCESS = "fake-claude-access";
const LEASE_TOKEN = `${"aGVhZGVy"}.${"cGF5bG9hZA"}.${"c2VjcmV0"}`;
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
const { startGatewayLinkForTests } = await import("../test/gatewayLink.ts");
const { installedGatewayLink } = await import("../gatewayLink.ts");
type LeaseRecord = import("../gateway/leases.ts").LeaseRecord;
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
      // No profile runs as the default's DATA_DIR account, link or not.
      const runsAs = profileId ?? profiles.DEFAULT_CLAUDE_PROFILE_ID;
      assert.deepEqual(spec.env.profile, {
        configDir: profiles.claudeConfigDir(runsAs),
      });
      assert.equal("gateway" in decodeEngineOpen(sent), false);

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
          ...profiles.claudeProfileEnvironment(runsAs),
          TMPDIR: tmp,
          CLAUDE_CODE_TMPDIR: tmp,
        },
      }).env;
      assert.deepEqual(env, expected);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.CLAUDE_CONFIG_DIR, profiles.claudeConfigDir(runsAs));
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

/** A turn's environment with the switch off, as the env test above builds it. */
function switchOffEnv(profileId: string, tmp: string): Record<string, string> {
  return buildClaudeSdkQueryOptions({
    cwd: dataDir,
    modelId: "sonnet",
    thinkingLevel: "medium",
    abortController: new AbortController(),
    env: {
      ...profiles.claudeProfileEnvironment(profileId),
      TMPDIR: tmp,
      CLAUDE_CODE_TMPDIR: tmp,
    },
  }).env as Record<string, string>;
}

/** The three variables a gateway engine adds, and the rest of its env. */
function splitGatewayEnv(env: Record<string, string | undefined>): {
  gateway: Record<string, string | undefined>;
  rest: Record<string, string | undefined>;
} {
  const {
    ANTHROPIC_BASE_URL,
    CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    ...rest
  } = env;
  return {
    gateway: {
      ANTHROPIC_BASE_URL,
      CLAUDE_CODE_OAUTH_TOKEN,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    },
    rest,
  };
}

/** One hosted query opened directly, on a session binding of its own. */
/** `spec` with its env's profile removed. */
function withoutProfile(
  spec: Record<string, unknown>,
): Record<string, unknown> {
  const { profile: _profile, ...env } = spec.env as Record<string, unknown>;
  return { ...spec, env };
}

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
  let admittedEpoch: string | undefined;
  const untool = registerAppToolSession(sessionId, {
    resolve: () => probe,
    session: () => ({}) as never,
    onExecute: (_name, epoch) => {
      admittedEpoch = epoch;
    },
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
    assert.equal(
      admittedEpoch,
      "epoch-ordered",
      "the server can fence the calling query, not a newer session epoch",
    );
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

test("with a gateway link, a profiled session's turns, its account switch and a standalone /compact each hold a lease the session owns", async () => {
  const gateway = await startGatewayLinkForTests();
  const live = () =>
    gateway.engineLeases().filter((record) => record.revoked === undefined);
  const lease = (leaseId: string) =>
    gateway.engineLeases().find((record) => record.leaseId === leaseId);
  /** The live lease an engine's token names, if the gateway accepts it. */
  const leaseOf = (token: string | undefined) => {
    const check = gateway.link.gateway!.leases.verify(token);
    return check.ok ? check.leaseId : undefined;
  };
  const a = claudeProfile("Leased A");
  const b = claudeProfile("Leased B");
  for (const id of [a, b])
    writeFileSync(
      join(profiles.claudeConfigDir(id), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: `${CLAUDE_ACCESS}` } }),
    );
  /** The live engine leases when each query started, in the Worker. */
  const atQuery: LeaseRecord[][] = [];
  const queries: FakeQuery[] = [];
  const seam: ClaudeSdkSeam = {
    query(params) {
      atQuery.push(live());
      const query = new FakeQuery(params);
      queries.push(query);
      return query;
    },
  };
  const { session } = makeSession({ credentialProfileId: a, seam });
  try {
    const adapter = session.createRuntimeAdapter();
    const first = adapter.prompt("first");
    await until(() => queries.length === 1);
    assert.equal(atQuery[0]!.length, 1);
    const [turn] = atQuery[0]!;
    assert.equal(turn!.profileId, a);
    assert.deepEqual(turn!.owner, { workerId: "local", sessionId: session.id });
    // Only the three gateway variables differ from the switch-off env.
    const firstEnv = splitGatewayEnv(queries[0]!.env);
    assert.deepEqual(firstEnv.gateway, {
      ANTHROPIC_BASE_URL: `${gateway.link.gateway!.url}/anthropic`,
      CLAUDE_CODE_OAUTH_TOKEN: firstEnv.gateway.CLAUDE_CODE_OAUTH_TOKEN,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    assert.equal(
      leaseOf(firstEnv.gateway.CLAUDE_CODE_OAUTH_TOKEN),
      turn!.leaseId,
    );
    assert.deepEqual(firstEnv.rest, switchOffEnv(a, queries[0]!.env.TMPDIR!));
    assert.equal(firstEnv.rest.CLAUDE_CONFIG_DIR, profiles.claudeConfigDir(a));
    assert.ok(!Object.values(queries[0]!.env).includes(SENTINEL));
    queries[0]!.output.emit(result("leased-first"));
    await first;
    await until(() => lease(turn!.leaseId)?.revoked === "session-ended");

    // The switch: the next turn's engine holds B's lease; A's has ended.
    const project = join(profiles.claudeConfigDir(a), "projects", "leased");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "provider-hosted.jsonl"), "{}\n");
    await session.switchAccount(b, () => {});
    const second = adapter.prompt("second");
    await until(() => queries.length === 2);
    assert.equal(atQuery[1]!.length, 1);
    const [switched] = atQuery[1]!;
    assert.equal(switched!.profileId, b);
    assert.deepEqual(switched!.owner, {
      workerId: "local",
      sessionId: session.id,
    });
    assert.equal(lease(turn!.leaseId)?.revoked, "session-ended");
    const secondEnv = queries[1]!.env;
    assert.equal(leaseOf(secondEnv.CLAUDE_CODE_OAUTH_TOKEN), switched!.leaseId);
    assert.notEqual(
      secondEnv.CLAUDE_CODE_OAUTH_TOKEN,
      firstEnv.gateway.CLAUDE_CODE_OAUTH_TOKEN,
    );
    assert.equal(secondEnv.CLAUDE_CONFIG_DIR, profiles.claudeConfigDir(b));
    queries[1]!.output.emit(result("leased-second"));
    await second;
    await until(() => lease(switched!.leaseId)?.revoked === "session-ended");
  } finally {
    session.dispose();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);

  // A standalone /compact holds a lease for the session's profile.
  serial += 1;
  const compacting = new ClaudeSdkSession(`claude-leased-compact-${serial}`, {
    seam: async () => ({
      query() {
        atQuery.push(live());
        return {
          async *[Symbol.asyncIterator]() {
            yield result("compacted");
          },
        };
      },
    }),
    providerSessionId: "provider-hosted",
    title: "Leased compact",
    agentType: "workshop",
    credentialProfileId: a,
  });
  try {
    await compacting.compactContext();
    assert.equal(atQuery[2]!.length, 1);
    const [compact] = atQuery[2]!;
    assert.equal(compact!.profileId, a);
    assert.deepEqual(compact!.owner, {
      workerId: "local",
      sessionId: compacting.id,
    });
    await until(() => lease(compact!.leaseId)?.revoked === "session-ended");
  } finally {
    compacting.dispose();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);

  // A session without a profile runs as claude-default (U12): one lease
  // the session owns, the default profile's scrubbed env, its records as
  // they were.
  const granted = gateway.engineLeases().length;
  const plain = makeSession();
  try {
    const turn = plain.session.createRuntimeAdapter().prompt("unprofiled");
    await until(() => plain.queries.length === 1);
    const leases = gateway.engineLeases().slice(granted);
    assert.equal(leases.length, 1);
    const [unprofiled] = leases;
    assert.equal(unprofiled!.profileId, profiles.DEFAULT_CLAUDE_PROFILE_ID);
    assert.deepEqual(unprofiled!.owner, {
      workerId: "local",
      sessionId: plain.session.id,
    });
    const env = plain.queries[0]!.env;
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(!Object.values(env).includes(SENTINEL));
    assert.equal(
      env.CLAUDE_CONFIG_DIR,
      profiles.claudeConfigDir(profiles.DEFAULT_CLAUDE_PROFILE_ID),
    );
    assert.equal(
      env.ANTHROPIC_BASE_URL,
      `${gateway.link.gateway!.url}/anthropic`,
    );
    assert.equal(leaseOf(env.CLAUDE_CODE_OAUTH_TOKEN), unprofiled!.leaseId);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.ok(env.TMPDIR);
    // Exactly what the default profile's session gets with the switch off.
    assert.deepEqual(
      splitGatewayEnv(env).rest,
      switchOffEnv(profiles.DEFAULT_CLAUDE_PROFILE_ID, env.TMPDIR),
    );
    plain.queries[0]!.output.emit(result("unprofiled"));
    await turn;
    await until(() => lease(unprofiled!.leaseId)?.revoked === "session-ended");
    assert.equal(plain.session.credentialProfileId, undefined);
    assert.equal(
      sessionStore.get(plain.session.id)?.credentialProfileId,
      undefined,
    );
  } finally {
    plain.session.dispose();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);

  // And its standalone /compact, too.
  serial += 1;
  let compactEnv: Record<string, string | undefined> = {};
  const compactingPlain = new ClaudeSdkSession(
    `claude-unprofiled-compact-${serial}`,
    {
      seam: async () => ({
        query(params) {
          atQuery.push(live());
          compactEnv = params.options?.env ?? {};
          return {
            async *[Symbol.asyncIterator]() {
              yield result("compacted-unprofiled");
            },
          };
        },
      }),
      providerSessionId: "provider-hosted",
      title: "Unprofiled compact",
      agentType: "workshop",
    },
  );
  try {
    await compactingPlain.compactContext();
    const [compact] = atQuery.at(-1)!;
    assert.equal(compact!.profileId, profiles.DEFAULT_CLAUDE_PROFILE_ID);
    assert.deepEqual(compact!.owner, {
      workerId: "local",
      sessionId: compactingPlain.id,
    });
    assert.equal(leaseOf(compactEnv.CLAUDE_CODE_OAUTH_TOKEN), compact!.leaseId);
    assert.equal(compactEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(
      compactEnv.CLAUDE_CONFIG_DIR,
      profiles.claudeConfigDir(profiles.DEFAULT_CLAUDE_PROFILE_ID),
    );
    await until(() => lease(compact!.leaseId)?.revoked === "session-ended");
    assert.equal(compactingPlain.credentialProfileId, undefined);
  } finally {
    compactingPlain.dispose();
    profiles.setCredentialProfileEnabled(a, false);
    profiles.setCredentialProfileEnabled(b, false);
    await gateway.close();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

test("without a link, a session with no account still runs as the default's DATA_DIR account, scrubbed and unleased", async () => {
  assert.equal(installedGatewayLink(), undefined);
  const { session, queries } = makeSession();
  let sent: Payload | undefined;
  const disarm = answerNextInProcessWorkerCallForTests(
    ENGINE_METHODS.open,
    (payload, signal, real) => {
      sent = payload;
      return real(payload, signal);
    },
  );
  try {
    const turn = session.createRuntimeAdapter().prompt("off");
    await until(() => queries.length === 1);
    assert.equal("gateway" in decodeEngineOpen(sent!), false);
    const env = queries[0]!.env;
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(!Object.values(env).includes(SENTINEL));
    assert.equal(
      env.CLAUDE_CONFIG_DIR,
      profiles.claudeConfigDir(profiles.DEFAULT_CLAUDE_PROFILE_ID),
    );
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
    queries[0]!.output.emit(result("off"));
    await turn;
    assert.equal(session.credentialProfileId, undefined);
    assert.equal(sessionStore.get(session.id)?.credentialProfileId, undefined);
  } finally {
    disarm();
    session.dispose();
  }
  await until(() => inProcessWorkerEnginesForTests() === 0);
});

test("a Claude engine opened with gateway access and no profile is refused before any query", async () => {
  let queried = 0;
  // The server always sends a profile now (a session with none runs as the
  // default); the Worker still refuses an open that lacks one.
  const disarm = answerNextInProcessWorkerCallForTests(
    ENGINE_METHODS.open,
    (payload, signal, real) =>
      real(
        {
          ...payload,
          json: {
            ...(payload.json as object),
            spec: withoutProfile(
              (payload.json as { spec: Record<string, unknown> }).spec,
            ),
            gateway: {
              baseUrl: "http://127.0.0.1:8788",
              leaseToken: LEASE_TOKEN,
            },
          },
        },
        signal,
      ),
  );
  try {
    await assert.rejects(
      openDirect(() => {
        queried += 1;
        return new FakeQuery({ prompt: "" });
      }),
      /a gateway Claude engine needs a credential profile/i,
    );
  } finally {
    disarm();
  }
  assert.equal(queried, 0);
  await until(() => inProcessWorkerEnginesForTests() === 0);
});
