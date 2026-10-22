/**
 * Task 1021: a user `/<skill>` invocation through the real prompt door.
 *   pnpm --filter @assistant/server test src/session/skillCommandPrompt.test.ts
 *
 * The door refuses everything a skill turn cannot be before anything is
 * appended; the runtime asks the adapter's synchronous dispatch before it
 * claims the request id; and what reaches the adapter is the native command
 * plus the typed args, the turn's context beside it, while the durable log
 * keeps the line as typed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type {
  AdapterEvent,
  AgentRunResult,
  ForkCapability,
  PromptableAdapter,
  PromptOptions,
} from "./adapters/contract.ts";
import type { SessionMode } from "@assistant/shared";
import type { ClaudeQuery, ClaudeQueryParams } from "../claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "skill-command-prompt-test-"));
process.env.ASSISTANT_CWD = tmp;

vi.mock("../sessionSkills.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessionSkills.ts")>()),
  sessionSkills: vi.fn(async () => ["alpha", "clash", "quiet"]),
  skillUserInvocable: vi.fn(async (name: string) => name !== "quiet"),
}));

const { SessionRuntime } = await import("./runtime/runtime.ts");
const { SessionLogStore } = await import("./log/store.ts");
const {
  promptRuntimeSessionWithRuntime,
  setDeferredBackgroundContextProvider,
} = await import("./runtimePrompt.ts");
const { subscribeSessionRunEnded } = await import("./runtime/liveSession.ts");
const { planModeHint, forgetPlanHintState } = await import("./planHint.ts");
const { closeDb } = await import("../db/index.ts");
const { createMemory, archiveMemory } =
  await import("../memory/memoryService.ts");
const { updateSettings, getSettings } = await import("../settings.ts");

updateSettings({
  memory: { ...getSettings().memory, learningMode: "off" },
  sessionNaming: { ...getSettings().sessionNaming, enabled: false },
});

afterEach(() => setDeferredBackgroundContextProvider(undefined));
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function harnessed(
  sessionId: string,
  outcome: AgentRunResult = { stopReason: "end" },
) {
  const prompts: Array<{ text: string; options: PromptOptions | undefined }> =
    [];
  const capabilities: ForkCapability = {
    fork: "none",
    compact: false,
    steer: false,
    attachments: true,
  };
  const adapter: PromptableAdapter = {
    provider: "scripted",
    capabilities,
    subscribe: (_l: (e: AdapterEvent) => void) => () => {},
    getBinding: () => ({ provider: "scripted", nativeId: "n1" }),
    prompt: (
      text: string,
      options?: PromptOptions,
    ): Promise<AgentRunResult> => {
      prompts.push({ text, options });
      return Promise.resolve(outcome);
    },
    skillDispatch: (name) =>
      name === "clash"
        ? { refused: `/${name} clashes with a repository skill.` }
        : { command: `/native:${name}` },
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession(sessionId, adapter);
  forgetPlanHintState(sessionId);
  const driver = {
    id: sessionId,
    key: sessionId,
    sessionId,
    harness: "claude-sdk" as const,
    agentType: "assistant" as const,
    sessionFile: undefined,
    isRunning: false,
    canSteer: false,
    sessionMode: "plan" as SessionMode,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => adapter,
  };
  const userTexts = () =>
    runtime
      .get(sessionId)!
      .getSnapshot()
      .entries.filter((e) => e.role === "user")
      .flatMap((e) =>
        e.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
      );
  return { runtime, driver, prompts, userTexts };
}

test("a skill turn sends the native command and args, its context beside them", async () => {
  const { runtime, driver, prompts, userTexts } = harnessed("sess-skill");
  await promptRuntimeSessionWithRuntime(runtime, driver, "/alpha  the parser", {
    clientRequestId: "s1",
    skillInvocation: { name: "alpha", args: "the parser" },
  });
  // Then an ordinary turn: it carries none of the skill turn's options.
  await promptRuntimeSessionWithRuntime(runtime, driver, "plain", {
    clientRequestId: "s2",
  });

  assert.equal(prompts.length, 2);
  assert.equal(prompts[0]!.text, "/native:alpha the parser");
  assert.equal(prompts[0]!.options?.skillCommand, "alpha");
  assert.equal(prompts[0]!.options?.titleText, "/alpha  the parser");
  assert.ok(
    prompts[0]!.options?.turnContext?.includes(planModeHint("claude-sdk")),
    "the per-turn context rides as turnContext, not in the command",
  );
  assert.ok(!prompts[0]!.text.includes("<session-mode>"));

  assert.ok(prompts[1]!.text.endsWith("plain"));
  assert.ok(prompts[1]!.text.includes(planModeHint("claude-sdk")));
  for (const key of ["skillCommand", "titleText", "turnContext"] as const)
    assert.equal(prompts[1]!.options?.[key], undefined);

  assert.deepEqual(userTexts(), ["/alpha  the parser", "plain"]);
});

test("a skill turn's deferred fact rides its context and settles by the run's outcome", async () => {
  const runs: { sessionId: string; runId: string; stopReason: string }[] = [];
  const unsubscribe = subscribeSessionRunEnded((sessionId, outcome) =>
    runs.push({ sessionId, ...outcome }),
  );
  const exposures: string[] = [];
  const finished: unknown[] = [];
  setDeferredBackgroundContextProvider(() => ({
    block: "BACKGROUND-FACT",
    observe: (receipt) => {
      receipt.observe((event) => {
        if (event.type === "appended" && event.append.runId)
          exposures.push(event.append.runId);
      });
    },
    finished: (thrown) => finished.push(thrown),
  }));
  try {
    const { runtime, driver, prompts, userTexts } = harnessed("sess-defer", {
      stopReason: "error",
      errorMessage: "/alpha is not available in this session's runtime.",
    });
    await assert.rejects(
      promptRuntimeSessionWithRuntime(runtime, driver, "/alpha", {
        clientRequestId: "d1",
        skillInvocation: { name: "alpha", args: "" },
      }),
      { message: "/alpha is not available in this session's runtime." },
    );
    assert.equal(prompts[0]!.text, "/native:alpha");
    assert.ok(prompts[0]!.options?.turnContext?.includes("BACKGROUND-FACT"));
    assert.deepEqual(userTexts(), ["/alpha"]);
    // The failed run is what the fact's settlement hears, as for any turn.
    const run = runs.find((r) => r.sessionId === "sess-defer");
    assert.equal(run?.stopReason, "error");
    assert.deepEqual(exposures, [run?.runId]);
    assert.equal(finished.length, 1);
  } finally {
    unsubscribe();
  }
});

test("one skill turn carries a selected memory, the Plan hint and a deferred fact, all beside the command", async () => {
  const created = createMemory({
    text: "Prefers terse parser reviews",
    kind: "preference",
    pinned: true,
    provenance: { sourceKind: "manual" },
  });
  assert.ok(created.ok);
  setDeferredBackgroundContextProvider(() => ({
    block: "BACKGROUND-FACT",
    observe: () => {},
    finished: () => {},
  }));
  try {
    const { runtime, driver, prompts, userTexts } = harnessed("sess-all");
    await promptRuntimeSessionWithRuntime(
      runtime,
      driver,
      "/alpha the parser",
      {
        clientRequestId: "a1",
        skillInvocation: { name: "alpha", args: "the parser" },
      },
    );
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]!.text, "/native:alpha the parser");
    const context = prompts[0]!.options?.turnContext ?? "";
    for (const part of [
      "Prefers terse parser reviews",
      planModeHint("claude-sdk"),
      "BACKGROUND-FACT",
    ])
      assert.ok(context.includes(part), `turnContext carries ${part}`);
    assert.deepEqual(userTexts(), ["/alpha the parser"]);
  } finally {
    archiveMemory(created.card.id, created.card.revision);
  }
});

test("the door refuses what a skill turn cannot be, before any append", async () => {
  const { runtime, driver, prompts, userTexts } = harnessed("sess-refuse");
  const refused = async (
    name: string,
    options: Record<string, unknown>,
    message: string,
  ) =>
    assert.rejects(
      promptRuntimeSessionWithRuntime(runtime, driver, `/${name} x`, {
        skillInvocation: { name, args: "x" },
        ...options,
      }),
      { message },
    );

  await refused("beta", {}, "/beta is not one of this session's skills.");
  await refused(
    "alpha",
    { steer: true },
    "/alpha starts a new turn; send it when the current one finishes.",
  );
  await refused(
    "alpha",
    { steerOnly: true, steer: true },
    "/alpha starts a new turn; send it when the current one finishes.",
  );
  await refused(
    "alpha",
    { hidden: true },
    "/alpha can only be sent as a visible prompt.",
  );
  await refused(
    "alpha",
    { continuation: true },
    "/alpha can only be sent as a visible prompt.",
  );
  await refused(
    "alpha",
    {
      attachments: [
        { name: "a.png", mimeType: "image/png", size: 1, data: "AA==" },
      ],
    },
    "Skill commands do not support attachments.",
  );
  await refused("quiet", {}, "/quiet can only be loaded by the agent.");

  assert.equal(prompts.length, 0);
  assert.deepEqual(userTexts(), []);
});

test("a dispatch refusal claims nothing: the same request id still sends", async () => {
  const { runtime, driver, prompts, userTexts } = harnessed("sess-clash");
  await assert.rejects(
    promptRuntimeSessionWithRuntime(runtime, driver, "/clash x", {
      clientRequestId: "r1",
      skillInvocation: { name: "clash", args: "x" },
    }),
    { message: "/clash clashes with a repository skill." },
  );
  assert.equal(prompts.length, 0);
  assert.deepEqual(userTexts(), []);
  assert.equal(runtime.get("sess-clash")!.isRunning, false);

  await promptRuntimeSessionWithRuntime(runtime, driver, "/alpha", {
    clientRequestId: "r1",
    skillInvocation: { name: "alpha", args: "" },
  });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.text, "/native:alpha");
  assert.deepEqual(userTexts(), ["/alpha"]);
});

/* ---- preflight against the real Claude driver, held at its registration ---- */

