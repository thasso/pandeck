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
const { hub } = await import("./hub.ts");
const { AGENTS_LIBRARY_DIR } = await import("./config.ts");
const { formatAgentManifest } = await import("./agents/agentLibrary.ts");
const { setAgentRuntimeSourcesForTests } =
  await import("./agents/agentRuntime.ts");
const { setAgentSpawnSourcesForTests } = await import("./agents/agentSpawn.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const accountRouter = await import("./accountRouter.ts");
const { setLibraryBroadcaster } = await import("./library/libraryPublish.ts");
const published: Array<{ type: string; library?: string }> = [];
setLibraryBroadcaster({
  broadcast: (message) => published.push(message as never),
});
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
    models: ["gpt-5"],
    effort: "low",
    denyTools: [],
    skills: [],
    body: "Draft briefly.",
  }),
);
const researcherFile = join(AGENTS_LIBRARY_DIR, "researcher", "AGENT.md");
/** Writes the researcher definition, by hand as a user would. */
function writeResearcher(
  patch: {
    effort?: "low" | "high";
    body?: string;
    persona?: "assistant" | "developer";
    compactionWindow?: number;
  } = {},
): void {
  writeFileSync(
    researcherFile,
    formatAgentManifest({
      name: "researcher",
      description: "Researches a question.",
      persona: patch.persona ?? "assistant",
      models: ["opus"],
      effort: patch.effort ?? "high",
      ...(patch.compactionWindow !== undefined
        ? { compactionWindow: patch.compactionWindow }
        : {}),
      denyTools: [],
      skills: [],
      body: patch.body ?? "Research carefully.",
    }),
  );
}
mkdirSync(join(AGENTS_LIBRARY_DIR, "researcher"), { recursive: true });
writeResearcher();

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

test.each(["claude-sdk", "pi"] as const)(
  "%s first send stores the definition window before the prompt, and a save failure reports the created id",
  async (harness) => {
    const name = harness === "pi" ? "drafter" : "researcher";
    const modelId = harness === "pi" ? "gpt-5" : "opus";
    const file = join(AGENTS_LIBRARY_DIR, name, "AGENT.md");
    const definition = {
      name,
      description: "Window test.",
      persona: "assistant" as const,
      models: [modelId],
      effort: "low" as const,
      body: "Draft briefly.",
    };
    writeFileSync(
      file,
      formatAgentManifest({ ...definition, compactionWindow: 50_000 }),
    );
    const liveSpy = vi.spyOn(hub, "getLiveById").mockImplementation(
      (sessionId: string) =>
        ({
          live: true,
          sessionId,
          broadcastState() {},
          compactionWindowStatus: () => ({
            contextWindow: 200_000,
            underlyingReserve: 16_384,
            live: { applied: "pending" },
          }),
          applyCompactionWindow: async () => ({}),
        }) as never,
    );
    try {
      const { conn, sent } = makeConnection();
      const req = {
        harness,
        id: `first-window-${harness}`,
        agentType: "assistant",
        text: "Start with window",
        agent: name,
        modelProvider: harness === "pi" ? "openai-codex" : "claude-sdk",
        modelId,
        thinkingLevel: "low",
        credentialProfileId: harness === "pi" ? "default" : claudeProfile.id,
      };
      await conn.handleFirstSend(req);
      const createdId = harness === "pi" ? "pi-agent-session" : req.id;
      assert.equal(
        sessionStore.get(createdId)?.compactionWindow,
        harness === "pi" ? 50_000 : 100_000,
      );
      assert.deepEqual(prompts, ["Start with window"]);
      if (harness !== "pi")
        assert.match(
          sessionStore.get(createdId)?.compactionWindowNote ?? "",
          /clamped/,
        );
      const save = vi
        .spyOn(sessionStore, "setCompactionWindow")
        .mockImplementation(() => {
          throw new Error("disk full");
        });
      prompts.length = 0;
      await conn.handleFirstSend({ ...req, id: `failed-window-${harness}` });
      assert.deepEqual(prompts, []);
      assert.ok(
        sent.some(
          (msg) =>
            msg.message?.includes(
              harness === "pi"
                ? "pi-agent-session"
                : `failed-window-${harness}`,
            ) && msg.message.includes("disk full"),
        ),
      );
      save.mockRestore();
    } finally {
      liveSpy.mockRestore();
      writeFileSync(file, formatAgentManifest(definition));
      writeResearcher();
    }
  },
);

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
  // Resolved on the account the user picked, not the automatic one: once to
  // prepare, once more right before the session exists.
  assert.deepEqual(offeredOn, [claudeProfile.id, claudeProfile.id]);
  assert.deepEqual(
    JSON.parse(sessionStore.getAgent("agent-first-send") ?? "null"),
    {
      name: "researcher",
      blob: JSON.parse(sessionStore.getAgent("agent-first-send")!).blob,
      persona: "assistant",
      provider: "claude-sdk",
      model: "opus",
      effort: "high",
      runtimeSource: "definition",
      denyTools: [],
      skills: [],
      body: "Research carefully.",
    },
  );
  assert.deepEqual(prompts, ["What changed?"]);
});

