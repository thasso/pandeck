import { createContext, useContext } from "react";
import {
  type AccountPickPreviewResult,
  type CredentialProfilePin,
  type CredentialProfileSummary,
  type ModelOption,
  type ThinkingLevel,
  clampThinkingLevelForModel,
  supportedThinkingLevelsForModel,
} from "@assistant/shared";
import type { UsageIndicator } from "@assistant/shared/usage";
import { ModelSelect, ThinkingSelect } from "./common/ModelThinkingSelect.tsx";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  accountPinWarning,
  automaticPreviewHint,
  isAutomaticModelOption,
  previewAutomaticAccount,
  type SlotModelOption,
} from "../lib/credentialProfiles.ts";
import { dataOf } from "../lib/loadState.ts";
import { useFetchState } from "../hooks/useFetchState.ts";

/**
 * One {@link AgentModelFields} change. It carries the slot's WHOLE account pin:
 * `credentialProfileId` is present exactly when the choice names an account,
 * so a change without one means Automatic and must clear an older pin — apply
 * it with {@link applyModelSlotChange}, never by spreading it over the slot.
 */
export interface ModelSlotChange {
  provider: string;
  modelId: string;
  /** Omitted when the model changed while no level was selected. */
  thinkingLevel?: ThinkingLevel;
  credentialProfileId?: string;
}

/** The slot after `change`: its fields, with the account pin replaced whole. */
export function applyModelSlotChange<T extends CredentialProfilePin>(
  slot: T,
  change: ModelSlotChange,
): T {
  const next = { ...slot };
  delete next.credentialProfileId;
  return { ...next, ...change };
}

/**
 * The account list, available to every settings section. It exists only so a
 * slot pinned to a disabled or deleted account can explain itself; the choice
 * itself travels with the selected account/model combination.
 */
export const CredentialProfilesContext = createContext<
  CredentialProfileSummary[]
>([]);

/** Server usage-cache updates invalidate unpinned Settings slot previews. */
export const AccountUsageContext = createContext<UsageIndicator[] | null>(null);

/**
 * Shared model + thinking-level picker for the configurable helper/custom agents.
 * Uses the same popover {@link ModelSelect}/{@link ThinkingSelect} as the chat
 * composer, grouped by provider with brand icons. Stores a flat
 * `{provider, modelId, thinkingLevel}` shape; selecting a model clamps the
 * thinking level to what that model supports.
 */
/**
 * Model + thinking level for one configured agent. `models` are account/model
 * combinations, so picking a model also pins the provider account the agent
 * authenticates as — or, for an Automatic option (`slotModelOptions`), leaves
 * the slot unpinned so the router picks the account per run.
 * `credentialProfiles` only powers the degradation notice for a pin whose
 * account was disabled or removed.
 *
 * That notice states a BEHAVIOUR — an unusable account degrades to the
 * automatic one — which is true of an ordinary settings slot and false of a
 * surface that refuses instead. `accountFallback={false}` is how such a surface
 * says so; it then owns explaining the consequence itself, since a promise the
 * server will not keep is worse than no promise.
 */