const { ClaudeSdkSession } = await import("../test/claudeSdkSession.ts");
const { SessionBusyError } = await import("./runtime/errors.ts");
const { skillRuntimePluginName, skillSetHash } =
  await import("../skills/skillRuntimeMaterializer.ts");

/** A Claude query whose command list answers only when the test says so. */
function gatedClaude(sessionId: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inputs: unknown[] = [];
  let registered = 0;
  const session = new ClaudeSdkSession(sessionId, {
    seam: async () => ({
      query(params: ClaudeQueryParams): ClaudeQuery {
        let closed!: () => void;
        const ended = new Promise<void>((resolve) => (closed = resolve));
        params.options?.abortController?.signal.addEventListener("abort", () =>
          closed(),
        );
        void (async () => {
          if (typeof params.prompt === "string") return;
          for await (const message of params.prompt) inputs.push(message);
        })();
        return {
          // Nothing to say until the process is closed.
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await ended;
              return { value: undefined, done: true as const };
            },
          }),
          async supportedCommands() {
            registered += 1;
            await gate;
            return [
              {
                name: `${skillRuntimePluginName(skillSetHash(["alpha"]))}:alpha`,
              },
            ];
          },
          close: () => closed(),
        };
      },
    }),
    agentType: "assistant",
    prepareSkillRuntime: async () => {},
  });
  (
    session as unknown as { frozenSkillNames: () => string[] }
  ).frozenSkillNames = () => ["alpha"];
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession(sessionId, session.createRuntimeAdapter());
  forgetPlanHintState(sessionId);
  const driver = {
    id: sessionId,
    key: sessionId,
    sessionId,
    harness: "claude-sdk" as const,
    agentType: "assistant" as const,
    sessionFile: undefined,
    isRunning: false,
    canSteer: true,
    sessionMode: "default" as SessionMode,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => session.createRuntimeAdapter(),
  };
  const userRows = () =>
    runtime
      .get(sessionId)!
      .getSnapshot()
      .entries.filter((e) => e.role === "user").length;
  const held = async () => {
    for (let i = 0; i < 2_000 && registered === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(registered, 1, "the driver is held at its registration");
  };
  const skill = (clientRequestId: string) =>
    promptRuntimeSessionWithRuntime(runtime, driver, "/alpha x", {
      clientRequestId,
      skillInvocation: { name: "alpha", args: "x" },
    });
  return { session, runtime, driver, inputs, release, held, skill, userRows };
}

