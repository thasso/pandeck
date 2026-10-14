/**
 * Starting a session from an agent definition on the new-session page
 * (`docs/agent-definitions.md` "UI"): the first send names the definition, the
 * server resolves it again on the picked account, runs the session on the
 * definition's model and effort, and freezes it like a spawn does.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/firstSendAgent.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "first-send-agent-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

const prompts: string[] = [];
vi.mock("./session/runtimePrompt.ts", () => ({
  subscribeHarnessOpened: () => () => {},
  promptRuntimeSession: async (_driver: unknown, text: string) => {
    prompts.push(text);
  },
}));

vi.mock("./piSdk/models.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findModelForProfile: async (_profile: string, provider: string, id: string) =>
    ({ provider, id }) as never,
}));

const { Connection } = await import("./connection.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { AGENTS_LIBRARY_DIR } = await import("./config.ts");
const { formatAgentManifest } = await import("./agents/agentLibrary.ts");
const { setAgentRuntimeSourcesForTests } =
  await import("./agents/agentRuntime.ts");
const { setAgentSpawnSourcesForTests } = await import("./agents/agentSpawn.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const claudeProfile = createCredentialProfile({
  name: "Test Claude",
  provider: "claude",
});

mkdirSync(join(AGENTS_LIBRARY_DIR, "drafter"), { recursive: true });
writeFileSync(
  join(AGENTS_LIBRARY_DIR, "drafter", "AGENT.md"),
  formatAgentManifest({
    name: "drafter",
    description: "Drafts notes.",
    persona: "assistant",
    model: "gpt-5",
    effort: "low",
    denyTools: [],
    skills: [],
    body: "Draft briefly.",
  }),
);
mkdirSync(join(AGENTS_LIBRARY_DIR, "researcher"), { recursive: true });
writeFileSync(
  join(AGENTS_LIBRARY_DIR, "researcher", "AGENT.md"),
  formatAgentManifest({
    name: "researcher",
    description: "Researches a question.",
    persona: "assistant",
    model: "opus",
    effort: "high",
    denyTools: [],
    skills: [],
    body: "Research carefully.",
  }),
);

let acquired: Array<{ id: string; opts: Record<string, unknown> }>;
let piAcquired: unknown[][];
let offeredOn: string[];

function makeConnection() {
  const sent: Array<{ type?: string; message?: string }> = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s) as { type?: string }),
  };
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs) as unknown as {
    handleFirstSend: (msg: Record<string, unknown>) => Promise<void>;
    view: unknown;
  };
  vi.spyOn(claudeSdkStore, "acquire").mockImplementation(((
    id: string,
    opts: Record<string, unknown>,
  ) => {
    acquired.push({ id, opts });
    return {
      sessionId: id,
      broadcastState() {},
      contextInfo: () => ({}),
      setTitle() {},
    };
  }) as never);
  vi.spyOn(piStore, "acquireNew").mockImplementation((async (
    ...args: unknown[]
  ) => {
    piAcquired.push(args);
    return {
      sessionId: "pi-agent-session",
      sessionMode: "build",
      broadcastState() {},
      contextInfo: () => ({}),
      rename() {},
    };
  }) as never);
  conn.view = () => {};
  return { conn, sent };
}

beforeEach(() => {
  acquired = [];
  piAcquired = [];
  offeredOn = [];
  prompts.length = 0;
  setAgentRuntimeSourcesForTests({
    models: async () => [
      {
        provider: "claude-sdk",
        id: "opus",
        name: "Opus",
        reasoning: true,
        supportedThinkingLevels: ["low", "medium", "high"],
        contextWindow: 200_000,
      },
      {
        provider: "openai-codex",
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        supportedThinkingLevels: ["low", "medium", "high"],
        contextWindow: 200_000,
      },
    ],
    skillNames: async () => [],
    toolNames: async () => [],
  });
  setAgentSpawnSourcesForTests({
    offers: async (profileId) => {
      offeredOn.push(profileId);
      return true;
    },
  });
});

afterAll(() => {
  setAgentRuntimeSourcesForTests(null);
  setAgentSpawnSourcesForTests(null);
});

test("a first send naming an agent runs as that definition and freezes it", async () => {
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "agent-first-send",
    agentType: "assistant",
    text: "What changed?",
    // What the pickers showed when the definition was picked.
    modelProvider: "claude-sdk",
    modelId: "opus",
    thinkingLevel: "high",
    agent: "researcher",
    credentialProfileId: claudeProfile.id,
  });

  assert.equal(acquired.length, 1);
  assert.equal(acquired[0]?.opts.modelId, "opus");
  assert.equal(acquired[0]?.opts.thinkingLevel, "high");
  assert.equal(acquired[0]?.opts.credentialProfileId, claudeProfile.id);
  // Resolved on the account the user picked, not the automatic one.
  assert.deepEqual(offeredOn, [claudeProfile.id]);
  assert.deepEqual(
    JSON.parse(sessionStore.getAgent("agent-first-send") ?? "null"),
    {
      name: "researcher",
      blob: JSON.parse(sessionStore.getAgent("agent-first-send")!).blob,
      persona: "assistant",
      provider: "claude-sdk",
      model: "opus",
      effort: "high",
      denyTools: [],
      skills: [],
      body: "Research carefully.",
    },
  );
  assert.deepEqual(prompts, ["What changed?"]);
});

test("a send staged for another persona or an unknown agent is refused before anything exists", async () => {
  const { conn, sent } = makeConnection();

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "agent-wrong-persona",
    agentType: "workshop",
    text: "hello",
    agent: "researcher",
    credentialProfileId: claudeProfile.id,
  });
  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "agent-unknown",
    agentType: "assistant",
    text: "hello",
    agent: "nobody",
    credentialProfileId: claudeProfile.id,
  });

  assert.equal(acquired.length, 0);
  assert.equal(prompts.length, 0);
  assert.equal(sessionStore.getAgent("agent-wrong-persona"), undefined);
  const said = JSON.stringify(sent);
  assert.match(
    said,
    /Agent \\"researcher\\" runs as the assistant persona, not workshop/,
  );
  assert.match(said, /no agent definition named \\"nobody\\"/);
});

test("a pi first send runs the definition's model and effort and hands it the agent", async () => {
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "pi",
    id: "pi-optimistic",
    agentType: "assistant",
    text: "Draft it.",
    modelProvider: "openai-codex",
    modelId: "gpt-5",
    thinkingLevel: "low",
    agent: "drafter",
  });

  assert.equal(piAcquired.length, 1);
  const [kind, model, thinking, opts] = piAcquired[0] as [
    string,
    { provider: string; id: string },
    string,
    { agent?: { name: string; model: string } },
  ];
  assert.equal(kind, "assistant");
  assert.deepEqual(model, { provider: "openai-codex", id: "gpt-5" });
  assert.equal(thinking, "low");
  assert.equal(opts.agent?.name, "drafter");
  assert.deepEqual(prompts, ["Draft it."]);
});

test("a send staged on another engine than the definition's is refused", async () => {
  const { conn, sent } = makeConnection();

  await conn.handleFirstSend({
    harness: "pi",
    id: "pi-wrong-engine",
    agentType: "assistant",
    text: "hello",
    agent: "researcher",
  });

  assert.equal(piAcquired.length, 0);
  assert.equal(acquired.length, 0);
  assert.match(
    JSON.stringify(sent),
    /runs on claude-sdk\/opus, which this engine does not run/,
  );
});

test("a definition whose runtime changed since it was picked is refused, not run", async () => {
  const { conn, sent } = makeConnection();

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "agent-stale-pick",
    agentType: "assistant",
    text: "hello",
    modelProvider: "claude-sdk",
    modelId: "opus",
    thinkingLevel: "low",
    agent: "researcher",
    credentialProfileId: claudeProfile.id,
  });

  assert.equal(acquired.length, 0);
  assert.equal(prompts.length, 0);
  assert.match(
    JSON.stringify(sent),
    /Agent \\"researcher\\" now runs on claude-sdk\/opus at high effort, not what was picked/,
  );
});
