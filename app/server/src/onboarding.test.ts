import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, test, vi } from "vitest";
import type { ModelOption, ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "onboarding-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const {
  assistantPinFor,
  checkOnboarding,
  finishOnboarding,
  initOnboarding,
  initialOnboardingState,
  onboardingState,
  setOnboardingBroadcaster,
} = await import("./onboarding.ts");
type UsableAccount = import("./onboarding.ts").UsableAccount;
const { APP_SETTINGS_PATH, readStoredAppSettings } =
  await import("./appSettingsFile.ts");
const { getSettings } = await import("./settings.ts");
const { saveSettings } = await import("./settingsService.ts");
// The hub installs its own broadcaster when it loads (a settings write's
// effects can load it); load it first so the test's listener is the last one.
await import("./hub.ts");
const pa = await import("./permanentAssistant.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const STATE_PATH = join(tmp, "data", "onboarding.json");
const FRESH = {
  settingsFile: false,
  sessions: false,
  accounts: false,
  gatewayClient: false,
};
const broadcasts: ServerMessage[] = [];
setOnboardingBroadcaster((message) => broadcasts.push(message));

/** A directory where a write's temp file goes makes that write fail (EISDIR). */
const STATE_TMP = `${STATE_PATH}.tmp`;
const SETTINGS_TMP = `${APP_SETTINGS_PATH}.tmp`;
const block = (path: string) => mkdirSync(path, { recursive: true });

let rotate: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const path of [STATE_PATH, APP_SETTINGS_PATH, STATE_TMP, SETTINGS_TMP])
    rmSync(path, { recursive: true, force: true });
  broadcasts.length = 0;
  rotate = vi.spyOn(pa, "rotatePermanentAssistantSession").mockResolvedValue();
});
afterEach(() => rotate.mockRestore());

function model(
  provider: string,
  id: string,
  levels?: ModelOption["supportedThinkingLevels"],
): ModelOption {
  return {
    provider,
    id,
    name: id,
    reasoning: true,
    contextWindow: 200_000,
    ...(levels ? { supportedThinkingLevels: levels } : {}),
  };
}

// Real accounts: a pin to an account that does not exist is dropped on write.
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const claudeAccount = createCredentialProfile({
  provider: "claude",
  name: "Claude",
});
const openAiAccount = createCredentialProfile({
  provider: "openai-codex",
  name: "OpenAI",
});

const CLAUDE: UsableAccount = {
  id: claudeAccount.id,
  provider: "claude",
  models: [model("claude-sdk", "sonnet"), model("claude-sdk", "opus")],
};
const OPENAI: UsableAccount = {
  id: openAiAccount.id,
  provider: "openai-codex",
  models: [
    model("openai-codex", "gpt-other", ["off", "low", "medium"]),
    model("openai-codex", "gpt-6-luna"),
  ],
};
const ENDPOINT: UsableAccount = {
  id: "openai-compatible-0123456789ab",
  provider: "openai-compatible",
  models: [
    model("openai-compatible-0123456789ab", "llama", ["off"]),
    model("openai-compatible-0123456789ab", "qwen"),
  ],
};

/** A probe that sees `account` and judges every saved slot by `runnable`. */
function probe(
  account: UsableAccount | undefined,
  runnable: (slot: { provider: string; modelId: string }) => boolean = () =>
    false,
) {
  return {
    usableAccount: async () => account,
    slotRunnable: async (slot: { provider: string; modelId: string }) =>
      runnable(slot),
  };
}

/** Put the install into guided setup the way a first run does. */
async function enterSetup(): Promise<void> {
  initOnboarding(() => FRESH);
  await checkOnboarding(probe(CLAUDE));
  assert.equal(onboardingState(), "setup");
  broadcasts.length = 0;
  rotate.mockClear();
}

