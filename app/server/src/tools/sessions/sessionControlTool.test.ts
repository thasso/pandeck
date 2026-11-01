import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import {
  holdAutomaticTurns,
  automaticTurnsHeld,
} from "../../automaticTurnHold.ts";
import { backgroundDeliveryOutboxStore as outbox } from "../../db/backgroundDeliveryOutboxStore.ts";
import { backgroundWorkStore } from "../../db/backgroundWorkStore.ts";
import { unhandledBackground } from "../../backgroundCompletionNotices.ts";
import { peerPromptStore } from "../../db/peerPromptStore.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import {
  sessionControlTools,
  setSessionControlRuntimeForTests,
} from "./sessionControlTool.ts";

let sequence = 0;
const sessions: string[] = [];

function seed(title: string, scope: "user" | "internal" = "user"): string {
  const id = `session-control-${sequence++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title,
    scope,
  });
  sessions.push(id);
  return id;
}

/** A real job with an interrupted delivery receipt, not a queued prompt. */
function interrupt(sessionId: string, count = 1) {
  return Array.from({ length: count }, () => {
    const item = backgroundWorkStore.reserveItem({
      ownerSessionId: sessionId,
      backend: "host-process",
      kind: "shell",
      label: "finished job",
      sourceRequestId: `control-job-${sequence++}`,
      lifetimeMs: 60_000,
      settingsGeneration: 1,
      bootEpoch: "test",
      ownerLimit: 100,
    });
    const finished = backgroundWorkStore.terminalize({
      itemId: item.id,
      state: "completed",
    });
    interruptReceipt(sessionId, {
      itemId: item.id,
      revision: finished.revision,
    });
    return finished;
  });
}

function interruptReceipt(
  sessionId: string,
  ref: { itemId: string; revision: number },
) {
  const attempt = `attempt-${sequence++}`;
  outbox.save({ sessionId, ...ref, disposition: "wake", retained: false });
  assert.ok(outbox.reserve(sessionId, attempt, [ref], "owed"));
  outbox.bind(sessionId, attempt, attempt, "entry");
  outbox.settleRun(sessionId, attempt, "failed");
}

function enqueue(senderSessionId: string, recipientSessionId: string) {
  const chainId = peerPromptStore.createChain(
    `session-control-chain-${sequence++}`,
  );
  return peerPromptStore.enqueue({
    conversationId: `session-control-conversation-${sequence++}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId,
    recipientSessionId,
    prompt: "queued work",
    responseRequested: false,
  });
}

/** A spawned child's opening prompt waiting for a slot. */
function hold(senderSessionId: string, recipientSessionId: string) {
  return peerPromptStore.enqueueRouted({
    conversationId: `session-control-conversation-${sequence++}`,
    chainId: peerPromptStore.createChain(),
    senderSessionId,
    recipientSessionId,
    participants: [senderSessionId, recipientSessionId],
    maxHops: 10,
    prompt: "start when there is room",
    responseRequested: true,
    held: { queueSeq: peerPromptStore.allocateQueueSeq() },
  });
}

const tool = () => sessionControlTools()[0]!;
const context = (sessionId: string) => ({
  toolCallId: "tool-call",
  session: {
    sessionId,
    harness: "pi" as const,
    agentType: "assistant" as const,
    title: "Coordinator",
  },
});

function resultText(
  result: Awaited<ReturnType<ReturnType<typeof tool>["execute"]>>,
) {
  return (result.content[0] as { type: "text"; text: string }).text;
}

afterEach(() => {
  setSessionControlRuntimeForTests(undefined);
  for (const id of sessions.splice(0)) sessionStore.remove(id);
});

