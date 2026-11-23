/**
 * The models port (`docs/agent-harnesses.md`): which models exist, which an
 * account can run, and how a stored session's model renders. Claude SDK models
 * come from the curated list (offered only while the integration is enabled),
 * narrowed per account to the ids its subscription lists
 * (`claudeAccountModels.ts`); every other model comes from pi's registry.
 * Callers never branch on the engine.
 */
import type {
  AppSettings,
  CredentialProfileProvider,
  Harness,
  ModelOption,
} from "@assistant/shared";
import { harnessForModelProvider } from "@assistant/shared";
import { CLAUDE_SDK_MODELS } from "../claudeSdk/modelSettings.ts";
import {
  credentialProfileById,
  listCredentialProfiles,
  subscribeCredentialProfileChanges,
  subscribeCredentialProfileDeleted,
} from "../credentialProfiles.ts";
import {
  claudeAccountModelIds,
  ensureClaudeAccountModels,
  refreshClaudeAccountModels,
  subscribeClaudeAccountModelsChanged,
} from "./claudeAccountModels.ts";
import { curatedModelOption } from "./curatedModels.ts";
import {
  findModel,
  findModelForProfile,
  listModels,
  listModelsForProfile,
  refreshModels,
  subscribePickerModelsChanged as subscribePiPickerModelsChanged,
  toModelOption,
} from "../piSdk/models.ts";
import { selectPiModelWithFallback } from "../piSdk/oneShot.ts";
import { getSettings } from "../settings.ts";

type CuratedClaudeModel = (typeof CLAUDE_SDK_MODELS)[number];

function claudeOption({
  sdkModelId: _sdkModelId,
  ...model
}: CuratedClaudeModel): ModelOption {
  return model;
}

/**
 * Whether a Claude account offers a curated model: it lists the model's
 * concrete id, or nothing is known of it yet (the curated list, as before).
 */
function listedOn(
  model: CuratedClaudeModel,
  listed: ReadonlySet<string> | undefined,
): boolean {
  return !listed || listed.has(model.sdkModelId);
}

/** The curated models one Claude account offers right now, without waiting. */
function claudeModelsFor(
  settings: AppSettings,
  profileId: string,
): ModelOption[] {
  if (!settings.claudeSdk.enabled) return [];
  const listed = claudeAccountModelIds(profileId);
  return CLAUDE_SDK_MODELS.filter((model) => listedOn(model, listed)).map(
    claudeOption,
  );
}

/**
 * The union over the enabled Claude accounts, in curated order; the whole
 * curated list while no Claude account is enabled.
 */
function claudePickerModels(settings: AppSettings): ModelOption[] {
  if (!settings.claudeSdk.enabled) return [];
  const accounts = listCredentialProfiles().filter(
    (profile) => profile.provider === "claude" && profile.enabled,
  );
  return CLAUDE_SDK_MODELS.filter(
    (model) =>
      accounts.length === 0 ||
      accounts.some((account) =>
        listedOn(model, claudeAccountModelIds(account.id)),
      ),
  ).map(claudeOption);
}

/** Every model the pickers offer, across both harnesses. */
export function pickerModels(
  settings: AppSettings = getSettings(),
): ModelOption[] {
  return [...listModels(), ...claudePickerModels(settings)];
}

/**
 * The concrete version each alias model runs TODAY, for the models one account
 * offers: the Claude SDK's `opus` runs `claude-opus-5-5`. An alias follows new
 * versions; a concrete id names exactly one, so a caller that honours a pinned
 * id may accept it only while it is still what its alias runs.
 */
export function pinnedModelIdsFor(
  account: { provider: CredentialProfileProvider },
  settings: AppSettings = getSettings(),
): Map<string, string> {
  if (account.provider !== "claude" || !settings.claudeSdk.enabled)
    return new Map();
  return new Map(
    CLAUDE_SDK_MODELS.map((model) => [
      `${model.provider}:${model.id}`,
      model.sdkModelId,
    ]),
  );
}

/**
 * Every model one account can run right now. Rejects when the account's pi
 * registry cannot be read; callers that list for display catch that.
 */
