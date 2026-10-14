/**
 * Whether an agent definition can RUN right now (`docs/agent-definitions.md`
 * "Model and effort", "Tools"): its model resolves against the connected
 * accounts, its effort fits that model, the tools it denies exist for its
 * persona, and the skills it mounts are valid library skills.
 *
 * None of this is the manifest's content rule — it depends on accounts,
 * Settings and the skills library, which change without the file changing —
 * so it is checked when a definition is written and again when one is
 * spawned, never by the scanner.
 */
import {
  clampThinkingLevelForModel,
  isCodingAgentType,
  type ModelOption,
  type ThinkingLevel,
} from "@assistant/shared";
import { listCredentialProfiles } from "../credentialProfiles.ts";
import { modelsForAccount, pinnedModelIdsFor } from "../harnesses/models.ts";
import { EntryValidationError } from "../library/entryManifest.ts";
import { scanSkillLibrary, skillLibraryStore } from "../skills/skillLibrary.ts";
import {
  AGENT_DEFAULT_EFFORT,
  AGENT_NATIVE_TOOLS,
  type AgentManifest,
  type AgentPersona,
} from "./agentLibrary.ts";

/** What a definition runs as, once resolved. */
export interface AgentRuntime {
  model: ModelOption;
  /**
   * The concrete version the definition pinned, when it named one rather than
   * the alias (`claude-opus-5-5` for `opus`): what the session must run, even
   * after the alias moves on.
   */
  pinnedModel?: string;
  /**
   * The effort it runs at: the definition's, or the default when it names
   * none, fitted to the levels the model supports. The one value a card shows,
   * an approval checks and a spawn freezes.
   */
  thinkingLevel: ThinkingLevel;
}

/** The outside state a runtime check reads; injectable for tests. */
export interface AgentRuntimeSources {
  models(): Promise<readonly AgentModelOption[]>;
  skillNames(): Promise<readonly string[]>;
  toolNames(persona: AgentPersona): Promise<readonly string[]>;
}

/**
 * A model as a definition may name it: its id, and for an alias model the
 * concrete version that alias runs today (`opus` → `claude-opus-5-5`).
 */
export type AgentModelOption = ModelOption & { pinnedId?: string };

/** How many candidate ids a resolution failure names. */
const MAX_LISTED_MODELS = 12;

/** Every model the ENABLED accounts can run now, one row per provider + id. */
async function connectedModels(): Promise<AgentModelOption[]> {
  const byKey = new Map<string, AgentModelOption>();
  for (const profile of listCredentialProfiles()) {
    if (!profile.enabled) continue;
    const models = await modelsForAccount(profile).catch(() => []);
    const pins = pinnedModelIdsFor(profile);
    for (const model of models) {
      const key = `${model.provider}:${model.id}`;
      const pinnedId = pins.get(key);
      byKey.set(key, pinnedId ? { ...model, pinnedId } : model);
    }
  }
  return [...byKey.values()];
}

const liveSources: AgentRuntimeSources = {
  models: connectedModels,
  async skillNames() {
    await skillLibraryStore.ensureInitialized();
    const scan = await scanSkillLibrary(skillLibraryStore.root);
    return scan.entries.map((entry) => entry.name);
  },
  async toolNames(persona) {
    // Imported here, not at the top: the catalog composes the agent tools,
    // which reach this module, so a static import would close a cycle.
    const { agentToolsFor } = await import("../tools/catalog.ts");
    return agentToolsFor(persona).map((tool) => tool.name);
  },
};

let activeSources = liveSources;

/** Test-only seam: run runtime checks against fixed accounts, skills and tools. */
export function setAgentRuntimeSourcesForTests(
  sources: AgentRuntimeSources | null,
): void {
  activeSources = sources ?? liveSources;
}

/**
 * Resolve a definition's `model` to exactly one model a connected account
 * offers. An exact id wins — a model's own id, or the concrete version an
 * alias model runs today (`claude-opus-5-5` resolves to `opus` only while
 * `opus` still runs exactly that version, so a pin never silently follows the
 * alias to another one). Otherwise the spec must equal one hyphen-separated
 * token of exactly one id (`sol` → `gpt-6.1-sol`). `provider/id` names one
 * row when two providers offer the same id, pins included
 * (`claude-sdk/claude-opus-5-5`). Never a guess: none, or
 * more than one, is a refusal that names the candidates.
 */
