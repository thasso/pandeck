/**
 * The live session and its adapter act on what the engine reports it did
 * (`PiEngineRun`), not on what they asked for.
 *   pnpm --filter @assistant/server test src/piSdk/engineRunDisposition.test.ts
 *
 * A steer the engine ran as a prompt (it found itself idle) is a new turn: the
 * steering caller does not wait for that turn, and its failure fails it as a
 * new run rather than as a queued steer. A steer the session itself sent as a
 * prompt, because pi was between streams of a running turn, stays a steer of
 * that turn even though the engine reports it "started". A continuation whose transcript write
 * failed started nothing: the adapter rejects, and the session neither marks a
 * run nor manufactures a failed one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import type { AdapterEvent } from "../session/adapters/contract.ts";
import { codexRefusalText } from "../test/modelRefusalCaptures.ts";

const tmp = mkdtempSync(join(tmpdir(), "engine-run-disposition-test-"));
process.env.ASSISTANT_CWD = tmp;

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { localPiEngine } = await import("./piEngine.ts");
const { closeDb } = await import("../db/index.ts");

type PiEngineHandle = import("./piEngine.ts").PiEngineHandle;
type PiEngineRun = ReturnType<PiEngineHandle["submit"]>;

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A live session over a scripted engine: reads come from a fake pi session,
 * whose events the test emits; `submit` and `continueFailedTurn` answer the
 * scripted run. Without them the local engine drives the fake pi's own
 * `prompt` and `steer`.
 */
function harness(
  sessionId: string,
  options: {
    streaming: boolean;
    submit?: PiEngineHandle["submit"];
    continueFailedTurn?: PiEngineHandle["continueFailedTurn"];
    prompt?: (text: string) => Promise<void>;
    steer?: (text: string) => Promise<void>;
    /** The model the fake session reports it runs. */
    model?: unknown;
  },
) {
  let emit: ((event: unknown) => void) | undefined;
  const fake = {
    sessionId,
    sessionName: "Already named",
    isStreaming: options.streaming,
    model: options.model,
    // The engine suppresses pi's retry of a non-retryable provider failure.
    settingsManager: {
      getRetrySettings: () => ({ enabled: true, maxRetries: 3 }),
      applyOverrides: () => {},
    },
    messages: [],
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getHeader: () => null,
    },
    subscribe: (listener: (event: unknown) => void) => {
      emit = listener;
      return () => {};
    },
    getSessionStats: () => ({
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextSize: 0,
    }),
    steer: options.steer ?? (() => Promise.resolve()),
    prompt: options.prompt ?? (() => Promise.resolve()),
    dispose: () => {},
  };
  const base = localPiEngine(fake as never);
  const engine: PiEngineHandle = Object.create(base, {
    ...(options.submit ? { submit: { value: options.submit } } : {}),
    ...(options.continueFailedTurn
      ? { continueFailedTurn: { value: options.continueFailedTurn } }
      : {}),
  });
  let runsStarted = 0;
  const live = new PiLiveSession(
    "coding" as never,
    engine,
    {
      sessionRowsChanged: () => {},
      noteRunStarted: () => {
        runsStarted += 1;
      },
      checkPendingReload: () => {},
      isReloadQueued: () => false,
      buildSessionState: () => ({}) as never,
    } as never,
    () => {},
  );
  const seen: ServerMessage[] = [];
  live.addViewer({ send: (m: ServerMessage) => seen.push(m) });
  const adapter = live.createRuntimeAdapter();
  const adapterEvents: string[] = [];
  adapter.subscribe((event) => adapterEvents.push(event.type));
  return {
    live,
    adapter,
    seen,
    adapterEvents,
    emit: (event: unknown) => emit?.(event),
    runsStarted: () => runsStarted,
  };
}

const errorNotices = (seen: ServerMessage[]) =>
  seen.filter(
    (m) =>
      (m as { type: string }).type === "notice" &&
      (m as { severity?: string }).severity === "error",
  );

