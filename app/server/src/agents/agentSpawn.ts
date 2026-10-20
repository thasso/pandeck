/**
 * Resolving an agent definition for a spawn (`docs/agent-definitions.md`
 * "Spawning by name"): read the definition the library holds NOW, pick the
 * listed model the caller named or the first, check that it can run, pick its
 * account, and produce the frozen copy the session will run as. Direct spawn
 * callers may opt into using the next healthy listed model for a degraded default.
 * Explicit model and account choices never substitute another model.
 */
import {
  isSafeEntryName,
  type EntryDiagnostic,
  type ThinkingLevel,
} from "@assistant/shared";
import {
  credentialProfileById,
  listCredentialProfiles,
} from "../credentialProfiles.ts";
import {
  pickAccount,
  type AccountPickRequest,
  type AccountPickResult,
} from "../accountRouter.ts";
import { accountOffersModel } from "../harnesses/models.ts";
import { assertManifest } from "../library/entryManifest.ts";
import { resolveEntrySource } from "../library/libraryAuthoring.ts";
import { scanLibrary, type LibraryScan } from "../library/libraryScanner.ts";
import type { LibraryStore } from "../library/libraryStore.ts";
import {
  agentKind,
  agentLibraryStore,
  type AgentManifest,
} from "./agentLibrary.ts";
import {
  agentRuntimeLabel,
  checkAgentRuntime,
  type AgentModelChoice,
  type AgentRuntime,
} from "./agentRuntime.ts";
import type { SessionAgent } from "./sessionAgent.ts";

/**
 * A definition that cannot be spawned right now; the reason is the message.
 * `listed` is every model it lists, as each resolves now, when the definition
 * itself could be read: a listing still shows the ones that can run.
 */
export class AgentSpawnRefusedError extends Error {
  listed?: AgentModelChoice[];
  /** Its persona, when the definition itself could be read. */
  persona?: AgentManifest["persona"];
}

/** Everything a spawn needs from one definition. */
export interface AgentSpawnRuntime {
  peerTurnCap?: number;
  compactionWindow?: number;
  agent: SessionAgent;
  description: string;
  provider: string;
  modelId: string;
  modelName?: string;
  credentialProfileId: string;
  accountName?: string;
  thinkingLevel: ThinkingLevel;
  /** Every model the definition lists, in order, as each resolves now. */
  listed: AgentModelChoice[];
  /**
   * The definition's `inheritGrants` spawn default, when it sets one. Not part
   * of the frozen {@link SessionAgent}: it only decides the spawn edge.
   */
  inheritGrants?: boolean;
}

/** The outside state a spawn reads besides the runtime check; for tests. */
export interface AgentSpawnSources {
  library(): LibraryStore;
  /** The ONE place a definition's account is chosen. */
  accountFor(
    request: AccountPickRequest,
  ): Promise<AccountPickResult> | AccountPickResult;
  offers(
    profileId: string,
    provider: string,
    modelId: string,
  ): Promise<boolean>;
  accountName(profileId: string): string | undefined;
}

const liveSources: AgentSpawnSources = {
  library: () => agentLibraryStore,
  accountFor: (request) => pickAccount(request),
  offers: accountOffersModel,
  accountName: (profileId) =>
    listCredentialProfiles().find((profile) => profile.id === profileId)?.name,
};

let sources = liveSources;

/** Test-only seam: spawn from a temp library on fixed accounts. */
export function setAgentSpawnSourcesForTests(
  override: Partial<AgentSpawnSources> | null,
): void {
  sources = override ? { ...liveSources, ...override } : liveSources;
}

/** One fresh scan of the agents library, for resolving several names. */
export async function scanAgentsForSpawn(): Promise<{
  library: LibraryStore;
  scan: LibraryScan;
}> {
  const library = sources.library();
  await library.ensureInitialized();
  return { library, scan: await scanLibrary(agentKind, library.root) };
}

/** Why `name` is not a valid definition, in the scanner's own words. */
function notFoundReason(name: string, diagnostics: EntryDiagnostic[]): string {
  // Each diagnostic is bounded, but a name can match a thousand folders: the
  // reasons are deduplicated and a few are quoted.
  const problems = [
    ...new Set(
      diagnostics
        .filter(
          (diagnostic) =>
            diagnostic.declaredName === name || diagnostic.folder === name,
        )
        .map((diagnostic) => diagnostic.error),
    ),
  ];
  if (problems.length === 0)
    return `There is no agent definition named "${name}". Call session_spawn with operation "agents" for the ones that exist.`;
  const quoted = problems.slice(0, MAX_QUOTED_PROBLEMS);
  const more = problems.length - quoted.length;
  return `Agent definition "${name}" is not valid: ${quoted.join(" ")}${
    more > 0 ? ` And ${more} more problems; agent_list shows them.` : ""
  }`;
}

