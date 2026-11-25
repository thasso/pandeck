/**
 * The models port (`docs/agent-harnesses.md`): which models exist, which an
 * account can run, and how a stored session's model renders. Claude SDK models
 * come from the curated list (offered only while the integration is enabled),
 * narrowed per account to the ids its subscription lists
 * (`claudeAccountModels.ts`); every other model comes from pi's registry.
 * Either way an id the provider refused to run on the account
 * (`modelUnavailability.ts`) is not offered there. Callers never branch on
 * the engine.
 */
import type {
  AppSettings,
  CredentialProfileProvider,
  Harness,
  ModelOption,
} from "@assistant/shared";
import {
  CLAUDE_SDK_PROVIDER,
  harnessForModelProvider,
} from "@assistant/shared";
import {
  CLAUDE_SDK_MODELS,
  type CuratedClaudeModel,
} from "../claudeSdk/modelSettings.ts";
import { resolveClaudeSdkModel } from "../claudeSdk/modelResolution.ts";
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
import type { ClaudeModelPin } from "./claudeModelResolution.ts";
import { claudeModelAlias, curatedModelOption } from "./curatedModels.ts";
import {
  clearAll as clearModelUnavailability,
  modelMarkedUnavailable,
  subscribeModelUnavailabilityChanged,
  unavailableModelIds,
} from "./modelUnavailability.ts";
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

function claudeOption({
  sdkModelIds: _sdkModelIds,
  offeredWhenUnknown: _offeredWhenUnknown,
  ...model
}: CuratedClaudeModel): ModelOption {
  return model;
}

/**
 * What the resolution knows of one Claude account: its listing (undefined
 * while unknown) and the ids the provider refused to run on it.
 */
interface ClaudeAccountView {
  listed: ReadonlySet<string> | undefined;
  refused: ReadonlySet<string>;
}

function claudeAccountView(profileId: string): ClaudeAccountView {
  return {
    listed: claudeAccountModelIds(profileId),
    refused: unavailableModelIds(profileId, CLAUDE_SDK_PROVIDER),
  };
}

/**
 * Whether a Claude account offers a curated model: the per-account resolution
 * (`claudeSdk/modelResolution.ts`) finds an id for it. A known account offers
 * what its listing names a candidate of; an unknown one every alias but the
 * entitlement-gated ones; neither an alias whose every candidate it refused.
 */
function listedOn(
  model: CuratedClaudeModel,
  account: ClaudeAccountView | undefined,
): boolean {
  return (
    resolveClaudeSdkModel(
      model.id,
      account?.listed,
      undefined,
      undefined,
      account?.refused,
    ) !== undefined
  );
}

/** The curated models one Claude account offers right now, without waiting. */
function claudeModelsFor(
  settings: AppSettings,
  profileId: string,
): ModelOption[] {
  if (!settings.claudeSdk.enabled) return [];
  const account = claudeAccountView(profileId);
  return CLAUDE_SDK_MODELS.filter((model) => listedOn(model, account)).map(
    claudeOption,
  );
}

/**
 * The union over the enabled Claude accounts, in curated order; while no
 * Claude account is enabled, what an unknown account offers.
 */