test("a steer the engine ran as a prompt is a new turn: the caller does not wait for it, and its failure fails it as a new run", async () => {
  const settled = deferred<void>();
  const intents: unknown[] = [];
  const h = harness("pi-steer-started", {
    // The driver's read says streaming; the engine had already gone idle.
    streaming: true,
    submit: (_text, _images, intent) => {
      intents.push(intent);
      const run: PiEngineRun = {
        disposition: Promise.resolve("started"),
        settled: settled.promise,
      };
      run.settled.catch(() => {});
      return run;
    },
  });

  let resolved = false;
  const result = await h.adapter
    .prompt("Also check the tests.", { steer: true })
    .then((value) => {
      resolved = true;
      return value;
    });
  assert.deepEqual(intents, [
    { steer: true, steerOnly: false, userTurnIdleMs: 0 },
  ]);
  assert.equal(resolved, true, "the steering caller returns at once");
  assert.equal(result.stopReason, "end");
  assert.equal(
    h.runsStarted(),
    0,
    "the driver does not mark the run before the engine's own turn starts",
  );

  // The engine's new turn starts after the disposition, and marks the run.
  h.emit({ type: "agent_start" });
  assert.equal(h.live.isRunning, true);
  assert.equal(h.runsStarted(), 1);

  // The drive completion the session waits on is that new turn.
  let admitted = false;
  const dropped = h.live.dropEncryptedReasoning(() => {
    admitted = true;
  });
  await tick();
  assert.equal(admitted, false, "the session waits for the new turn's end");

  settled.reject(new Error("provider down"));
  await dropped;
  assert.equal(admitted, true);
  assert.equal(
    h.live.isRunning,
    false,
    "the failed new turn ends the run, rather than leaving it to a turn that is gone",
  );
  assert.ok(
    h.seen.some(
      (m) =>
        (m as { type: string }).type === "assistantEnd" &&
        /provider down/.test(String((m as { error?: string }).error)),
    ),
    "the new turn ends as failed, not as a banner beside a running turn",
  );
  assert.ok(h.adapterEvents.includes("runFailing"));
  h.live.dispose();
});

test("a steer the engine took as a steer stays a steer", async () => {
  const settled = deferred<void>();
  const h = harness("pi-steer-steered", {
    streaming: true,
    submit: () => {
      const run: PiEngineRun = {
        disposition: Promise.resolve("steered"),
        settled: settled.promise,
      };
      run.settled.catch(() => {});
      return run;
    },
  });
  // Mark a running turn the steer joins.
  h.emit({ type: "agent_start" });

  let resolved = false;
  const pending = h.adapter
    .prompt("Also check the tests.", { steer: true })
    .then(() => {
      resolved = true;
    });
  await tick();
  assert.equal(resolved, false, "an ordinary steer waits for pi's acceptance");
  settled.resolve();
  await pending;
  assert.equal(h.live.isRunning, true, "the joined turn keeps running");
  h.live.dispose();
});

test("a steer sent as a prompt because pi was not streaming stays a steer of the running turn", async () => {
  const turn = deferred<void>();
  const steerRun = deferred<void>();
  steerRun.promise.catch(() => {});
  const prompts: string[] = [];
  const steers: string[] = [];
  const h = harness("pi-steer-not-streaming", {
    // The session's own turn is running, but pi is between streams.
    streaming: false,
    prompt: (text) => {
      prompts.push(text);
      return prompts.length === 1 ? turn.promise : steerRun.promise;
    },
    steer: (text) => {
      steers.push(text);
      return Promise.resolve();
    },
  });

  const first = h.adapter.prompt("Fix the build.");
  first.catch(() => {});
  h.emit({ type: "agent_start" });
  assert.equal(h.live.isRunning, true);

  let resolved = false;
  const pending = h.adapter
    .prompt("Also check the tests.", { steer: true })
    .then(() => {
      resolved = true;
    });
  pending.catch(() => {});
  await tick();
  // The local engine ran it as pi's prompt (`steer: false`) and reports it
  // "started"; the session did not ask to steer, so it is no new turn.
  assert.deepEqual(prompts, ["Fix the build.", "Also check the tests."]);
  assert.deepEqual(steers, []);
  assert.equal(
    resolved,
    false,
    "the steering caller waits for pi's settlement",
  );

  steerRun.reject(new Error("provider down"));
  await assert.rejects(pending, /provider down/);
  await tick();
  assert.equal(
    errorNotices(h.seen).length,
    1,
    "the failure is a banner beside the running turn",
  );
  assert.equal(h.live.isRunning, true, "the running turn is not failed");
  assert.ok(
    !h.seen.some((m) => (m as { type: string }).type === "assistantEnd"),
    "the running turn does not end",
  );
  assert.ok(!h.adapterEvents.includes("runFailing"));

  // The drive completion the session waits on is still the running turn.
  let admitted = false;
  const dropped = h.live.dropEncryptedReasoning(() => {
    admitted = true;
  });
  await tick();
  assert.equal(admitted, false, "the session waits for the running turn's end");
  turn.resolve();
  await dropped;
  assert.equal(admitted, true);
  h.live.dispose();
});

