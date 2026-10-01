/**
 * Steers whose fate the provider decides later (`steerAcceptance: "deferred"`).
 *   pnpm --filter @assistant/server test src/session/deferredSteerPrompt.test.ts
 *
 * The Claude CLI folds a queued message into the running turn at its next tool
 * step, or runs it after the final reply when there is no step left. Which one
 * happened is known only when the CLI takes it, so the runtime records the
 * message then: a late one lands AFTER the reply it missed, and a withdrawn one
 * leaves no trace.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { PromptDelivery } from "@assistant/shared/session";
import type {
  AdapterEvent,
  AgentRunResult,
  ForkCapability,
  PromptableAdapter,
  PromptOptions,
} from "./adapters/contract.ts";

const tmp = mkdtempSync(join(tmpdir(), "deferred-steer-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionRuntime } = await import("./runtime/runtime.ts");
const { SessionLogStore } = await import("./log/store.ts");
const { promptRuntimeSessionWithRuntime } = await import("./runtimePrompt.ts");
const { SessionBusyError, SteerWithdrawnError } =
  await import("./runtime/errors.ts");
const { closeDb } = await import("../db/index.ts");
const { updateSettings, getSettings } = await import("../settings.ts");

updateSettings({ memory: { ...getSettings().memory, learningMode: "off" } });

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * An adapter that answers a steer only when the test says so, and can emit its
 * own events in between — the reply the steer arrived too late for.
 */
