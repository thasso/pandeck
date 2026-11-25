/**
 * A Claude turn the API refused because the account cannot run the model
 * (Task-1483, `docs/account-routing.md`): the captured CLI shape (synthetic
 * assistant `model_not_found`, a 404 `not_found_error` result, then the SDK's
 * thrown wrapper) fails the turn as `model_unavailable` naming the concrete id
 * of the query that ran it, never the alias. The visible text stays the
 * provider's own wording.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { enableClaudeSdkForTests } from "../test/claudeSdkEnabled.ts";
import { COMPANY, Y } from "../test/claudeListings.ts";
import {
  claudeRefusalMessages,
  claudeRefusalText,
  claudeRefusalThrown,
} from "../test/modelRefusalCaptures.ts";
import type {
  ClaudeQuery,
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";

const dataDir = mkdtempSync(join(tmpdir(), "claude-model-refusal-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { ClaudeSdkSession } = await import("../test/claudeSdkSession.ts");
const { createCredentialProfile } = await import("../credentialProfiles.ts");
const { resetClaudeAccountModelsForTests } =
  await import("../harnesses/claudeAccountModels.ts");
const { backgroundWorkStore } = await import("../db/backgroundWorkStore.ts");
const { updateSettings } = await import("../settings.ts");
const { sessionStore } = await import("../db/sessionStore.ts");

const PROVIDER_SESSION = "provider-refusal";
let serial = 0;

beforeEach(enableClaudeSdkForTests);

// Each test owns a fresh account in this suite's own DATA_DIR.
afterEach(() => resetClaudeAccountModelsForTests());

/** A Claude account whose listing the returned setter can change. */
function account(listing: readonly string[]) {
  const profile = createCredentialProfile({
    name: `Refusal ${serial++}`,
    provider: "claude",
  });
  let current = [...listing];
  const cache = resetClaudeAccountModelsForTests({
    read: async (id) => (id === profile.id ? [...current] : undefined),
  });
  return {
    id: profile.id,
    relist: async (next: readonly string[]) => {
      current = [...next];
      await cache.refresh({ profileIds: [profile.id], force: true });
    },
  };
}

class OutputQueue implements AsyncIterable<ClaudeSdkMessage> {
  private readonly values: Array<ClaudeSdkMessage | Error> = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<ClaudeSdkMessage>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;

  emit(message: ClaudeSdkMessage | Error): void {
    const waiter = this.waiters.shift();
    if (!waiter) this.values.push(message);
    else if (message instanceof Error) waiter.reject(message);
    else waiter.resolve({ value: message, done: false });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value instanceof Error) return Promise.reject(value);
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) =>
          this.waiters.push({ resolve, reject }),
        );
      },
    };
  }
}

/** A query the test answers message by message; it may throw like the SDK. */
class FakeQuery implements ClaudeQuery {
  readonly output = new OutputQueue();
  readonly inputs: ClaudeSdkUserMessage[] = [];
  readonly modelCalls: Array<string | undefined> = [];

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
  async applyFlagSettings(): Promise<void> {}
  async setModel(model?: string): Promise<void> {
    this.modelCalls.push(model);
  }

  private async consumeInput(): Promise<void> {
    if (typeof this.params.prompt === "string") return;
    for await (const message of this.params.prompt) this.inputs.push(message);
  }
}

function cleanResult(uuid: string): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: PROVIDER_SESSION,
    uuid,
    is_error: false,
    result: "done",
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
  } as unknown as ClaudeSdkMessage;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

function harness(profileId: string, modelId: string) {
  const queries: FakeQuery[] = [];
  const seam: ClaudeSdkSeam = {
    query(params) {
      const query = new FakeQuery(params);
      queries.push(query);
      return query;
    },
  };
  const id = `claude-refusal-${serial++}`;
  // Background work needs the owning session's row.
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
    credentialProfileId: profileId,
  });
  const session = new ClaudeSdkSession(id, {
    seam: async () => seam,
    credentialProfileId: profileId,
    modelId,
    thinkingLevel: "medium",
    agentType: "developer",
  });
  const envelopes: ServerMessage[] = [];
  session.addViewer({ send: (message) => envelopes.push(message) });
  return {
    session,
    adapter: session.createRuntimeAdapter(),
    queries,
    envelopes,
  };
}

/** The turn's end as viewers saw it, and the failure the runtime received. */
async function refusedTurn(
  h: ReturnType<typeof harness>,
  turn: Promise<Awaited<ReturnType<typeof h.adapter.prompt>>>,
  modelId: string,
) {
  const result = await turn;
  const end = h.envelopes.findLast(
    (message) => message.type === "assistantEnd",
  );
  assert.ok(end && end.type === "assistantEnd");
  assert.equal(result.stopReason, "error");
  assert.equal(
    result.stopReason === "error" ? result.errorMessage : undefined,
    claudeRefusalText(modelId),
    "the provider's own wording, unchanged",
  );
  assert.equal(end.error, claudeRefusalText(modelId));
  assert.equal(end.errorInfo?.kind, "model_unavailable");
  return result.stopReason === "error" ? result.failure : undefined;
}

