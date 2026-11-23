/**
 * The concrete Claude id a run executes on its account (`docs/agent-harnesses.md`,
 * models port): the pure rule of `claudeSdk/modelResolution.ts` applied to the
 * account's listing (`./claudeAccountModels.ts`). Query opens, a retained
 * process's model change and one-shots resolve here, so this module must stay
 * light: it reaches no pi SDK (`architecture.test.ts`).
 */
import { claudeSdkModelOption } from "../claudeSdk/modelSettings.ts";
import { resolveClaudeSdkModel } from "../claudeSdk/modelResolution.ts";
import { credentialProfileById } from "../credentialProfiles.ts";
import { getSettings } from "../settings.ts";
import { ModelUnavailableOnAccountError } from "../settingsModelSlots.ts";
import {
  claudeAccountModelIds,
  ensureClaudeAccountModels,
} from "./claudeAccountModels.ts";

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
 * The id `aliasOrId` runs on the account, after waiting (bounded) for the
 * account's first listing; an undefined account is unknown. Throws
 * {@link ModelUnavailableOnAccountError} ("<account> can't run <model>.") when
 * the account does not offer it. With the Claude SDK disabled in settings
 * nothing is offered: a resident session, a retained process's model change
 * or a configured helper reaches no provider either, refused the same way
 * (`availability.ts` only guards opening sessions).
 */
export async function resolveClaudeAccountModel(
  profileId: string | undefined,
  aliasOrId: string,
  pin: ClaudeModelPin = {},
): Promise<string> {
  if (!getSettings().claudeSdk.enabled)
    throw new ModelUnavailableOnAccountError(
      "Claude SDK is disabled in settings.",
    );
  if (profileId !== undefined) await ensureClaudeAccountModels(profileId);
  const id = resolveClaudeSdkModel(
    aliasOrId,
    profileId !== undefined ? claudeAccountModelIds(profileId) : undefined,
    pin.pinnedModelId,
    pin.persistedPinnedModelId,
  );
  if (id !== undefined) return id;
  const account =
    (profileId !== undefined
      ? credentialProfileById(profileId)?.name
      : undefined) ?? "This account";
  throw new ModelUnavailableOnAccountError(
    `${account} can't run ${claudeSdkModelOption(aliasOrId).name}.`,
  );
}