function claudePickerModels(settings: AppSettings): ModelOption[] {
  if (!settings.claudeSdk.enabled) return [];
  const accounts = listCredentialProfiles().filter(
    (profile) => profile.provider === "claude" && profile.enabled,
  );
  return CLAUDE_SDK_MODELS.filter((model) =>
    accounts.length === 0
      ? listedOn(model, undefined)
      : accounts.some((account) =>
          listedOn(model, claudeAccountView(account.id)),
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
 * The concrete versions the accounts can pin per alias model, over all of
 * them and in candidate order (newest first), whatever the accounts' order.
 * One account pins the candidates its listing names, or, while it is unknown,
 * every candidate of an alias an unknown account runs
 * (`claudeSdk/modelResolution.ts`). An alias follows new versions; a concrete
 * id names exactly one, so a pinned id is accepted only while it is one of
 * these.
 */
export function pinnedModelIdsFor(
  accounts: readonly { id: string; provider: CredentialProfileProvider }[],
  settings: AppSettings = getSettings(),
): Map<string, string[]> {
  const pins = new Map<string, string[]>();
  if (!settings.claudeSdk.enabled) return pins;
  const views = accounts
    .filter((account) => account.provider === "claude")
    .map((account) => claudeAccountView(account.id));
  for (const model of CLAUDE_SDK_MODELS) {
    const ids = model.sdkModelIds.filter((id) =>
      views.some(
        ({ listed, refused }) =>
          resolveClaudeSdkModel(model.id, listed, id, undefined, refused) !==
          undefined,
      ),
    );
    if (ids.length) pins.set(`${model.provider}:${model.id}`, ids);
  }
  return pins;
}

/**
 * Every model one account can run right now. Rejects when the account's pi
 * registry cannot be read; callers that list for display catch that.
 */
export async function modelsForAccount(account: {
  id: string;
  provider: CredentialProfileProvider;
}): Promise<ModelOption[]> {
  if (account.provider !== "claude")
    return (await listModelsForProfile(account.id)).filter(
      (model) => !modelMarkedUnavailable(account.id, model.provider, model.id),
    );
  await ensureClaudeAccountModels(account.id);
  return claudeModelsFor(getSettings(), account.id);
}

/**
 * Each account's models, for the account projection
 * (`GET /api/credential-profiles?includeModels=1`). An account whose models
 * cannot be read offers none. A Claude account not yet known waits (bounded)
 * for its first listing, whose success pushes `models` to every client.
 */
export async function modelsByAccount(
  profiles: readonly { id: string; provider: CredentialProfileProvider }[],
): Promise<Record<string, ModelOption[]>> {
  return Object.fromEntries(
    await Promise.all(
      profiles.map(async (profile) => [
        profile.id,
        await modelsForAccount(profile).catch(() => []),
      ]),
    ),
  );
}

/**
 * Whether the account offers this exact model; never a fallback. A Claude
 * model with a pin is offered only where that exact id runs (`pin`,
 * {@link accountLacksModel}).
 */
export async function accountOffersModel(
  profileId: string,
  provider: string,
  modelId: string,
  pin: ClaudeModelPin = {},
): Promise<boolean> {
  if (harnessForModelProvider(provider) === "claude-sdk") {
    if (pin.pinnedModelId !== undefined)
      return !!(await pinnedModelOption(profileId, provider, modelId, pin));
    await ensureClaudeAccountModels(profileId);
    const settings = getSettings();
    if (
      !claudeModelsFor(settings, profileId).some(
        (model) => model.provider === provider && model.id === modelId,
      )
    )
      return false;
    return claudeModelRuns(profileId, modelId, pin);
  }
  if (modelMarkedUnavailable(profileId, provider, modelId)) return false;
  return !!(await findModelForProfile(profileId, provider, modelId));
}

/**
 * The option a pinned session runs on the account, judged by its pin alone:
 * a known listing naming the exact pin offers the alias even when it lists
 * none of the alias's current candidates (a session's legacy `claude-opus-5`).
 * Only Claude pins a version, so only a curated Claude alias with the Claude
 * SDK enabled has one; the pin rule itself is {@link accountLacksModel}'s.
 */
export async function pinnedModelOption(
  profileId: string,
  provider: string,
  modelId: string,
  pin: ClaudeModelPin,
): Promise<ModelOption | undefined> {
  if (!getSettings().claudeSdk.enabled) return undefined;
  const model = CLAUDE_SDK_MODELS.find(
    (option) => option.provider === provider && option.id === modelId,
  );
  if (!model) return undefined;
  await ensureClaudeAccountModels(profileId);
  return claudeModelRuns(profileId, modelId, pin)
    ? claudeOption(model)
    : undefined;
}

/** Whether the Claude account's resolution finds an id for the model. */
function claudeModelRuns(
  profileId: string,
  modelId: string,
  pin: ClaudeModelPin,
): boolean {
  const { listed, refused } = claudeAccountView(profileId);
  return (
    resolveClaudeSdkModel(
      claudeModelAlias(modelId),
      listed,
      pin.pinnedModelId,
      pin.persistedPinnedModelId,
      refused,
    ) !== undefined
  );
}

/**
 * Whether the account is not entitled to the model: the per-account
 * resolution (`claudeSdk/modelResolution.ts`) finds no id for it. A known
 * account lacks what its listing names no candidate of, or a pin it does not
 * list; an unknown account lacks an entitlement-gated model (mythos) and a pin
 * outside what D1 allows. Claude normalizes every id it accepts
 * (`claudeModelAlias`): another spelling runs that curated model and an
 * unknown id the default, so that is the model judged. A candidate the
 * provider refused on the account never resolves. Any other provider lacks
 * exactly the (provider, id) it refused on the account
 * (`modelUnavailability.ts`). Routing and every start refuse such an account
 * (`docs/account-routing.md`).
 */
export async function accountLacksModel(
  profileId: string,
  provider: string,
  modelId: string,
  pin: ClaudeModelPin = {},
): Promise<boolean> {
  if (harnessForModelProvider(provider) !== "claude-sdk")
    return modelMarkedUnavailable(profileId, provider, modelId);
  await ensureClaudeAccountModels(profileId);
  return !claudeModelRuns(profileId, modelId, pin);
}

/** {@link storedSessionModelOption} for a binding-shaped record. */
export function storedBindingModelOption(end: {
  harness?: Harness | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}): ModelOption | undefined {
  return end.harness
    ? storedSessionModelOption(end.harness, end.provider, end.model)
    : undefined;
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
 * logged. It forgets every remembered model refusal first: the user asked to
 * look again. Only this Refresh does; the background refreshes never do.
 */
export async function refreshAllModels(): ReturnType<typeof refreshModels> {
  clearModelUnavailability();
  const [pi] = await Promise.all([
    refreshModels(),
    refreshClaudeAccountModels(),
  ]);
  return pi;
}

/**
 * Hear when what the pickers offer ({@link pickerModels}) or what one account
 * offers may have changed: a pi catalog the periodic refresh brought in, a
 * Claude account's listing, a model refusal remembered or forgotten, or a
 * Claude account enabled, disabled, created or deleted. Returns the
 * unsubscribe.
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
    subscribeModelUnavailabilityChanged(notify),
    subscribeCredentialProfileChanges(claudeAccountChanged),
    subscribeCredentialProfileDeleted(claudeAccountChanged),
  ];
  return () => {
    for (const stop of unsubscribe) stop();
  };
}