describe("fresh-install detection", () => {
  test("only an install with nothing at all is fresh", () => {
    assert.equal(initialOnboardingState(FRESH), "pending");
    for (const used of [
      "settingsFile",
      "sessions",
      "accounts",
      "gatewayClient",
    ] as const)
      assert.equal(
        initialOnboardingState({ ...FRESH, [used]: true }),
        "complete",
        used,
      );
  });

  test("the first boot persists its decision privately", () => {
    assert.equal(
      initOnboarding(() => FRESH),
      "pending",
    );
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "pending",
    });
    assert.equal(statSync(STATE_PATH).mode & 0o777, 0o600);
  });

  test("an established install is complete and never consults the facts again", () => {
    assert.equal(
      initOnboarding(() => ({ ...FRESH, accounts: true })),
      "complete",
    );
    // Later boots read the file: an emptied install does not go back.
    let consulted = false;
    assert.equal(
      initOnboarding(() => {
        consulted = true;
        return FRESH;
      }),
      "complete",
    );
    assert.equal(consulted, false);
  });

  test("an unreadable state file never means first run", () => {
    writeFileSync(STATE_PATH, "{not json");
    assert.equal(
      initOnboarding(() => FRESH),
      "complete",
    );
  });
});

describe("beginning guided setup", () => {
  test("waits for a usable account, then moves to setup once", async () => {
    initOnboarding(() => FRESH);
    await checkOnboarding(probe(undefined));
    assert.equal(onboardingState(), "pending");
    assert.equal(broadcasts.length, 0);

    await checkOnboarding(probe(CLAUDE));
    assert.equal(onboardingState(), "setup");
    assert.deepEqual(broadcasts, [{ type: "onboarding", state: "setup" }]);
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "setup",
    });

    // Past pending, checks do nothing; a later boot reads setup back.
    await checkOnboarding(probe(OPENAI));
    assert.equal(broadcasts.length, 1);
    assert.equal(
      initOnboarding(() => FRESH),
      "setup",
    );
  });

  test("names an unsaved assistant Larry through the settings file", async () => {
    initOnboarding(() => FRESH);
    assert.equal(existsSync(APP_SETTINGS_PATH), false);
    assert.equal(getSettings().permanentAssistant.name, "Personal Assistant");
    await checkOnboarding(probe(CLAUDE));
    assert.equal(readStoredAppSettings().permanentAssistant?.name, "Larry");
  });

  test("never overwrites a saved name", async () => {
    initOnboarding(() => FRESH);
    await saveSettings({
      permanentAssistant: { ...getSettings().permanentAssistant, name: "Ada" },
    });
    await checkOnboarding(probe(CLAUDE));
    assert.equal(getSettings().permanentAssistant.name, "Ada");
  });

  test("keeps every other assistant field another writer saved", async () => {
    initOnboarding(() => FRESH);
    // Saved while first run is pending, e.g. from Settings in another tab.
    await saveSettings({
      permanentAssistant: {
        ...getSettings().permanentAssistant,
        additionalInstructions: "Be brief.",
      },
    });
    await checkOnboarding(probe(CLAUDE));
    const assistant = getSettings().permanentAssistant;
    assert.equal(assistant.name, "Larry");
    assert.equal(assistant.additionalInstructions, "Be brief.");
  });

  test("turns memory off before the setup conversation exists", async () => {
    initOnboarding(() => FRESH);
    const defaults = getSettings().memory;
    assert.equal(defaults.loadingEnabled, true);
    assert.equal(defaults.learningMode, "adaptive");
    await checkOnboarding(probe(undefined));
    assert.equal(readStoredAppSettings().memory, undefined);
    await checkOnboarding(probe(CLAUDE));
    assert.equal(onboardingState(), "setup");
    const stored = readStoredAppSettings().memory;
    assert.equal(stored?.loadingEnabled, false);
    assert.equal(stored?.learningMode, "off");
    // Every other memory setting keeps its default.
    assert.deepEqual(getSettings().memory, {
      ...defaults,
      loadingEnabled: false,
      learningMode: "off",
    });
  });

  test("a memory setting saved before setup stands", async () => {
    initOnboarding(() => FRESH);
    await saveSettings({ memory: { ...getSettings().memory, maxCards: 4 } });
    await checkOnboarding(probe(CLAUDE));
    assert.equal(onboardingState(), "setup");
    assert.equal(getSettings().memory.loadingEnabled, true);
    assert.equal(getSettings().memory.learningMode, "adaptive");
    assert.equal(getSettings().memory.maxCards, 4);
  });

  test("overlapping checks begin setup once", async () => {
    initOnboarding(() => FRESH);
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const first = checkOnboarding({
      ...probe(CLAUDE),
      usableAccount: async () => {
        await gate;
        return CLAUDE;
      },
    });
    const second = checkOnboarding(probe(CLAUDE));
    release();
    await Promise.all([first, second]);
    assert.equal(onboardingState(), "setup");
    assert.equal(broadcasts.length, 1);
  });
});

