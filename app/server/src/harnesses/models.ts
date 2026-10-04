/**
 * The models port (`docs/agent-harnesses.md`): which models exist, which an
 * account can run, and how a stored session's model renders. Claude SDK models
 * come from the curated list (offered only while the integration is enabled),
 * every other model from pi's registry; callers never branch on the engine.
 */
import type {
  AppSettings,
  CredentialProfileProvider,
  Harness,
  ModelOption,
} from "@assistant/shared";
import { harnessForModelProvider } from "@assistant/shared";
import {
  CLAUDE_SDK_MODELS,
  knownClaudeSdkModelAlias,
} from "../claudeSdk/modelSettings.ts";
import { curatedModelOption } from "./curatedModels.ts";
import {
  findModel,
  findModelForProfile,
  listModels,
  listModelsForProfile,
  toModelOption,
} from "../piSdk/models.ts";
import { getSettings } from "../settings.ts";

function claudeModels(settings: AppSettings): ModelOption[] {
  return settings.claudeSdk.enabled
    ? CLAUDE_SDK_MODELS.map(({ sdkModelId: _sdkModelId, ...model }) => model)
    : [];
}

/** Every model the pickers offer, across both harnesses. */
export function pickerModels(
  settings: AppSettings = getSettings(),
): ModelOption[] {
  return [...listModels(), ...claudeModels(settings)];
}

/**
 * Every model one account can run right now. Rejects when the account's pi
 * registry cannot be read; callers that list for display catch that.
 */
export async function modelsForAccount(account: {
  id: string;
  provider: CredentialProfileProvider;
}): Promise<ModelOption[]> {
  return account.provider === "claude"
    ? claudeModels(getSettings())
    : listModelsForProfile(account.id);
}

/** Whether the account offers this exact model; never a fallback. */
export async function accountOffersModel(
  profileId: string,
  provider: string,
  modelId: string,
): Promise<boolean> {
  if (harnessForModelProvider(provider) === "claude-sdk")
    return (
      getSettings().claudeSdk.enabled && !!knownClaudeSdkModelAlias(modelId)
    );
  return !!(await findModelForProfile(profileId, provider, modelId));
}

/** The display option of the model a stored session names, when it is known. */
export function storedSessionModelOption(
  harness: Harness,
  provider: string | undefined,
  modelId: string | undefined,
): ModelOption | undefined {
  if (!modelId) return undefined;
  if (harness === "claude-sdk") return curatedModelOption(harness, modelId);
  if (!provider) return undefined;
  const model = findModel(provider, modelId);
  return model ? toModelOption(model) : undefined;
}