/** How many distinct problems a refusal quotes. */
const MAX_QUOTED_PROBLEMS = 3;

/** The forms a caller may name a listed model by. */
function namesOf(choice: AgentModelChoice): string[] {
  const forms = [choice.spec];
  const runtime = choice.runtime;
  if (runtime) {
    const { provider, id } = runtime.model;
    forms.push(id, `${provider}/${id}`);
    if (runtime.pinnedModel)
      forms.push(runtime.pinnedModel, `${provider}/${runtime.pinnedModel}`);
  }
  return forms.map((form) => form.toLowerCase());
}

/**
 * The listed models that resolve now, for a refusal to offer instead. Their
 * accounts are checked only when one is chosen.
 */
function runnableNamed(choices: readonly AgentModelChoice[]): string {
  const runnable = choices.filter((choice) => choice.runtime);
  return runnable.length === 0
    ? "None of its listed models resolve now."
    : `Its listed models that resolve now: ${runnable
        .map(
          (choice) => `${choice.spec} (${agentRuntimeLabel(choice.runtime!)})`,
        )
        .join(", ")}; name one as modelId.`;
}

/**
 * The listed model a spawn runs on: the one `wanted` names, else the first.
 * A model the definition does not list is refused, never approximated: running
 * it needs the user's approval.
 */
function chosenModel(
  name: string,
  choices: readonly AgentModelChoice[],
  wanted: string | undefined,
  enabledChoices = choices,
): { spec: string; runtime: AgentRuntime } {
  if (wanted === undefined) {
    const first = choices[0]!;
    if (first.runtime) return { spec: first.spec, runtime: first.runtime };
    throw new AgentSpawnRefusedError(
      `Agent "${name}" cannot run on its default model "${first.spec}": ${first.problem} ${runnableNamed(enabledChoices.slice(1))}`,
    );
  }
  const asked = wanted.trim().toLowerCase();
  const matches = choices.filter((choice) => namesOf(choice).includes(asked));
  if (matches.length > 1)
    throw new AgentSpawnRefusedError(
      `"${wanted}" names more than one model agent "${name}" lists (${matches.map((choice) => choice.spec).join(", ")}); name one exactly, as provider/id.`,
    );
  const match = matches[0];
  if (!match)
    throw new AgentSpawnRefusedError(
      `Agent "${name}" does not list "${wanted}"; it runs only on ${choices.map((choice) => choice.spec).join(", ")}. To run it on another model, use operation "propose" with this agent so the user can approve that runtime.`,
    );
  if (match.problem !== undefined)
    throw new AgentSpawnRefusedError(
      `Agent "${name}" cannot run on "${match.spec}": ${match.problem}`,
    );
  return { spec: match.spec, runtime: match.runtime };
}

/** A definition read and parsed for a spawn, before any model is chosen. */
interface AgentDefinitionRead {
  manifest: AgentManifest;
  blob: string;
  listed: AgentModelChoice[];
  fallbackListed?: AgentModelChoice[];
}

/**
 * Read one definition for a spawn and check everything but its models, which
 * are answered one by one. Every refusal is an {@link AgentSpawnRefusedError}.
 */