describe("pinning the assistant's model", () => {
  test("per account kind", () => {
    assert.deepEqual(assistantPinFor(CLAUDE), {
      provider: "claude-sdk",
      modelId: "opus",
      thinkingLevel: "medium",
      credentialProfileId: claudeAccount.id,
    });
    assert.deepEqual(assistantPinFor(OPENAI), {
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      thinkingLevel: "high",
      credentialProfileId: openAiAccount.id,
    });
    // Without the default helper model, the first Codex model, its thinking
    // clamped to what it supports.
    assert.deepEqual(
      assistantPinFor({ ...OPENAI, models: OPENAI.models.slice(0, 1) }),
      {
        provider: "openai-codex",
        modelId: "gpt-other",
        thinkingLevel: "medium",
        credentialProfileId: openAiAccount.id,
      },
    );
    assert.deepEqual(assistantPinFor(ENDPOINT), {
      provider: "openai-compatible-0123456789ab",
      modelId: "llama",
      thinkingLevel: "off",
      credentialProfileId: "openai-compatible-0123456789ab",
    });
  });

  test("an install that never chose a model runs on the first account", async () => {
    initOnboarding(() => FRESH);
    // Runnable or not, the default slot was never the user's choice.
    await checkOnboarding(probe(CLAUDE, () => true));
    const stored = readStoredAppSettings().permanentAssistant;
    assert.equal(stored?.provider, "claude-sdk");
    assert.equal(stored?.modelId, "opus");
    assert.equal(stored?.thinkingLevel, "medium");
    assert.equal(stored?.credentialProfileId, claudeAccount.id);
    assert.equal(stored?.name, "Larry");
  });

  test("a saved slot that cannot run is replaced", async () => {
    initOnboarding(() => FRESH);
    await saveSettings({
      permanentAssistant: {
        ...getSettings().permanentAssistant,
        provider: "openai-codex",
        modelId: "gpt-6-luna",
      },
    });
    await checkOnboarding(probe(CLAUDE, () => false));
    assert.equal(getSettings().permanentAssistant.modelId, "opus");
  });

  test("a saved slot that can run is never touched", async () => {
    initOnboarding(() => FRESH);
    await saveSettings({
      permanentAssistant: {
        ...getSettings().permanentAssistant,
        provider: "claude-sdk",
        modelId: "sonnet",
        thinkingLevel: "low",
      },
    });
    const judged: string[] = [];
    await checkOnboarding(
      probe(OPENAI, (slot) => {
        judged.push(`${slot.provider}:${slot.modelId}`);
        return true;
      }),
    );
    assert.deepEqual(judged, ["claude-sdk:sonnet"]);
    const assistant = getSettings().permanentAssistant;
    assert.equal(assistant.provider, "claude-sdk");
    assert.equal(assistant.modelId, "sonnet");
    assert.equal(assistant.thinkingLevel, "low");
    assert.equal(assistant.credentialProfileId, undefined);
    assert.equal(onboardingState(), "setup");
  });

  test("a model another writer saves during the check stands", async () => {
    initOnboarding(() => FRESH);
    await saveSettings({
      permanentAssistant: {
        ...getSettings().permanentAssistant,
        provider: "openai-codex",
        modelId: "retired",
      },
    });
    await checkOnboarding(
      probe(CLAUDE, () => {
        // Chosen in Settings while the slot was being judged.
        writeFileSync(
          APP_SETTINGS_PATH,
          JSON.stringify({
            permanentAssistant: {
              ...readStoredAppSettings().permanentAssistant,
              modelId: "gpt-6-luna",
            },
          }),
        );
        return false;
      }),
    );
    assert.equal(getSettings().permanentAssistant.modelId, "gpt-6-luna");
  });
});

