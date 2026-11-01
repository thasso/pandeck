/**
 * Integration gates reach pi engines as a command, and the Tools inspector
 * reads the engine's mirror (`docs/workers.md` "pi engine start resolution
 * (W9c-1)"): a settings flip changes a live session's active set and what
 * `find_tools` may load, a flip that lands while an open is in flight is
 * caught up before the acquisition resolves, a staged replacement commits
 * under the gates current at its commit, and the inspector and the native
 * loading facts equal the engine's own activation.
 *
 * Real pi sessions on the in-process Worker (real codec) and a local
 * OpenAI-compatible fixture provider; nothing here sends a prompt.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/piIntegrationGates.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pi-integration-gates-"));
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
const { sessionStore } = await import("../db/sessionStore.ts");
const { piStore } = await import("./piStore.ts");
const { findModelForProfile } = await import("./models.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
const { updateGithubSettings } = await import("../githubSettings.ts");
const { notifyIntegrationToolsChanged } =
  await import("../integrationToolChanges.ts");
const { sessionToolExposure } = await import("../tools/sessionToolExposure.ts");
const {
  nativePiSessionForTests,
  piToolActivationForTests,
  syncPiEngineMirrorForTests,
} = await import("./piEngine.ts");
const { answerNextInProcessWorkerCallForTests } =
  await import("../workers/inProcessWorker.ts");
const { decodeEngineOpen, ENGINE_METHODS } =
  await import("../workerProtocol/engineMethods.ts");
type PiEngineHandle = import("./piEngine.ts").PiEngineHandle;
type PiEngineOpenSpec = import("./piEngineHost.ts").PiEngineOpenSpec;
type PiLiveSession = import("./PiLiveSession.ts").PiLiveSession;

/** A deferred tool behind the GitHub gate, in the assistant's catalog. */
const GATED = "github_list_notifications";

const lives: PiLiveSession[] = [];

/** Flip the gate as a settings save does: write, then notify. */
function setGithub(enabled: boolean): void {
  updateGithubSettings({ enabled });
  notifyIntegrationToolsChanged();
}

