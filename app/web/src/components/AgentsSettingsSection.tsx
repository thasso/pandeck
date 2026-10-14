/**
 * The agent definitions library (`docs/agent-definitions.md`): the shared
 * library page ({@link LibrarySettingsSection}) with what each definition
 * would run on right now under its description, or why it cannot start.
 *
 * Nothing here writes. Agents author definitions through the `agent_*` tools,
 * with an approval card for anything that sets the model or effort, and the
 * user owns the files and their Git history.
 */
import { TriangleAlert } from "lucide-react";
import { agentRuntimeOf, type EntryLibraryList } from "@assistant/shared";
import type { LoadState } from "../lib/loadState.ts";
import {
  LibrarySettingsSection,
  type LibraryPageCopy,
} from "./LibrarySettingsSection.tsx";
import { ItemDescription } from "@/components/ui/item";

const AGENTS_COPY: LibraryPageCopy = {
  library: "agents",
  title: "Agents",
  noun: "agent",
  manifestFile: "AGENT.md",
  intro: (
    <>
      Named agents a session can start by name: “spawn a test-reviewer agent”.
      Each agent is a folder with an <code>AGENT.md</code> whose frontmatter
      declares its persona, model, effort and the tools it must not use; the
      body is its role. Agents write them with the agent tools, and a change to
      the model or effort asks you first. You own the files and their Git
      history.
    </>
  ),
  listTitle: "Available agents",
  listDescription: (
    <>
      Each runs on the model and effort shown. A spawn uses the first enabled
      account of the model's provider, which is what this list checks; a session
      started from the new-session page uses the account picked there. Select an
      agent to read its <code>AGENT.md</code>.
    </>
  ),
  emptyText: (
    <>
      No agents yet. Ask an agent to create one, or add a folder with an{" "}
      <code>AGENT.md</code> inside the library folder above.
    </>
  ),
  noneUsableText:
    "No usable agents. Every folder in the library has a problem listed below.",
  diagnosticsDescription:
    "These folders cannot be used as agents. They stay listed here so a typo does not simply make an agent disappear.",
};

/** What an agent runs on, as one line: persona, model and effort. */
function agentRuntimeLabel(
  runtime: NonNullable<EntryLibraryList["agentRuntimes"]>[string],
): string | undefined {
  if (runtime.problem !== undefined) return undefined;
  const model = `${runtime.provider}/${runtime.modelId}${
    runtime.pinnedModel ? ` (pinned ${runtime.pinnedModel})` : ""
  }`;
  return `${runtime.persona} · ${model} · ${runtime.thinkingLevel} effort`;
}

export function AgentsSettingsSection({
  library,
  initialSelected,
}: {
  library: LoadState<EntryLibraryList>;
  /** A definition to open first, e.g. the one the session inspector linked. */
  initialSelected?: string | null | undefined;
}) {
  return (
    <LibrarySettingsSection
      copy={AGENTS_COPY}
      library={library}
      initialSelected={initialSelected}
      rowMeta={(agent, list) => {
        const runtime = agentRuntimeOf(list, agent.name);
        if (!runtime) return null;
        const label = agentRuntimeLabel(runtime);
        return label ? (
          <ItemDescription>{label}</ItemDescription>
        ) : (
          <ItemDescription className="flex items-start gap-1.5">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>Cannot start: {runtime.problem}</span>
          </ItemDescription>
        );
      }}
    />
  );
}
