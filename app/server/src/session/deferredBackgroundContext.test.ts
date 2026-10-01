/**
 * Deferred background-work facts riding a turn that exists for another reason.
 *   pnpm --filter @assistant/server test src/session/deferredBackgroundContext.test.ts
 *
 * The prompt facade with a scripted adapter: what the MODEL receives carries the
 * deferred block, the durable log and the client projection keep only the clean
 * human text, and the block is consumed exactly once — by an ACCEPTED turn.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test } from "vitest";
import type {
  AdapterEvent,
  AgentRunResult,
  ForkCapability,
  PromptableAdapter,
  PromptOptions,
} from "./adapters/contract.ts";

const tmp = mkdtempSync(join(tmpdir(), "deferred-bg-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionRuntime } = await import("./runtime/runtime.ts");
const { SessionLogStore } = await import("./log/store.ts");
const {
  promptRuntimeSessionWithRuntime,
  setDeferredBackgroundContextProvider,
} = await import("./runtimePrompt.ts");
const { closeDb } = await import("../db/index.ts");
const { updateSettings, getSettings } = await import("../settings.ts");

updateSettings({ memory: { ...getSettings().memory, learningMode: "off" } });

afterEach(() => setDeferredBackgroundContextProvider(undefined));
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function harnessed(sessionId: string) {
  const modelTexts: string[] = [];
  const capabilities: ForkCapability = {
    fork: "none",
    compact: false,
    steer: true,
    attachments: true,
  };
  const adapter: PromptableAdapter = {
    provider: "scripted",
    capabilities,
    subscribe: (_l: (e: AdapterEvent) => void) => () => {},
    getBinding: () => ({ provider: "scripted", nativeId: "n1" }),
    prompt: (text: string, _o?: PromptOptions): Promise<AgentRunResult> => {
      modelTexts.push(text);
      return Promise.resolve({ stopReason: "end" });
    },
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession(sessionId, adapter);
  return {
    runtime,
    modelTexts,
    driver: {
      id: sessionId,
      key: sessionId,
      sessionId,
      harness: "claude-sdk" as const,
      agentType: "assistant" as const,
      sessionFile: undefined,
      isRunning: false,
      canSteer: true,
      contextInfo: () => ({}) as never,
      broadcastState: () => {},
      createRuntimeAdapter: () => adapter,
    },
  };
}

/** A provider that hands out one block and records whether it was committed. */
function oneBlock(block: string) {
  const state = { commits: 0, peeks: 0, live: true };
  setDeferredBackgroundContextProvider(() => {
    state.peeks += 1;
    if (!state.live) return undefined;
    return {
      block,
      commit: () => {
        state.commits += 1;
        state.live = false;
      },
    };
  });
  return state;
}

test("a deferred fact reaches the model and never the durable log", async () => {
  const { runtime, modelTexts, driver } = harnessed("sess-defer");
  const state = oneBlock("BACKGROUND-FACT");

  await promptRuntimeSessionWithRuntime(runtime, driver, "what next?", {
    clientRequestId: "d1",
  });

  assert.equal(modelTexts.length, 1);
  assert.ok(
    modelTexts[0]!.includes("BACKGROUND-FACT"),
    "the model-bound text carries the deferred block",
  );
  assert.ok(
    modelTexts[0]!.endsWith("what next?"),
    "the human text stays last, after the model-only block",
  );
  assert.equal(state.commits, 1, "an accepted turn consumes the block");

  const durable = runtime
    .get("sess-defer")!
    .getSnapshot()
    .entries.filter((e) => e.role === "user")
    .flatMap((e) =>
      e.content
        .filter((b): b is Extract<typeof b, { type: "text" }> =>
          Boolean(b.type === "text"),
        )
        .map((b) => b.text),
    );
  assert.deepEqual(
    durable,
    ["what next?"],
    "the durable log keeps only the clean human text",
  );
  assert.ok(
    !JSON.stringify(runtime.get("sess-defer")!.clientTimeline()).includes(
      "BACKGROUND-FACT",
    ),
    "the client projection never shows the deferred block",
  );
});

test("the block is consumed once and does not repeat on the next turn", async () => {
  const { runtime, modelTexts, driver } = harnessed("sess-once");
  oneBlock("ONLY-ONCE");

  await promptRuntimeSessionWithRuntime(runtime, driver, "first", {
    clientRequestId: "o1",
  });
  await promptRuntimeSessionWithRuntime(runtime, driver, "second", {
    clientRequestId: "o2",
  });

  assert.ok(modelTexts[0]!.includes("ONLY-ONCE"));
  assert.ok(
    !modelTexts[1]!.includes("ONLY-ONCE"),
    "a committed block must not ride a second turn",
  );
});

test("a hidden prompt carries the deferred block", async () => {
  // `connection.ts` resumes approval decisions, pull-request outcomes and
  // answered questions as HIDDEN prompts. They are real turns where the agent
  // acts, so a fact deferred to arrive "before the next action" has to ride
  // them; excluding them let a session act without it.
  const { runtime, modelTexts, driver } = harnessed("sess-hidden");
  const state = oneBlock("MUST-APPEAR");

  await promptRuntimeSessionWithRuntime(runtime, driver, "approval outcome", {
    clientRequestId: "h1",
    hidden: true,
  });

  assert.ok(modelTexts[0]!.includes("MUST-APPEAR"));
  assert.equal(state.commits, 1);
});

/**
 * A REAL steer: the runtime has to be `running`, or `options.steer` falls
 * through to the ordinary path and the test proves nothing about steering.
 * `steerAccepted` decides whether the provider takes the mid-turn message.
 */
