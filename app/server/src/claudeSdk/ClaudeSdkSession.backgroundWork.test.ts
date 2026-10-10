import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

const dataDir = mkdtempSync(join(tmpdir(), "claude-background-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { ClaudeSdkSession } = await import("./ClaudeSdkSession.ts");
const { backgroundWorkStore } = await import("../db/backgroundWorkStore.ts");
const { backgroundWorkSupervisor } =
  await import("../backgroundWork/supervisor.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { updateSettings } = await import("../settings.ts");
const { sessionSkills } = await import("../sessionSkills.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { drainRecipient, setHubForTests } = await import("../peerPrompt.ts");
const { peerPromptStore } = await import("../db/peerPromptStore.ts");
const { claudeBackgroundWorkBackend } =
  await import("./backgroundWorkBackend.ts");

afterEach(() => setHubForTests(undefined));

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

class FakeRetainedQuery implements ClaudeQuery {
  readonly output = new OutputQueue();
  readonly inputs: ClaudeSdkUserMessage[] = [];
  readonly stopped: string[] = [];
  closeCalls = 0;
  interruptCalls = 0;
  abortObserved = false;

  constructor(
    readonly params: ClaudeQueryParams,
    private readonly hangOnClose = false,
  ) {
    params.options?.abortController?.signal.addEventListener("abort", () => {
      this.abortObserved = true;
      this.output.close();
    });
    void this.consumeInput();
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return this.output[Symbol.asyncIterator]();
  }

  close(): void {
    this.closeCalls += 1;
    if (!this.hangOnClose) this.output.close();
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async stopTask(taskId: string): Promise<void> {
    this.stopped.push(taskId);
  }

  async setModel(): Promise<void> {}
  async setMaxThinkingTokens(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}

  private async consumeInput(): Promise<void> {
    if (typeof this.params.prompt === "string") return;
    for await (const message of this.params.prompt) this.inputs.push(message);
  }
}

function result(uuid: string): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "provider-background",
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

function chargedResult(uuid: string): ClaudeSdkMessage {
  return {
    ...(result(uuid) as unknown as Record<string, unknown>),
    total_cost_usd: 0.5,
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.5,
        contextWindow: 200_000,
      },
    },
  } as unknown as ClaudeSdkMessage;
}

/**
 * A result whose `modelUsage`/`total_cost_usd` are the RUNNING TOTAL for its
 * `query()` epoch so far — what the SDK says a streaming-input session reports.
 */
function runningTotalResult(uuid: string, scale: number): ClaudeSdkMessage {
  return {
    ...(result(uuid) as unknown as Record<string, unknown>),
    total_cost_usd: 0.5 * scale,
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 10 * scale,
        outputTokens: 5 * scale,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.5 * scale,
        contextWindow: 200_000,
      },
    },
  } as unknown as ClaudeSdkMessage;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

function preToolHook(query: FakeRetainedQuery) {
  const hooks = query.params.options?.hooks;
  assert.ok(hooks?.PreToolUse?.[0]?.hooks[0]);
  return hooks.PreToolUse[0]!.hooks[0]!;
}

let serial = 0;
function makeHarness(
  graceSeconds = 30,
  options: {
    hangFirstQueryOnClose?: boolean;
    processCloseTimeoutMs?: number;
  } = {},
): {
  session: InstanceType<typeof ClaudeSdkSession>;
  queries: FakeRetainedQuery[];
} {
  serial += 1;
  const id = `claude-background-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
  });
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: graceSeconds,
    },
  });
  const queries: FakeRetainedQuery[] = [];
  const seam: ClaudeSdkSeam = {
    query(params) {
      const query = new FakeRetainedQuery(
        params,
        options.hangFirstQueryOnClose === true && queries.length === 0,
      );
      queries.push(query);
      return query;
    },
  };
  return {
    session: new ClaudeSdkSession(id, {
      seam: async () => seam,
      agentType: "developer",
      ...(options.processCloseTimeoutMs !== undefined
        ? { processCloseTimeoutMs: options.processCloseTimeoutMs }
        : {}),
    }),
    queries,
  };
}

test("ordinary Claude turns close their transient process at result", async () => {
  const { session, queries } = makeHarness();
  const turn = session.createRuntimeAdapter().prompt("hello");
  await until(() => queries.length === 1);
  queries[0]!.output.emit(result("ordinary-result"));
  await turn;
  assert.equal(queries[0]!.closeCalls, 1);
  session.dispose();
});

test("a closing ordinary process cannot finish the next prompt", async () => {
  const { session, queries } = makeHarness(30, {
    hangFirstQueryOnClose: true,
    processCloseTimeoutMs: 5,
  });
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("first");
  await until(() => queries.length === 1);
  queries[0]!.output.emit(result("stuck-first-result"));
  await first;

  let secondSettled = false;
  const second = adapter.prompt("second").then((value) => {
    secondSettled = true;
    return value;
  });
  await until(() => queries.length === 2);
  assert.equal(
    queries[0]!.abortObserved,
    true,
    "the bounded close wait falls back to the epoch abort controller",
  );
  assert.equal(
    secondSettled,
    false,
    "the old query finalizer must not complete the new turn while its prompt is still unanswered",
  );
  queries[1]!.output.emit(result("second-after-abort"));
  await second;
  session.dispose();
});

test("a query construction throw unregisters its background host", async () => {
  serial += 1;
  const id = `claude-background-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
  });
  const session = new ClaudeSdkSession(id, {
    seam: async () => ({
      query() {
        throw new Error("query construction failed");
      },
    }),
    agentType: "developer",
  });
  await session.createRuntimeAdapter().prompt("fail before query exists");
  assert.equal(claudeBackgroundWorkBackend.registeredHostCount(id), 0);
  session.dispose();
});

