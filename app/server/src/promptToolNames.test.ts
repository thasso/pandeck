/**
 * Task 283: a prompt may not teach a tool that does not exist.
 *
 *   pnpm --filter @assistant/server test src/promptToolNames.test.ts
 *
 * `config/prompts/*.md` is prose, so a renamed or deleted tool leaves a stale
 * mention behind with nothing to catch it — which is exactly how
 * `request_agent_assistance` survived in three persona prompts long after the
 * tool was gone. This scans every tracked prompt asset for backticked
 * snake_case tool mentions and asserts each one resolves in the catalog of
 * every persona that actually loads that file.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { AGENT_TYPES } from "./agentTypes.ts";
import type { AgentType } from "@assistant/shared";
import { toolGroupsFor } from "./tools/catalog.ts";

/** The repository's tracked prompt assets, independent of `ASSISTANT_CWD`. */
const repoPromptsDir = fileURLToPath(
  new URL("../../../config/prompts", import.meta.url),
);

const ALL_PERSONAS = Object.keys(AGENT_TYPES) as AgentType[];

/**
 * Which personas a prompt file reaches. The persona files and the shared
 * project-registry layer are composed into the system prompt
 * (`promptAssets.ts`); the convention documents are read on demand by Workshop
 * sessions, and are held to the same rule because a Workshop agent acts on
 * them.
 */
const PROMPT_FILE_PERSONAS: Record<string, AgentType[]> = {
  "assistant.md": ["assistant"],
  "personal-assistant.md": ["personal-assistant"],
  "workshop.md": ["workshop"],
  "developer.md": ["developer"],
  "workflow-coordinator.md": ["workflow-coordinator"],
  "project-registry.md": ALL_PERSONAS.filter(
    (persona) => persona !== "workflow-coordinator",
  ),
  "chat-files.md": ALL_PERSONAS.filter(
    (persona) => persona !== "workflow-coordinator",
  ),
  "chat-math.md": ALL_PERSONAS.filter(
    (persona) => persona !== "workflow-coordinator",
  ),
  // Conditional sections (Task 287): composed into the same personas that
  // carried the text before it moved out of their persona file.
  "integration-slack.md": ["assistant"],
  "integration-google.md": ["assistant"],
  "integration-tempo.md": ["personal-assistant"],
  "workshop-ui-conventions.md": ["workshop"],
  "workshop-tool-widget-conventions.md": ["workshop"],
};

/**
 * Backticked spans shaped like a tool name: `tool_name`, or a `prefix_*` glob
 * standing for a family. Anchoring on the whole backtick span keeps file paths,
 * shell snippets, and placeholder links out of the match.
 */
const TOOL_MENTION = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z][a-z0-9]*_\*)`/g;

/** Tool-shaped spans that name something other than a tool. */
const NOT_A_TOOL = new Set(["node_modules"]);

function toolNamesFor(agentType: AgentType): Set<string> {
  return new Set(
    toolGroupsFor(agentType).flatMap((group) =>
      group.tools.map((tool) => tool.name),
    ),
  );
}

function mentionsIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(TOOL_MENTION)) {
    const name = match[1];
    if (name && !NOT_A_TOOL.has(name)) names.add(name);
  }
  return [...names];
}

test("the persona-file map covers every tracked prompt asset", () => {
  const onDisk = readdirSync(repoPromptsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  assert.deepEqual(
    onDisk,
    Object.keys(PROMPT_FILE_PERSONAS).sort(),
    "a new prompt file must declare which personas read it, so its tool mentions are checked",
  );
});

test("every tool a prompt names resolves for the personas that read it", () => {
  const catalogs = new Map(ALL_PERSONAS.map((p) => [p, toolNamesFor(p)]));
  let checked = 0;

  for (const [file, personas] of Object.entries(PROMPT_FILE_PERSONAS)) {
    const text = readFileSync(join(repoPromptsDir, file), "utf8");
    for (const mention of mentionsIn(text)) {
      checked += 1;
      for (const persona of personas) {
        const names = catalogs.get(persona) ?? new Set<string>();
        if (mention.endsWith("_*")) {
          const prefix = mention.slice(0, -1);
          assert.ok(
            [...names].some((name) => name.startsWith(prefix)),
            `${file} names the tool family \`${mention}\`, but no ${persona} tool starts with "${prefix}"`,
          );
        } else {
          assert.ok(
            names.has(mention),
            `${file} names \`${mention}\`, which is not a ${persona} tool — remove the mention or add it to NOT_A_TOOL if it is not a tool`,
          );
        }
      }
    }
  }

  assert.ok(
    checked > 0,
    "the scan found no tool mentions at all — the pattern stopped matching",
  );
});
