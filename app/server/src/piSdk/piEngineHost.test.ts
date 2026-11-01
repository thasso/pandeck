/**
 * The pi engine opener (`docs/workers.md` "pi engine construction"): every
 * open the store makes is a JSON spec answered by a handle and JSON info, app
 * tools reach the transcript through the handle, a Build/Plan flip the engine
 * refuses changes nothing, and a staged engine commits under the mode it is
 * handed.
 *
 * Real pi sessions on a local OpenAI-compatible fixture provider; nothing
 * here sends a prompt, so no request leaves the process.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/piEngineHost.test.ts
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { AgentTool, ToolSideEffects } from "../mcp/tool.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-engine-host-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "openai-compatible.json"),
  JSON.stringify({
    enabled: true,
    name: "Fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "fixture",
    models: [
      {
        id: "chosen",
        name: "chosen",
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 4_000,
        reasoning: false,
      },
    ],
  }),
);

await import("../hub.ts");
const { Connection } = await import("../connection.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { AGENT_TYPES } = await import("../agentTypes.ts");
const { agentPromptLayer } = await import("../agents/agentDefinitionPolicy.ts");
const { piStore } = await import("./piStore.ts");
const { openPiEngine } = await import("./piEngineHost.ts");
const { nativePiSessionForTests, piToolActivationForTests } =
  await import("./piEngine.ts");
const { readSessionHeaderId } = await import("./sessionOpen.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
const { findModelForProfile } = await import("./models.ts");
const { serverPiModelPort } = await import("./piModelPort.ts");
const { piPersonaOptions, resolvePiEngineStart } =
  await import("./piEngineStart.ts");
const { SKILLS_LIBRARY_DIR } = await import("../config.ts");
const { updateSettings } = await import("../settings.ts");
const { childProcessEnv } = await import("../subprocessEnv.ts");
const { appToolExecutorFor, persistSessionOutput } =
  await import("../workers/inProcessWorker.ts");

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ctx = {
  childEnv: childProcessEnv,
  appToolExecutor: appToolExecutorFor,
  models: serverPiModelPort,
  persistOutput: persistSessionOutput,
};

/** A persisted pi transcript on the fixture model: one user turn, one reply. */
function transcript(id: string): string {
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  const at = new Date().toISOString();
  const message = (
    entryId: string,
    parentId: string,
    body: Record<string, unknown>,
  ) => ({
    type: "message",
    id: entryId,
    parentId,
    timestamp: at,
    message: { ...body, timestamp: Date.now() },
  });
  writeFileSync(
    file,
    [
      { type: "session", version: 3, id, timestamp: at, cwd: tmp },
      {
        type: "model_change",
        id: `${id}-model`,
        parentId: null,
        timestamp: at,
        provider: "openai-compatible",
        modelId: "chosen",
      },
      message(`${id}-user`, `${id}-model`, { role: "user", content: "hi" }),
      message(`${id}-reply`, `${id}-user`, {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "openai-completions",
        provider: "openai-compatible",
        model: "chosen",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  return file;
}

const jsonRoundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));

test("every open the store makes is a JSON spec, answered with JSON info naming the transcript it opened", async () => {
  const opens = vi.spyOn(
    piStore as unknown as {
      openEngine: (spec: unknown) => Promise<{ info: unknown }>;
    },
    "openEngine",
  );
  const chosen = await findModelForProfile(
    "default",
    "openai-compatible",
    "chosen",
  );
  assert.ok(chosen);

  const created = await piStore.acquireNew("developer", chosen, "off", {
    cwd: tmp,
  });
  const file = transcript("host-open");
  const opened = await piStore.acquireExisting("developer", file, "host-open");
  const forked = await piStore.forkSession(
    "developer",
    file,
    "host-open-reply",
    "at",
    "app-entry-1",
  );
  const staged = await (
    opened as unknown as {
      reopenForAccount(profileId: string): Promise<{ dispose(): unknown }>;
    }
  ).reopenForAccount("default");
  try {
    const transcripts = [];
    for (const call of opens.mock.results) {
      const spec = opens.mock.calls[opens.mock.results.indexOf(call)]![0] as {
        transcript: { type: string };
        staged?: true;
      };
      assert.deepEqual(jsonRoundTrip(spec), spec);
      const { info } = (await call.value) as {
        info: { sessionId: string; sessionFile?: string };
      };
      assert.deepEqual(jsonRoundTrip(info), info);
      assert.ok(info.sessionFile, "the opener names the transcript file");
      // pi writes a transcript with its first reply; until then a new one
      // names the canonical path it will write.
      if (spec.transcript.type === "new")
        assert.equal(info.sessionFile, canonicalPiSessionPath(info.sessionId));
      else assert.equal(readSessionHeaderId(info.sessionFile), info.sessionId);
      transcripts.push(
        `${spec.transcript.type}${spec.staged ? " (staged)" : ""}`,
      );
    }
    assert.deepEqual(transcripts, ["new", "open", "fork", "open (staged)"]);
    for (const [index, live] of [created, opened, forked].entries())
      assert.equal(
        (
          (await opens.mock.results[index]!.value) as {
            info: { sessionId: string };
          }
        ).info.sessionId,
        live.sessionId,
      );
  } finally {
    await staged.dispose();
    for (const live of [created, opened, forked]) live.dispose();
  }
});

test("a routed app tool appends to the transcript through the handle, and the engine notes its use", async () => {
  const probe: AgentTool = {
    name: "w9b_probe",
    label: "Probe",
    description: "Appends a probe entry to the calling session.",
    parameters: { type: "object", properties: {} },
    sideEffects: "none",
    async execute(_params, { session }) {
      await session.sessionManager!.appendCustomEntry("w9b-probe", {
        from: session.sessionId,
      });
      return { content: [{ type: "text", text: "appended" }] };
    },
  };
  const tools = AGENT_TYPES.developer.tools.bind(AGENT_TYPES.developer);
  vi.spyOn(AGENT_TYPES.developer, "tools").mockImplementation(() => [
    ...tools(),
    probe,
  ]);
  const id = "host-app-tool";
  const file = transcript(id);
  const live = await piStore.acquireExisting("developer", file, id);
  try {
    const { engine } = live;
    const manager = engine.toolSessionManager.bind(engine);
    const appended: string[] = [];
    vi.spyOn(engine, "toolSessionManager").mockImplementation(() => {
      const inner = manager();
      return Object.create(inner, {
        appendCustomEntry: {
          value: (type: string, data: unknown) => {
            appended.push(type);
            return inner.appendCustomEntry(type, data);
          },
        },
      });
    });

    const definition = nativePiSessionForTests(engine).getToolDefinition(
      probe.name,
    );
    assert.ok(definition, "the probe is registered with pi");
    await definition.execute("call-1", {}, undefined, undefined, {} as never);

    assert.deepEqual(appended, ["w9b-probe"]);
    const entry = engine.transcript
      .getEntries()
      .find(
        (candidate) =>
          candidate.type === "custom" &&
          (candidate as { customType?: string }).customType === "w9b-probe",
      );
    assert.ok(entry, "the entry is in the live transcript");
    assert.match(readFileSync(file, "utf8"), /"customType":"w9b-probe"/);
    assert.ok(
      piToolActivationForTests(engine).loading().usedToolNames?.has(probe.name),
      "the engine noted the tool as used",
    );
  } finally {
    live.dispose();
  }
});

test("the server's binding notes a routed call's use after its gate: a failed run counts, a Plan denial does not", async () => {
  const ran: string[] = [];
  const routed = (name: string, sideEffects: ToolSideEffects): AgentTool => ({
    name,
    label: name,
    description: `Probe ${name}.`,
    parameters: { type: "object", properties: {} },
    sideEffects,
    async execute() {
      ran.push(name);
      throw new Error(`${name} failed`);
    },
  });
  const failing = routed("w9b_failing", "none");
  const mutating = routed("w9b_mutating", "local");
  const tools = AGENT_TYPES.developer.tools.bind(AGENT_TYPES.developer);
  vi.spyOn(AGENT_TYPES.developer, "tools").mockImplementation(() => [
    ...tools(),
    failing,
    mutating,
  ]);
  const id = "host-app-tool-accounting";
  const live = await piStore.acquireExisting("developer", transcript(id), id);
  try {
    const { engine } = live;
    const marked = vi.spyOn(engine, "markToolUsed");
    const used = () =>
      piToolActivationForTests(engine).loading().usedToolNames ?? new Set();
    const call = (tool: AgentTool) =>
      nativePiSessionForTests(engine)
        .getToolDefinition(tool.name)!
        .execute(`call-${tool.name}`, {}, undefined, undefined, {} as never);

    await assert.rejects(call(failing), /w9b_failing failed/);
    assert.ok(used().has(failing.name), "a failed run still counts as used");

    await live.setMode("plan");
    await assert.rejects(
      call(mutating),
      /Tool w9b_mutating is not available in Plan mode/,
    );
    assert.equal(used().has(mutating.name), false, "a denial is not a use");
    assert.deepEqual(ran, [failing.name]);
    assert.deepEqual(marked.mock.calls, [[failing.name]]);
  } finally {
    live.dispose();
  }
});

test("a mode flip the engine refuses changes nothing and reaches the viewer as an error", async () => {
  const id = "host-mode-refused";
  const live = await piStore.acquireExisting("developer", transcript(id), id);
  const storedMode = sessionStore.get(id)?.mode;
  try {
    const refusal = new Error("the engine refused the mode");
    vi.spyOn(live.engine, "setToolMode").mockRejectedValue(refusal);
    const broadcasts = vi.spyOn(live, "broadcastState");
    const sent: unknown[] = [];
    const conn = new (
      Connection as unknown as new (ws: unknown) => {
        withViewedSession(act: (driver: unknown) => unknown): Promise<void>;
        onSetSessionMode(mode: string): Promise<void>;
      }
    )({ OPEN: 1, readyState: 1, send: () => {} });
    Object.assign(conn, {
      send: (message: unknown) => sent.push(message),
      withViewedSession: async (act: (driver: unknown) => unknown) => {
        await act(live);
      },
    });

    await conn.onSetSessionMode("plan");

    assert.deepEqual(sent, [
      {
        type: "error",
        target: { type: "session", id },
        message: refusal.message,
      },
    ]);
    assert.equal(live.sessionMode, "build");
    assert.equal(sessionStore.get(id)?.mode, storedMode);
    assert.equal(broadcasts.mock.calls.length, 0);
    // The plan gate the server applies to routed tools still reads Build.
    const gate = (
      piStore as unknown as { sessionModes: Map<string, string> }
    ).sessionModes.get(id);
    assert.equal(gate, "build");
  } finally {
    live.dispose();
  }
});

test("the opener builds from the spec's start records and writes none of them", async () => {
  const skillDir = join(SKILLS_LIBRARY_DIR, "host-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: host-skill\ndescription: host skill\n---\n# host-skill\n",
  );
  const agent = {
    name: "host-reviewer",
    blob: "2".repeat(40),
    persona: "developer" as const,
    provider: "openai-compatible",
    model: "chosen",
    effort: "low" as const,
    runtimeSource: "definition" as const,
    denyTools: ["write"],
    skills: ["host-skill"],
    body: "Review the opener.",
  };
  const conditions = {
    attachments: true,
    slack: true,
    google: false,
    tempo: true,
    knowledgeBase: true,
    projectRegistryPointer: true,
    memoryWrite: false,
  };
  const { engine, info } = await openPiEngine(
    {
      kind: "developer",
      credentialProfileId: "default",
      transcript: { type: "new", cwd: tmp },
      start: { conditions, skillNames: ["host-skill"], agent },
      persona: piPersonaOptions("developer", "default", conditions, agent),
      mode: "build",
    },
    ctx,
  );
  try {
    const id = info.sessionId;
    assert.equal(sessionStore.getPromptConditions(id), undefined);
    assert.equal(sessionStore.getSkills(id), undefined);
    assert.equal(sessionStore.getAgent(id), undefined);
    const native = nativePiSessionForTests(engine);
    // The developer sections the spec's conditions add, then the agent layer;
    // not the persona those conditions switched off would build.
    const prompt = native.systemPrompt;
    const layered = (persona: string) =>
      `${persona}\n\n${agentPromptLayer(agent)}`;
    assert.ok(
      prompt.includes(
        layered(AGENT_TYPES.developer.systemPrompt({ conditions })),
      ),
    );
    assert.ok(
      !prompt.includes(
        layered(
          AGENT_TYPES.developer.systemPrompt({
            conditions: {
              ...conditions,
              knowledgeBase: false,
              projectRegistryPointer: false,
            },
          }),
        ),
      ),
    );
    assert.ok(prompt.includes("host-skill"));
    assert.equal(engine.model?.id, "chosen");
    assert.ok(!native.getActiveToolNames().includes("write"));
  } finally {
    await engine.discard({});
  }
});

test("the personal assistant's spec carries the profile suffix from settings at open, and a later change does not reach the open engine", async () => {
  updateSettings({
    permanentAssistant: {
      name: "Host Fixture",
      additionalInstructions: "Answer in one line.",
    } as never,
  });
  const started = await resolvePiEngineStart({
    kind: "personal-assistant",
    credentialProfileId: "default",
  });
  const suffix =
    '## Personal profile instructions\n\nYour name is "Host Fixture". Use this name when identifying yourself or when the user asks your name.\n\nAnswer in one line.';
  const persona = started.persona.systemPrompt;
  assert.ok("replace" in persona && persona.replace.endsWith(suffix));
  const { engine } = await openPiEngine(
    {
      kind: "personal-assistant",
      credentialProfileId: "default",
      transcript: { type: "new", cwd: tmp },
      model: { provider: "openai-compatible", id: "chosen" },
      ...started,
      mode: "build",
    },
    ctx,
  );
  try {
    const native = nativePiSessionForTests(engine);
    const before = native.systemPrompt;
    assert.ok(before.includes(suffix));
    updateSettings({
      permanentAssistant: {
        name: "Renamed",
        additionalInstructions: "",
      } as never,
    });
    // pi rebuilds its prompt on every active-set change, from what it loaded.
    native.setActiveToolsByName(native.getActiveToolNames());
    assert.equal(native.systemPrompt, before);
  } finally {
    await engine.discard({});
    updateSettings({
      permanentAssistant: {
        name: "Personal Assistant",
        additionalInstructions: "",
      } as never,
    });
  }
});

test("an open spec's compaction window is installed with no session record behind it", async () => {
  const id = "host-compaction-window";
  const file = transcript(id);
  assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
  const { engine } = await openPiEngine(
    {
      kind: "developer",
      credentialProfileId: "default",
      transcript: { type: "open", file, expectedId: id, cwd: tmp },
      ...(await resolvePiEngineStart({
        kind: "developer",
        credentialProfileId: "default",
        knownId: id,
      })),
      compactionWindow: 60_000,
      mode: "build",
    },
    ctx,
  );
  try {
    assert.equal(engine.compactionWindowStatus().live.appliedTokens, 60_000);
    assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
  } finally {
    await engine.discard({});
  }
});

test("a staged engine committed under Plan activates no edit or write, and its local gated tools deny before they run", async () => {
  const id = "host-staged-plan";
  const file = transcript(id);
  const { engine } = await openPiEngine(
    {
      kind: "developer",
      credentialProfileId: "default",
      transcript: { type: "open", file, expectedId: id, cwd: tmp },
      model: { provider: "openai-compatible", id: "chosen" },
      ...(await resolvePiEngineStart({
        kind: "developer",
        credentialProfileId: "default",
        knownId: id,
      })),
      mode: "build",
      staged: true,
    },
    ctx,
  );
  try {
    await engine.commitStaged({ mode: "plan" });
    const native = nativePiSessionForTests(engine);
    const active = native.getActiveToolNames();
    for (const name of ["edit", "write"])
      assert.ok(!active.includes(name), `${name} is not active`);
    // The engine gates the tools it executes itself; monitor starts local
    // processes. Its own argument check would refuse `{}`, so the Plan text
    // shows the gate ran first.
    assert.ok(!active.includes("monitor"), "monitor is not active");
    await assert.rejects(
      native
        .getToolDefinition("monitor")!
        .execute("call-1", {}, undefined, undefined, {} as never),
      /Tool monitor is not available in Plan mode/,
    );
  } finally {
    await engine.discard({});
  }
});
