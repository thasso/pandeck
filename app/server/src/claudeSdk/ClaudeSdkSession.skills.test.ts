import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { SessionSkillInvocation } from "@assistant/shared";
import {
  skillRuntimePluginName,
  skillSetHash,
} from "../skills/skillRuntimeMaterializer.ts";
import { SKILLS_RUNTIME_DIR } from "../config.ts";
import type {
  ClaudeQuery,
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";

const mocked = vi.hoisted(() => ({
  names: new Map<string, string[]>(),
}));

vi.mock("../sessionSkills.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activeSkillsForSession: (sessionId: string) =>
    mocked.names.get(sessionId) ?? [],
}));

const { ClaudeSdkSession } = await import("./ClaudeSdkSession.ts");
const { getSettings, updateSettings } = await import("../settings.ts");
const { fallbackSessionTitle } = await import("../sessionNaming.ts");

// Visible prompts here name their session: the deterministic fallback, never
// a naming model.
updateSettings({
  sessionNaming: { ...getSettings().sessionNaming, enabled: false },
});

const sessions: InstanceType<typeof ClaudeSdkSession>[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  mocked.names.clear();
});

function captureSeam(calls: ClaudeQueryParams[]): ClaudeSdkSeam {
  return {
    query(params) {
      calls.push(params);
      return {
        async *[Symbol.asyncIterator]() {
          // An empty fake stream is sufficient to inspect each query's options.
        },
      };
    },
  };
}

function makeSession(
  id: string,
  agentType: "developer" | "workshop" | "assistant",
  calls: ClaudeQueryParams[],
  preparations: string[][],
  providerSessionId?: string,
) {
  const session = new ClaudeSdkSession(id, {
    seam: () => Promise.resolve(captureSeam(calls)),
    agentType,
    ...(providerSessionId ? { providerSessionId } : {}),
    prepareSkillRuntime: async (names) => {
      preparations.push([...names]);
    },
  });
  sessions.push(session);
  return session;
}

async function hiddenPrompt(
  session: InstanceType<typeof ClaudeSdkSession>,
): Promise<void> {
  await session.createRuntimeAdapter().prompt("inspect skills", {
    hidden: true,
  });
}

function pluginPath(call: ClaudeQueryParams): string | undefined {
  return (call.options?.plugins as Array<{ path: string }> | undefined)?.[0]
    ?.path;
}

test("fresh, resumed, and forked coding queries reuse and prepare the frozen skill set", async () => {
  for (const scenario of [
    { id: "skills-fresh", providerSessionId: undefined },
    { id: "skills-resumed", providerSessionId: "provider-resumed" },
    { id: "skills-forked", providerSessionId: "provider-forked" },
  ]) {
    mocked.names.set(scenario.id, ["frozen-skill"]);
    const calls: ClaudeQueryParams[] = [];
    const preparations: string[][] = [];
    const session = makeSession(
      scenario.id,
      "developer",
      calls,
      preparations,
      scenario.providerSessionId,
    );

    await hiddenPrompt(session);
    assert.deepEqual(preparations, [["frozen-skill"]]);
    assert.match(pluginPath(calls[0]!) ?? "", /skills-runtime\/[0-9a-f]{64}$/);
    assert.equal(
      calls[0]!.options?.resume,
      scenario.providerSessionId,
      `${scenario.id} keeps its provider resume identity`,
    );
  }
});