async function readAgentDefinition(
  name: string,
  scanned?: { library: LibraryStore; scan: LibraryScan },
  includeDisabledModels = false,
): Promise<AgentDefinitionRead> {
  // A name no definition could declare is refused unquoted: it is the
  // caller's own input, of any size.
  if (!isSafeEntryName(name))
    throw new AgentSpawnRefusedError(
      `That is not a valid agent name. Call session_spawn with operation "agents" for the ones that exist.`,
    );
  const { library, scan } = scanned ?? (await scanAgentsForSpawn());
  let read;
  try {
    read = await resolveEntrySource(library, scan, name);
  } catch (error) {
    throw new AgentSpawnRefusedError(
      // A size refusal or a source that changed since the scan: the message
      // says which.
      `Agent definition "${name}" cannot be read: ${(error as Error).message}`,
    );
  }
  if (!read)
    throw new AgentSpawnRefusedError(notFoundReason(name, scan.diagnostics));
  if (read.truncated)
    throw new AgentSpawnRefusedError(
      `Agent definition "${name}" is larger than an agent definition may be.`,
    );
  let manifest;
  let listed;
  let fallbackListed;
  try {
    // The bytes being frozen are parsed again, not trusted to the scan.
    manifest = assertManifest(agentKind, read.source, read.path);
    listed = (await checkAgentRuntime(manifest, { checkModel: "each" }))!;
    if (includeDisabledModels)
      fallbackListed = (await checkAgentRuntime(manifest, {
        checkModel: "each",
        includeDisabledModels: true,
      }))!;
  } catch (error) {
    throw new AgentSpawnRefusedError(
      `Agent "${name}" cannot run: ${(error as Error).message}`,
    );
  }
  // The bytes on disk, not the decoded text: decoding drops a BOM and bad
  // UTF-8, and the id has to name the repository's own blob.
  const blob = await library.gitBlobIdOf(read.raw);
  // Only enabled-account resolutions belong in caller-visible choices and
  // refusal hints. Known disabled models are internal fallback candidates.
  return {
    manifest,
    blob,
    listed,
    ...(fallbackListed ? { fallbackListed } : {}),
  };
}

/**
 * The blob id of a definition's source as it is NOW, or undefined when it
 * cannot be read. No model is checked, so nothing slow sits between the read
 * and the answer: a caller that checked the definition earlier compares this
 * to the blob it checked.
 */
export async function agentDefinitionBlob(
  name: string,
): Promise<string | undefined> {
  if (!isSafeEntryName(name)) return undefined;
  const { library, scan } = await scanAgentsForSpawn();
  let read;
  try {
    read = await resolveEntrySource(library, scan, name);
  } catch {
    return undefined;
  }
  if (!read || read.truncated) return undefined;
  return library.gitBlobIdOf(read.raw);
}

/** The role half of a frozen agent: everything a runtime choice never changes. */
export type AgentRole = Omit<
  SessionAgent,
  | "provider"
  | "model"
  | "pinnedModel"
  | "effort"
  | "runtimeSource"
  | "modelFallbackReason"
>;

function roleOf({ manifest, blob }: AgentDefinitionRead): AgentRole {
  return {
    name: manifest.name,
    blob,
    persona: manifest.persona,
    denyTools: [...manifest.denyTools],
    skills: [...manifest.skills],
    body: manifest.body.trim(),
  };
}

/**
 * A definition's role for a runtime the USER approves (a proposal card): its
 * models do not need to run, since the user picks the runtime, but everything
 * else about it does.
 */
export async function resolveAgentRole(
  name: string,
  scanned?: { library: LibraryStore; scan: LibraryScan },
): Promise<{
  role: AgentRole;
  listed: AgentModelChoice[];
  peerTurnCap?: number;
  compactionWindow?: number;
  inheritGrants?: boolean;
}> {
  const read = await readAgentDefinition(name, scanned);
  return {
    role: roleOf(read),
    listed: read.listed,
    ...(read.manifest.peerTurns !== undefined
      ? { peerTurnCap: read.manifest.peerTurns }
      : {}),
    ...creationDefaultsOf(read.manifest),
  };
}

/** Creation-only defaults, spread only when the definition sets them. */
function creationDefaultsOf(manifest: AgentManifest): {
  inheritGrants?: boolean;
  compactionWindow?: number;
} {
  return {
    ...(manifest.inheritGrants !== undefined
      ? { inheritGrants: manifest.inheritGrants }
      : {}),
    ...(manifest.compactionWindow !== undefined
      ? { compactionWindow: manifest.compactionWindow }
      : {}),
  };
}

/**
 * A definition started on a runtime the USER picked on the new-session page:
 * that pick is their approval. A listed model at the definition's effort runs
 * as listed, its pin included; any other runtime is the user's own and
 * follows normal session model rules. The role is the definition's either way.
 */