export async function modelsForAccount(account: {
  id: string;
  provider: CredentialProfileProvider;
}): Promise<ModelOption[]> {
  if (account.provider !== "claude") return listModelsForProfile(account.id);
  await ensureClaudeAccountModels(account.id);
  return claudeModelsFor(getSettings(), account.id);
}

/** Whether the account offers this exact model; never a fallback. */
export async function accountOffersModel(
  profileId: string,
  provider: string,
  modelId: string,
): Promise<boolean> {
  if (harnessForModelProvider(provider) === "claude-sdk") {
    await ensureClaudeAccountModels(profileId);
    return claudeModelsFor(getSettings(), profileId).some(
      (model) => model.provider === provider && model.id === modelId,
    );
  }
  return !!(await findModelForProfile(profileId, provider, modelId));
}

/**
 * Whether the account is KNOWN not to be entitled to the model: its Claude
 * listing lacks the model's concrete id. Unknown accounts, other providers and
 * models outside the curated list are never lacking, so this only ever
 * removes what a real listing proves absent. Routing and every pinned start
 * refuse such an account (`docs/account-routing.md`).
 */
export async function accountLacksModel(
  profileId: string,
  provider: string,
  modelId: string,
): Promise<boolean> {
  if (harnessForModelProvider(provider) !== "claude-sdk") return false;
  const model = CLAUDE_SDK_MODELS.find(
    (entry) => entry.id === modelId || entry.sdkModelId === modelId,
  );
  if (!model) return false;
  await ensureClaudeAccountModels(profileId);
  const listed = claudeAccountModelIds(profileId);
  return listed !== undefined && !listedOn(model, listed);
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

/**
 * The pi model handle a new pi session runs on, resolved on its account:
 * undefined when that account cannot run it. A Claude session names its model
 * by id and needs no handle.
 */
export function piModelForAccount(
  credentialProfileId: string,
  provider: string,
  modelId: string,
): ReturnType<typeof findModelForProfile> {
  return findModelForProfile(credentialProfileId, provider, modelId);
}

/**
 * The pi model a configured slot names on its account, else the helper
 * fallback; undefined when the account can run neither.
 */
export function piModelForSlot(
  slot: { provider: string; modelId: string },
  credentialProfileId: string,
): ReturnType<typeof selectPiModelWithFallback> {
  return selectPiModelWithFallback(slot, credentialProfileId);
}

/**
 * The user's Refresh: pi's model registries (re-read the configured providers
 * and fetch every account's remote catalog) and every enabled Claude account's
 * listing, both forced. The error names the pi configuration, runtime or
 * catalog that failed; a failed Claude listing keeps the last one and is
 * logged.
 */
export async function refreshAllModels(): ReturnType<typeof refreshModels> {
  const [pi] = await Promise.all([
    refreshModels(),
    refreshClaudeAccountModels(),
  ]);
  return pi;
}

/**
 * Hear when what the pickers offer ({@link pickerModels}) or what one account
 * offers may have changed: a pi catalog the periodic refresh brought in, a
 * Claude account's listing, or a Claude account enabled, disabled, created or
 * deleted. Returns the unsubscribe.
 */
export function subscribePickerModelsChanged(listener: () => void): () => void {
  const notify = () => listener();
  const enabled = new Map(
    listCredentialProfiles()
      .filter((profile) => profile.provider === "claude")
      .map((profile) => [profile.id, profile.enabled]),
  );
  const claudeAccountChanged = (id: string) => {
    const profile = credentialProfileById(id);
    const now = profile?.provider === "claude" ? profile.enabled : undefined;
    if (enabled.get(id) === now) return;
    if (now === undefined) enabled.delete(id);
    else enabled.set(id, now);
    listener();
  };
  const unsubscribe = [
    subscribePiPickerModelsChanged(notify),
    subscribeClaudeAccountModelsChanged(notify),
    subscribeCredentialProfileChanges(claudeAccountChanged),
    subscribeCredentialProfileDeleted(claudeAccountChanged),
  ];
  return () => {
    for (const stop of unsubscribe) stop();
  };
}
