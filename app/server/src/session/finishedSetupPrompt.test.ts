/**
 * The guided setup conversation after setup finished (`docs/onboarding.md`),
 * through the real prompt door:
 *   pnpm --filter @assistant/server test src/session/finishedSetupPrompt.test.ts
 *
 * Its prompt was frozen with the setup section and finish tool, and frozen
 * prompts never change, so once setup is over the session runs nothing more:
 * every turn is refused before the runtime session and any append, whichever
 * path it arrives on. While setup lasts it runs, and every other session runs
 * as always.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import type {
  AdapterEvent,
  AgentRunResult,
  PromptableAdapter,
} from "./adapters/contract.ts";

const tmp = mkdtempSync(join(tmpdir(), "finished-setup-prompt-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionRuntime } = await import("./runtime/runtime.ts");
const { SessionLogStore } = await import("./log/store.ts");
const { promptRuntimeSessionWithRuntime, beginRuntimeProviderTurn } =
  await import("./runtimePrompt.ts");
const { DATA_DIR } = await import("../config.ts");
const { initOnboarding, SetupFinishedError } = await import("../onboarding.ts");
const { sessionPromptConditions, sessionRanGuidedSetup } =
  await import("../promptConditions.ts");
const { closeDb } = await import("../db/index.ts");
const { onboardingTools } =
  await import("../tools/settings/onboardingTools.ts");
const pa = await import("../permanentAssistant.ts");
const { updateSettings, getSettings } = await import("../settings.ts");

updateSettings({
  memory: { ...getSettings().memory, learningMode: "off" },
  sessionNaming: { ...getSettings().sessionNaming, enabled: false },
});

afterAll(() => {
  closeDb();
  rmSync(join(DATA_DIR, "onboarding.json"), { force: true });
  rmSync(tmp, { recursive: true, force: true });
});

function onboarding(state: "setup" | "complete"): void {
  writeFileSync(join(DATA_DIR, "onboarding.json"), JSON.stringify({ state }));
  initOnboarding(() => {
    throw new Error("the file decides");
  });
}

/** A Personal Assistant session, frozen as the setup one or not. */
function harnessed(sessionId: string, guidedSetup: boolean) {
  sessionPromptConditions(sessionId, "personal-assistant", { guidedSetup });
  const prompts: string[] = [];
  const adapter: PromptableAdapter = {
    provider: "scripted",
    capabilities: {
      fork: "none",
      compact: false,
      steer: false,
      attachments: true,
    },
    subscribe: (_l: (e: AdapterEvent) => void) => () => {},
    getBinding: () => ({ provider: "scripted", nativeId: "n1" }),
    prompt: (text: string): Promise<AgentRunResult> => {
      prompts.push(text);
      return Promise.resolve({ stopReason: "end" });
    },
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession(sessionId, adapter);
  const driver = {
    id: sessionId,
    key: sessionId,
    sessionId,
    harness: "claude-sdk" as const,
    agentType: "personal-assistant" as const,
    sessionFile: undefined,
    isRunning: false,
    canSteer: false,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => adapter,
  };
  const userEntries = () =>
    runtime
      .get(sessionId)!
      .getSnapshot()
      .entries.filter((e) => e.role === "user").length;
  return { runtime, driver, prompts, userEntries };
}

test("the setup conversation runs while setup lasts", async () => {
  onboarding("setup");
  const { runtime, driver, prompts } = harnessed("pa-setup-live", true);
  assert.equal(sessionRanGuidedSetup("pa-setup-live"), true);
  await promptRuntimeSessionWithRuntime(runtime, driver, "Keep Larry.");
  assert.equal(prompts.length, 1);
});

test("once setup is finished, it refuses every turn before any append", async () => {
  onboarding("setup");
  const { runtime, driver, prompts, userEntries } = harnessed(
    "pa-setup-done",
    true,
  );
  onboarding("complete");
  // A message from the open view, a deep link, a peer or a queue drain: all
  // arrive through this door.
  await assert.rejects(
    Promise.resolve(
      promptRuntimeSessionWithRuntime(runtime, driver, "One more thing"),
    ),
    (err) =>
      err instanceof SetupFinishedError &&
      /Setup is finished\. Continue in your Personal Assistant\./.test(
        err.message,
      ),
  );
  // A provider-initiated turn (a resume, a background result) too.
  await assert.rejects(
    beginRuntimeProviderTurn(driver, { kind: "human" }),
    SetupFinishedError,
  );
  assert.equal(prompts.length, 0, "nothing reached the provider");
  assert.equal(userEntries(), 0, "nothing was appended");
  // The frozen record is untouched: the transcript stays readable as it was.
  assert.equal(sessionRanGuidedSetup("pa-setup-done"), true);
});

for (const [path, finish] of [
  [
    "the assistant's finish tool",
    () =>
      onboardingTools
        .find((tool) => tool.name === "onboarding_finish")!
        .execute({}, {
          toolCallId: "call-finish",
          session: { sessionId: "pa-setup-tool" },
        } as never),
  ],
  // What POST /api/onboarding/finish runs.
  [
    "the Finish setup button",
    async () => (await import("../onboarding.ts")).finishOnboarding(),
  ],
] as const)
  test(`after ${path} ends setup, the next message in that conversation is refused`, async () => {
    const rotate = vi
      .spyOn(pa, "rotatePermanentAssistantSession")
      .mockResolvedValue();
    try {
      onboarding("setup");
      const id = `pa-setup-${path.replaceAll(" ", "-")}`;
      const { runtime, driver, prompts } = harnessed(id, true);
      await promptRuntimeSessionWithRuntime(runtime, driver, "I'm done.");
      await finish();
      assert.equal(rotate.mock.calls.length, 1);
      await assert.rejects(
        Promise.resolve(
          promptRuntimeSessionWithRuntime(runtime, driver, "Wait, one more"),
        ),
        SetupFinishedError,
      );
      assert.equal(prompts.length, 1);
    } finally {
      rotate.mockRestore();
    }
  });

test("every other session runs as always once setup is finished", async () => {
  onboarding("complete");
  const { runtime, driver, prompts } = harnessed("pa-ordinary", false);
  await promptRuntimeSessionWithRuntime(runtime, driver, "Hello");
  assert.equal(prompts.length, 1);
});

test("a session without a frozen record is not the setup one", () => {
  assert.equal(sessionRanGuidedSetup("never-started"), false);
});
