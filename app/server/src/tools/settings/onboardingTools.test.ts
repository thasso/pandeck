import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { DATA_DIR } from "../../config.ts";
import {
  claudeConfigDir,
  createCredentialProfile,
} from "../../credentialProfiles.ts";
import { initOnboarding, onboardingState } from "../../onboarding.ts";
import * as pa from "../../permanentAssistant.ts";
import { getSettings } from "../../settings.ts";
import { saveSettings } from "../../settingsService.ts";
import { onboardingTools } from "./onboardingTools.ts";
import { settingsTools } from "./settingsTools.ts";

const STATE_PATH = join(DATA_DIR, "onboarding.json");
const ctx = { toolCallId: "call-1", session: { sessionId: "s-pa" } } as never;
const finish = onboardingTools.find((t) => t.name === "onboarding_finish")!;
const modelsRead = settingsTools.find((t) => t.name === "models_read")!;
const settingsUpdate = settingsTools.find((t) => t.name === "settings_update")!;

function boot(state: "pending" | "setup" | "complete") {
  writeFileSync(STATE_PATH, JSON.stringify({ state }));
  initOnboarding(() => {
    throw new Error("the file decides");
  });
}

let rotate: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  rotate = vi.spyOn(pa, "rotatePermanentAssistantSession").mockResolvedValue();
});
afterEach(() => {
  rotate.mockRestore();
  rmSync(STATE_PATH, { force: true });
});

describe("onboarding_finish", () => {
  test("ends guided setup and starts the assistant afresh", async () => {
    boot("setup");
    const result = await finish.execute({}, ctx);
    assert.deepEqual(result.details, { state: "complete" });
    assert.equal(onboardingState(), "complete");
    assert.equal(rotate.mock.calls.length, 1);
  });

  test("refuses outside guided setup and changes nothing", async () => {
    for (const state of ["pending", "complete"] as const) {
      boot(state);
      await assert.rejects(finish.execute({}, ctx), /not running/);
      assert.equal(onboardingState(), state);
    }
    assert.equal(rotate.mock.calls.length, 0);
  });
});

describe("renaming the assistant during guided setup", () => {
  const rename = async (name: string) =>
    (
      await settingsUpdate.execute(
        { changes: [{ path: "permanentAssistant.name", value: name }] },
        ctx,
      )
    ).details as { assistantRestart?: string };

  test("keeps the conversation and says so", async () => {
    boot("setup");
    const result = await rename("Max");
    assert.equal(getSettings().permanentAssistant.name, "Max");
    assert.equal(result.assistantRestart, undefined);
    assert.equal(rotate.mock.calls.length, 0);
  });

  test("restarts the assistant as always once setup is over", async () => {
    boot("complete");
    const result = await rename("Moritz");
    assert.match(result.assistantRestart ?? "", /fresh session/);
    assert.equal(rotate.mock.calls.length, 1);
  });
});

describe("models_read", () => {
  test("lists each signed-in account's models with their picker visibility", async () => {
    const account = createCredentialProfile({
      provider: "claude",
      name: "Models Claude",
    });
    writeFileSync(join(claudeConfigDir(account.id), ".credentials.json"), "{}");
    const signedOut = createCredentialProfile({
      provider: "claude",
      name: "Signed-out Claude",
    });
    await saveSettings({
      claudeSdk: { ...getSettings().claudeSdk, enabled: true },
      models: { ...getSettings().models, hidden: ["claude-sdk:haiku"] },
    });
    const result = (await modelsRead.execute({}, ctx)).details as {
      assistantModel: string;
      accounts: Array<{
        id: string;
        models?: Array<{ key: string; shown: boolean }>;
      }>;
    };
    const { permanentAssistant } = getSettings();
    assert.equal(
      result.assistantModel,
      `${permanentAssistant.provider}:${permanentAssistant.modelId}`,
    );
    const listed = result.accounts.find((entry) => entry.id === account.id);
    assert.ok(listed?.models?.some((m) => m.key === "claude-sdk:opus"));
    assert.equal(
      listed?.models?.find((m) => m.key === "claude-sdk:haiku")?.shown,
      false,
    );
    assert.equal(
      listed?.models?.find((m) => m.key === "claude-sdk:opus")?.shown,
      true,
    );
    assert.ok(!result.accounts.some((entry) => entry.id === signedOut.id));
  });

  test("takes no arguments", async () => {
    await assert.rejects(modelsRead.execute({ account: "x" }, ctx));
  });
});