describe("finishing guided setup", () => {
  test("rotates the assistant, then completes once and for good", async () => {
    await enterSetup();
    assert.equal(await finishOnboarding(), "complete");
    assert.equal(rotate.mock.calls.length, 1);
    assert.equal(onboardingState(), "complete");
    assert.deepEqual(broadcasts, [{ type: "onboarding", state: "complete" }]);
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "complete",
    });

    // Idempotent, and complete is final whatever is asked or read later.
    assert.equal(await finishOnboarding(), "complete");
    await checkOnboarding(probe(CLAUDE));
    assert.equal(rotate.mock.calls.length, 1);
    assert.equal(broadcasts.length, 1);
    assert.equal(
      initOnboarding(() => FRESH),
      "complete",
    );
  });

  test("overlapping finishes rotate and broadcast once", async () => {
    await enterSetup();
    const [a, b] = await Promise.all([finishOnboarding(), finishOnboarding()]);
    assert.equal(a, "complete");
    assert.equal(b, "complete");
    assert.equal(rotate.mock.calls.length, 1);
    assert.equal(broadcasts.length, 1);
  });

  test("does nothing while pending", async () => {
    initOnboarding(() => FRESH);
    assert.equal(await finishOnboarding(), "pending");
    assert.equal(rotate.mock.calls.length, 0);
    assert.equal(onboardingState(), "pending");
  });

  test("a failed rotation stays in setup, and finishing again completes", async () => {
    await enterSetup();
    rotate.mockRejectedValueOnce(new Error("flush failed"));
    await assert.rejects(finishOnboarding(), /flush failed/);
    assert.equal(onboardingState(), "setup");
    assert.equal(broadcasts.length, 0);
    assert.equal(await finishOnboarding(), "complete");
  });

  test("a failed completion write stays in setup", async () => {
    await enterSetup();
    block(STATE_TMP);
    await assert.rejects(finishOnboarding());
    assert.equal(onboardingState(), "setup");
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "setup",
    });
    assert.equal(broadcasts.length, 0);
    rmSync(STATE_TMP, { recursive: true });
    assert.equal(await finishOnboarding(), "complete");
  });
});

describe("renaming during guided setup", () => {
  const rename = (name: string) =>
    saveSettings({
      permanentAssistant: { ...getSettings().permanentAssistant, name },
    });

  test("keeps the live setup conversation", async () => {
    await enterSetup();
    await rename("Max");
    assert.equal(getSettings().permanentAssistant.name, "Max");
    assert.equal(rotate.mock.calls.length, 0);
    // Any other profile change still starts the assistant afresh.
    await saveSettings({
      permanentAssistant: {
        ...getSettings().permanentAssistant,
        name: "Moritz",
        additionalInstructions: "Be brief.",
      },
    });
    assert.equal(rotate.mock.calls.length, 1);
  });

  test("rotates as always outside setup", async () => {
    await enterSetup();
    await finishOnboarding();
    rotate.mockClear();
    await rename("Max");
    assert.equal(rotate.mock.calls.length, 1);
  });
});

