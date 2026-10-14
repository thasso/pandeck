/**
 * Resolving an agent definition for a spawn (`docs/agent-definitions.md`
 * "Spawning by name"): read the definition the library holds NOW, check that
 * it can run, pick its account, and produce the frozen copy the session will
 * run as. Nothing here falls back: a definition whose model no longer
 * resolves, or whose account does not offer it, refuses the spawn.
 */
import {
  HARNESSES,
  harnessForModelProvider,
  isSafeEntryName,
  type EntryDiagnostic,
  type ThinkingLevel,
} from "@assistant/shared";
import {
  automaticProfileIdFor,
  listCredentialProfiles,
} from "../credentialProfiles.ts";
import { accountOffersModel } from "../harnesses/models.ts";
import { assertManifest } from "../library/entryManifest.ts";
import { resolveEntrySource } from "../library/libraryAuthoring.ts";
import { scanLibrary, type LibraryScan } from "../library/libraryScanner.ts";
import type { LibraryStore } from "../library/libraryStore.ts";
import { agentKind, agentLibraryStore } from "./agentLibrary.ts";
import { checkAgentRuntime } from "./agentRuntime.ts";
import type { SessionAgent } from "./sessionAgent.ts";

/** A definition that cannot be spawned right now; the reason is the message. */
export class AgentSpawnRefusedError extends Error {}

/** Everything a spawn needs from one definition. */
export interface AgentSpawnRuntime {
  agent: SessionAgent;
  description: string;
  provider: string;
  modelId: string;
  modelName?: string;
  credentialProfileId: string;
  accountName?: string;
  thinkingLevel: ThinkingLevel;
}

/** The outside state a spawn reads besides the runtime check; for tests. */
export interface AgentSpawnSources {
  library(): LibraryStore;
  /** The ONE place a definition's account is chosen. */
  accountFor(modelProvider: string): string;
  offers(
    profileId: string,
    provider: string,
    modelId: string,
  ): Promise<boolean>;
  accountName(profileId: string): string | undefined;
}

const liveSources: AgentSpawnSources = {
  library: () => agentLibraryStore,
  // Usage-aware account routing will replace this one function.
  accountFor: (modelProvider) =>
    automaticProfileIdFor(
      HARNESSES[harnessForModelProvider(modelProvider)].accountProvider,
    ),
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

/**
 * Resolve one definition for a spawn, against `scanned` when the caller holds
 * a scan, else a fresh one. Every refusal is an {@link AgentSpawnRefusedError}.
 */
export async function resolveAgentSpawn(
  name: string,
  scanned?: { library: LibraryStore; scan: LibraryScan },
  /** An account the caller picked, in place of the automatic one. */
  options: { profileId?: string } = {},
): Promise<AgentSpawnRuntime> {
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
  let runtime;
  try {
    // The bytes being frozen are parsed again, not trusted to the scan.
    manifest = assertManifest(agentKind, read.source, read.path);
    runtime = (await checkAgentRuntime(manifest))!;
  } catch (error) {
    throw new AgentSpawnRefusedError(
      `Agent "${name}" cannot run: ${(error as Error).message}`,
    );
  }
  const { model, pinnedModel } = runtime;
  const credentialProfileId =
    options.profileId ?? sources.accountFor(model.provider);
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
  const { thinkingLevel } = runtime;
  const accountName = sources.accountName(credentialProfileId);
  // The bytes on disk, not the decoded text: decoding drops a BOM and bad
  // UTF-8, and the id has to name the repository's own blob.
  const blob = await library.gitBlobIdOf(read.raw);
  return {
    agent: {
      name: manifest.name,
      blob,
      persona: manifest.persona,
      provider: model.provider,
      model: model.id,
      ...(pinnedModel ? { pinnedModel } : {}),
      effort: thinkingLevel,
      denyTools: [...manifest.denyTools],
      skills: [...manifest.skills],
      body: manifest.body.trim(),
    },
    description: manifest.description,
    provider: model.provider,
    modelId: model.id,
    ...(model.name ? { modelName: model.name } : {}),
    credentialProfileId,
    ...(accountName ? { accountName } : {}),
    thinkingLevel,
  };
}

/** One row of `session_spawn` operation "agents". */
export type SpawnableAgent =
  | { name: string; description: string; runtime: AgentSpawnRuntime }
  | { name: string; description?: string; problem: string };

/**
 * Every definition and whether it can be spawned now: the valid ones with
 * what they would run on, the rest with the reason they cannot.
 */
export async function listSpawnableAgents(scanned?: {
  library: LibraryStore;
  scan: LibraryScan;
}): Promise<SpawnableAgent[]> {
  scanned ??= await scanAgentsForSpawn();
  const rows: SpawnableAgent[] = [];
  for (const entry of scanned.scan.entries) {
    try {
      rows.push({
        name: entry.name,
        description: entry.description,
        runtime: await resolveAgentSpawn(entry.name, scanned),
      });
    } catch (error) {
      if (!(error instanceof AgentSpawnRefusedError)) throw error;
      rows.push({
        name: entry.name,
        description: entry.description,
        problem: error.message,
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