export function resolveAgentModel(
  spec: string,
  models: readonly AgentModelOption[],
): AgentModelOption {
  const wanted = spec.toLowerCase();
  const exact = models.filter(
    (model) =>
      model.id.toLowerCase() === wanted ||
      // `provider/id` names one row even when two providers offer the id.
      `${model.provider}/${model.id}`.toLowerCase() === wanted ||
      (model.pinnedId !== undefined &&
        (model.pinnedId.toLowerCase() === wanted ||
          `${model.provider}/${model.pinnedId}`.toLowerCase() === wanted)),
  );
  if (exact.length === 1) return exact[0]!;
  const matches =
    exact.length > 1
      ? exact
      : models.filter((model) =>
          model.id.toLowerCase().split("-").includes(wanted),
        );
  if (matches.length === 1) return matches[0]!;
  const named = (list: readonly AgentModelOption[]) =>
    list
      .slice(0, MAX_LISTED_MODELS)
      .map((model) => `${model.provider}/${model.id}`)
      .join(", ");
  if (matches.length > 1)
    throw new EntryValidationError(
      `Model "${spec}" matches more than one connected model (${named(matches)}); name one of them exactly, as provider/id.`,
    );
  throw new EntryValidationError(
    models.length === 0
      ? `Model "${spec}" cannot resolve: no enabled account offers any model.`
      : `No enabled account offers a model "${spec}". Use an alias such as opus or an exact id: ${named(models)}.`,
  );
}

/**
 * Check everything about a definition that its file alone cannot prove, and
 * throw ONE refusal naming every problem. `checkModel: false` skips the model
 * (an edit that leaves model and effort alone must not fail because an
 * account was disconnected since the definition was approved).
 */
export async function checkAgentRuntime(
  manifest: Pick<
    AgentManifest,
    "persona" | "model" | "effort" | "denyTools" | "skills"
  >,
  options: { checkModel?: boolean; sources?: AgentRuntimeSources } = {},
): Promise<AgentRuntime | undefined> {
  const sources = options.sources ?? activeSources;
  const problems: string[] = [];
  let runtime: AgentRuntime | undefined;
  if (options.checkModel !== false) {
    try {
      const model = resolveAgentModel(manifest.model, await sources.models());
      const { pinnedId, ...option } = model;
      const pinned =
        pinnedId !== undefined &&
        [pinnedId, `${model.provider}/${pinnedId}`].some(
          (form) => form.toLowerCase() === manifest.model.toLowerCase(),
        );
      runtime = {
        model: option,
        ...(pinned ? { pinnedModel: pinnedId } : {}),
        thinkingLevel: clampThinkingLevelForModel(
          option,
          manifest.effort ?? AGENT_DEFAULT_EFFORT,
        ),
      };
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (manifest.denyTools.length > 0) {
    // Only the coding persona has native tools to deny.
    const coding = isCodingAgentType(manifest.persona);
    const known = new Set<string>([
      ...(coding ? AGENT_NATIVE_TOOLS : []),
      ...(await sources.toolNames(manifest.persona)),
    ]);
    const unknown = manifest.denyTools.filter((name) => !known.has(name));
    if (unknown.length > 0)
      problems.push(
        `tools.deny names ${unknown.join(", ")}, which the ${manifest.persona} persona does not have; deny only its own tools (unprefixed, e.g. worktree_push)${coding ? ` or ${AGENT_NATIVE_TOOLS.join(", ")}` : ""}.`,
      );
  }
  if (manifest.skills.length > 0) {
    const valid = new Set(await sources.skillNames());
    const missing = manifest.skills.filter((name) => !valid.has(name));
    if (missing.length > 0)
      problems.push(
        `skills names ${missing.join(", ")}, which the skills library does not declare as valid.`,
      );
  }
  if (problems.length > 0) throw new EntryValidationError(problems.join(" "));
  return runtime;
}