test("an unknown provider task is durably observed despite disabled policy", async () => {
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const blockerId = `observed-cap-blocker-${serial}`;
  sessionStore.upsert({
    id: blockerId,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
  });
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 1,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
  const blocker = backgroundWorkSupervisor.admit({
    ownerSessionId: blockerId,
    backend: "claude-query",
    kind: "shell",
    label: "capacity blocker",
    sourceRequestId: "capacity-blocker",
    hostEpochKey: "capacity-blocker-epoch",
  });
  assert.equal(blocker.admitted, true);
  updateSettings({
    backgroundWork: {
      enabled: false,
      ownerSessionCap: 1,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: 30,
    },
  });

  const turn = session.createRuntimeAdapter().prompt("observe unknown work");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  query.output.emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      {
        task_id: "vendor-observed",
        task_type: "future-native-background",
        description: "unexpected provider work",
      },
    ],
    uuid: "observed-level",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit({
    type: "system",
    subtype: "task_started",
    task_id: "vendor-observed",
    tool_use_id: "unadmitted-tool-use",
    description: "unexpected provider work",
    task_type: "future-native-background",
    uuid: "observed-started",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(
    () =>
      backgroundWorkStore.listItems({ ownerSessionId: session.id })[0]
        ?.providerTaskId === "vendor-observed",
  );
  const observed = backgroundWorkStore.listItems({
    ownerSessionId: session.id,
  })[0]!;
  assert.equal(observed.provenance, "observed-over-cap");
  assert.equal(
    blocker.admitted
      ? backgroundWorkStore.getItem(blocker.item.id)?.state
      : undefined,
    "pending-launch",
    "the over-cap observation never evicts the existing slot holder",
  );
  assert.equal(query.closeCalls, 0, "observation lazily retains the query");

  query.output.emit(result("observed-result"));
  await turn;
  query.output.emit({
    type: "system",
    subtype: "task_notification",
    task_id: "vendor-observed",
    tool_use_id: "unadmitted-tool-use",
    status: "completed",
    output_file: "",
    summary: "observed work finished",
    uuid: "observed-notification",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  if (blocker.admitted) await backgroundWorkSupervisor.launch(blocker);
  session.dispose();
});

test("background admission lazily retains one query and binds after the level signal", async () => {
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("start background work");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  const pre = preToolHook(query);
  const hookResult = await pre(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 1", run_in_background: true },
      tool_use_id: "tool-bg-1",
    },
    "tool-bg-1",
    { signal: new AbortController().signal },
  );
  assert.equal((hookResult as { continue?: boolean }).continue, true);
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: session.id }).length,
    1,
  );
  // The row says what the job IS, from the tool input: no description was
  // given, so the command's first line is the title and the command travels.
  const admitted = backgroundWorkStore.listItems({
    ownerSessionId: session.id,
  })[0]!;
  assert.equal(admitted.label, "sleep 1");
  assert.equal(admitted.command, "sleep 1");
  assert.equal(admitted.description, undefined);
  // The model learns the job's PA id beside the call, and how to say nobody
  // waits on it: Claude's own task id is not one background_tasks accepts.
  const context = (
    hookResult as { hookSpecificOutput?: { additionalContext?: string } }
  ).hookSpecificOutput?.additionalContext;
  assert.match(context ?? "", new RegExp(`task ${admitted.id} `));
  assert.match(context ?? "", /set_intent/);

  query.output.emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: "vendor-1", task_type: "shell", description: "sleep" }],
    uuid: "level-1",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(
    () =>
      backgroundWorkStore.listItems({ ownerSessionId: session.id }).length ===
      1,
  );
  query.output.emit({
    type: "system",
    subtype: "task_started",
    task_id: "vendor-1",
    tool_use_id: "tool-bg-1",
    description: "sleep",
    task_type: "shell",
    uuid: "started-1",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit(result("first-result"));
  await first;
  assert.equal(query.closeCalls, 0, "the admitted task retains its process");
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: session.id })[0]
      ?.providerTaskId,
    "vendor-1",
  );

  const second = adapter.prompt("status please");
  await until(() => query.inputs.length === 2);
  query.output.emit(result("second-result"));
  await second;
  assert.equal(queries.length, 1, "later input uses the retained process");

  session.beginSyntheticTool("/compact", { command: "/compact", rawArgs: "" });
  const compact = session.compactContext();
  await until(() => query.inputs.length === 3);
  query.output.emit({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 10_000,
      post_tokens: 2_000,
    },
    uuid: "compact-boundary",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit(result("compact-result"));
  const compacted = await compact;
  assert.equal(compacted.kind, "compacted");
  assert.equal(
    queries.length,
    1,
    "in-band compact does not start a second query",
  );
  session.discardSyntheticTool();

  const tmpDir = query.params.options?.env?.TMPDIR;
  assert.ok(tmpDir);
  const taskOutputRoot = join(
    tmpDir,
    `claude-${process.getuid?.() ?? 0}`,
    "cwd-slug",
    "provider-session",
    "tasks",
  );
  mkdirSync(taskOutputRoot, { recursive: true });
  const taskOutputFile = join(taskOutputRoot, "vendor-1.output");
  writeFileSync(taskOutputFile, "captured background output\n");
  query.output.emit({
    type: "system",
    subtype: "task_notification",
    task_id: "vendor-1",
    tool_use_id: "tool-bg-1",
    status: "completed",
    output_file: taskOutputFile,
    summary: "background shell finished",
    uuid: "notification-1",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  const retainedHost = backgroundWorkStore.hostForOwner(session.id);
  assert.ok(retainedHost);
  const retainedOriginItemId = claudeBackgroundWorkBackend.firstActiveItemId(
    session.id,
    retainedHost.epochKey,
  );
  assert.ok(
    retainedOriginItemId,
    "the completed task remains the provider-turn origin during quiet grace",
  );
  await until(
    () =>
      backgroundWorkStore.listItems({ ownerSessionId: session.id })[0]
        ?.state === "completed",
  );
  const completedItem = backgroundWorkStore.listItems({
    ownerSessionId: session.id,
  })[0]!;
  assert.ok(completedItem.evidence?.artifactId);
  assert.equal(completedItem.evidence?.originalBytes, 27);
  assert.equal(completedItem.evidence?.capturedBytes, 27);
  assert.equal(completedItem.evidence?.text, true);
  assert.equal(completedItem.evidence?.truncated, false);
  assert.equal(JSON.stringify(completedItem).includes(taskOutputFile), false);
  const stopHook = query.params.options?.hooks?.Stop?.[0]?.hooks[0];
  assert.ok(stopHook);
  await stopHook(
    {
      hook_event_name: "Stop",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      stop_hook_active: false,
      background_tasks: [
        {
          id: "vendor-1",
          type: "shell",
          status: "completed",
          description: "stale completion snapshot",
        },
      ],
    },
    undefined,
    { signal: new AbortController().signal },
  );
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: session.id }).length,
    1,
    "a stale Stop snapshot does not resurrect the completed row",
  );

  query.output.emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Background follow-up." },
    },
    parent_tool_use_id: null,
    uuid: "provider-stream",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(() => session.isRunning);
  backgroundWorkSupervisor.setOrdinaryTurnActiveHandler(
    (ownerSessionId) => ownerSessionId === session.id && session.isRunning,
  );
  await backgroundWorkSupervisor.stopAllOwner({
    ownerSessionId: session.id,
    sourceRequestId: "human-stop-all",
    reason: "the human stopped all background work",
  });
  assert.equal(
    query.interruptCalls,
    1,
    "Stop-all interrupts a provider-origin turn despite the ordinary boundary",
  );
  query.output.emit({
    type: "assistant",
    uuid: "provider-assistant",
    session_id: "provider-background",
    parent_tool_use_id: null,
    message: {
      id: "provider-message",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "Background follow-up." }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as ClaudeSdkMessage);
  query.output.emit(result("provider-result"));
  await until(() => !session.isRunning);
  const providerText = session
    .snapshot()
    .flatMap((message) => message.blocks)
    .filter(
      (block) =>
        block.kind === "text" && block.text === "Background follow-up.",
    );
  assert.equal(providerText.length, 1, "the provider turn is normalized once");
  const providerEntry = session
    .toRecord()
    .entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.role === "assistant" &&
        entry.content.some(
          (block) =>
            block.type === "text" && block.text === "Background follow-up.",
        ),
    );
  assert.equal(
    providerEntry?.type === "message" && providerEntry.role === "assistant"
      ? providerEntry.stopReason
      : undefined,
    "aborted",
    "Stop-all records the interrupted provider-origin turn as aborted",
  );
  const durableProviderEntry = sessionRuntime
    .get(session.id)
    ?.getSnapshot()
    .entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.role === "assistant" &&
        entry.content.some(
          (block) =>
            block.type === "text" && block.text === "Background follow-up.",
        ),
    );
  assert.deepEqual(
    durableProviderEntry?.type === "message" &&
      durableProviderEntry.role === "assistant"
      ? durableProviderEntry.origin
      : undefined,
    {
      kind: "system",
      source: `claude-background:${retainedOriginItemId}`,
    },
  );
  backgroundWorkSupervisor.setOrdinaryTurnActiveHandler(() => false);
  session.dispose();
});