test("every resumed query recreates the runtime, while empty and assistant sessions mount nothing", async () => {
  mocked.names.set("skills-repeat", ["frozen-skill"]);
  const repeatCalls: ClaudeQueryParams[] = [];
  const repeatPreparations: string[][] = [];
  const repeat = makeSession(
    "skills-repeat",
    "workshop",
    repeatCalls,
    repeatPreparations,
    "provider-repeat",
  );
  await hiddenPrompt(repeat);
  await hiddenPrompt(repeat);
  assert.deepEqual(repeatPreparations, [["frozen-skill"], ["frozen-skill"]]);
  assert.equal(repeatCalls.length, 2);
  assert.equal(pluginPath(repeatCalls[0]!), pluginPath(repeatCalls[1]!));

  mocked.names.set("skills-empty", []);
  const emptyCalls: ClaudeQueryParams[] = [];
  const emptyPreparations: string[][] = [];
  await hiddenPrompt(
    makeSession("skills-empty", "developer", emptyCalls, emptyPreparations),
  );
  assert.deepEqual(emptyPreparations, []);
  assert.equal(emptyCalls[0]!.options?.plugins, undefined);

  // The mocked read is deliberately hostile here: persona gating must still be
  // authoritative even if a caller or corrupt row appears to supply names.
  mocked.names.set("skills-assistant", ["frozen-skill"]);
  const assistantCalls: ClaudeQueryParams[] = [];
  const assistantPreparations: string[][] = [];
  await hiddenPrompt(
    makeSession(
      "skills-assistant",
      "assistant",
      assistantCalls,
      assistantPreparations,
    ),
  );
  assert.deepEqual(assistantPreparations, []);
  assert.equal(assistantCalls[0]!.options?.plugins, undefined);
  assert.deepEqual(assistantCalls[0]!.options?.settingSources, []);
});

test("manual compaction is explicitly skill-free and does not recreate a runtime", async () => {
  mocked.names.set("skills-compact", ["frozen-skill"]);
  const calls: ClaudeQueryParams[] = [];
  const preparations: string[][] = [];
  const session = makeSession(
    "skills-compact",
    "developer",
    calls,
    preparations,
    "provider-compact",
  );

  const outcome = await session.compactContext();
  assert.equal(outcome.kind, "skipped");
  assert.deepEqual(preparations, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.options?.tools, []);
  assert.equal(calls[0]!.options?.plugins, undefined);
});

/* ----------------------- user `/<skill>` invocations ---------------------- */

const FROZEN = ["alpha"];
const PLUGIN = skillRuntimePluginName(skillSetHash(FROZEN));
const REGISTERED = `${PLUGIN}:alpha`;
const COMMAND = `/${REGISTERED}`;

class OutputQueue implements AsyncIterable<ClaudeSdkMessage> {
  private readonly values: ClaudeSdkMessage[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<ClaudeSdkMessage>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | undefined;

  emit(message: ClaudeSdkMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: message, done: false });
    else this.values.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter.resolve({ value: undefined, done: true });
  }

  /** The stream throws, as the SDK does on a provider-limit error result. */
  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) =>
          this.waiters.push({ resolve, reject }),
        );
      },
    };
  }
}

/** What the CLI registered, and a gate the test holds its answer on. */
interface CommandRegistry {
  commands: string[];
  gate: Promise<void> | undefined;
  calls: number;
}

class GatedQuery implements ClaudeQuery {
  readonly output = new OutputQueue();
  readonly inputs: ClaudeSdkUserMessage[] = [];
  closeCalls = 0;

  constructor(
    readonly params: ClaudeQueryParams,
    private readonly registry: CommandRegistry,
  ) {
    params.options?.abortController?.signal.addEventListener("abort", () =>
      this.output.close(),
    );
    void this.consumeInput();
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return this.output[Symbol.asyncIterator]();
  }

  async supportedCommands(): Promise<Array<{ name: string }>> {
    this.registry.calls += 1;
    await this.registry.gate;
    return this.registry.commands.map((name) => ({ name }));
  }

  close(): void {
    this.closeCalls += 1;
    this.output.close();
  }

  async interrupt(): Promise<void> {}
  async cancelAsyncMessage(): Promise<boolean> {
    return true;
  }
  async setModel(): Promise<void> {}
  async setMaxThinkingTokens(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}

  private async consumeInput(): Promise<void> {
    if (typeof this.params.prompt === "string") return;
    for await (const message of this.params.prompt) this.inputs.push(message);
  }
}

function uuidOf(message: ClaudeSdkUserMessage | undefined): string {
  const uuid = (message as { uuid?: string } | undefined)?.uuid;
  assert.ok(uuid, "every input is uuid-stamped");
  return uuid;
}

function textOf(message: ClaudeSdkUserMessage | undefined): string {
  const content = (message as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? "")
    .join("");
}

function init(): ClaudeSdkMessage {
  return {
    type: "system",
    subtype: "init",
    capabilities: ["msg_lifecycle_v1"],
    uuid: `init-${Math.random()}`,
    session_id: "provider-skill",
  } as unknown as ClaudeSdkMessage;
}