test("(a) a fable turn on an account listing 5-2 records the concrete 5-2, never the alias", async () => {
  const { id } = account(COMPANY);
  const h = harness(id, "fable");
  const turn = h.adapter.prompt("hello");
  await until(() => h.queries.length === 1);
  const query = h.queries[0]!;
  assert.equal(query.params.options?.model, "claude-fable-5-2");
  const { assistant, result } = claudeRefusalMessages(
    "claude-fable-5-2",
    PROVIDER_SESSION,
  );
  query.output.emit(assistant);
  query.output.emit(result);
  query.output.emit(new Error(claudeRefusalThrown("claude-fable-5-2")));
  assert.deepEqual(await refusedTurn(h, turn, "claude-fable-5-2"), {
    kind: "model_unavailable",
    unavailableModelId: "claude-fable-5-2",
  });
  assert.equal(h.session.toRecord().modelId, "fable");
  h.session.dispose();
});

test("(c) the result before the assistant message gives the same facts", async () => {
  const { id } = account(COMPANY);
  const h = harness(id, "fable");
  const turn = h.adapter.prompt("hello");
  await until(() => h.queries.length === 1);
  const query = h.queries[0]!;
  const { assistant, result } = claudeRefusalMessages(
    "claude-fable-5-2",
    PROVIDER_SESSION,
  );
  query.output.emit(result);
  query.output.emit(assistant);
  query.output.emit(new Error(claudeRefusalThrown("claude-fable-5-2")));
  assert.deepEqual(await refusedTurn(h, turn, "claude-fable-5-2"), {
    kind: "model_unavailable",
    unavailableModelId: "claude-fable-5-2",
  });
  h.session.dispose();
});

test("(e) a throw with no result finishes the turn on the fatal path, still naming the open query's id", async () => {
  const { id } = account(COMPANY);
  const h = harness(id, "fable");
  const turn = h.adapter.prompt("hello");
  await until(() => h.queries.length === 1);
  const query = h.queries[0]!;
  const { assistant } = claudeRefusalMessages(
    "claude-fable-5-2",
    PROVIDER_SESSION,
  );
  query.output.emit(assistant);
  query.output.emit(new Error(claudeRefusalThrown("claude-fable-5-2")));
  assert.deepEqual(await refusedTurn(h, turn, "claude-fable-5-2"), {
    kind: "model_unavailable",
    unavailableModelId: "claude-fable-5-2",
  });
  h.session.dispose();
});

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

/** Starts a background shell in the running turn, so its process is kept. */
async function startBackgroundShell(query: FakeQuery): Promise<void> {
  const pre = query.params.options?.hooks?.PreToolUse?.[0]?.hooks[0];
  assert.ok(pre);
  await pre(
    {
      hook_event_name: "PreToolUse",
      session_id: PROVIDER_SESSION,
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
    session_id: PROVIDER_SESSION,
  } as unknown as ClaudeSdkMessage);
}

/** A session whose first fable turn ended with its process retained. */
async function retainedFable(listing: readonly string[]) {
  enableBackgroundWork();
  const relisting = account(listing);
  const h = harness(relisting.id, "fable");
  const first = h.adapter.prompt("hello");
  await until(() => h.queries.length === 1);
  const query = h.queries[0]!;
  await startBackgroundShell(query);
  query.output.emit(cleanResult("retained-first"));
  assert.equal((await first).stopReason, "end");
  return { ...h, query, relist: relisting.relist };
}

async function disposeRetained(
  h: Awaited<ReturnType<typeof retainedFable>>,
): Promise<void> {
  h.query.output.emit({
    type: "system",
    subtype: "task_notification",
    task_id: "vendor-1",
    tool_use_id: "tool-bg-1",
    status: "completed",
    output_file: "",
    summary: "done",
    uuid: "completed-1",
    session_id: PROVIDER_SESSION,
  } as unknown as ClaudeSdkMessage);
  h.session.dispose();
  await until(() => !backgroundWorkStore.hostForOwner(h.session.id));
}

test("(b) after a retained model change to sonnet, the refused turn names claude-sonnet-5-5", async () => {
  const h = await retainedFable(COMPANY);
  try {
    assert.equal(h.query.params.options?.model, "claude-fable-5-2");
    await h.session.setModel("sonnet");
    assert.deepEqual(h.query.modelCalls, ["claude-sonnet-5-5"]);
    const turn = h.adapter.prompt("on sonnet");
    await until(() => h.query.inputs.length === 2);
    assert.equal(h.queries.length, 1, "the retained process ran the turn");
    const { assistant, result } = claudeRefusalMessages(
      "claude-sonnet-5-5",
      PROVIDER_SESSION,
    );
    h.query.output.emit(assistant);
    h.query.output.emit(result);
    assert.deepEqual(await refusedTurn(h, turn, "claude-sonnet-5-5"), {
      kind: "model_unavailable",
      unavailableModelId: "claude-sonnet-5-5",
    });
  } finally {
    await disposeRetained(h);
  }
});

test("(d) a turn the retained query took records that query's id, not what a fresh open would resolve now", async () => {
  const h = await retainedFable(COMPANY);
  try {
    // A fresh open would now resolve fable to 5-1; the kept process runs 5-2.
    await h.relist(Y);
    const turn = h.adapter.prompt("again");
    await until(() => h.query.inputs.length === 2);
    assert.equal(h.queries.length, 1, "no new query opened");
    const { assistant, result } = claudeRefusalMessages(
      "claude-fable-5-2",
      PROVIDER_SESSION,
    );
    h.query.output.emit(assistant);
    h.query.output.emit(result);
    assert.deepEqual(await refusedTurn(h, turn, "claude-fable-5-2"), {
      kind: "model_unavailable",
      unavailableModelId: "claude-fable-5-2",
    });
  } finally {
    await disposeRetained(h);
  }
});