describe("session_control tool", () => {
  it("exposes the operations and validates operation-specific fields", async () => {
    const schema = tool().parameters as {
      required: string[];
      properties: Record<string, unknown>;
    };
    assert.deepEqual(schema.required.sort(), ["operation", "targetSessionId"]);
    assert.deepEqual((schema.properties.operation as { enum: string[] }).enum, [
      "cancel_queued_prompts",
      "stop",
      "dismiss_background_updates",
    ]);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "clearQueue",
      "operation",
      "targetSessionId",
    ]);

    const caller = seed("Caller");
    const target = seed("Target");
    await assert.rejects(
      () =>
        tool().execute(
          {
            operation: "cancel_queued_prompts",
            targetSessionId: target,
            clearQueue: false,
          },
          context(caller),
        ),
      /only valid with operation "stop"/,
    );
    await assert.rejects(
      () =>
        tool().execute(
          { operation: "stop", targetSessionId: target, clearQueue: "yes" },
          context(caller),
        ),
      /clearQueue must be a boolean/,
    );
  });

  it("dismisses all 23 interrupted receipts without deleting jobs or recording handling", async () => {
    const caller = seed("Caller");
    const child = seed("Child");
    sessionStore.linkSpawned(caller, child);
    const jobs = interrupt(child, 23);
    setSessionControlRuntimeForTests({
      isRunning: () => false,
      abort: () => assert.fail("no turn is started or stopped"),
    });
    const dismiss = () =>
      tool().execute(
        { operation: "dismiss_background_updates", targetSessionId: child },
        context(caller),
      );
    assert.equal(unhandledBackground(child).count, 23);
    const result = resultText(await dismiss());
    assert.match(result, /Dismissed 23 unhandled background updates/);
    assert.match(result, /not handled/);
    assert.match(result, /0 remain/);
    assert.equal(outbox.interruptedCount(child), 0);
    assert.equal(unhandledBackground(child).count, 0);
    for (const job of jobs)
      assert.deepEqual(backgroundWorkStore.getItem(job.id), job);
    assert.match(
      resultText(await dismiss()),
      /had no unhandled background updates.*Dismissed 0; 0 remain/,
    );
  });

  it("refuses unauthorized dismissal without changing any interrupted receipts", async () => {
    const caller = seed("Caller");
    const other = seed("Other parent");
    const internal = seed("Internal", "internal");
    const deleted = seed("Deleted");
    const unrelated = seed("Other parent's child");
    sessionStore.linkSpawned(other, unrelated);
    const taken = seed("Taken over");
    sessionStore.linkSpawned(caller, taken, 123, "taken-over");
    const child = seed("Child");
    sessionStore.linkSpawned(caller, child);
    const grandchild = seed("Grandchild");
    sessionStore.linkSpawned(child, grandchild);
    for (const target of [caller, deleted, unrelated, taken, child, grandchild])
      interrupt(target);
    // Internal sessions cannot own jobs, but the authority guard must also
    // preserve any receipt already present for one.
    interruptReceipt(internal, { itemId: "internal-receipt", revision: 1 });
    sessionStore.remove(deleted);
    setSessionControlRuntimeForTests({
      isRunning: () => false,
      abort: () => assert.fail("no abort"),
    });
    const cases = [
      { target: caller, error: /current session/ },
      { target: "unknown-session", error: /No session found/ },
      { target: deleted, error: /deleted/ },
      { target: internal, error: /not a user session/ },
      { target: unrelated, error: /not spawned/ },
      { target: taken, error: /no longer owned.*cannot be dismissed here/ },
      { target: grandchild, error: /not spawned/ },
      { target: child, error: /clearQueue is only valid/, clearQueue: false },
    ];
    const before = outbox.handlingCounts();
    for (const { target, error, ...extra } of cases) {
      await assert.rejects(
        () =>
          tool().execute(
            {
              operation: "dismiss_background_updates",
              targetSessionId: target,
              ...extra,
            },
            context(caller),
          ),
        error,
      );
      assert.deepEqual(outbox.handlingCounts(), before, target);
    }
    sessionStore.setSpawnedOwnership(taken, "coordinator");
    assert.match(
      resultText(
        await tool().execute(
          { operation: "dismiss_background_updates", targetSessionId: taken },
          context(caller),
        ),
      ),
      /Dismissed 1/,
    );
    assert.equal(outbox.interruptedCount(taken), 0);
  });

  it("refuses dismissal while running, then permits a stopped held child without lifting its hold", async () => {
    const caller = seed("Caller");
    const child = seed("Child");
    sessionStore.linkSpawned(caller, child);
    interrupt(child);
    let running = true;
    setSessionControlRuntimeForTests({
      isRunning: () => running,
      abort: () => {
        running = false;
        holdAutomaticTurns(child);
      },
    });
    const dismiss = () =>
      tool().execute(
        { operation: "dismiss_background_updates", targetSessionId: child },
        context(caller),
      );
    await assert.rejects(
      dismiss,
      /is running; dismiss its background updates once its turn ends/,
    );
    assert.equal(outbox.interruptedCount(child), 1);
    await tool().execute(
      { operation: "stop", targetSessionId: child },
      context(caller),
    );
    assert.equal(automaticTurnsHeld(child), true);
    assert.match(resultText(await dismiss()), /Dismissed 1.*0 remain/);
    assert.equal(outbox.interruptedCount(child), 0);
    assert.equal(automaticTurnsHeld(child), true);
  });

  it("cancels only the caller's own waiting prompts", async () => {
    const caller = seed("Caller");
    const other = seed("Other sender");
    const target = seed("Target");
    const own = enqueue(caller, target);
    const unrelated = enqueue(other, target);

    const result = await tool().execute(
      { operation: "cancel_queued_prompts", targetSessionId: target },
      context(caller),
    );

    assert.match(resultText(result), /Cancelled 1 queued prompt/);
    assert.equal(peerPromptStore.getById(own.id)?.status, "cancelled");
    assert.equal(peerPromptStore.getById(unrelated.id)?.status, "queued");
  });

  it("stops a coordinator-owned child after clearing its whole queue", async () => {
    const caller = seed("Caller");
    const other = seed("Other sender");
    const child = seed("Child");
    sessionStore.linkSpawned(caller, child);
    const own = enqueue(caller, child);
    const unrelated = enqueue(other, child);
    let aborted = false;
    setSessionControlRuntimeForTests({
      isRunning: (sessionId) => sessionId === child,
      abort: (sessionId) => {
        assert.equal(sessionId, child);
        assert.equal(
          peerPromptStore.listPendingForRecipient(child).length,
          0,
          "the queue is cleared before abort can trigger the idle hook",
        );
        aborted = true;
      },
    });

    const result = await tool().execute(
      { operation: "stop", targetSessionId: child, clearQueue: true },
      context(caller),
    );

    assert.equal(aborted, true);
    assert.equal(peerPromptStore.getById(own.id)?.status, "cancelled");
    assert.equal(peerPromptStore.getById(unrelated.id)?.status, "cancelled");
    assert.match(resultText(result), /Stopped the current turn/);
    assert.match(resultText(result), /Cancelled 2 queued prompts first/);
  });

  it("refuses a child born user-owned without clearing its queued work", async () => {
    const caller = seed("Caller");
    const child = seed("User work");
    sessionStore.linkSpawned(caller, child, 123, "taken-over");
    const waiting = enqueue(caller, child);
    let aborted = false;
    setSessionControlRuntimeForTests({
      isRunning: () => true,
      abort: () => {
        aborted = true;
      },
    });
    await assert.rejects(
      () =>
        tool().execute(
          { operation: "stop", targetSessionId: child, clearQueue: true },
          context(caller),
        ),
      /no longer owned/,
    );
    assert.equal(aborted, false);
    assert.equal(peerPromptStore.getById(waiting.id)?.status, "queued");
  });

  it("refuses an unrelated or user-taken-over child", async () => {
    const caller = seed("Caller");
    const unrelated = seed("Unrelated");
    await assert.rejects(
      () =>
        tool().execute(
          { operation: "stop", targetSessionId: unrelated },
          context(caller),
        ),
      /was not spawned by the current session/,
    );

    const child = seed("Taken over child");
    sessionStore.linkSpawned(caller, child);
    sessionStore.setSpawnedOwnership(child, "taken-over");
    await assert.rejects(
      () =>
        tool().execute(
          { operation: "stop", targetSessionId: child },
          context(caller),
        ),
      /no longer owned by the current session/,
    );
  });

  it("gets its stop authority back when the user hands the child back", async () => {
    const caller = seed("Caller");
    const child = seed("Handed back child");
    sessionStore.linkSpawned(caller, child);
    let aborts = 0;
    setSessionControlRuntimeForTests({
      isRunning: (sessionId) => sessionId === child,
      abort: () => {
        aborts += 1;
      },
    });
    const stop = () =>
      tool().execute(
        { operation: "stop", targetSessionId: child },
        context(caller),
      );

    await stop();
    assert.equal(aborts, 1, "a coordinator stops the child it owns");
    sessionStore.setSpawnedOwnership(child, "taken-over");
    await assert.rejects(stop, /no longer owned by the current session/);
    assert.equal(aborts, 1);
    sessionStore.setSpawnedOwnership(child, "coordinator");
    await stop();
    assert.equal(aborts, 2, "handing back restores the coordinator's stop");
  });

  it("cancels a child's opening prompt still waiting for a slot, either way", async () => {
    setSessionControlRuntimeForTests({
      isRunning: () => false,
      abort: () => {},
    });
    const coordinator = seed("Coordinator");
    for (const operation of ["cancel_queued_prompts", "stop"] as const) {
      const child = seed("Waiting child");
      sessionStore.linkSpawned(coordinator, child);
      const opener = hold(coordinator, child);
      const text = resultText(
        await tool().execute(
          {
            operation,
            targetSessionId: child,
            ...(operation === "stop" ? { clearQueue: true } : {}),
          },
          context(coordinator),
        ),
      );
      assert.match(text, /Cancelled 1 queued prompt/, operation);
      assert.equal(peerPromptStore.getById(opener.id)?.status, "cancelled");
    }
  });
});