test("while the Claude driver awaits registration, a skill turn admits nothing else", async () => {
  // A duplicate id is the same submission; another prompt finds the run busy.
  const busy = gatedClaude("sess-held");
  const first = busy.skill("held-1");
  await busy.held();
  await busy.skill("held-1");
  await assert.rejects(
    promptRuntimeSessionWithRuntime(busy.runtime, busy.driver, "plain", {
      clientRequestId: "held-2",
    }),
    SessionBusyError,
  );
  assert.equal(busy.userRows(), 1);
  assert.equal(busy.inputs.length, 0);
  busy.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(busy.inputs.length, 1, "only the command, once");
  void busy.runtime.abort("sess-held");
  await first.catch(() => {});
  busy.session.dispose();

  // Stop during the hold pushes nothing; the id stays spent.
  const stopped = gatedClaude("sess-held-stop");
  const stopping = stopped.skill("stop-1");
  await stopped.held();
  await stopped.runtime.abort("sess-held-stop");
  stopped.release();
  await stopping.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped.inputs.length, 0);
  assert.equal(stopped.userRows(), 1);
  await stopped.skill("stop-1");
  assert.equal(stopped.userRows(), 1, "a replay of the same id adds no row");
  stopped.session.dispose();

  // Teardown during the hold pushes nothing either.
  const torn = gatedClaude("sess-held-teardown");
  const tearing = torn.skill("tear-1");
  await torn.held();
  torn.runtime.closeForTeardown("sess-held-teardown");
  torn.session.dispose();
  torn.release();
  await tearing.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(torn.inputs.length, 0);
  assert.equal(torn.userRows(), 1);
});