function started(uuid: string): ClaudeSdkMessage {
  return {
    type: "command_lifecycle",
    command_uuid: uuid,
    state: "started",
    uuid: `lifecycle-${uuid}`,
    session_id: "provider-skill",
  } as unknown as ClaudeSdkMessage;
}

function result(
  uuid: string,
  consumed: string[],
  extra: Record<string, unknown> = {},
): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "provider-skill",
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
    user_message_uuids: consumed,
    ...extra,
  } as unknown as ClaudeSdkMessage;
}

/** A real model answer: streamed text, then its committed message. */
function reply(text: string, id = `msg-${Math.random()}`): ClaudeSdkMessage[] {
  const stream = (event: unknown) =>
    ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: `evt-${Math.random()}`,
      session_id: "provider-skill",
    }) as unknown as ClaudeSdkMessage;
  return [
    stream({ type: "message_start", message: { id, usage: {} } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    {
      type: "assistant",
      uuid: `asst-${id}`,
      session_id: "provider-skill",
      message: {
        id,
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as unknown as ClaudeSdkMessage,
  ];
}

/** The CLI's own message for a limit it hit: no model wrote it. */
function synthetic(error?: string): ClaudeSdkMessage {
  return {
    type: "assistant",
    uuid: `synthetic-${Math.random()}`,
    session_id: "provider-skill",
    ...(error ? { error } : {}),
    message: {
      id: "synthetic-message",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: "You've hit your session limit" }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as unknown as ClaudeSdkMessage;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 5_000; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

type Internals = {
  frozenSkillNames: () => string[];
  steer(text: string): Promise<unknown>;
  pendingSteers: Map<string, unknown>;
  skillSubmission: object | undefined;
  retainedEpochKey: string | undefined;
  queryEpochKey: string | undefined;
  skillTurnNativeResponse: boolean;
  skillInvocations(names: string[]): SessionSkillInvocation[];
};

let skillSerial = 0;
function skillHarness(
  options: {
    providerSessionId?: string;
    /** Awaited before each process start, inside the submission's own setup. */
    beforeSeam?: () => Promise<void>;
    prepareSkillRuntime?: () => Promise<void>;
    /** The SDK refuses to start the process. */
    failStart?: boolean;
  } = {},
) {
  skillSerial += 1;
  const id = `skill-command-${skillSerial}`;
  const registry: CommandRegistry = {
    commands: [REGISTERED],
    gate: undefined,
    calls: 0,
  };
  const queries: GatedQuery[] = [];
  const seam: ClaudeSdkSeam = {
    query(params) {
      if (options.failStart) throw new Error("spawn claude ENOENT");
      const query = new GatedQuery(params, registry);
      queries.push(query);
      return query;
    },
  };
  const session = new ClaudeSdkSession(id, {
    seam: async () => {
      await options.beforeSeam?.();
      return seam;
    },
    agentType: "assistant",
    prepareSkillRuntime: options.prepareSkillRuntime ?? (async () => {}),
    ...(options.providerSessionId
      ? { providerSessionId: options.providerSessionId }
      : {}),
  });
  sessions.push(session);
  const internals = session as unknown as Internals;
  internals.frozenSkillNames = () => FROZEN;
  const hold = () => {
    let release!: () => void;
    registry.gate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      registry.gate = undefined;
      release();
    };
  };
  return {
    id,
    session,
    internals,
    registry,
    queries,
    hold,
    adapter: session.createRuntimeAdapter(),
  };
}

type SkillHarness = ReturnType<typeof skillHarness>;

function skillPrompt(h: SkillHarness, context = "<memory>ctx</memory>") {
  return h.adapter.prompt(`${COMMAND} the parser`, {
    skillCommand: "alpha",
    ...(context ? { turnContext: context } : {}),
    titleText: "/alpha the parser",
  });
}

function messageEntries(session: InstanceType<typeof ClaudeSdkSession>) {
  return session
    .toRecord()
    .entries.filter(
      (entry): entry is Extract<typeof entry, { type: "message" }> =>
        entry.type === "message",
    );
}

/** The trail now, and as a session restored from the persisted entries reads it. */
function trails(h: SkillHarness): SessionSkillInvocation[][] {
  const restored = new ClaudeSdkSession(`${h.id}-restored`, {
    seam: async () => ({
      query: () => {
        throw new Error("a restored session is only read here");
      },
    }),
    agentType: "assistant",
    entries: h.session.toRecord().entries,
  });
  sessions.push(restored);
  return [
    h.internals.skillInvocations(FROZEN),
    (restored as unknown as Internals).skillInvocations(FROZEN),
  ];
}

function nativeResponses(h: SkillHarness): number {
  return messageEntries(h.session).filter(
    (entry) => entry.role === "assistant" && entry.nativeResponse,
  ).length;
}

test("a skill turn sends context then command once registered, and settles only on the command", async () => {
  const h = skillHarness();
  const release = h.hold();
  let done = false;
  const turn = skillPrompt(h).then((outcome) => {
    done = true;
    return outcome;
  });
  await until(() => h.registry.calls === 1);
  assert.equal(h.queries[0]!.inputs.length, 0, "nothing reaches the CLI yet");
  release();
  const query = h.queries[0]!;
  await until(() => query.inputs.length === 2);
  const [context, command] = query.inputs;
  assert.equal((context as { shouldQuery?: boolean }).shouldQuery, false);
  assert.equal(textOf(context), "<memory>ctx</memory>");
  assert.equal(textOf(command), `${COMMAND} the parser`);

  // The context message's own 0-turn result neither starts nor ends the turn.
  query.output.emit(init());
  query.output.emit(started(uuidOf(context)));
  query.output.emit(result("context", [uuidOf(context)], { num_turns: 0 }));
  await settle();
  assert.equal(done, false);

  query.output.emit(started(uuidOf(command)));
  // Once the command is in, an ordinary steer goes in as today.
  const steer = h.adapter.prompt("steer me", { steer: true });
  await until(() => query.inputs.length === 3);
  query.output.emit(started(uuidOf(query.inputs[2])));
  assert.deepEqual(await steer, { stopReason: "end", steerDelivery: "steer" });
  for (const message of reply("Explained.")) query.output.emit(message);
  query.output.emit(
    result("command", [uuidOf(command), uuidOf(query.inputs[2])]),
  );
  assert.equal((await turn).stopReason, "end");

  const entries = messageEntries(h.session);
  const user = entries.find((entry) => entry.role === "user");
  assert.equal(user?.role === "user" && user.skillCommand, "alpha");
  assert.deepEqual(user?.content, [
    { type: "text", text: "/alpha the parser" },
  ]);
  assert.ok(
    !JSON.stringify(entries).includes(PLUGIN) &&
      !JSON.stringify(entries).includes("<memory>"),
    "the native token and the context stay model-only",
  );
  assert.equal(nativeResponses(h), 1);
  assert.equal(h.session.title, fallbackSessionTitle("/alpha the parser", []));
  for (const trail of trails(h))
    assert.deepEqual(
      trail.map(({ name, via }) => `${via}:${name}`),
      ["command:alpha"],
    );
});

test("the registration gate holds steers on cold, resumed and retained processes", async () => {
  for (const scenario of ["cold", "resumed", "retained"] as const) {
    const h = skillHarness(
      scenario === "resumed" ? { providerSessionId: "provider-resumed" } : {},
    );
    let before = 0;
    if (scenario === "retained") {
      // A process kept alive past its turn takes the next prompt directly.
      const first = h.adapter.prompt("first");
      await until(() => h.queries[0]?.inputs.length === 1);
      h.internals.retainedEpochKey = h.internals.queryEpochKey;
      const query = h.queries[0]!;
      query.output.emit(init());
      query.output.emit(started(uuidOf(query.inputs[0])));
      query.output.emit(result("first", [uuidOf(query.inputs[0])]));
      await first;
      before = 1;
    }
    const release = h.hold();
    const turn = skillPrompt(h);
    await until(() => h.registry.calls === 1);
    const query = h.queries[0]!;
    assert.equal(h.queries.length, 1, `${scenario}: one process`);
    const userRows = () =>
      messageEntries(h.session).filter((entry) => entry.role === "user").length;
    const rowsBefore = userRows();
    assert.equal(
      await h.internals.steer("not now"),
      "refused",
      `${scenario}: a steer during the gate is refused`,
    );
    assert.equal(h.internals.pendingSteers.size, 0);
    assert.equal(userRows(), rowsBefore, `${scenario}: no steer row`);
    assert.equal(query.inputs.length, before, `${scenario}: nothing sent yet`);

    release();
    await until(() => query.inputs.length === before + 2);
    assert.equal(
      textOf(query.inputs[before]),
      "<memory>ctx</memory>",
      `${scenario}: the context goes first`,
    );
    assert.equal(textOf(query.inputs[before + 1]), `${COMMAND} the parser`);
    assert.equal(h.internals.skillSubmission, undefined);
    const command = uuidOf(query.inputs[before + 1]);
    if (scenario !== "retained") query.output.emit(init());
    query.output.emit(started(command));
    for (const message of reply("Done.")) query.output.emit(message);
    query.output.emit(result("command", [command]));
    assert.equal((await turn).stopReason, "end", scenario);
    h.internals.retainedEpochKey = undefined;
  }
});

test("a stopped submission's late exit leaves the next one guarded (C2)", async () => {
  let starts = 0;
  let releaseSetup!: () => void;
  const setup = new Promise<void>((resolve) => (releaseSetup = resolve));
  const h = skillHarness({
    beforeSeam: async () => {
      starts += 1;
      if (starts === 1) await setup;
    },
  });
  // A is stopped while its submission awaits its process setup.
  const a = skillPrompt(h, "<memory>A</memory>");
  await until(() => starts === 1);
  assert.ok(h.internals.skillSubmission, "A guards from its first step");
  h.session.abort();
  // B reaches the registration gate and is held there.
  const release = h.hold();
  const b = skillPrompt(h, "<memory>B</memory>");
  await until(() => h.registry.calls === 1);
  // A's stale continuation finishes now.
  releaseSetup();
  await a;
  await settle();
  assert.ok(h.internals.skillSubmission, "B's submission still guards");
  assert.equal(await h.internals.steer("not now"), "refused");
  assert.equal(h.internals.pendingSteers.size, 0);

  release();
  assert.equal(h.queries.length, 1, "A never started a process");
  const query = h.queries[0]!;
  await until(() => query.inputs.length === 2);
  assert.equal(textOf(query.inputs[0]), "<memory>B</memory>");
  assert.equal(textOf(query.inputs[1]), `${COMMAND} the parser`);
  assert.equal(h.internals.skillSubmission, undefined);
  const command = uuidOf(query.inputs[1]);
  query.output.emit(init());
  query.output.emit(started(command));
  for (const message of reply("B.")) query.output.emit(message);
  query.output.emit(result("b", [command]));
  assert.equal((await b).stopReason, "end");
});

test("a gate failure or a Stop during the gate clears the guard for the next turn", async () => {
  // Unregistered: the turn fails, nothing is sent, and the orphaned process closes.
  const failed = skillHarness();
  failed.registry.commands = [];
  const outcome = await skillPrompt(failed);
  assert.equal(outcome.stopReason, "error");
  assert.match(
    outcome.errorMessage ?? "",
    /\/alpha is not available in this session's runtime\./,
  );
  assert.equal(failed.queries[0]!.inputs.length, 0);
  assert.equal(failed.internals.skillSubmission, undefined);
  assert.equal(nativeResponses(failed), 0);
  for (const trail of trails(failed)) assert.deepEqual(trail, []);

  const stopped = skillHarness();
  const release = stopped.hold();
  const turn = skillPrompt(stopped);
  await until(() => stopped.registry.calls === 1);
  stopped.session.abort();
  await turn;
  release();
  await settle();
  assert.equal(stopped.internals.skillSubmission, undefined);
  for (const query of stopped.queries) assert.equal(query.inputs.length, 0);

  // A later ordinary turn steers normally.
  const next = stopped.adapter.prompt("next");
  await until(() => stopped.queries.at(-1)!.inputs.length === 1);
  const query = stopped.queries.at(-1)!;
  query.output.emit(init());
  query.output.emit(started(uuidOf(query.inputs[0])));
  const steer = stopped.adapter.prompt("steer me", { steer: true });
  await until(() => query.inputs.length === 2);
  query.output.emit(started(uuidOf(query.inputs[1])));
  assert.deepEqual(await steer, { stopReason: "end", steerDelivery: "steer" });
  query.output.emit(
    result("next", [uuidOf(query.inputs[0]), uuidOf(query.inputs[1])]),
  );
  await next;
});

/** Run one context-less skill turn to its command start, then script the rest. */
async function commandTurn(
  h: SkillHarness,
  script: (query: GatedQuery, command: string) => void | Promise<void>,
) {
  const turn = skillPrompt(h, "");
  await until(() => h.queries[0]?.inputs.length === 1);
  const query = h.queries[0]!;
  const command = uuidOf(query.inputs[0]);
  query.output.emit(init());
  query.output.emit(started(command));
  await script(query, command);
  return turn;
}

test("a synthetic message is never the command's answer (C1)", async () => {
  // `ClaudeSdkSession.test.ts`'s limit fixture as a skill turn: the sentinel
  // carries no `error`, then the stream throws.
  const thrown = skillHarness();
  const outcome = await commandTurn(thrown, (query) => {
    query.output.emit(synthetic());
    query.output.fail(
      new Error(
        "Claude Code returned an error result: You've hit your session limit",
      ),
    );
  });
  assert.equal(outcome.stopReason, "error");
  assert.equal(nativeResponses(thrown), 0);
  for (const trail of trails(thrown)) assert.deepEqual(trail, []);

  // The error-bearing sentinel, ended by an error result.
  const flagged = skillHarness();
  const flaggedOutcome = await commandTurn(flagged, (query, command) => {
    query.output.emit(synthetic("rate_limit"));
    query.output.emit(
      result("limit", [command], { is_error: true, api_error_status: 429 }),
    );
  });
  assert.equal(flaggedOutcome.stopReason, "error");
  assert.equal(nativeResponses(flagged), 0);
  for (const trail of trails(flagged)) assert.deepEqual(trail, []);
});

test("a genuine answer counts even when the turn then fails or is stopped", async () => {
  const failing = skillHarness();
  const failed = await commandTurn(failing, (query, command) => {
    for (const message of reply("Part one.")) query.output.emit(message);
    query.output.emit(
      result("overloaded", [command], {
        is_error: true,
        api_error_status: 529,
      }),
    );
  });
  assert.equal(failed.stopReason, "error");
  assert.equal(nativeResponses(failing), 1);
  for (const trail of trails(failing))
    assert.deepEqual(
      trail.map(({ via }) => via),
      ["command"],
    );

  const aborted = skillHarness();
  const stopped = await commandTurn(aborted, async (query) => {
    for (const message of reply("Part one.")) query.output.emit(message);
    await until(() => aborted.internals.skillTurnNativeResponse);
    aborted.session.abort();
  });
  assert.equal(stopped.stopReason, "aborted");
  assert.equal(nativeResponses(aborted), 1);
  for (const trail of trails(aborted))
    assert.deepEqual(
      trail.map(({ via }) => via),
      ["command"],
    );

  // Stopped before any answer: nothing loaded.
  const early = skillHarness();
  await commandTurn(early, () => early.session.abort());
  assert.equal(nativeResponses(early), 0);
  for (const trail of trails(early)) assert.deepEqual(trail, []);
});

test("a command that failed to expand ends the turn with its stderr", async () => {
  const h = skillHarness();
  const outcome = await commandTurn(h, (query, command) => {
    query.output.emit({
      type: "user",
      isReplay: true,
      uuid: "replay-stderr",
      session_id: "provider-skill",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content:
          "<local-command-stderr>Error: alpha could not be loaded</local-command-stderr>",
      },
    } as unknown as ClaudeSdkMessage);
    query.output.emit(result("expanded", [command], { num_turns: 0 }));
  });
  assert.equal(outcome.stopReason, "error");
  assert.equal(outcome.errorMessage, "Error: alpha could not be loaded");
  assert.equal(nativeResponses(h), 0);
  for (const trail of trails(h)) assert.deepEqual(trail, []);
});

test("without lifecycle frames, the result consuming the command binds its answer", async () => {
  const h = skillHarness();
  const turn = skillPrompt(h, "");
  await until(() => h.queries[0]?.inputs.length === 1);
  const query = h.queries[0]!;
  const command = uuidOf(query.inputs[0]);
  for (const message of reply("Done.")) query.output.emit(message);
  query.output.emit(result("command", [command]));
  assert.equal((await turn).stopReason, "end");
  assert.equal(nativeResponses(h), 1);

  // An ordinary turn's answer is no skill's.
  const plain = h.adapter.prompt("plain");
  await until(() => h.queries[1]?.inputs.length === 1);
  const next = h.queries[1]!;
  const prompt = uuidOf(next.inputs[0]);
  for (const message of reply("Plain.")) next.output.emit(message);
  next.output.emit(result("plain", [prompt]));
  await plain;
  assert.equal(nativeResponses(h), 1);
  for (const trail of trails(h))
    assert.deepEqual(
      trail.map(({ via }) => via),
      ["command"],
    );
});

test("a skill turn that never reached the CLI is no load", async () => {
  const materializing = skillHarness({
    prepareSkillRuntime: async () => {
      throw new Error("the skill runtime could not be written");
    },
  });
  const unwritten = await skillPrompt(materializing);
  assert.equal(unwritten.stopReason, "error");
  assert.equal(materializing.queries.length, 0);

  const starting = skillHarness({ failStart: true });
  const unstarted = await skillPrompt(starting);
  assert.equal(unstarted.stopReason, "error");
  assert.match(unstarted.errorMessage ?? "", /ENOENT/);
  assert.equal(starting.internals.skillSubmission, undefined);

  for (const h of [materializing, starting]) {
    assert.equal(nativeResponses(h), 0);
    for (const trail of trails(h)) assert.deepEqual(trail, []);
  }
});

test("a steer the command's reply missed runs as a follow-up the skill never answers", async () => {
  const h = skillHarness();
  let steer!: Promise<unknown>;
  let steerUuid = "";
  const turn = await commandTurn(h, async (query, command) => {
    steer = h.adapter.prompt("and also", { steer: true });
    await until(() => query.inputs.length === 2);
    steerUuid = uuidOf(query.inputs[1]);
    for (const message of reply("Skill answer.")) query.output.emit(message);
    // The reply missed the steer: it continues this run as its next turn.
    query.output.emit(result("command", [command]));
    assert.deepEqual(await steer, {
      stopReason: "end",
      steerDelivery: "followUp",
    });
    query.output.emit(started(steerUuid));
    for (const message of reply("Follow-up answer."))
      query.output.emit(message);
    query.output.emit(result("follow-up", [steerUuid]));
  });
  assert.equal(turn.stopReason, "end");
  const answers = messageEntries(h.session).filter(
    (entry) => entry.role === "assistant",
  );
  assert.deepEqual(
    answers.map((entry) => entry.nativeResponse === true),
    [true, false],
    "only the command's own reply carries the flag",
  );
  for (const trail of trails(h))
    assert.deepEqual(
      trail.map(({ via }) => via),
      ["command"],
    );
});

/** A genuine answer that wrote nothing displayable. */
function emptyAnswer(id = `empty-${Math.random()}`): ClaudeSdkMessage {
  return {
    type: "assistant",
    uuid: `asst-${id}`,
    session_id: "provider-skill",
    message: {
      id,
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  } as unknown as ClaudeSdkMessage;
}

const SKILL_FILE = join(
  SKILLS_RUNTIME_DIR,
  skillSetHash(FROZEN),
  "skills",
  "alpha",
  "SKILL.md",
);

/** The model loading alpha itself, by Skill call or by reading its file, and succeeding. */
const LOADS = [
  { via: "skill_tool", name: "Skill", input: { skill: REGISTERED } },
  { via: "read", name: "Read", input: { file_path: SKILL_FILE } },
] as const;

function loadAlpha(
  load: (typeof LOADS)[number],
  toolUseId: string,
): ClaudeSdkMessage[] {
  return [
    {
      type: "assistant",
      uuid: `asst-${toolUseId}`,
      session_id: "provider-skill",
      message: {
        id: `msg-${toolUseId}`,
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: load.name,
            input: load.input,
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as unknown as ClaudeSdkMessage,
    {
      type: "user",
      uuid: `result-${toolUseId}`,
      session_id: "provider-skill",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUseId, content: "loaded" },
        ],
      },
    } as unknown as ClaudeSdkMessage,
  ];
}

test("an empty genuine answer still confirms the command durably", async () => {
  const h = skillHarness();
  const outcome = await commandTurn(h, async (query, command) => {
    query.output.emit(emptyAnswer());
    await until(() => h.internals.skillTurnNativeResponse);
    query.output.emit(result("empty", [command]));
  });
  assert.equal(outcome.stopReason, "end");
  const answers = messageEntries(h.session).filter(
    (entry) => entry.role === "assistant",
  );
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0]!.content, []);
  assert.equal(answers[0]!.nativeResponse, true);
  for (const trail of trails(h))
    assert.deepEqual(
      trail.map(({ via }) => via),
      ["command"],
    );

  // An ordinary turn's empty answer is still not recorded.
  const plain = h.adapter.prompt("plain");
  await until(() => h.queries[1]?.inputs.length === 1);
  const next = h.queries[1]!;
  const prompt = uuidOf(next.inputs[0]);
  next.output.emit(emptyAnswer());
  next.output.emit(result("plain-empty", [prompt]));
  await plain;
  assert.equal(
    messageEntries(h.session).filter((entry) => entry.role === "assistant")
      .length,
    1,
  );
});

test("an empty answer the follow-up continues past still confirms the command", async () => {
  const h = skillHarness();
  const outcome = await commandTurn(h, async (query, command) => {
    const steer = h.adapter.prompt("and also", { steer: true });
    await until(() => query.inputs.length === 2);
    const steerUuid = uuidOf(query.inputs[1]);
    query.output.emit(emptyAnswer());
    await until(() => h.internals.skillTurnNativeResponse);
    query.output.emit(result("command", [command]));
    assert.deepEqual(await steer, {
      stopReason: "end",
      steerDelivery: "followUp",
    });
    query.output.emit(started(steerUuid));
    for (const message of reply("Follow-up answer."))
      query.output.emit(message);
    query.output.emit(result("follow-up", [steerUuid]));
  });
  assert.equal(outcome.stopReason, "end");
  const answers = messageEntries(h.session).filter(
    (entry) => entry.role === "assistant",
  );
  assert.deepEqual(
    answers.map((entry) => [entry.content.length, entry.nativeResponse]),
    [
      [0, true],
      [1, undefined],
    ],
  );
  for (const trail of trails(h))
    assert.deepEqual(
      trail.map(({ via }) => via),
      ["command"],
    );
});

for (const load of LOADS) {
  test(`a ${load.via} load of the commanded skill in its own turn is not counted again`, async () => {
    const h = skillHarness();
    const outcome = await commandTurn(h, (query, command) => {
      for (const message of loadAlpha(load, "same-turn"))
        query.output.emit(message);
      for (const message of reply("Skill answer.")) query.output.emit(message);
      query.output.emit(result("command", [command]));
    });
    assert.equal(outcome.stopReason, "end");
    for (const trail of trails(h))
      assert.deepEqual(
        trail.map(({ via }) => via),
        ["command"],
      );
  });

  test(`a follow-up turn's ${load.via} load of the commanded skill is counted`, async () => {
    const h = skillHarness();
    const outcome = await commandTurn(h, async (query, command) => {
      const steer = h.adapter.prompt("load alpha again", { steer: true });
      await until(() => query.inputs.length === 2);
      const steerUuid = uuidOf(query.inputs[1]);
      for (const message of reply("Skill answer.")) query.output.emit(message);
      query.output.emit(result("command", [command]));
      assert.deepEqual(await steer, {
        stopReason: "end",
        steerDelivery: "followUp",
      });
      query.output.emit(started(steerUuid));
      for (const message of loadAlpha(load, "follow-up"))
        query.output.emit(message);
      for (const message of reply("Loaded again.")) query.output.emit(message);
      query.output.emit(result("follow-up", [steerUuid]));
    });
    assert.equal(outcome.stopReason, "end");
    for (const trail of trails(h))
      assert.deepEqual(
        trail.map(({ via }) => via),
        ["command", load.via],
      );
  });
}
