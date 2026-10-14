import type { ModelOption } from "@assistant/shared";
import type { LoadState } from "./loadState.ts";
import { dataOf } from "./loadState.ts";
import type { CredentialProfileProjection } from "./credentialProfiles.ts";

/** Whether first send must wait for an authoritative profile/runtime projection. */
export function credentialProfileProjectionBlocksSend(
  load: LoadState<CredentialProfileProjection>,
): boolean {
  return dataOf(load) === undefined;
}

/**
 * An actionable reason first send cannot use the loaded projection.
 *
 * Fetch progress and fetch failures are deliberately NOT returned here: the
 * quick-start runtime section is their one narration on the surface. Composer
 * controls are disabled quietly until data exists.
 *
 * A staged agent definition (`docs/agent-definitions.md` "UI") skips the model
 * checks: it runs its own model, which Settings → Models may hide from the
 * pickers, and the server checks that model against the picked account and
 * refuses with the reason.
 */
export function credentialProfileProjectionBlockReason(
  load: LoadState<CredentialProfileProjection>,
  selection: {
    /** The explicit account, or null for Automatic. */
    profileId: string | null;
    requiresEnterprise: boolean;
  },
  selectedModels: ModelOption[] | undefined,
  selectedModel?: Pick<ModelOption, "provider" | "id">,
  agentStaged = false,
): string | undefined {
  const projection = dataOf(load);
  if (!projection) return undefined;
  const profiles = projection.profiles.filter(
    (profile) =>
      profile.enabled && (!selection.requiresEnterprise || profile.enterprise),
  );
  // "Requires enterprise" is a hard limit: with no enterprise account there is
  // nothing to start on, and the session must not fall back to another one.
  if (selection.requiresEnterprise && profiles.length === 0)
    return "No enabled account is marked Enterprise. Mark one in Settings, or turn off “Requires enterprise”.";
  if (selection.profileId === null) {
    if (profiles.length === 0)
      return "No provider account is enabled. Connect or enable one in Settings to continue.";
  } else if (!profiles.some((profile) => profile.id === selection.profileId)) {
    // The user's explicit pick stopped being usable while staged. It is never
    // swapped for another account: the user chooses again.
    const picked = projection.profiles.find(
      (profile) => profile.id === selection.profileId,
    );
    if (!picked)
      return "The selected account no longer exists. Choose another account or Automatic.";
    if (!picked.enabled)
      return `“${picked.name}” is disabled. Choose another account or Automatic.`;
    return `“${picked.name}” is not an enterprise account. Choose an enterprise account or Automatic.`;
  }
  if (selectedModels === undefined || agentStaged) return undefined;
  if (selectedModels.length === 0)
    return selection.profileId === null
      ? "No visible models are available on any enabled account. Connect one in Settings or enable a model under Models, then retry."
      : "No visible models are available for this credential profile. Connect it in Settings or enable one under Models, then retry.";
  if (
    selectedModel &&
    !selectedModels.some(
      (model) =>
        model.provider === selectedModel.provider &&
        model.id === selectedModel.id,
    )
  ) {
    return selection.profileId === null
      ? "Select a model to continue."
      : "Select a model for this provider account to continue.";
  }
  return undefined;
}
