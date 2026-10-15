/**
 * The `agents` topic: the agent definitions library as the browser reads it
 * (`docs/agent-definitions.md` "UI"), the shared library list plus what each
 * valid definition would run on right now, so the Agents page can say why one
 * cannot start and the new-session picker can preselect its runtime.
 */
import type {
  AgentListedModelSummary,
  AgentRuntimeSummary,
} from "@assistant/shared";
import type { AgentModelChoice } from "./agentRuntime.ts";
import {
  libraryListMessage,
  publishLibrary,
} from "../library/libraryPublish.ts";
import type { LibraryScan } from "../library/libraryScanner.ts";
import type { LibraryStore } from "../library/libraryStore.ts";
import { agentLibraryStore } from "./agentLibrary.ts";
import { listSpawnableAgents } from "./agentSpawn.ts";

async function agentRuntimes(
  library: LibraryStore,
  scan: LibraryScan,
): Promise<{ agentRuntimes: Record<string, AgentRuntimeSummary> }> {
  const runtimes: Record<string, AgentRuntimeSummary> = {};
  const valid = new Set(scan.entries.map((entry) => entry.name));
  for (const row of await listSpawnableAgents({ library, scan })) {
    // Diagnostics already say why a folder is not a definition, and one
    // listed under a valid definition's name must not replace its runtime:
    // the definitions come first, so the first row for a name wins.
    if (!valid.has(row.name) || Object.hasOwn(runtimes, row.name)) continue;
    runtimes[row.name] =
      "problem" in row
        ? {
            problem: row.problem,
            ...(row.listed ? { models: row.listed.map(listedSummary) } : {}),
          }
        : {
            persona: row.runtime.agent.persona,
            provider: row.runtime.provider,
            modelId: row.runtime.modelId,
            ...(row.runtime.agent.pinnedModel
              ? { pinnedModel: row.runtime.agent.pinnedModel }
              : {}),
            thinkingLevel: row.runtime.thinkingLevel,
            models: row.runtime.listed.map(listedSummary),
          };
  }
  return { agentRuntimes: runtimes };
}

/** One listed model as the browser shows it. */
function listedSummary(choice: AgentModelChoice): AgentListedModelSummary {
  return choice.runtime
    ? {
        spec: choice.spec,
        provider: choice.runtime.model.provider,
        modelId: choice.runtime.model.id,
        ...(choice.runtime.pinnedModel
          ? { pinnedModel: choice.runtime.pinnedModel }
          : {}),
        thinkingLevel: choice.runtime.thinkingLevel,
      }
    : { spec: choice.spec, problem: choice.problem };
}

/** The `agents` topic's list message, for one store. */
export function agentLibraryListMessage(
  library: LibraryStore = agentLibraryStore,
) {
  return libraryListMessage("agents", library, agentRuntimes);
}

/** Scan now and push the result to every `agents` subscriber. */
export function publishAgentLibrary(
  library: LibraryStore = agentLibraryStore,
): Promise<void> {
  return publishLibrary("agents", library, agentRuntimes);
}