export function AgentModelFields({
  models,
  provider,
  modelId,
  thinkingLevel,
  credentialProfileId,
  onChange,
  modelLabel = "Model",
  thinkingLabel = "Thinking mode",
  thinkingPlaceholder,
  thinkingSelection = "clamp",
  accountFallback = true,
}: {
  models: SlotModelOption[];
  provider: string;
  modelId: string;
  /**
   * The selected level, or `undefined` when the slot has none this build can
   * run. The picker then shows NO selection, and changing the model alone
   * leaves the level unset — inventing one would record a choice nobody made.
   */
  thinkingLevel: ThinkingLevel | undefined;
  credentialProfileId?: string | undefined;
  onChange: (next: ModelSlotChange) => void;
  modelLabel?: string;
  thinkingLabel?: string;
  /** Trigger label while no level is selected. */
  thinkingPlaceholder?: string;
  /**
   * What a level the selected model cannot run means.
   *
   * `"clamp"` (the default, and what an ordinary settings slot wants) shows and
   * emits the nearest supported level: the slot names a preference, and the
   * runtime lowers it. `"exact"` is for a surface where the model/level PAIR is
   * the record — an approved peer runtime — so a level this model cannot run is
   * shown as no selection and changing the model emits no level at all. The
   * difference matters because clamping there would persist an approval for a
   * level the human never chose.
   */
  thinkingSelection?: "clamp" | "exact";
  /** Whether an unusable pinned account degrades to the automatic one. */
  accountFallback?: boolean;
}) {
  // An unpinned settings slot is Automatic even without a matching offer.
  // Explicit-only surfaces keep matching the model on any account.
  // Clearing a saved pin must not depend on today's model catalog or accounts.
  const canClearPin =
    accountFallback &&
    Boolean(credentialProfileId) &&
    !models.some(
      (model) =>
        isAutomaticModelOption(model) &&
        model.provider === provider &&
        model.id === modelId,
    );
  const selected = models.find(
    (m) =>
      m.provider === provider &&
      m.id === modelId &&
      (credentialProfileId
        ? !isAutomaticModelOption(m) &&
          m.credentialProfileId === credentialProfileId
        : !accountFallback || isAutomaticModelOption(m)),
  );
  const supported =
    thinkingLevel !== undefined &&
    supportedThinkingLevelsForModel(selected).includes(thinkingLevel);
  // In `exact` mode an unrunnable level is not a selection at all.
  const shownLevel =
    thinkingSelection === "clamp" || supported ? thinkingLevel : undefined;
  const profiles = useContext(CredentialProfilesContext);
  const usageIndicators = useContext(AccountUsageContext);
  // Which account an unpinned slot resolves to, as the server's router sees it
  // for background work — one request for the slot's own model/effort, never
  // one per option. Keyed on the slot's INTENT, not on a matching Automatic
  // option: with every account disabled, or the model offered by none, there
  // is no such option, yet the slot still runs (or fails) and must say how.
  // Surfaces whose record names an account (`accountFallback={false}`) never
  // ask.
  const automaticIntent =
    accountFallback &&
    !credentialProfileId?.trim() &&
    provider.trim() !== "" &&
    modelId.trim() !== "";
  const preview = useFetchState<AccountPickPreviewResult>(
    automaticIntent
      ? JSON.stringify([
          provider,
          modelId,
          shownLevel ?? null,
          profiles.map(
            (profile) =>
              `${profile.id}:${profile.enabled}:${profile.health.state}`,
          ),
          (usageIndicators ?? []).map(
            (indicator) => `${indicator.profileId}:${indicator.fetchedAt}`,
          ),
        ])
      : null,
    (_key, signal) =>
      previewAutomaticAccount(
        {
          model: { provider, modelId },
          ...(shownLevel !== undefined ? { thinkingLevel: shownLevel } : {}),
          scope: "background",
        },
        signal,
      ),
  );
  const previewData = automaticIntent ? dataOf(preview.state) : undefined;
  const automaticHint = previewData
    ? automaticPreviewHint(previewData, profiles, provider)
    : undefined;
  const warning = accountFallback
    ? accountPinWarning(profiles, {
        ...(credentialProfileId !== undefined ? { credentialProfileId } : {}),
      })
    : undefined;
  return (
    <div className="space-y-2">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>{modelLabel}</FieldLabel>
          <ModelSelect
            models={models}
            value={
              selected ?? {
                provider,
                id: modelId,
                ...(credentialProfileId
                  ? { credentialProfileId }
                  : accountFallback
                    ? { automatic: true as const }
                    : {}),
              }
            }
            variant="field"
            placeholder={
              automaticIntent
                ? `${modelId} · Automatic`
                : models.length === 0
                  ? "No models available"
                  : "Select a model"
            }
            onChange={(m) =>
              onChange({
                provider: m.provider,
                modelId: m.id,
                ...thinkingForModel(m, thinkingLevel, thinkingSelection),
                ...(isAutomaticModelOption(m)
                  ? {}
                  : { credentialProfileId: m.credentialProfileId }),
              })
            }
          />
          {canClearPin && (
            <Button
              variant="link"
              size="sm"
              className="justify-start"
              onClick={() =>
                onChange({
                  provider,
                  modelId,
                  ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
                })
              }
            >
              Use Automatic
            </Button>
          )}
        </Field>
        <Field>
          <FieldLabel>{thinkingLabel}</FieldLabel>
          <ThinkingSelect
            model={selected}
            value={shownLevel}
            variant="field"
            {...(thinkingPlaceholder === undefined
              ? {}
              : { placeholder: thinkingPlaceholder })}
            onChange={(lvl) =>
              onChange({
                provider,
                modelId,
                thinkingLevel: lvl,
                ...(credentialProfileId !== undefined
                  ? { credentialProfileId }
                  : {}),
              })
            }
          />
        </Field>
      </div>
      {warning ? (
        <Alert variant="warning" role="note">
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ) : null}
      {automaticHint?.warning ? (
        <Alert variant="warning" role="note">
          <AlertDescription>{automaticHint.text}</AlertDescription>
        </Alert>
      ) : automaticHint ? (
        <FieldDescription>{automaticHint.text}</FieldDescription>
      ) : null}
    </div>
  );
}

/**
 * The thinking level a model change carries.
 *
 * `clamp` lowers the current level into the new model's ladder, which is what a
 * preference slot means. `exact` carries it only when the new model really
 * supports it and otherwise omits the field: on a surface where the pair IS the
 * approval, choosing a model says nothing about the thinking level, and writing
 * the neighbour would record a choice the human never made.
 */
function thinkingForModel(
  model: ModelOption,
  level: ThinkingLevel | undefined,
  selection: "clamp" | "exact",
): { thinkingLevel?: ThinkingLevel } {
  if (level === undefined) return {};
  if (selection === "clamp")
    return { thinkingLevel: clampThinkingLevelForModel(model, level) };
  return supportedThinkingLevelsForModel(model).includes(level)
    ? { thinkingLevel: level }
    : {};
}