function steerHarness(sessionId: string, steerAccepted: boolean) {
  const modelTexts: string[] = [];
  let releaseTurn: (() => void) | undefined;
  const adapter: PromptableAdapter = {
    provider: "scripted",
    capabilities: {
      fork: "none",
      compact: false,
      steer: true,
      attachments: true,
    },
    subscribe: (_l: (e: AdapterEvent) => void) => () => {},
    getBinding: () => ({ provider: "scripted", nativeId: "n1" }),
    prompt: (text: string, options: PromptOptions = {}) => {
      if (options.steer) {
        if (!steerAccepted)
          return Promise.reject(new Error("pi rejected the steer"));
        modelTexts.push(text);
        return Promise.resolve<AgentRunResult>({ stopReason: "end" });
      }
      modelTexts.push(text);
      return new Promise<AgentRunResult>((resolve) => {
        releaseTurn = () => resolve({ stopReason: "end" });
      });
    },
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const live = runtime.createSession(sessionId, adapter);
  return {
    runtime,
    modelTexts,
    release: () => releaseTurn?.(),
    start: async () => {
      void live.prompt("long running turn");
      await Promise.resolve();
      assert.equal(live.isRunning, true, "the turn has to be live to steer");
    },
    driver: {
      id: sessionId,
      key: sessionId,
      sessionId,
      harness: "pi" as const,
      agentType: "assistant" as const,
      sessionFile: undefined,
      isRunning: false,
      canSteer: true,
      contextInfo: () => ({}) as never,
      broadcastState: () => {},
      createRuntimeAdapter: () => adapter,
    },
  };
}

test("a steering prompt into a live turn carries the deferred block", async () => {
  const h = steerHarness("sess-steered", true);
  await h.start();
  const state = oneBlock("MUST-APPEAR-TOO");

  await promptRuntimeSessionWithRuntime(h.runtime, h.driver, "steered", {
    clientRequestId: "s1",
    steer: true,
  });

  assert.ok(
    h.modelTexts.some((t) => t.includes("MUST-APPEAR-TOO")),
    "the block rides the mid-turn message",
  );
  assert.equal(state.commits, 1);
  h.release();
});

test("a steer the provider rejects does not consume the deferred block", async () => {
  // Deferred facts ride ordinary steers now, so the adapter reporting a steer as
  // accepted before pi settles became a loss path: the facade would commit while
  // pi later rejected and the model never saw the message.
  const h = steerHarness("sess-steer-rejected", false);
  await h.start();
  const state = oneBlock("SURVIVES-REJECTED-STEER");

  await assert.rejects(
    promptRuntimeSessionWithRuntime(h.runtime, h.driver, "steered", {
      clientRequestId: "s2",
      steer: true,
    }),
  );
  assert.equal(state.commits, 0, "a rejected steer consumes nothing");
  assert.ok(
    !h.modelTexts.some((t) => t.includes("SURVIVES-REJECTED-STEER")),
    "and the block never reached the model",
  );
  h.release();
});

test("a provider that refuses the prompt does not consume the fact", async () => {
  // The commit must follow PROVIDER ACCEPTANCE, not the durable append that
  // precedes it. Committing at append threw the only copy away whenever the
  // adapter then rejected — a fact the model never saw, gone.
  const modelTexts: string[] = [];
  let failNext = true;
  const adapter: PromptableAdapter = {
    provider: "scripted",
    capabilities: {
      fork: "none",
      compact: false,
      steer: true,
      attachments: true,
    },
    subscribe: (_l: (e: AdapterEvent) => void) => () => {},
    getBinding: () => ({ provider: "scripted", nativeId: "n1" }),
    prompt: (text: string, _o?: PromptOptions): Promise<AgentRunResult> => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("provider refused"));
      }
      modelTexts.push(text);
      return Promise.resolve({ stopReason: "end" });
    },
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession("sess-provider-refused", adapter);
  const driver = {
    id: "sess-provider-refused",
    key: "sess-provider-refused",
    sessionId: "sess-provider-refused",
    harness: "claude-sdk" as const,
    agentType: "assistant" as const,
    sessionFile: undefined,
    isRunning: false,
    canSteer: true,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => adapter,
  };
  const state = oneBlock("SURVIVES-PROVIDER-FAILURE");

  await assert.rejects(
    promptRuntimeSessionWithRuntime(runtime, driver, "first", {
      clientRequestId: "p1",
    }),
  );
  assert.equal(state.commits, 0, "a rejected prompt consumes nothing");

  await promptRuntimeSessionWithRuntime(runtime, driver, "second", {
    clientRequestId: "p2",
  });
  assert.ok(
    modelTexts[0]!.includes("SURVIVES-PROVIDER-FAILURE"),
    "the fact still reaches the next turn that the provider accepts",
  );
  assert.equal(state.commits, 1);
});

test("a refused turn leaves the fact for the next one", async () => {
  const { runtime, driver } = harnessed("sess-refused");
  const state = oneBlock("SURVIVES");
  // A duplicate clientRequestId is dropped before any user entry is appended,
  // so `onUserEntry` never fires and the block must stay uncommitted.
  await promptRuntimeSessionWithRuntime(runtime, driver, "once", {
    clientRequestId: "same",
  });
  assert.equal(state.commits, 1);

  const second = oneBlock("SURVIVES-AGAIN");
  await promptRuntimeSessionWithRuntime(runtime, driver, "again", {
    clientRequestId: "same",
  });
  assert.equal(
    second.commits,
    0,
    "a deduplicated prompt appends nothing, so it consumes nothing",
  );
});