test("compact refuses an outstanding denied provider result and drops its usage", async () => {
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const turn = session.createRuntimeAdapter().prompt("retain for compact");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-compact-race",
    },
    "tool-compact-race",
    { signal: new AbortController().signal },
  );
  query.output.emit(result("compact-race-initial"));
  await turn;
  const host = backgroundWorkStore.hostForOwner(session.id);
  assert.ok(host);
  await claudeBackgroundWorkBackend.stopAll({
    ownerSessionId: session.id,
    sourceRequestId: "prepare-denied-provider-turn",
    attempt: 1,
    reason: "prepare denied provider turn",
    protectOrdinaryTurn: true,
  });
  query.output.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "running",
    uuid: "denied-provider-running",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(() => query.interruptCalls === 1);

  session.beginSyntheticTool("/compact", { command: "/compact", rawArgs: "" });
  const attempt = session.compactContext().then(
    () => ({ kind: "resolved" as const, message: "" }),
    (error: unknown) => ({
      kind: "rejected" as const,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  const beforeStaleResult = await Promise.race([
    attempt,
    new Promise<{ kind: "timeout"; message: string }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout", message: "" }), 20),
    ),
  ]);
  query.output.emit(chargedResult("denied-provider-result"));
  const finalAttempt = await attempt;
  assert.equal(beforeStaleResult.kind, "rejected");
  assert.match(
    finalAttempt.message,
    /still settling an interrupted background/,
  );
  assert.equal(
    session.toRecord().usage?.cost,
    0,
    "a denied provider result has no owning turn and contributes no usage",
  );
  session.discardSyntheticTool();
  session.dispose();
});

