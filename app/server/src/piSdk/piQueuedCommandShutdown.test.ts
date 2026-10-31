import assert from "node:assert/strict";
import { test } from "vitest";
import { PiLiveSession } from "./PiLiveSession.ts";
import { localPiEngine } from "./piEngine.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { promptQueueStore } from "../db/promptQueueStore.ts";
import { setDeliveryWake } from "../deliveryWake.ts";
import { setPromptQueueHost, stopPromptQueueDelivery } from "../promptQueue.ts";
import { installDeliveryTestScheduler } from "../test/deliveryScheduler.ts";

test("shutdown during acquisition does not persist a reload refusal on a queued pi command", async () => {
  const id = "pi-queued-command-shutdown";
  let shutdown = false;
  let cold = true;
  const driver = new PiLiveSession(
    "assistant",
    localPiEngine({
      sessionId: id,
      sessionName: "Already named",
      isStreaming: false,
      sessionManager: { getBranch: () => [] },
      subscribe: () => () => {},
      dispose: () => {},
      getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        contextSize: 0,
      }),
    } as never),
    {
      sessionRowsChanged: () => {},
      noteRunStarted: () => {},
      checkPendingReload: () => {},
      isReloadQueued: () => shutdown,
      buildSessionState: () => ({}) as never,
    } as never,
    () => {},
  );
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  setPromptQueueHost({
    live: () => driver,
    publish: () => {},
    reportError: () => {},
    yieldToOthers: () => {},
  });
  const scheduler = installDeliveryTestScheduler({
    live: () => (cold ? undefined : driver),
    acquire: async () => {
      await Promise.resolve();
      shutdown = true;
      stopPromptQueueDelivery();
      cold = false;
      return driver;
    },
    shutdown: () => shutdown,
  });
  promptQueueStore.append({
    id: `draft-${id}`,
    sessionId: id,
    text: "/clear",
    command: { name: "clear", rawArgs: "" },
  });
  try {
    await scheduler.wake(id);
    assert.equal(
      promptQueueStore.isPaused(id),
      false,
      "a deploy must not require Resume after reboot",
    );
    const rows = promptQueueStore.list(id);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]?.error,
      undefined,
      "a reload refusal must not become a durable send error",
    );
    assert.equal(driver.isRunning, false);
  } finally {
    setDeliveryWake(undefined);
    setPromptQueueHost(undefined);
    promptQueueStore.clear(id);
    sessionStore.remove(id);
    driver.dispose();
  }
});
