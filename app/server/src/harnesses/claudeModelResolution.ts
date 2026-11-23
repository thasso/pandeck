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
 * the account does not offer it. The Claude SDK setting is not judged here: a
 * disabled integration already refuses to open sessions (`availability.ts`)
 * and to offer models (`models.ts`), so a run that reaches this resolves as
 * before.
 */
export async function resolveClaudeAccountModel(
  profileId: string | undefined,
  aliasOrId: string,
  pin: ClaudeModelPin = {},
): Promise<string> {
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
