/**
 * The concrete Claude id a run executes on its account (`docs/agent-harnesses.md`,
 * models port): the pure rule of `claudeSdk/modelResolution.ts` applied to the
 * account's listing (`./claudeAccountModels.ts`). Query opens, a retained
 * process's model change and one-shots resolve here, so this module must stay
 * light: it reaches no pi SDK (`architecture.test.ts`).
 */
import {
  ACCOUNT_MODEL_REFUSAL_HINT,
  CLAUDE_SDK_PROVIDER,
  harnessForModelProvider,
} from "@assistant/shared";
import { claudeSdkModelOption } from "../claudeSdk/modelSettings.ts";
import { resolveClaudeSdkModel } from "../claudeSdk/modelResolution.ts";
import { credentialProfileById } from "../credentialProfiles.ts";
import { getSettings } from "../settings.ts";
import { ModelUnavailableOnAccountError } from "../settingsModelSlots.ts";
import {
  claudeAccountModelIds,
  ensureClaudeAccountModels,
} from "./claudeAccountModels.ts";
import { unavailableModelIds } from "./modelUnavailability.ts";

/**
 * A Claude session's pin. `pinnedModelId` is the effective pinned id;
 * `persistedPinnedModelId` is the session's stored pin string, passed only for
 * an existing session (never a new start, spawn, definition or model change).
 */
export interface ClaudeModelPin {
  pinnedModelId?: string;
  persistedPinnedModelId?: string;
}

/**
 * The refusal of every Claude run while the integration is off: what is off,
 * and the one switch that turns it on.
 */
export const CLAUDE_SDK_DISABLED_MESSAGE =
  'Claude SDK is disabled in settings. Turn on "Enable Claude SDK sessions" in Settings > Claude SDK to run Claude models.';

/**
 * Why no run can start on the engine serving `provider` at all: Claude while
 * the Claude SDK is disabled in settings, with the message every Claude run
 * gets then. A switch onto that engine is judged by it before any account is
 * picked or anything moves (`sessionPendingRuntime.ts`).
 */
export function engineDisabledRefusal(provider: string): string | undefined {
  return harnessForModelProvider(provider) === "claude-sdk" &&
    !getSettings().claudeSdk.enabled
    ? CLAUDE_SDK_DISABLED_MESSAGE
    : undefined;
}

/**
 * The id `aliasOrId` runs on the account, after waiting (bounded) for the
 * account's first listing; an undefined account is unknown. Throws
 * {@link ModelUnavailableOnAccountError} ("<account> can't run <model>.") when
 * the account does not offer it, a refused candidate skipped
 * (`modelUnavailability.ts`). With the Claude SDK disabled in settings
 * nothing is offered: a resident session opening a new query, a retained
 * process's model change or a configured helper (the scanned-PDF fallback
 * too) reaches no provider either, refused the same way (`availability.ts`
 * only guards opening sessions). Turning the setting off takes effect at the
 * next query open: a retained query keeps taking prompts and compacts (Task-1487).
 */
export async function resolveClaudeAccountModel(
  profileId: string | undefined,
  aliasOrId: string,
  pin: ClaudeModelPin = {},
): Promise<string> {
  if (!getSettings().claudeSdk.enabled)
    throw new ModelUnavailableOnAccountError(CLAUDE_SDK_DISABLED_MESSAGE);
  if (profileId !== undefined) await ensureClaudeAccountModels(profileId);
  const id = resolveClaudeSdkModel(
    aliasOrId,
    profileId !== undefined ? claudeAccountModelIds(profileId) : undefined,
    pin.pinnedModelId,
    pin.persistedPinnedModelId,
    profileId !== undefined
      ? unavailableModelIds(profileId, CLAUDE_SDK_PROVIDER)
      : undefined,
  );
  if (id !== undefined) return id;
  const account =
    (profileId !== undefined
      ? credentialProfileById(profileId)?.name
      : undefined) ?? "This account";
  throw new ModelUnavailableOnAccountError(
    `${account} can't run ${claudeSdkModelOption(aliasOrId).name}. ${ACCOUNT_MODEL_REFUSAL_HINT}`,
  );
}
