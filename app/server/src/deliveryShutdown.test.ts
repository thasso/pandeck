import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { agentHandoffStore } from "./db/agentHandoffStore.ts";
import { promptQueueStore } from "./db/promptQueueStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  enqueueAgentHandoff,
  stopAgentHandoffDelivery,
  setAgentHandoffDeliveryStoppedForTests,
} from "./agentHandoffs.ts";
import { setPromptQueueHost, stopPromptQueueDelivery } from "./promptQueue.ts";
import { setDeliveryWake } from "./deliveryWake.ts";
import { installDeliveryTestScheduler } from "./test/deliveryScheduler.ts";
import { FakeRuntimeDriver } from "./test/fakeRuntimeDriver.ts";

afterEach(() => {
  setDeliveryWake(undefined);
  setPromptQueueHost(undefined);
  setAgentHandoffDeliveryStoppedForTests(false);
});

for (const lane of ["queue", "handoffs"] as const) {
  for (const acquisition of ["success", "error", "unavailable"] as const) {
    test(`shutdown during ${acquisition} cold acquisition leaves ${lane} rows for boot`, async () => {
      const id = `shutdown-acquire-${lane}-${acquisition}`;
      sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
      const driver = new FakeRuntimeDriver(id);
      let shutdown = false;
      let cold = true;
      const scheduler = installDeliveryTestScheduler({
        live: () => (cold ? undefined : driver),
        acquire: async () => {
          await Promise.resolve();
          shutdown = true;
          stopPromptQueueDelivery();
          stopAgentHandoffDelivery();
          cold = false;
          if (acquisition === "error")
            throw new Error("shutdown during acquisition");
          return acquisition === "unavailable" ? undefined : driver;
        },
        shutdown: () => shutdown,
      });
      setPromptQueueHost({
        live: () => undefined,
        publish: () => {},
        reportError: () => assert.fail("shutdown is not a send failure"),
        yieldToOthers: () => {},
      });
      if (lane === "queue")
        promptQueueStore.append({
          id: `draft-${id}`,
          sessionId: id,
          text: "draft",
        });
      else
        enqueueAgentHandoff({
          sessionId: id,
          text: "decision",
          origin: { kind: "system", source: "approval-decision" },
        });
      try {
        await scheduler.wake(id);
        assert.deepEqual(
          driver.promptTexts,
          [],
          "no turn starts after shutdown",
        );
        if (lane === "queue") {
          assert.equal(promptQueueStore.list(id).length, 1);
          assert.equal(promptQueueStore.isPaused(id), false);
          assert.equal(promptQueueStore.list(id)[0]?.error, undefined);
        } else {
          assert.equal(agentHandoffStore.listForSession(id).length, 1);
          assert.equal(agentHandoffStore.listForSession(id)[0]?.attempts, 0);
        }
      } finally {
        promptQueueStore.clear(id);
        for (const row of agentHandoffStore.listForSession(id))
          agentHandoffStore.remove(row.id);
        sessionStore.remove(id);
      }
    });
  }
}