export async function resolveAgentOnRuntime(
  name: string,
  runtime: { provider: string; modelId: string; thinkingLevel: ThinkingLevel },
  /** The account it runs on, which must offer the model. */
  profileId: string,
): Promise<{
  agent: SessionAgent;
  peerTurnCap?: number;
  compactionWindow?: number;
}> {
  const read = await readAgentDefinition(name);
  let offered: boolean;
  try {
    offered = await sources.offers(
      profileId,
      runtime.provider,
      runtime.modelId,
    );
  } catch (error) {
    throw new AgentSpawnRefusedError(
      `Agent "${name}" cannot run: the models of its ${runtime.provider} account could not be read: ${(error as Error).message}`,
    );
  }
  if (!offered)
    throw new AgentSpawnRefusedError(
      `Agent "${name}" cannot run: the account picked for it (${sources.accountName(profileId) ?? profileId}) does not offer ${runtime.provider}/${runtime.modelId}.`,
    );
  const listed = read.listed.find(
    (choice) =>
      choice.runtime?.model.provider === runtime.provider &&
      choice.runtime.model.id === runtime.modelId &&
      choice.runtime.thinkingLevel === runtime.thinkingLevel,
  )?.runtime;
  return {
    ...(read.manifest.peerTurns !== undefined
      ? { peerTurnCap: read.manifest.peerTurns }
      : {}),
    ...(read.manifest.compactionWindow !== undefined
      ? { compactionWindow: read.manifest.compactionWindow }
      : {}),
    agent: {
      ...roleOf(read),
      provider: runtime.provider,
      model: runtime.modelId,
      ...(listed?.pinnedModel ? { pinnedModel: listed.pinnedModel } : {}),
      effort: runtime.thinkingLevel,
      runtimeSource: listed ? "definition" : "user",
    },
  };
}

/**
 * Resolve one definition for a spawn, against `scanned` when the caller holds
 * a scan, else a fresh one. Every refusal is an {@link AgentSpawnRefusedError}.
 */
export async function resolveAgentSpawn(
  name: string,
  scanned?: { library: LibraryStore; scan: LibraryScan },
  options: {
    /** An account the caller picked, in place of the automatic one. */
    profileId?: string;
    requiresEnterprise?: boolean;
    /** One of the listed models; absent selects the default. */
    model?: string;
    /** Direct session_spawn only; first sends and browser prefill stay exact. */
    allowModelFallback?: boolean;
  } = {},
): Promise<AgentSpawnRuntime> {
  const allowFallback =
    options.allowModelFallback === true &&
    options.model === undefined &&
    options.profileId === undefined;
  // Disabled accounts may still identify a known default model. They never
  // authorize a start: every candidate must pass the scoped account router.
  const read = await readAgentDefinition(name, scanned, allowFallback);
  let chosen: { spec: string; runtime: AgentRuntime } | undefined;
  try {
    const candidates = read.fallbackListed ?? read.listed;
    chosen = chosenModel(name, candidates, options.model, read.listed);
    const pick = (runtime: AgentRuntime) =>
      sources.accountFor({
        model: { provider: runtime.model.provider, modelId: runtime.model.id },
        thinkingLevel: runtime.thinkingLevel,
        requiresEnterprise: options.requiresEnterprise === true,
      });
    let account = options.profileId
      ? { profileId: options.profileId }
      : await pick(chosen.runtime);
    let modelFallbackReason: string | undefined;
    if (
      allowFallback &&
      (!account.profileId || account.degraded === "no-eligible-account")
    ) {
      const skipped = [unavailableReason(chosen.spec, account)];
      for (const alternative of candidates.slice(1)) {
        if (!alternative.runtime) {
          skipped.push(`${alternative.spec} does not resolve`);
          continue;
        }
        const next = await pick(alternative.runtime);
        if (!next.profileId || next.degraded) {
          skipped.push(unavailableReason(alternative.spec, next));
          continue;
        }
        chosen = { spec: alternative.spec, runtime: alternative.runtime };
        account = next;
        modelFallbackReason = `${skipped.join("; ")}; used ${alternative.spec}`;
        break;
      }
    }
    if (!account.profileId)
      throw new AgentSpawnRefusedError(
        options.requiresEnterprise
          ? "No enabled enterprise account is available for this agent definition."
          : "No enabled account is available for this agent definition.",
      );
    return await spawnRuntimeOf(
      read,
      name,
      chosen.runtime,
      {
        ...options,
        profileId: account.profileId,
      },
      modelFallbackReason,
    );
  } catch (error) {
    if (error instanceof AgentSpawnRefusedError) {
      error.persona ??= read.manifest.persona;
      // A chosen model that resolved but cannot start on its account is no
      // alternative either: its row says why.
      const failed = chosen?.spec;
      error.listed ??= read.listed.map((choice) =>
        choice.spec === failed
          ? { spec: choice.spec, problem: error.message }
          : choice,
      );
    }
    throw error;
  }
}

