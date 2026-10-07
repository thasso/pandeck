import { createContext, useContext } from "react";
import {
  type AccountModelOption,
  type CredentialProfileSummary,
  type ModelOption,
  type ThinkingLevel,
  clampThinkingLevelForModel,
  supportedThinkingLevelsForModel,
} from "@assistant/shared";
import {
  ModelSelect,
  ThinkingSelect,
  SelectField,
} from "./common/ModelThinkingSelect.tsx";
import { accountPinWarning } from "../lib/credentialProfiles.ts";

/**
 * The account list, available to every settings section. It exists only so a
 * slot pinned to a disabled or deleted account can explain itself; the choice
 * itself travels with the selected account/model combination.
 */
export const CredentialProfilesContext = createContext<
  CredentialProfileSummary[]
>([]);

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
 * authenticates as; `credentialProfiles` only powers the degradation notice for
 * a pin whose account was disabled or removed.
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
  models: AccountModelOption[];
  provider: string;
  modelId: string;
  /**
   * The selected level, or `undefined` when the slot has none this build can
   * run. The picker then shows NO selection, and changing the model alone
   * leaves the level unset — inventing one would record a choice nobody made.
   */
  thinkingLevel: ThinkingLevel | undefined;
  credentialProfileId?: string | undefined;
  onChange: (next: {
    provider: string;
    modelId: string;
    /** Omitted when the model changed while no level was selected. */
    thinkingLevel?: ThinkingLevel;
    credentialProfileId?: string;
  }) => void;
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
  const selected = models.find(
    (m) =>
      m.provider === provider &&
      m.id === modelId &&
      (!credentialProfileId || m.credentialProfileId === credentialProfileId),
  );
  const supported =
    thinkingLevel !== undefined &&
    supportedThinkingLevelsForModel(selected).includes(thinkingLevel);
  // In `exact` mode an unrunnable level is not a selection at all.
  const shownLevel =
    thinkingSelection === "clamp" || supported ? thinkingLevel : undefined;
  const profiles = useContext(CredentialProfilesContext);
  const warning = accountFallback
    ? accountPinWarning(profiles, {
        provider,
        ...(credentialProfileId !== undefined ? { credentialProfileId } : {}),
      })
    : undefined;
  return (
    <div className="space-y-2">
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label={modelLabel}>
          <ModelSelect
            models={models}
            value={
              selected ?? {
                provider,
                id: modelId,
                ...(credentialProfileId ? { credentialProfileId } : {}),
              }
            }
            variant="field"
            placeholder={
              models.length === 0 ? "No models available" : "Select a model"
            }
            onChange={(m) =>
              onChange({
                provider: m.provider,
                modelId: m.id,
                ...thinkingForModel(m, thinkingLevel, thinkingSelection),
                credentialProfileId: m.credentialProfileId,
              })
            }
          />
        </SelectField>
        <SelectField label={thinkingLabel}>
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
        </SelectField>
      </div>
      {warning ? <p className="text-caption text-warning">{warning}</p> : null}
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