test.each([
  ["claude-sdk", "researcher", "opus", "high"],
  ["pi", "drafter", "gpt-5", "low"],
] as const)(
  "Automatic first send for %s resolves the definition before picking, without preview fields",
  async (harness, agent, modelId, thinkingLevel) => {
    const profileId = harness === "claude-sdk" ? claudeProfile.id : "default";
    const picker = vi
      .spyOn(accountRouter, "pickAccount")
      .mockResolvedValue({ profileId });
    try {
      const { conn, sent } = makeConnection();
      await conn.handleFirstSend({
        harness,
        id: `automatic-agent-${harness}`,
        agentType: "assistant",
        text: "Do the work.",
        agent,
      });
      assert.equal(
        sent.some((message) => message.type === "error"),
        false,
        JSON.stringify(sent),
      );
      assert.equal(prompts.length, 1);
      assert.deepEqual(picker.mock.calls, [
        [
          {
            model: {
              provider:
                harness === "claude-sdk" ? "claude-sdk" : "openai-codex",
              modelId,
            },
            thinkingLevel,
            requiresEnterprise: false,
          },
        ],
      ]);
      const opts =
        harness === "claude-sdk"
          ? acquired[0]!.opts
          : (piAcquired[0]![3] as Record<string, unknown>);
      assert.equal(opts.credentialProfileId, profileId);
    } finally {
      picker.mockRestore();
    }
  },
);

test("an Automatic first send keeps its default even when spawn could fall back across providers", async () => {
  const folder = join(AGENTS_LIBRARY_DIR, "spawn-fallback-only");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "AGENT.md"),
    formatAgentManifest({
      name: "spawn-fallback-only",
      description: "Checks first-send routing.",
      persona: "assistant",
      models: ["gpt-5", "opus"],
      effort: "low",
      denyTools: [],
      skills: [],
      body: "Draft briefly.",
    }),
  );
  const picker = vi
    .spyOn(accountRouter, "pickAccount")
    .mockImplementation(async (request) =>
      request.model.provider === "openai-codex"
        ? {
            profileId: "default",
            degraded: "no-eligible-account",
            limited: { until: Date.now() + 60_000 },
          }
        : { profileId: claudeProfile.id },
    );
  try {
    const { conn, sent } = makeConnection();
    await conn.handleFirstSend({
      harness: "pi",
      id: "agent-no-spawn-fallback",
      agentType: "assistant",
      text: "Draft.",
      agent: "spawn-fallback-only",
    });
    assert.equal(
      sent.some((message) => message.type === "error"),
      false,
      JSON.stringify(sent),
    );
    assert.equal(piAcquired.length, 1);
    assert.equal(acquired.length, 0);
    assert.deepEqual(prompts, ["Draft."]);
    assert.ok(
      picker.mock.calls.every(([request]) => request.model.modelId === "gpt-5"),
    );
  } finally {
    picker.mockRestore();
  }
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

test("a runtime the user picked runs with the role, as their own pick", async () => {
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "agent-user-pick",
    agentType: "assistant",
    text: "hello",
    // The definition runs opus at high; the user lowered the effort.
    modelProvider: "claude-sdk",
    modelId: "opus",
    thinkingLevel: "low",
    agent: "researcher",
    credentialProfileId: claudeProfile.id,
  });

  assert.equal(acquired.length, 1);
  assert.equal(acquired[0]?.opts.thinkingLevel, "low");
  const frozen = JSON.parse(sessionStore.getAgent("agent-user-pick") ?? "null");
  assert.equal(frozen.effort, "low");
  assert.equal(frozen.runtimeSource, "user");
  assert.equal(frozen.body, "Research carefully.");
  assert.deepEqual(prompts, ["hello"]);
});

