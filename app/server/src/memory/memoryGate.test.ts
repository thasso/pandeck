/**
 * The first-run memory gate (`docs/onboarding.md`): while onboarding is
 * `pending`, no turn of any persona loads or captures memory and maintenance
 * runs no processor, whatever the stored settings say. Isolated temp data dir,
 * injected fake processor.
 *   pnpm --filter @assistant/server test src/memory/memoryGate.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "memory-gate-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { initOnboarding, onboardingState } = await import("../onboarding.ts");
const svc = await import("./memoryService.ts");
const rt = await import("./memoryRuntime.ts");
const proc = await import("./memoryProcessor.ts");
const { memoryScheduler } = await import("./memoryScheduler.ts");
const { memorySettingsInEffect } = await import("./memoryGate.ts");
const { memoryObservationStore } =
  await import("../db/memoryObservationStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { closeDb } = await import("../db/index.ts");
const { getSettings, updateSettings } = await import("../settings.ts");

let processorCalls = 0;
proc.setMemoryProcessorRunnerForTests({
  run: async () => {
    processorCalls += 1;
    return { text: JSON.stringify({ operations: [] }) };
  },
});

afterAll(() => {
  proc.resetMemoryProcessorRunnerForTests();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const SESSION = "assistant-while-pending";

test("an Assistant turn while pending loads and captures nothing", async () => {
  initOnboarding(() => ({
    settingsFile: false,
    sessions: false,
    accounts: false,
    gatewayClient: false,
  }));
  assert.equal(onboardingState(), "pending");
  // Stored on, everything: only the gate stands between the turn and memory.
  updateSettings({
    memory: {
      ...getSettings().memory,
      loadingEnabled: true,
      learningMode: "every-turn",
      maintenanceEnabled: true,
    },
  });
  const settings = memorySettingsInEffect();
  assert.deepEqual(
    [
      settings.loadingEnabled,
      settings.learningMode,
      settings.maintenanceEnabled,
    ],
    [false, "off", false],
  );
  assert.equal(settings.maxCards, getSettings().memory.maxCards);

  sessionStore.upsert({
    id: SESSION,
    harness: "pi",
    agentType: "assistant",
    requiresEnterprise: false,
  });
  for (const text of ["Prefers concise answers", "Uses metric units"])
    assert.ok(
      svc.createMemory({
        text,
        kind: "preference",
        pinned: true,
        provenance: { sourceKind: "manual" },
      }).ok,
    );

  const decision = rt.decideMemoryDeliveryForPrompt(
    { sessionId: SESSION, agentType: "assistant" },
    "hello",
  );
  assert.equal(decision.deliveryState, "none");
  assert.equal(decision.memoryBlock, undefined);

  memoryScheduler.observeTurn({
    sessionId: SESSION,
    userTurnId: "turn-1",
    persona: "assistant",
    humanText: "Remember that I always want metric units.",
  });
  await memoryScheduler.flushIdle(Date.now() + 86_400_000);
  const maintenance = memoryScheduler.runMaintenance(Date.now() + 86_400_000);
  assert.equal(maintenance.consolidationDue, false);
  await settle();
  assert.equal(memoryObservationStore.pendingCountForSession(SESSION), 0);
  assert.equal(processorCalls, 0);

  // Past first run the stored settings apply: the same turn loads and learns.
  rmSync(join(tmp, "data", "onboarding.json"));
  initOnboarding(() => ({
    settingsFile: true,
    sessions: true,
    accounts: true,
    gatewayClient: false,
  }));
  assert.equal(onboardingState(), "complete");
  assert.equal(
    rt.decideMemoryDeliveryForPrompt(
      { sessionId: SESSION, agentType: "assistant" },
      "hello",
    ).deliveryState,
    "injected",
  );
  memoryScheduler.observeTurn({
    sessionId: SESSION,
    userTurnId: "turn-2",
    persona: "assistant",
    humanText: "Remember that I always want metric units.",
  });
  await settle();
  assert.equal(processorCalls, 1);
});