test("a continuation whose disposition rejects later starts nothing and fails nothing", async () => {
  const disposition = deferred<"started">();
  let continuations = 0;
  const h = harness("pi-continuation-write-failed", {
    streaming: false,
    continueFailedTurn: () => {
      continuations += 1;
      const run: PiEngineRun = {
        disposition: disposition.promise,
        settled: disposition.promise.then(() => undefined),
      };
      run.disposition.catch(() => {});
      run.settled.catch(() => {});
      return run;
    },
  });

  const pending = h.adapter.prompt("Continue on the new account.", {
    continuation: true,
  });
  pending.catch(() => {});
  await tick();
  // A second continuation before the engine answered is refused, not doubled.
  await assert.rejects(
    h.adapter.prompt("Continue again.", { continuation: true }),
    /Cannot continue/,
  );
  assert.equal(continuations, 1);

  disposition.reject(new Error("ENOSPC: transcript write failed"));
  await assert.rejects(pending, /ENOSPC/);
  await tick();

  assert.equal(h.runsStarted(), 0, "no run was marked");
  assert.equal(h.live.isRunning, false);
  assert.deepEqual(errorNotices(h.seen), [], "no error banner");
  assert.ok(
    !h.seen.some((m) => (m as { type: string }).type.startsWith("assistant")),
    "no synthetic assistant turn",
  );
  for (const type of ["messageStarted", "runFailing", "messageCompleted"])
    assert.ok(!h.adapterEvents.includes(type), `no ${type}`);

  // The refusal leaves the session usable: the next continuation is taken.
  const next = h.adapter.prompt("Continue once more.", { continuation: true });
  next.catch(() => {});
  assert.equal(continuations, 2);
  h.live.dispose();
});

test("a continuation the engine started marks the run once it reports", async () => {
  const disposition = deferred<"started">();
  const settled = deferred<void>();
  const h = harness("pi-continuation-started", {
    streaming: false,
    continueFailedTurn: () => {
      const run: PiEngineRun = {
        disposition: disposition.promise,
        settled: settled.promise,
      };
      run.settled.catch(() => {});
      return run;
    },
  });

  const pending = h.adapter.prompt("Continue on the new account.", {
    continuation: true,
  });
  await tick();
  assert.equal(
    h.runsStarted(),
    0,
    "nothing is marked before the engine reports",
  );
  assert.equal(h.live.isRunning, false);

  disposition.resolve("started");
  await tick();
  assert.equal(h.runsStarted(), 1);
  assert.equal(h.live.isRunning, true);

  settled.reject(new Error("provider down"));
  const result = await pending;
  assert.equal(
    result.stopReason,
    "error",
    "a started continuation that fails is a failed run",
  );
  assert.equal(h.live.isRunning, false);
  h.live.dispose();
});

// Task-1483: a Codex model refusal names the engine's concrete model on every
// failure event, so account health can remember it for the account.
describe("model refused on the account", () => {
  const CODEX_MODEL = {
    provider: "openai-codex",
    id: "gpt-4o",
    api: "openai-codex-responses",
  };

  function refusalHarness(sessionId: string) {
    const h = harness(sessionId, { streaming: false, model: CODEX_MODEL });
    const events: AdapterEvent[] = [];
    h.adapter.subscribe((event) => events.push(event));
    return { ...h, events };
  }

  const failureOf = (events: AdapterEvent[], type: AdapterEvent["type"]) => {
    const event = events.find((candidate) => candidate.type === type);
    return event && "failure" in event ? event.failure : undefined;
  };

  test.each([
    ["the captured Codex text", codexRefusalText("gpt-4o"), true],
    [
      "a near miss naming another surface",
      "Codex error: The 'gpt-4o' model is not supported when using Codex with an API key.",
      false,
    ],
  ] as const)(
    "%s on runFailing, messageCompleted and runCompleted",
    async (_case, errorMessage, refused) => {
      const h = refusalHarness(`pi-refusal-${refused}`);
      h.emit({ type: "agent_start" });
      h.emit({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      h.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage,
          provider: "openai-codex",
          model: "gpt-4o",
          api: "openai-codex-responses",
        },
      });
      h.emit({ type: "agent_settled" });
      const failing = failureOf(h.events, "runFailing");
      const completed = failureOf(h.events, "messageCompleted");
      const closed = failureOf(h.events, "runCompleted");
      assert.ok(failing);
      assert.deepEqual(completed, failing);
      assert.deepEqual(closed, failing);
      if (refused)
        assert.deepEqual(failing, {
          kind: "model_unavailable",
          unavailableModelId: "gpt-4o",
        });
      else assert.notEqual(failing.kind, "model_unavailable");
      h.live.dispose();
    },
  );

  test("a retry that ends refused reports the facts on the run's first runFailing, the one the runtime records", () => {
    const h = refusalHarness("pi-refusal-retry");
    h.emit({ type: "agent_start" });
    h.emit({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    h.emit({ type: "agent_end", willRetry: true });
    h.emit({
      type: "auto_retry_end",
      success: false,
      finalError: codexRefusalText("gpt-4o"),
    });
    h.emit({ type: "agent_settled" });
    const failures = h.events.filter((event) => event.type === "runFailing");
    // The runtime keeps a run's FIRST failure (`reportRunFailure`); the
    // settle's later report and the run's close add no other facts.
    assert.deepEqual("failure" in failures[0]! && failures[0].failure, {
      kind: "model_unavailable",
      unavailableModelId: "gpt-4o",
    });
    for (const event of [
      ...failures.slice(1),
      ...h.events.filter((e) => e.type === "runCompleted"),
    ])
      assert.equal("failure" in event ? event.failure : undefined, undefined);
    assert.ok(h.events.some((event) => event.type === "runCompleted"));
    h.live.dispose();
  });
});