describe("established installs", () => {
  test("an upgrade stays complete: no naming, no pinning, no setup", async () => {
    // An install from before onboarding existed: settings but no marker.
    writeFileSync(
      APP_SETTINGS_PATH,
      JSON.stringify({ models: { hidden: [], order: [] } }),
    );
    assert.equal(
      initOnboarding(() => ({ ...FRESH, settingsFile: true })),
      "complete",
    );
    await checkOnboarding(probe(CLAUDE));
    assert.equal(await finishOnboarding(), "complete");
    assert.equal(readStoredAppSettings().permanentAssistant, undefined);
    assert.equal(readStoredAppSettings().memory, undefined);
    assert.equal(getSettings().memory.loadingEnabled, true);
    assert.equal(getSettings().memory.learningMode, "adaptive");
    assert.equal(rotate.mock.calls.length, 0);
    assert.equal(broadcasts.length, 0);
    assert.equal(onboardingState(), "complete");
  });

  test("a gateway client is never set up and keeps memory as it is", async () => {
    assert.equal(
      initOnboarding(() => ({ ...FRESH, gatewayClient: true })),
      "complete",
    );
    await checkOnboarding(probe(CLAUDE));
    assert.equal(existsSync(APP_SETTINGS_PATH), false);
    assert.equal(getSettings().memory.loadingEnabled, true);
    assert.equal(broadcasts.length, 0);
  });

  test("an unknown state in the file reads as complete", () => {
    writeFileSync(STATE_PATH, JSON.stringify({ state: "welcome" }));
    assert.equal(
      initOnboarding(() => FRESH),
      "complete",
    );
  });
});

describe("storage failures", () => {
  test("a marker that cannot be written never blocks boot and never enrolls", async () => {
    block(STATE_TMP);
    for (const facts of [{ ...FRESH, accounts: true }, FRESH]) {
      assert.equal(
        initOnboarding(() => facts),
        "complete",
      );
      assert.equal(onboardingState(), "complete");
      assert.equal(existsSync(STATE_PATH), false);
      await checkOnboarding(probe(CLAUDE));
      assert.equal(existsSync(APP_SETTINGS_PATH), false);
      assert.equal(broadcasts.length, 0);
    }
  });

  test("a failed setup write stays pending and the next check finishes it", async () => {
    initOnboarding(() => FRESH);
    block(STATE_TMP);
    await checkOnboarding(probe(CLAUDE));
    assert.equal(onboardingState(), "pending");
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "pending",
    });
    assert.equal(broadcasts.length, 0);
    // Named, pinned and memory off already; the retry changes none of it, it
    // only moves on.
    assert.equal(readStoredAppSettings().permanentAssistant?.name, "Larry");
    assert.equal(readStoredAppSettings().permanentAssistant?.modelId, "opus");
    assert.equal(readStoredAppSettings().memory?.loadingEnabled, false);

    rmSync(STATE_TMP, { recursive: true });
    await checkOnboarding(probe(OPENAI, () => true));
    assert.equal(onboardingState(), "setup");
    assert.equal(readStoredAppSettings().permanentAssistant?.modelId, "opus");
    assert.deepEqual(broadcasts, [{ type: "onboarding", state: "setup" }]);
  });

  test("a failed settings write stays pending, and moves on once it lands", async () => {
    initOnboarding(() => FRESH);
    block(SETTINGS_TMP);
    await checkOnboarding(probe(CLAUDE));
    assert.equal(onboardingState(), "pending");
    assert.equal(readStoredAppSettings().permanentAssistant, undefined);
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "pending",
    });
    assert.equal(broadcasts.length, 0);

    assert.equal(readStoredAppSettings().memory, undefined);

    rmSync(SETTINGS_TMP, { recursive: true });
    await checkOnboarding(probe(CLAUDE));
    assert.equal(readStoredAppSettings().memory?.loadingEnabled, false);
    assert.equal(readStoredAppSettings().memory?.learningMode, "off");
    assert.equal(readStoredAppSettings().permanentAssistant?.name, "Larry");
    assert.equal(readStoredAppSettings().permanentAssistant?.modelId, "opus");
    assert.equal(onboardingState(), "setup");
    assert.deepEqual(broadcasts, [{ type: "onboarding", state: "setup" }]);
  });
});