test("a role keeps its identity on another provider's engine the user picked", async () => {
  const { conn } = makeConnection();

  // researcher lists only claude-sdk/opus; the user picked a pi model.
  await conn.handleFirstSend({
    harness: "pi",
    id: "pi-user-pick",
    agentType: "assistant",
    text: "Research it.",
    modelProvider: "openai-codex",
    modelId: "gpt-5",
    thinkingLevel: "medium",
    agent: "researcher",
  });

  assert.equal(piAcquired.length, 1);
  const [, model, thinking, opts] = piAcquired[0] as [
    string,
    { provider: string; id: string },
    string,
    { agent?: { name: string; model: string; runtimeSource: string } },
  ];
  assert.deepEqual(model, { provider: "openai-codex", id: "gpt-5" });
  assert.equal(thinking, "medium");
  assert.equal(opts.agent?.name, "researcher");
  assert.equal(opts.agent?.model, "gpt-5");
  assert.equal(opts.agent?.runtimeSource, "user");
});

test("a picked model the account does not offer is refused", async () => {
  const { conn, sent } = makeConnection();
  setAgentSpawnSourcesForTests({ offers: async () => false });

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "agent-unoffered-pick",
    agentType: "assistant",
    text: "hello",
    modelProvider: "claude-sdk",
    modelId: "opus",
    thinkingLevel: "high",
    agent: "researcher",
    credentialProfileId: claudeProfile.id,
  });

  assert.equal(acquired.length, 0);
  assert.equal(sessionStore.getAgent("agent-unoffered-pick"), undefined);
  assert.match(JSON.stringify(sent), /does not offer claude-sdk\/opus/);
});

/** A hand edit that lands after the send was prepared, before creation. */
function editAfterPrepare(patch: Parameters<typeof writeResearcher>[0]) {
  let calls = 0;
  setAgentSpawnSourcesForTests({
    offers: async () => {
      if (++calls === 1) writeResearcher(patch);
      return true;
    },
  });
}

test("a hand edit made while the session is set up is what it freezes", async () => {
  const { conn } = makeConnection();
  editAfterPrepare({ body: "Research twice." });
  try {
    await conn.handleFirstSend({
      harness: "claude-sdk",
      id: "agent-late-edit",
      agentType: "assistant",
      text: "Go.",
      agent: "researcher",
      credentialProfileId: claudeProfile.id,
    });
  } finally {
    writeResearcher();
  }

  assert.equal(acquired.length, 1);
  const frozen = JSON.parse(sessionStore.getAgent("agent-late-edit") ?? "null");
  assert.equal(frozen.body, "Research twice.");
});

test("a runtime that changes while the session is set up is refused, not run", async () => {
  const { conn, sent } = makeConnection();
  published.length = 0;
  editAfterPrepare({ effort: "low" });
  try {
    await conn.handleFirstSend({
      harness: "claude-sdk",
      id: "agent-late-runtime",
      agentType: "assistant",
      text: "Go.",
      agent: "researcher",
      credentialProfileId: claudeProfile.id,
    });
  } finally {
    writeResearcher();
  }

  assert.equal(acquired.length, 0);
  assert.equal(sessionStore.getAgent("agent-late-runtime"), undefined);
  assert.match(
    JSON.stringify(sent),
    /changed while the session was being set up: it now runs on claude-sdk\/opus at low effort/,
  );
  await vi.waitFor(() =>
    assert.ok(
      published.some(
        (message) =>
          message.type === "libraryList" && message.library === "agents",
      ),
    ),
  );
});

test("a persona that changes while the session is set up is refused, not run", async () => {
  const { conn, sent } = makeConnection();
  editAfterPrepare({ persona: "developer" });
  try {
    await conn.handleFirstSend({
      harness: "claude-sdk",
      id: "agent-late-persona",
      agentType: "assistant",
      text: "Go.",
      agent: "researcher",
      credentialProfileId: claudeProfile.id,
    });
  } finally {
    writeResearcher();
  }

  assert.equal(acquired.length, 0);
  assert.equal(sessionStore.getAgent("agent-late-persona"), undefined);
  assert.match(
    JSON.stringify(sent),
    /runs as the developer persona, not assistant/,
  );
});

test("an agent first send to an id that already holds a Claude session is refused", async () => {
  const { conn, sent } = makeConnection();
  vi.spyOn(claudeSdkStore, "exists").mockImplementation(
    (id) => id === "agent-existing",
  );

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "agent-existing",
    agentType: "assistant",
    text: "Go.",
    agent: "researcher",
    credentialProfileId: claudeProfile.id,
  });

  assert.equal(acquired.length, 0);
  assert.equal(sessionStore.getAgent("agent-existing"), undefined);
  assert.match(
    JSON.stringify(sent),
    /already exists, and an agent only ever starts a new session/,
  );
});
