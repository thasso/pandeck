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
 */
export function credentialProfileProjectionBlockReason(
  load: LoadState<CredentialProfileProjection>,
  selectedProfileId: string,
  selectedModels: ModelOption[] | undefined,
  selectedModel?: Pick<ModelOption, "provider" | "id">,
): string | undefined {
  const projection = dataOf(load);
  if (!projection) return undefined;
  const profiles = projection.profiles.filter((profile) => profile.enabled);
  if (
    !selectedProfileId ||
    !profiles.some((profile) => profile.id === selectedProfileId)
  )
    return "Select a credential profile to continue.";
  if (selectedModels === undefined) return undefined;
  if (selectedModels.length === 0)
    return "No visible models are available for this credential profile. Connect it in Settings or enable one under Models, then retry.";
  if (
    selectedModel &&
    !selectedModels.some(
      (model) =>
        model.provider === selectedModel.provider &&
        model.id === selectedModel.id,
    )
  ) {
    return "Select a model for this provider account to continue.";
  }
  return undefined;
}
