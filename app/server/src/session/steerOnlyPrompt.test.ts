/**
 * `steerOnly`: join a running turn, or send nothing at all.
 *   pnpm --filter @assistant/server test src/session/steerOnlyPrompt.test.ts
 *
 * The mode exists because `steer` alone is decided twice — once by the runtime's
 * `runState`, again by the driver's live streaming state — and a turn ending in
 * between makes the driver start a fresh one that the caller hears about as a
 * successful steer. An automatic sender loses that race often, because the event
 * that produces its message is frequently the event that ends the turn. These
 * tests pin the two things that make the fallback safe: nothing is appended when
 * the steer is not taken, and the caller can tell.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type {
  AdapterEvent,
  AgentRunResult,
  ForkCapability,
  PromptableAdapter,
  PromptOptions,
} from "./adapters/contract.ts";

const tmp = mkdtempSync(join(tmpdir(), "steer-only-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionRuntime } = await import("./runtime/runtime.ts");
const { SessionLogStore } = await import("./log/store.ts");
const { promptRuntimeSessionWithRuntime } = await import("./runtimePrompt.ts");
const { SteerNotTakenError } = await import("./runtime/errors.ts");
const { closeDb } = await import("../db/index.ts");
const { updateSettings, getSettings } = await import("../settings.ts");

updateSettings({ memory: { ...getSettings().memory, learningMode: "off" } });

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * An adapter whose steer answer is scripted. Ordinary prompts stay PENDING until
 * released, so the runtime really is `running` — a turn that resolves at once
 * leaves nothing to steer and the tests would pass for the wrong reason.
 */
function harnessed(sessionId: string, steerTaken: boolean) {
  const sent: { text: string; options: PromptOptions }[] = [];
  let releaseTurn: (() => void) | undefined;
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
    prompt: (text: string, options: PromptOptions = {}) => {
      sent.push({ text, options });
      if (options.steerOnly)
        return Promise.resolve<AgentRunResult>({
          stopReason: "end",
          steered: steerTaken,
        });
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
    live,
    sent,
    release: () => releaseTurn?.(),
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

function userTexts(
  runtime: InstanceType<typeof SessionRuntime>,
  sessionId: string,
): string[] {
  return runtime
    .get(sessionId)!
    .getSnapshot()
    .entries.filter((e) => e.role === "user")
    .flatMap((e) =>
      e.content
        .filter((b): b is Extract<typeof b, { type: "text" }> =>
          Boolean(b.type === "text"),
        )
        .map((b) => b.text),
    );
}

/** Open a turn and leave it running, so a steer has something to join. */
async function startTurn(live: {
  prompt: (t: string) => Promise<void>;
  isRunning: boolean;
}): Promise<void> {
  void live.prompt("long running turn");
  await Promise.resolve();
  assert.equal(live.isRunning, true, "the turn has to be live to steer into");
}

test("a taken steer appends its entry and carries the model-only block", async () => {
  const { runtime, live, sent, driver } = harnessed("steer-taken", true);
  await startTurn(live as never);

  await promptRuntimeSessionWithRuntime(runtime, driver, "background note", {
    steer: true,
    steerOnly: true,
    contextBlock: "STRUCTURED-FACT",
    clientRequestId: "s1",
  });

  const steered = sent.find((s) => s.options.steerOnly);
  assert.ok(steered, "the adapter was asked to steer");
  assert.ok(
    steered.text.includes("STRUCTURED-FACT"),
    "the model-only block rides the steer",
  );
  assert.ok(steered.text.endsWith("background note"));
  assert.ok(
    userTexts(runtime, "steer-taken").includes("background note"),
    "a taken steer is durable, like any other prompt",
  );
});

test("a refused steer sends nothing and appends nothing", async () => {
  const { runtime, live, sent, driver } = harnessed("steer-refused", false);
  await startTurn(live as never);
  const before = userTexts(runtime, "steer-refused").length;

  await assert.rejects(
    promptRuntimeSessionWithRuntime(runtime, driver, "background note", {
      steer: true,
      steerOnly: true,
      clientRequestId: "s2",
    }),
    (error: unknown) => error instanceof SteerNotTakenError,
    "the caller is told, so it can fall back deliberately",
  );

  assert.equal(
    userTexts(runtime, "steer-refused").length,
    before,
    "a refused steer must leave no phantom entry in the transcript",
  );
  assert.equal(
    sent.filter((s) => s.options.steerOnly).length,
    1,
    "and it must not retry as an ordinary prompt",
  );
});

test("steerOnly on an idle session is refused rather than starting a turn", async () => {
  // The race this mode exists for, caught one layer earlier: the caller sampled
  // a running session, but the turn ended before the runtime saw the request.
  const { runtime, sent, driver } = harnessed("steer-idle", true);

  await assert.rejects(
    promptRuntimeSessionWithRuntime(runtime, driver, "background note", {
      steer: true,
      steerOnly: true,
      clientRequestId: "s3",
    }),
    (error: unknown) => error instanceof SteerNotTakenError,
  );
  assert.deepEqual(sent, [], "nothing reached the adapter at all");
  assert.deepEqual(
    userTexts(runtime, "steer-idle"),
    [],
    "and no turn was started",
  );
});

test("a refused steer frees its request id for the fallback delivery", async () => {
  const { runtime, live, sent, driver, release } = harnessed(
    "steer-retry",
    false,
  );
  await startTurn(live as never);

  await assert.rejects(
    promptRuntimeSessionWithRuntime(runtime, driver, "background note", {
      steer: true,
      steerOnly: true,
      clientRequestId: "same-id",
    }),
    (error: unknown) => error instanceof SteerNotTakenError,
  );

  // Delivery retries with the SAME batch request key once the session is idle.
  // Had the refused attempt kept the dedup key, that retry would be swallowed as
  // a duplicate and the fact would never reach the model at all.
  release();
  await new Promise((r) => setTimeout(r, 0));
  const ordinaryBefore = sent.filter((s) => !s.options.steerOnly).length;
  // The retry's own turn stays pending in this harness, so drive it without
  // awaiting and release it once the assertions have seen it.
  const retry = promptRuntimeSessionWithRuntime(
    runtime,
    driver,
    "background note",
    { clientRequestId: "same-id" },
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    sent.filter((s) => !s.options.steerOnly).length,
    ordinaryBefore + 1,
    "the retry was accepted rather than deduplicated away",
  );
  assert.ok(userTexts(runtime, "steer-retry").includes("background note"));
  release();
  await retry;
});