afterEach(async () => {
  for (const live of lives.splice(0)) piStore.evict(live.key);
  setGithub(false);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Whether the engine's own gates let `find_tools` load {@link GATED}. */
function usable(engine: PiEngineHandle): boolean {
  return (
    piToolActivationForTests(engine)
      .exposure()
      .tools.find((tool) => tool.name === GATED)?.usable ?? false
  );
}

/** Whether pi exposes {@link GATED} to the model right now. */
function active(engine: PiEngineHandle): boolean {
  return nativePiSessionForTests(engine).getActiveToolNames().includes(GATED);
}

/** Ask the engine's own `find_tools` to load {@link GATED} by name. */
async function load(engine: PiEngineHandle): Promise<void> {
  await nativePiSessionForTests(engine)
    .getToolDefinition("find_tools")!
    .execute(
      `call-${Math.random()}`,
      { names: [GATED] },
      undefined,
      undefined,
      {} as never,
    );
}

async function chosen() {
  const model = await findModelForProfile(
    "default",
    "openai-compatible",
    "chosen",
  );
  assert.ok(model);
  return model;
}

/** A persisted assistant transcript on the fixture model. */
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
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  return file;
}

/**
 * Hold the next open: run the real handler, then flip the gate on and notify
 * while the server still awaits the answer, so nothing live hears the flip.
 */
function flipWhileOpening(): () => PiEngineOpenSpec {
  let spec: PiEngineOpenSpec | undefined;
  answerNextInProcessWorkerCallForTests(
    ENGINE_METHODS.open,
    async (payload, signal, real) => {
      spec = decodeEngineOpen(payload).spec as PiEngineOpenSpec;
      const answer = await real(payload, signal);
      setGithub(true);
      return answer;
    },
  );
  return () => {
    assert.ok(spec, "the Worker decoded an open");
    return spec;
  };
}

test("a settings flip changes a live session's active set and find_tools' usable set, and changes them back", async () => {
  setGithub(false);
  const live = await piStore.acquireNew("assistant", await chosen(), "off", {
    cwd: tmp,
  });
  lives.push(live);
  const { engine } = live;
  assert.equal(usable(engine), false);
  await load(engine);
  assert.equal(active(engine), false, "a gated-off tool does not load");

  setGithub(true);
  await vi.waitFor(() => assert.equal(usable(engine), true));
  // A flip makes a tool usable; only find_tools loads it.
  assert.equal(active(engine), false);
  await load(engine);
  assert.equal(active(engine), true);

  setGithub(false);
  await vi.waitFor(() => assert.equal(usable(engine), false));
  assert.equal(active(engine), false, "the gate hides a loaded tool");

  setGithub(true);
  await vi.waitFor(() => assert.equal(active(engine), true));
  assert.equal(usable(engine), true);
});

test("a flip that lands while a new, forked or reopened session is opening is caught up before it is returned", async () => {
  const opened: Array<[string, PiEngineOpenSpec, PiLiveSession]> = [];
  const parentFile = transcript("gates-parent");
  const reopenFile = transcript("gates-reopen");

  setGithub(false);
  let spec = flipWhileOpening();
  const created = await piStore.acquireNew("assistant", await chosen(), "off", {
    cwd: tmp,
  });
  lives.push(created);
  opened.push(["new", spec(), created]);
  // Read before any await: the acquisition itself carried the flip.
  const createdUsable = usable(created.engine);

  setGithub(false);
  spec = flipWhileOpening();
  const forked = await piStore.forkSession(
    "assistant",
    parentFile,
    "gates-parent-reply",
    "at",
    "app-entry-1",
  );
  lives.push(forked);
  opened.push(["fork", spec(), forked]);
  const forkedUsable = usable(forked.engine);

  setGithub(false);
  spec = flipWhileOpening();
  const reopened = await piStore.acquireExisting(
    "assistant",
    reopenFile,
    "gates-reopen",
  );
  lives.push(reopened);
  opened.push(["cold reopen", spec(), reopened]);
  const reopenedUsable = usable(reopened.engine);

  assert.deepEqual(
    [createdUsable, forkedUsable, reopenedUsable],
    [true, true, true],
  );
  for (const [label, openSpec, live] of opened) {
    assert.equal(
      openSpec.integrationGates.github,
      false,
      `${label}: opened under the old gates`,
    );
    await load(live.engine);
    assert.equal(active(live.engine), true, `${label}: find_tools loads it`);
  }
});

test("a flip while an account reopen is staged reaches the replacement at its commit, and the inspector moves to it only then", async () => {
  setGithub(false);
  const live = await piStore.acquireExisting(
    "assistant",
    transcript("gates-staged"),
    "gates-staged",
  );
  lives.push(live);
  const resident = live.engine;
  // piStore's own stage and commit, without the session's engine swap: the
  // resident stays `live.engine`, so the replacement is released here.
  let committed = false;
  const staged = await (
    live as unknown as {
      reopenForAccount(profileId: string): Promise<{
        engine: PiEngineHandle;
        commit(): Promise<void>;
        dispose(): Promise<void>;
      }>;
    }
  ).reopenForAccount("default");
  try {
    setGithub(true);
    await vi.waitFor(() => assert.equal(usable(resident), true));
    // Nothing is sent to a staged engine: it is not live.
    assert.equal(usable(staged.engine), false);
    await load(resident);
    await syncPiEngineMirrorForTests(resident);
    assert.deepEqual(
      sessionToolExposure(live.sessionId),
      piToolActivationForTests(resident).exposure(),
      "the resident still answers the inspector",
    );

    await staged.commit();
    committed = true;
    assert.equal(usable(staged.engine), true);
    assert.deepEqual(
      sessionToolExposure(live.sessionId),
      piToolActivationForTests(staged.engine).exposure(),
      "the committed replacement answers the inspector",
    );
  } finally {
    await (committed ? staged.engine.dispose() : staged.dispose());
  }
});

test("the inspector and the native loading facts equal the engine's activation after a find_tools load, a gate flip and a Plan flip", async () => {
  setGithub(true);
  const live = await piStore.acquireNew("assistant", await chosen(), "off", {
    cwd: tmp,
  });
  lives.push(live);
  const { engine } = live;
  const activation = piToolActivationForTests(engine);
  const agree = (label: string) => {
    assert.deepEqual(
      sessionToolExposure(live.sessionId),
      activation.exposure(),
      `${label}: inspector`,
    );
    assert.deepEqual(
      live.nativeFacts().live?.toolLoading,
      activation.loading(),
      `${label}: native loading`,
    );
  };

  await load(engine);
  // The load ran inside pi, outside any command; the mirror learns it here.
  await syncPiEngineMirrorForTests(engine);
  assert.equal(active(engine), true);
  agree("find_tools load");

  setGithub(false);
  await vi.waitFor(() => assert.equal(usable(engine), false));
  await syncPiEngineMirrorForTests(engine);
  agree("gate flip");
  const exposed = sessionToolExposure(live.sessionId)!.tools.find(
    (tool) => tool.name === GATED,
  );
  // Loaded natively, hidden by the gate: the two sets stay apart.
  assert.equal(
    live.nativeFacts().live?.toolLoading?.loadedToolNames.has(GATED),
    true,
  );
  assert.deepEqual([exposed?.usable, exposed?.loaded], [false, false]);

  await live.setMode("plan");
  agree("Plan flip");
});
