import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { OnboardingState } from "@assistant/shared/onboarding";
import { join } from "node:path";
import { CLAUDE_SDK_PROVIDER, DEFAULT_HELPER_MODEL } from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { APP_SETTINGS_PATH } from "./appSettingsFile.ts";
import {
  credentialProfileById,
  listCredentialProfiles,
} from "./credentialProfiles.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { modelsForAccount } from "./harnesses/models.ts";
import { getSettings } from "./settings.ts";
import { saveSettings } from "./settingsService.ts";

const completionFile = join(DATA_DIR, "onboarding-complete");
const pendingFile = join(DATA_DIR, "onboarding-pending");

/** Read-only detection: never mark an existing installation on GET. */
export function onboardingState(): OnboardingState {
  if (existsSync(completionFile))
    return {
      required: false,
      guidedSetup: readFileSync(completionFile, "utf8") === "complete\n",
    };
  if (existsSync(pendingFile)) return { required: true, guidedSetup: false };
  return {
    required:
      !existsSync(APP_SETTINGS_PATH) &&
      sessionStore.list({ scopes: "all" }).length === 0,
    guidedSetup: false,
  };
}

/** The user's first provider choice freezes onboarding before any account or
 * settings write can make this installation look established on reload. */
export function beginOnboarding(): void {
  if (!onboardingState().required)
    throw new Error("Onboarding is already complete.");
  if (!existsSync(pendingFile))
    writeFileSync(pendingFile, "pending\n", { mode: 0o600, flag: "wx" });
}

export async function completeOnboarding(profileId: string): Promise<void> {
  if (!onboardingState().required)
    throw new Error("Onboarding is already complete.");
  // Protected defaults can inherit ~/.claude or an earlier ~/.pi import. Never
  // silently choose either as the account for the first Assistant conversation.
  if (profileId === "default" || profileId === "claude-default")
    throw new Error("Sign in with a new account to finish setup.");
  const profile = credentialProfileById(profileId);
  if (
    !profile ||
    !profile.enabled ||
    !listCredentialProfiles().some(
      (item) => item.id === profileId && item.status === "ready",
    )
  )
    throw new Error("Finish signing in before continuing.");

  const settings = getSettings();
  const availableModels =
    profile.provider === "claude" ? [] : await modelsForAccount(profile);
  const model =
    profile.provider === "claude"
      ? { provider: CLAUDE_SDK_PROVIDER, id: "sonnet" }
      : (availableModels.find(
          (item) =>
            item.provider === DEFAULT_HELPER_MODEL.provider &&
            item.id === DEFAULT_HELPER_MODEL.modelId,
        ) ?? availableModels.find((item) => item.provider === "openai-codex"));
  if (!model)
    throw new Error(
      "No model is available for this account yet. Try again after sign-in completes.",
    );

  await saveSettings({
    ...(profile.provider === "claude" ? { claudeSdk: { enabled: true } } : {}),
    permanentAssistant: {
      ...settings.permanentAssistant,
      provider: model.provider,
      modelId: model.id,
      credentialProfileId: profileId,
    },
  });
  writeFileSync(completionFile, "complete\n", { mode: 0o600, flag: "wx" });
}