test("a missing foreign result leaves a reload-visible durable error entry", async () => {
  const { session, queries } = makeHarness(30, { processCloseTimeoutMs: 10 });
  await sessionSkills(session.id, session.agentType);
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("retain for timer failure");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-timer-failure",
    },
    "tool-timer-failure",
    { signal: new AbortController().signal },
  );
  query.output.emit(result("timer-failure-initial"));
  await first;
  await claudeBackgroundWorkBackend.stopAll({
    ownerSessionId: session.id,
    sourceRequestId: "timer-failure-stop-all",
    attempt: 1,
    reason: "test timer failure",
    protectOrdinaryTurn: true,
  });
  query.output.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "running",
    uuid: "timer-failure-provider-running",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(() => query.interruptCalls === 1);
  const prompted = adapter.prompt("this prompt must get an explanation");
  await prompted;
  const entries = session.timelineEntries();
  const marker = entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.role === "assistant" &&
      entry.content.some(
        (block) =>
          block.type === "text" &&
          block.text.includes("did not establish a new turn"),
      ),
  );
  assert.ok(marker, "the timer failure survives a reload");
  session.dispose();
});

test("compact stays loudly refused while armed and guarded auto-compaction is retained", async () => {
  const { session, queries } = makeHarness(30, {
    processCloseTimeoutMs: 50,
  });
  await sessionSkills(session.id, session.agentType);
  const turn = session
    .createRuntimeAdapter()
    .prompt("retain for compact reset");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-compact-reset",
    },
    "tool-compact-reset",
    { signal: new AbortController().signal },
  );
  query.output.emit(result("compact-reset-initial"));
  await turn;
  await claudeBackgroundWorkBackend.stopAll({
    ownerSessionId: session.id,
    sourceRequestId: "prepare-compact-reset",
    attempt: 1,
    reason: "prepare compact reset",
    protectOrdinaryTurn: true,
  });
  query.output.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "running",
    uuid: "compact-reset-provider-running",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(() => query.interruptCalls === 1);

  session.beginSyntheticTool("/compact", { command: "/compact", rawArgs: "" });
  await assert.rejects(
    session.compactContext(),
    /still settling an interrupted background/,
  );
  session.discardSyntheticTool();
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  session.beginSyntheticTool("/compact", { command: "/compact", rawArgs: "" });
  await assert.rejects(
    session.compactContext(),
    /still settling an interrupted background/,
    "timeout must not turn a safe refusal into a pending compact",
  );
  session.discardSyntheticTool();

  query.output.emit({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "auto",
      pre_tokens: 9_000,
      post_tokens: 2_500,
    },
    uuid: "guarded-auto-compact-boundary",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(() => session.contextInfo().context?.tokens === 2_500);
  query.output.emit(chargedResult("compact-reset-late-foreign-result"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    session.toRecord().usage?.cost,
    0,
    "the expired compact guard still excludes a late foreign result",
  );

  session.beginSyntheticTool("/compact", { command: "/compact", rawArgs: "" });
  const retry = session.compactContext();
  await until(() => query.inputs.length === 2);
  query.output.emit({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 8_000,
      post_tokens: 2_000,
    },
    uuid: "compact-reset-boundary",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit(result("compact-reset-result"));
  assert.equal((await retry).kind, "compacted");
  session.discardSyntheticTool();
  session.dispose();
});

test("a peer turn is not swallowed when a denied provider result never arrives", async () => {
  const { session, queries } = makeHarness(30, {
    processCloseTimeoutMs: 1_000,
  });
  await sessionSkills(session.id, session.agentType);
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("retain for peer priority");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-peer-priority",
    },
    "tool-peer-priority",
    { signal: new AbortController().signal },
  );
  query.output.emit(result("peer-priority-initial"));
  await first;

  const senderId = `peer-priority-sender-${serial}`;
  sessionStore.upsert({
    id: senderId,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
    title: "Peer sender",
  });
  setHubForTests({
    getLiveById: (id) => (id === session.id ? session : undefined),
    acquireById: async (id) => (id === session.id ? session : undefined),
    broadcastPeerPromptCardUpdate: () => undefined,
  });
  const chainId = peerPromptStore.createChain();
  peerPromptStore.enqueue({
    conversationId: `peer-priority-conversation-${serial}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: senderId,
    recipientSessionId: session.id,
    prompt: "peer work must run",
    responseRequested: false,
    senderLabel: "Peer sender",
  });
  query.output.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "running",
    uuid: "peer-priority-provider-running",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(() => query.interruptCalls === 1 && query.inputs.length === 2);
  const drain = drainRecipient(session.id);
  query.output.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "running",
    uuid: "peer-priority-prompted-turn-running",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit({
    type: "assistant",
    uuid: "peer-priority-assistant",
    session_id: "provider-background",
    parent_tool_use_id: null,
    message: {
      id: "peer-priority-message",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "peer turn completed" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as ClaudeSdkMessage);
  query.output.emit(result("peer-priority-result"));
  const drained = await Promise.race([
    drain.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  assert.equal(
    drained,
    true,
    "the peer drain lock releases even when the denied provider result is absent",
  );
  setHubForTests(undefined);
  session.dispose();
});

test("trailing denied-provider content and result cannot corrupt a prompted turn", async () => {
  const { session, queries } = makeHarness(30, {
    processCloseTimeoutMs: 1_000,
  });
  await sessionSkills(session.id, session.agentType);
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("retain for late result");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-late-result",
    },
    "tool-late-result",
    { signal: new AbortController().signal },
  );
  query.output.emit(result("late-result-initial"));
  await first;
  await claudeBackgroundWorkBackend.stopAll({
    ownerSessionId: session.id,
    sourceRequestId: "prepare-late-result",
    attempt: 1,
    reason: "prepare late denied result",
    protectOrdinaryTurn: true,
  });
  query.output.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "running",
    uuid: "late-result-provider-running",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(() => query.interruptCalls === 1);

  const prompted = adapter.prompt("user follow-up");
  await until(() => query.inputs.length === 2);
  query.output.emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "FOREIGN TRAILING" },
    },
    parent_tool_use_id: null,
    uuid: "late-foreign-trailing-stream",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit(chargedResult("late-foreign-result"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    session.isRunning,
    true,
    "the foreign result does not finish the prompted turn",
  );
  assert.equal(
    session.toRecord().usage?.cost,
    0,
    "the foreign result is not charged to the prompted turn",
  );
  assert.equal(
    session
      .snapshot()
      .flatMap((message) => message.blocks)
      .some(
        (block) => block.kind === "text" && block.text === "FOREIGN TRAILING",
      ),
    false,
    "trailing foreign content never enters the prompted turn",
  );

  query.output.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "running",
    uuid: "late-result-prompted-turn-running",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "the user's own answer" },
    },
    parent_tool_use_id: null,
    uuid: "late-result-own-stream",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit({
    type: "assistant",
    uuid: "late-result-own-assistant",
    session_id: "provider-background",
    parent_tool_use_id: null,
    message: {
      id: "late-result-own-message",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "the user's own answer" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as ClaudeSdkMessage);
  query.output.emit(result("late-result-own-result"));
  await prompted;
  assert.ok(
    session
      .snapshot()
      .flatMap((message) => message.blocks)
      .some(
        (block) =>
          block.kind === "text" && block.text === "the user's own answer",
      ),
  );
  session.dispose();
});

test("Stop-all protects an ordinary retained turn", async () => {
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("retain ordinary host");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-protected-ordinary",
    },
    "tool-protected-ordinary",
    { signal: new AbortController().signal },
  );
  query.output.emit(result("protected-first"));
  await first;

  const ordinary = adapter.prompt("ordinary retained follow-up");
  await until(() => query.inputs.length === 2);
  backgroundWorkSupervisor.setOrdinaryTurnActiveHandler(
    (ownerSessionId) => ownerSessionId === session.id && session.isRunning,
  );
  await backgroundWorkSupervisor.stopAllOwner({
    ownerSessionId: session.id,
    sourceRequestId: "protect-ordinary-stop-all",
    reason: "test ordinary protection",
  });
  assert.equal(
    query.interruptCalls,
    0,
    "Stop-all never interrupts an ordinary prompted turn",
  );
  query.output.emit(result("protected-second"));
  await ordinary;
  backgroundWorkSupervisor.setOrdinaryTurnActiveHandler(() => false);
  session.dispose();
});

test("abort interrupts but does not close a retained epoch", async () => {
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("retain abort host");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-retained-abort",
    },
    "tool-retained-abort",
    { signal: new AbortController().signal },
  );
  query.output.emit(result("abort-first"));
  await first;

  const aborted = adapter.prompt("abort this retained turn");
  await until(() => query.inputs.length === 2);
  session.abort();
  await aborted;
  assert.equal(query.interruptCalls, 1);
  assert.equal(query.closeCalls, 0);

  let survivorSettled = false;
  const survivor = adapter.prompt("same process survived").then((value) => {
    survivorSettled = true;
    return value;
  });
  await until(() => query.inputs.length === 3);
  assert.equal(queries.length, 1);
  query.output.emit(result("aborted-turn-settled"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    survivorSettled,
    false,
    "the retained host's delayed interrupt result must not finish the next turn",
  );
  query.output.emit(result("surviving-turn"));
  await survivor;
  session.dispose();
});

test("a Plan session returns to Build on its retained process", async () => {
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  session.setMode("plan");
  const adapter = session.createRuntimeAdapter();
  const first = adapter.prompt("start a dev server while planning");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  const pre = preToolHook(query);
  const call = (toolName: string, toolInput: Record<string, unknown>) =>
    pre(
      {
        hook_event_name: "PreToolUse",
        session_id: "provider-background",
        transcript_path: "/tmp/transcript",
        cwd: dataDir,
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: `tool-${toolName}`,
      },
      `tool-${toolName}`,
      { signal: new AbortController().signal },
    ) as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
  await call("Bash", { command: "sleep 10", run_in_background: true });
  query.output.emit(result("plan-first"));
  await first;
  assert.equal(query.closeCalls, 0, "the background shell retains the query");
  assert.ok(
    (query.params.options!.tools as string[]).includes("Edit"),
    "the retained process was started with Edit on its tool list",
  );
  assert.equal(
    (await call("Edit", { file_path: "a.ts" })).hookSpecificOutput
      ?.permissionDecision,
    "deny",
    "Plan refuses Edit on the retained process",
  );

  session.setMode("build");
  assert.equal(session.sessionMode, "build");
  assert.notEqual(
    (await call("Edit", { file_path: "a.ts" })).hookSpecificOutput
      ?.permissionDecision,
    "deny",
    "Build lets the same retained process edit again",
  );
  assert.equal(queries.length, 1, "returning to Build restarts nothing");
  assert.equal(query.closeCalls, 0);
  session.dispose();
});

test("a completed last task closes the retained query after frozen quiet grace", async () => {
  const { session, queries } = makeHarness(0);
  await sessionSkills(session.id, session.agentType);
  const turn = session.createRuntimeAdapter().prompt("start short work");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "true", run_in_background: true },
      tool_use_id: "tool-quiet",
    },
    "tool-quiet",
    { signal: new AbortController().signal },
  );
  query.output.emit({
    type: "system",
    subtype: "task_started",
    task_id: "vendor-quiet",
    tool_use_id: "tool-quiet",
    description: "true",
    task_type: "shell",
    uuid: "started-quiet",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit(result("quiet-turn-result"));
  await turn;
  query.output.emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [],
    uuid: "level-empty-quiet",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(
    () =>
      query.closeCalls === 1 &&
      backgroundWorkStore.hostForOwner(session.id) === undefined,
  );
  assert.equal(
    backgroundWorkStore.hostForOwner(session.id),
    undefined,
    "the durable live host closes with the process",
  );
  assert.match(
    backgroundWorkStore.listItems({ ownerSessionId: session.id })[0]
      ?.outcomeSummary ?? "",
    /final status notification was not received/,
  );
  session.dispose();
});

test("a Stop waiting for task_started fires after tool_use_id binding", async () => {
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const turn = session.createRuntimeAdapter().prompt("start then stop");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-awaiting-binding",
    },
    "tool-awaiting-binding",
    { signal: new AbortController().signal },
  );
  const item = backgroundWorkStore.listItems({
    ownerSessionId: session.id,
  })[0]!;
  const reservedStop = await backgroundWorkSupervisor.stopOne({
    itemId: item.id,
    ownerSessionId: session.id,
    sourceRequestId: "stop-before-binding",
    reason: "test targeted Stop",
  });
  assert.equal(reservedStop.state, "awaiting-binding");
  query.output.emit({
    type: "system",
    subtype: "task_started",
    task_id: "vendor-awaiting-binding",
    tool_use_id: "tool-awaiting-binding",
    description: "sleep",
    task_type: "shell",
    uuid: "started-awaiting-binding",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  await until(() => query.stopped.includes("vendor-awaiting-binding"));
  query.output.emit({
    type: "system",
    subtype: "task_notification",
    task_id: "vendor-awaiting-binding",
    tool_use_id: "tool-awaiting-binding",
    status: "stopped",
    output_file: "",
    summary: "stopped",
    uuid: "notification-awaiting-binding",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit(result("awaiting-binding-result"));
  await turn;
  session.dispose();
});

test("fatal retained-process loss marks its active task and host lost", async () => {
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const turn = session.createRuntimeAdapter().prompt("start doomed work");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-lost",
    },
    "tool-lost",
    { signal: new AbortController().signal },
  );
  query.output.emit({
    type: "system",
    subtype: "task_started",
    task_id: "vendor-lost",
    tool_use_id: "tool-lost",
    description: "sleep",
    task_type: "shell",
    uuid: "started-lost",
    session_id: "provider-background",
  } as unknown as ClaudeSdkMessage);
  query.output.emit(result("lost-turn-result"));
  await turn;
  query.output.close();
  await until(
    () =>
      backgroundWorkStore.listItems({ ownerSessionId: session.id })[0]
        ?.state === "lost",
  );
  assert.equal(backgroundWorkStore.hostForOwner(session.id), undefined);
  session.dispose();
});

test("Monitor denial at disabled policy creates no row and foreground Bash is unchanged", async () => {
  const { session, queries } = makeHarness();
  updateSettings({
    backgroundWork: {
      enabled: false,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
  const turn = session.createRuntimeAdapter().prompt("try tools");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  const pre = preToolHook(query);
  const denied = await pre(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Monitor",
      tool_input: {
        description: "watch",
        timeout_ms: 1_000,
        persistent: true,
        command: "echo ready",
      },
      tool_use_id: "monitor-disabled",
    },
    "monitor-disabled",
    { signal: new AbortController().signal },
  );
  assert.equal(
    (
      denied as {
        hookSpecificOutput?: { permissionDecision?: string };
      }
    ).hookSpecificOutput?.permissionDecision,
    "deny",
  );
  const foreground = await pre(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "pwd" },
      tool_use_id: "foreground-1",
    },
    "foreground-1",
    { signal: new AbortController().signal },
  );
  assert.deepEqual(foreground, { continue: true });
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: session.id }).length,
    0,
  );
  query.output.emit(result("disabled-result"));
  await turn;
  session.dispose();
});

test("a retained epoch's running totals are rebased across turns, not summed", async () => {
  // The bug this pins: background work keeps ONE query() open across turns, and
  // each result restates the epoch's running total. PA used to ADD them, so turn
  // N re-billed every earlier turn of the epoch — a real session reported 2.45B
  // cache-read tokens where the CLI's own per-request transcript had 143.9M.
  const { session, queries } = makeHarness();
  await sessionSkills(session.id, session.agentType);
  const adapter = session.createRuntimeAdapter();
  const perTurn: Array<number | undefined> = [];
  adapter.subscribe((event) => {
    if (event.type === "messageCompleted") perTurn.push(event.usage?.costUSD);
  });

  const first = adapter.prompt("retain the host");
  await until(() => queries.length === 1);
  const query = queries[0]!;
  await preToolHook(query)(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-background",
      transcript_path: "/tmp/transcript",
      cwd: dataDir,
      tool_name: "Bash",
      tool_input: { command: "sleep 10", run_in_background: true },
      tool_use_id: "tool-usage-epoch",
    },
    "tool-usage-epoch",
    { signal: new AbortController().signal },
  );
  query.output.emit(runningTotalResult("epoch-turn-1", 1));
  await first;

  const second = adapter.prompt("second turn on the same host");
  await until(() => query.inputs.length === 2);
  query.output.emit(runningTotalResult("epoch-turn-2", 2));
  await second;

  assert.equal(queries.length, 1, "both turns ran in one query epoch");
  assert.ok(
    perTurn[0] !== undefined && Math.abs(perTurn[0] - 0.5) < 1e-9,
    `turn 1 bills its own run (${perTurn[0]})`,
  );
  assert.ok(
    perTurn[1] !== undefined && Math.abs(perTurn[1] - 0.5) < 1e-9,
    `turn 2 bills the delta, not the running total (${perTurn[1]})`,
  );
  assert.ok(
    Math.abs((session.toRecord().usage?.cost ?? 0) - 1) < 1e-9,
    `the session total is the epoch's LAST report, not the sum of its reports (${session.toRecord().usage?.cost})`,
  );
  session.dispose();
});
