/**
 * Deferred background-work facts riding a turn that exists for another reason.
 *   pnpm --filter @assistant/server test src/session/deferredBackgroundContext.test.ts
 *
 * The prompt facade with a scripted adapter: what the MODEL receives carries the
 * deferred block, the durable log and the client projection keep only the clean
 * human text, and the block is claimed by exactly one prompt: bound to the run
 * its append joined (whose outcome alone settles it), or given back when the
 * prompt provably never exposed it.
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
const { subscribeSessionRunEnded } = await import("./runtime/liveSession.ts");
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

/**
 * A provider that hands out one block, claimed by the prompt that takes it, and
 * records where it was exposed and how its carrier ended. A carrier that ends
 * without exposing it — or a steer the provider refused after its append —
 * gives it back, as `completionDelivery.ts` does.
 */
function oneBlock(block: string) {
  const state = {
    claims: 0,
    live: true,
    exposures: [] as (string | undefined)[],
    providerCalls: [] as (string | undefined)[],
    declined: 0,
    finished: [] as unknown[],
  };
  setDeferredBackgroundContextProvider(() => {
    if (!state.live) return undefined;
    state.claims += 1;
    state.live = false;
    let exposed = false;
    let called = false;
    let declined = false;
    return {
      block,
      hooks: {
        onUserEntry: (_entryId, runId) => {
          exposed = true;
          state.exposures.push(runId);
        },
        onProviderCall: (runId) => {
          called = true;
          state.providerCalls.push(runId);
        },
        onProviderDeclined: () => {
          declined = true;
          state.declined += 1;
        },
      },
      finished: (thrown) => {
        state.finished.push(thrown);
        // As `BackgroundHandlingAttempt`: only the runtime's own word that the
        // provider never had it gives the block back.
        if (declined || (!exposed && !called)) state.live = true;
      },
    };
  });
  return state;
}

/** Every run outcome, as `index.ts` hears them to settle background facts. */
const outcomes: { sessionId: string; runId: string; stopReason: string }[] = [];
subscribeSessionRunEnded((sessionId, outcome) =>
  outcomes.push({ sessionId, ...outcome }),
);

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
  assert.equal(state.exposures.length, 1, "appended once, into a run");
  const run = outcomes.find((o) => o.sessionId === "sess-defer");
  assert.equal(
    state.exposures[0],
    run?.runId,
    "bound to the run whose outcome settles it",
  );
  assert.equal(run?.stopReason, "end");

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
    "a claimed block must not ride a second turn",
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
  assert.equal(state.exposures.length, 1);
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
  assert.equal(state.exposures.length, 1);
  assert.ok(state.exposures[0], "bound to the run the steer joined");
  assert.equal(state.live, false, "taken by that run");
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
  assert.equal(state.declined, 1, "the runtime says pi took nothing");
  assert.equal(state.live, true, "a rejected steer gives the block back");
  assert.ok(
    !h.modelTexts.some((t) => t.includes("SURVIVES-REJECTED-STEER")),
    "and the block never reached the model",
  );
  h.release();
});

test("a turn that fails after its append keeps the fact with that failed run, never the next turn", async () => {
  // Once appended, the prompt may have reached the provider: whether it did is
  // the run's outcome to say, and a failed run leaves the fact interrupted for
  // the user's Recover — never silently handed to whatever turn comes next.
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
  const failed = outcomes.find((o) => o.sessionId === "sess-provider-refused");
  assert.equal(failed?.stopReason, "error");
  assert.deepEqual(state.exposures, [failed?.runId], "bound to the failed run");
  assert.equal(state.live, false, "not given back to the queue");

  await promptRuntimeSessionWithRuntime(runtime, driver, "second", {
    clientRequestId: "p2",
  });
  assert.ok(
    !modelTexts[0]!.includes("SURVIVES-PROVIDER-FAILURE"),
    "an unrelated later turn does not carry, or discharge, it",
  );
});

test("a refused turn leaves the fact for the next one", async () => {
  const { runtime, driver } = harnessed("sess-refused");
  const state = oneBlock("SURVIVES");
  // A duplicate clientRequestId is dropped before any user entry is appended,
  // so `onUserEntry` never fires and the block must stay uncommitted.
  await promptRuntimeSessionWithRuntime(runtime, driver, "once", {
    clientRequestId: "same",
  });
  assert.equal(state.exposures.length, 1);

  const second = oneBlock("SURVIVES-AGAIN");
  await promptRuntimeSessionWithRuntime(runtime, driver, "again", {
    clientRequestId: "same",
  });
  assert.equal(
    second.exposures.length,
    0,
    "a deduplicated prompt appends nothing",
  );
  assert.equal(second.live, true, "so the block goes back");
});
