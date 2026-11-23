/**
 * A started Claude session changes model and effort between turns, applied at
 * once like pi's switch (`docs/session-runtime-switching.md`): the next query
 * epoch, resume included, opens on the new selection; a running turn refuses
 * the change; only a curated Claude model the bound account can run is
 * accepted, with the effort clamped to it.
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
} from "./sdkSeam.ts";
import { seedLegacyDefaultAccounts } from "../test/legacyDefaultAccounts.ts";

const dataDir = mkdtempSync(join(tmpdir(), "claude-runtime-selection-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { ClaudeSdkSession } = await import("../test/claudeSdkSession.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const profiles = await import("../credentialProfiles.ts");
const { resetClaudeAccountModelsForTests } =
  await import("../harnesses/claudeAccountModels.ts");
const { freezeSessionAgent } = await import("../agents/sessionAgent.ts");

await seedLegacyDefaultAccounts();

afterEach(() => {
  resetClaudeAccountModelsForTests();
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

class FakeQuery implements ClaudeQuery {
  readonly output = new OutputQueue();

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

  private async consumeInput(): Promise<void> {
    if (typeof this.params.prompt === "string") return;
    for await (const _message of this.params.prompt) {
      // drained like the CLI
    }
  }
}

function result(uuid: string): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "provider-selection",
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
function makeHarness(opts: { credentialProfileId?: string } = {}) {
  serial += 1;
  const id = `claude-selection-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
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
    agentType: "developer",
    modelId: "opus",
    thinkingLevel: "off",
    providerSessionId: "provider-selection",
    ...(opts.credentialProfileId
      ? { credentialProfileId: opts.credentialProfileId }
      : {}),
  });
  let persists = 0;
  session.onPersist = () => {
    persists += 1;
  };
  const adapter = session.createRuntimeAdapter();
  return { id, session, adapter, queries, persists: () => persists };
}

/** Run one complete turn on its own query epoch. */
async function runTurn(
  h: ReturnType<typeof makeHarness>,
  text: string,
): Promise<FakeQuery> {
  const before = h.queries.length;
  const turn = h.adapter.prompt(text);
  await until(() => h.queries.length === before + 1);
  const query = h.queries.at(-1)!;
  query.output.emit(result(`${text}-result`));
  await turn;
  return query;
}

test("an idle started session switches model and effort; the next epoch resumes on them", async () => {
  const h = makeHarness();
  try {
    const first = await runTurn(h, "first");
    assert.equal(first.params.options?.model, "claude-opus-5-5");
    const persistsBefore = h.persists();

    await h.session.setModel("haiku");
    await h.session.setThinkingLevel("high");
    assert.equal(h.session.modelSelection().model?.id, "haiku");
    assert.equal(h.session.toRecord().modelId, "haiku");
    assert.equal(h.session.toRecord().thinkingLevel, "high");
    assert.ok(h.persists() >= persistsBefore + 2, "each change persists");

    const second = await runTurn(h, "second");
    assert.equal(second.params.options?.model, "claude-haiku-5-5");
    assert.equal(second.params.options?.resume, "provider-selection");
    assert.equal(second.params.options?.effort, "high");
  } finally {
    h.session.dispose();
  }
});

test("a change during a running turn is refused and leaves the selection", async () => {
  const h = makeHarness();
  try {
    const turn = h.adapter.prompt("running");
    await until(() => h.queries.length === 1);
    await assert.rejects(
      async () => h.adapter.setModel({ provider: "claude-sdk", id: "haiku" }),
      /This session is running; change its model once the turn ends\./,
    );
    await assert.rejects(
      async () => h.adapter.setReasoning("high"),
      /This session is running; change its effort once the turn ends\./,
    );
    assert.equal(h.session.modelSelection().model?.id, "opus");
    assert.equal(h.session.toRecord().thinkingLevel, "off");
    h.queries[0]!.output.emit(result("running-result"));
    await turn;
    const next = await runTurn(h, "after");
    assert.equal(next.params.options?.model, "claude-opus-5-5");
  } finally {
    h.session.dispose();
  }
});

test("a model the bound account's listing lacks is refused; one it lists is taken", async () => {
  const profile = profiles.createCredentialProfile({
    name: "Listed",
    provider: "claude",
  }).id;
  resetClaudeAccountModelsForTests({
    read: async () => ["claude-opus-5-5", "claude-sonnet-5-5"],
    readable: () => true,
  });
  const h = makeHarness({ credentialProfileId: profile });
  try {
    await runTurn(h, "first");
    await assert.rejects(h.session.setModel("haiku"), /Listed can't run/);
    assert.equal(h.session.modelSelection().model?.id, "opus");
    await h.session.setModel("sonnet");
    assert.equal(h.session.modelSelection().model?.id, "sonnet");
  } finally {
    h.session.dispose();
    profiles.setCredentialProfileEnabled(profile, false);
  }
});

test("only a curated Claude model is accepted, never another harness's", async () => {
  const h = makeHarness();
  try {
    await runTurn(h, "first");
    await assert.rejects(
      async () =>
        h.adapter.setModel({ provider: "openai-codex", id: "gpt-5.5" }),
      /does not run on Claude/,
    );
    await assert.rejects(
      h.session.setModel("<synthetic>"),
      /is not a Claude model/,
    );
    assert.equal(h.session.modelSelection().model?.id, "opus");
  } finally {
    h.session.dispose();
  }
});

test("effort is clamped to the model: a switch to Fable lifts off to low, and off stays unavailable there", async () => {
  const h = makeHarness();
  try {
    await runTurn(h, "first");
    await h.session.setModel("fable");
    assert.equal(h.session.toRecord().thinkingLevel, "low");
    await h.session.setThinkingLevel("off");
    assert.equal(h.session.toRecord().thinkingLevel, "low");
    const next = await runTurn(h, "on fable");
    assert.equal(next.params.options?.model, "claude-fable-5-1");
  } finally {
    h.session.dispose();
  }
});

test("a pinned agent session runs another model as usual and its pinned version back on the alias", async () => {
  const h = makeHarness();
  freezeSessionAgent(h.id, {
    name: "test-reviewer",
    blob: "0".repeat(40),
    persona: "developer",
    provider: "claude-sdk",
    model: "opus",
    pinnedModel: "claude-opus-4-6",
    effort: "high",
    runtimeSource: "definition",
    denyTools: [],
    skills: [],
    body: "Review.",
  });
  try {
    const first = await runTurn(h, "first");
    assert.equal(first.params.options?.model, "claude-opus-4-6");
    await h.session.setModel("sonnet");
    const second = await runTurn(h, "second");
    assert.equal(second.params.options?.model, "claude-sonnet-5-5");
    await h.session.setModel("opus");
    const third = await runTurn(h, "third");
    assert.equal(third.params.options?.model, "claude-opus-4-6");
  } finally {
    h.session.dispose();
  }
});