function harnessed(sessionId: string, deferred: boolean) {
  const sent: { text: string; options: PromptOptions }[] = [];
  const listeners = new Set<(e: AdapterEvent) => void>();
  let releaseTurn: (() => void) | undefined;
  let answerSteer: ((result: AgentRunResult) => void) | undefined;
  const capabilities: ForkCapability = {
    fork: "none",
    compact: false,
    steer: true,
    ...(deferred ? { steerAcceptance: "deferred" as const } : {}),
    attachments: true,
  };
  const adapter: PromptableAdapter = {
    provider: "scripted",
    capabilities,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getBinding: () => ({ provider: "scripted", nativeId: "n1" }),
    prompt: (text: string, options: PromptOptions = {}) => {
      sent.push({ text, options });
      if (options.steer)
        return deferred
          ? new Promise<AgentRunResult>((resolve) => {
              answerSteer = resolve;
            })
          : Promise.resolve<AgentRunResult>({ stopReason: "end" });
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
  const emit = (event: AdapterEvent): void => {
    for (const listener of listeners) listener(event);
  };
  return {
    runtime,
    live,
    sent,
    emit,
    release: () => releaseTurn?.(),
    /** The steer has reached the adapter, so it can be answered. */
    asked: () => answerSteer !== undefined,
    answer: (
      delivery: PromptDelivery | "withdrawn" | "uncertain" | undefined,
    ) =>
      answerSteer?.({
        stopReason: "end",
        ...(delivery === "uncertain"
          ? { steerWithdrawn: true, steerUncertain: true }
          : delivery === "withdrawn"
            ? { steerWithdrawn: true }
            : delivery
              ? { steerDelivery: delivery }
              : {}),
      }),
    driver: {
      id: sessionId,
      key: sessionId,
      sessionId,
      harness: "claude-sdk" as const,
      agentType: "assistant" as const,
      sessionFile: undefined,
      isRunning: true,
      canSteer: true,
      contextInfo: () => ({}) as never,
      broadcastState: () => {},
      createRuntimeAdapter: () => adapter,
    },
  };
}

function entries(runtime: InstanceType<typeof SessionRuntime>, id: string) {
  return runtime.get(id)!.getSnapshot().entries;
}

function textOf(entry: { content: { type: string; text?: string }[] }) {
  return entry.content.map((b) => b.text ?? "").join("");
}

async function startTurn(live: {
  prompt: (t: string) => Promise<void>;
  isRunning: boolean;
}): Promise<void> {
  void live.prompt("long running turn");
  await until(() => live.isRunning, "the turn to steer into");
}

/** Wait on the condition itself, not a fixed pause a loaded runner outlasts. */
async function until(check: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} was not reached`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("a late steer is recorded after the reply it missed, as a follow-up", async () => {
  const { runtime, live, emit, answer, asked, release, driver } = harnessed(
    "deferred-follow-up",
    true,
  );
  await startTurn(live as never);

  const steer = promptRuntimeSessionWithRuntime(runtime, driver, "one more", {
    steer: true,
    clientRequestId: "late-1",
  });
  await until(asked, "the steer to reach the adapter");
  assert.equal(
    entries(runtime, "deferred-follow-up").filter((e) => e.role === "user")
      .length,
    1,
    "nothing is recorded while the provider has not taken the message",
  );

  // The turn replies without reading it; the provider then runs it next.
  emit({ type: "messageStarted", streamId: "a1" });
  emit({
    type: "messageCompleted",
    streamId: "a1",
    content: [{ type: "text", text: "the reply" }],
  });
  answer("followUp");
  await steer;

  const log = entries(runtime, "deferred-follow-up");
  const reply = log.findIndex((e) => e.role === "assistant");
  const late = log.findIndex(
    (e) => e.role === "user" && textOf(e) === "one more",
  );
  assert.ok(reply >= 0 && late > reply, "the follow-up sits after the reply");
  const lateEntry = log[late]!;
  assert.equal(
    lateEntry.role === "user" ? lateEntry.delivery : undefined,
    "followUp",
  );
  assert.equal(live.isRunning, true, "the run it continues is still open");
  release();
});

test("a folded steer is recorded as a steer", async () => {
  const { runtime, live, answer, asked, release, driver } = harnessed(
    "deferred-steer",
    true,
  );
  await startTurn(live as never);
  const steer = promptRuntimeSessionWithRuntime(runtime, driver, "turn left", {
    steer: true,
    clientRequestId: "fold-1",
  });
  await until(asked, "the steer to reach the adapter");
  answer("steer");
  await steer;
  const entry = entries(runtime, "deferred-steer").find(
    (e) => e.role === "user" && textOf(e) === "turn left",
  );
  assert.equal(entry?.role === "user" ? entry.delivery : undefined, "steer");
  release();
});

test("a withdrawn steer appends nothing, reads as busy and frees its id", async () => {
  const { runtime, live, answer, asked, release, driver } = harnessed(
    "deferred-withdrawn",
    true,
  );
  await startTurn(live as never);
  const steer = promptRuntimeSessionWithRuntime(runtime, driver, "never mind", {
    steer: true,
    clientRequestId: "gone-1",
  });
  await until(asked, "the steer to reach the adapter");
  answer(undefined);
  await assert.rejects(
    steer,
    (error: unknown) => error instanceof SessionBusyError,
    "a handoff falls back to its queue on busy, so it must not lose the fact",
  );
  assert.equal(
    entries(runtime, "deferred-withdrawn").filter(
      (e) => e.role === "user" && textOf(e) === "never mind",
    ).length,
    0,
  );

  release();
  await until(() => !live.isRunning, "the turn to end");
  const retry = promptRuntimeSessionWithRuntime(
    runtime,
    { ...driver, isRunning: false },
    "never mind",
    { clientRequestId: "gone-1" },
  );
  await until(
    () =>
      entries(runtime, "deferred-withdrawn").some(
        (e) => e.role === "user" && textOf(e) === "never mind",
      ),
    "the same id to be accepted again once the session is idle",
  );
  release();
  await retry;
});

test("an immediate steer is marked as a steer at submission", async () => {
  const { runtime, live, release, driver } = harnessed(
    "immediate-steer",
    false,
  );
  await startTurn(live as never);
  await promptRuntimeSessionWithRuntime(runtime, driver, "quick note", {
    steer: true,
    clientRequestId: "pi-1",
  });
  const entry = entries(runtime, "immediate-steer").find(
    (e) => e.role === "user" && textOf(e) === "quick note",
  );
  assert.equal(entry?.role === "user" ? entry.delivery : undefined, "steer");
  release();
});

test("a steer its turn ended before reading is withdrawn, not merely busy", async () => {
  const { runtime, live, answer, asked, release, driver } = harnessed(
    "deferred-stopped",
    true,
  );
  await startTurn(live as never);
  const steer = promptRuntimeSessionWithRuntime(runtime, driver, "wait", {
    steer: true,
    clientRequestId: "stopped-1",
  });
  await until(asked, "the steer to reach the adapter");
  answer("withdrawn");
  await assert.rejects(steer, (error: unknown) => {
    // Still busy to a handoff, which queues on busy; distinct for the user's
    // own send, which gets the message back.
    assert.ok(error instanceof SessionBusyError);
    return error instanceof SteerWithdrawnError;
  });
  release();
});

test("a steer the provider never confirmed dropping is withdrawn as uncertain", async () => {
  const { runtime, live, answer, asked, release, driver } = harnessed(
    "deferred-uncertain",
    true,
  );
  await startTurn(live as never);
  const steer = promptRuntimeSessionWithRuntime(runtime, driver, "maybe", {
    steer: true,
    clientRequestId: "uncertain-1",
  });
  await until(asked, "the steer to reach the adapter");
  answer("uncertain");
  await assert.rejects(
    steer,
    (error: unknown) =>
      error instanceof SteerWithdrawnError && error.uncertain === true,
  );
  release();
});