/** Router-owned eligibility, with its selected account's bench when present. */
function unavailableReason(spec: string, picked: AccountPickResult): string {
  const reason =
    picked.degraded === "no-eligible-account"
      ? "has no eligible account"
      : "has no enabled account in scope";
  return `${spec} ${reason}${picked.limited ? `, selected account limited until ${new Date(picked.limited.until).toISOString()}` : ""}`;
}

/** The chosen listed model of a read definition, on its account. */
async function spawnRuntimeOf(
  read: AgentDefinitionRead,
  name: string,
  { model, pinnedModel, thinkingLevel }: AgentRuntime,
  options: Parameters<typeof resolveAgentSpawn>[2] & { profileId: string },
  modelFallbackReason?: string,
): Promise<AgentSpawnRuntime> {
  const { manifest, listed } = read;
  const credentialProfileId = options.profileId;
  if (
    options.requiresEnterprise &&
    !credentialProfileById(credentialProfileId)?.enterprise
  )
    throw new AgentSpawnRefusedError(
      "This session requires an enterprise account, but the agent definition's selected account is missing or no longer marked as enterprise.",
    );
  let offered: boolean;
  try {
    offered = await sources.offers(
      credentialProfileId,
      model.provider,
      model.id,
    );
  } catch (error) {
    // An account whose models cannot be read refuses this definition, not
    // every other one listed beside it.
    throw new AgentSpawnRefusedError(
      `Agent "${name}" cannot run: the models of its ${model.provider} account could not be read: ${(error as Error).message}`,
    );
  }
  if (!offered)
    throw new AgentSpawnRefusedError(
      `Agent "${name}" cannot run: the account its ${model.provider} sessions use (${sources.accountName(credentialProfileId) ?? credentialProfileId}) does not offer ${model.provider}/${model.id}.`,
    );
  const accountName = sources.accountName(credentialProfileId);
  return {
    agent: {
      ...roleOf(read),
      provider: model.provider,
      model: model.id,
      ...(pinnedModel ? { pinnedModel } : {}),
      effort: thinkingLevel,
      runtimeSource: "definition",
      ...(modelFallbackReason ? { modelFallbackReason } : {}),
    },
    ...(manifest.peerTurns !== undefined
      ? { peerTurnCap: manifest.peerTurns }
      : {}),
    description: manifest.description,
    provider: model.provider,
    modelId: model.id,
    ...(model.name ? { modelName: model.name } : {}),
    credentialProfileId,
    ...(accountName ? { accountName } : {}),
    thinkingLevel,
    listed,
    ...creationDefaultsOf(manifest),
  };
}

/**
 * One row of `session_spawn` operation "agents". A definition whose default
 * cannot run still carries every model it lists, so the ones that can run
 * stay visible.
 */
export type SpawnableAgent =
  | { name: string; description: string; runtime: AgentSpawnRuntime }
  | {
      name: string;
      description?: string;
      problem: string;
      listed?: AgentModelChoice[];
      persona?: AgentManifest["persona"];
    };

/**
 * Every definition and whether it can be spawned now: the valid ones with
 * what they would run on, the rest with the reason they cannot.
 */
export async function listSpawnableAgents(
  scanned?: { library: LibraryStore; scan: LibraryScan },
  options: { allowModelFallback?: boolean } = {},
): Promise<SpawnableAgent[]> {
  scanned ??= await scanAgentsForSpawn();
  const rows: SpawnableAgent[] = [];
  for (const entry of scanned.scan.entries) {
    try {
      rows.push({
        name: entry.name,
        description: entry.description,
        runtime: await resolveAgentSpawn(entry.name, scanned, options),
      });
    } catch (error) {
      if (!(error instanceof AgentSpawnRefusedError)) throw error;
      rows.push({
        name: entry.name,
        description: entry.description,
        problem: error.message,
        ...(error.listed ? { listed: error.listed } : {}),
        ...(error.persona ? { persona: error.persona } : {}),
      });
    }
  }
  for (const diagnostic of scanned.scan.diagnostics)
    rows.push({
      name: diagnostic.declaredName ?? diagnostic.folder,
      problem: diagnostic.error,
    });
  return rows;
}
