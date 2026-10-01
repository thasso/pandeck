/**
 * pi-side inputs for the prompt inventory ({@link ../promptInventory.ts}).
 *
 * The inventory must report what pi ACTUALLY assembles, not a hand-copied
 * replica that silently drifts on a pi upgrade — so this module reuses pi's own
 * `buildSystemPrompt`. That function is not part of the package's `exports`
 * map, so it is loaded by resolving the package entry and importing the file
 * directly. That is a deliberate reach into pi internals for a measurement
 * tool: {@link loadPiPromptBuilder} throws loudly if the module or the export
 * disappears, and `promptInventory.test.ts` pins it, so a pi upgrade fails the
 * suite instead of quietly degrading the baseline.
 *
 * Everything here mirrors what `options.ts` hands to `createAgentSession`; the
 * one deliberate deviation is that skills and the agent-dir global context file
 * are excluded, so the measurement does not depend on the measuring machine's
 * `~/.pi` (recorded as an assumption in the report). For the same reason pi's
 * own install directory is normalized out of the assembled text — see
 * {@link PI_PACKAGE_LABEL}.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";

/**
 * A prompt-relevant slice of a tool definition. Only pi's BUILTINS still carry
 * prompt extras: our own {@link import("../mcp/tool.ts").AgentTool} has none
 * since Task-282, so an app tool contributes nothing but its name here. That is
 * the point — it keeps the app-eager rows in the inventory measurable (and
 * provably zero) instead of removing them from the table.
 */
export interface PiPromptTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/** One project-context file as pi embeds it in `<project_context>`. */
export interface PiContextFile {
  path: string;
  content: string;
}

/** The inputs `AgentSession._rebuildSystemPrompt` derives for one session. */
export interface PiPromptInput {
  cwd: string;
  /** Set for the assistant personas (pi's default prompt is replaced). */
  customPrompt?: string;
  /** Set for the coding personas (pi's default prompt is kept). */
  appendSystemPrompt?: string;
  contextFiles: PiContextFile[];
  /** Active tool names, in pi's registration order. */
  selectedTools: string[];
  toolSnippets: Record<string, string>;
  promptGuidelines: string[];
}

export interface PiPromptBuilder {
  /** Absolute path of the pi module the measurement reached into. */
  modulePath: string;
  /** Absolute path of pi's install directory, normalized out of `build`. */
  packageRoot: string;
  /** Assemble the prompt exactly as a pi session would, from `input`. */
  build(input: PiPromptInput): string;
}

/**
 * The stand-in for pi's install directory in a measured prompt.
 *
 * pi's default prompt embeds absolute paths to its own README, docs and
 * examples, so the assembled length would otherwise depend on where the
 * measuring machine put the checkout (a CI container's `/workspace` against a
 * developer's home directory) and on pi's version, which pnpm encodes in the
 * store path. Both are noise: they move the number without moving a character
 * the model's author wrote. The label normalizes them away exactly as the cwd
 * label does for the workspace, so the committed sizes are reproducible.
 */
export const PI_PACKAGE_LABEL = "/pi";

/** The pi package's own directory: the nearest ancestor with a manifest. */
function packageRootOf(entry: string): string {
  let dir = dirname(entry);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(
        `no package.json above ${entry} — the prompt inventory cannot normalize pi's install path out of the measurement`,
      );
    dir = parent;
  }
}

interface PiSystemPromptModule {
  buildSystemPrompt(options: {
    customPrompt?: string;
    selectedTools?: string[];
    toolSnippets?: Record<string, string>;
    promptGuidelines?: string[];
    appendSystemPrompt?: string;
    cwd: string;
    contextFiles?: PiContextFile[];
    skills?: never[];
  }): string;
}

/** Resolve pi's `buildSystemPrompt`, failing loudly if pi moved it. */
export async function loadPiPromptBuilder(): Promise<PiPromptBuilder> {
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const modulePath = join(dirname(entry), "core", "system-prompt.js");
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(modulePath).href);
  } catch (err) {
    throw new Error(
      `pi's system-prompt module is no longer at ${modulePath} — the prompt inventory measures pi's real assembly and must be repointed: ${String(err)}`,
    );
  }
  const mod = loaded as Partial<PiSystemPromptModule>;
  if (typeof mod.buildSystemPrompt !== "function")
    throw new Error(
      `${modulePath} no longer exports buildSystemPrompt — the prompt inventory cannot measure pi's real assembly`,
    );
  const buildSystemPrompt = mod.buildSystemPrompt;
  const packageRoot = packageRootOf(entry);
  return {
    modulePath,
    packageRoot,
    build(input) {
      const prompt = buildSystemPrompt({
        cwd: input.cwd,
        ...(input.customPrompt ? { customPrompt: input.customPrompt } : {}),
        ...(input.appendSystemPrompt
          ? { appendSystemPrompt: input.appendSystemPrompt }
          : {}),
        contextFiles: input.contextFiles,
        // Skills are excluded from the measurement (see the module comment).
        skills: [],
        selectedTools: input.selectedTools,
        toolSnippets: input.toolSnippets,
        promptGuidelines: input.promptGuidelines,
      });
      return prompt.replaceAll(packageRoot, PI_PACKAGE_LABEL);
    },
  };
}

/**
 * The builtin definitions a pi CODING session really sends, in pi's
 * `createAllToolDefinitions` order. The provider-native background `bash`
 * shadow replaces pi's builtin definition on the wire and is priced as an app
 * eager tool, so it is deliberately absent here. The search builtins are the
 * ones `options.ts` unions in (`PI_SEARCH_BUILTIN_TOOLS`, Task-316). pi's `ls`
 * builtin is also absent: Task-319 replaced it with the app-side `ls` tool.
 * Assistant personas run `noTools: "builtin"` and have none.
 */
function piBuiltinDefinitions(cwd: string) {
  return [
    createReadToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
  ];
}

/**
 * pi's builtin tools for a coding-persona session, with only their
 * prompt-relevant fields (what lands in `buildSystemPrompt`).
 */
export function piBuiltinPromptTools(cwd: string): PiPromptTool[] {
  return piBuiltinDefinitions(cwd).map((tool) => ({
    name: tool.name,
    ...(tool.promptSnippet !== undefined
      ? { promptSnippet: tool.promptSnippet }
      : {}),
    ...(tool.promptGuidelines !== undefined
      ? { promptGuidelines: tool.promptGuidelines }
      : {}),
  }));
}

/**
 * The WIRE cost of those builtins: name + description + serialized schema, the
 * same three things the inventory counts for an app tool. pi's prompt carries
 * only their one-line snippets, so without this row the report would price a
 * builtin at a few dozen characters and miss the block entirely (Task-316).
 */
export function piBuiltinDefinitionChars(
  cwd: string,
): Array<{ name: string; chars: number }> {
  return piBuiltinDefinitions(cwd).map((tool) => ({
    name: tool.name,
    chars:
      tool.name.length +
      (tool.description?.length ?? 0) +
      JSON.stringify(tool.parameters).length,
  }));
}

/**
 * The `<project_context>` files pi loads for `cwd` (CLAUDE.md/AGENTS.md up the
 * ancestor chain). `agentDir` is pointed at a path that does not exist so the
 * measurement never picks up the measuring user's global context file.
 */
export function piProjectContextFiles(cwd: string): PiContextFile[] {
  return loadProjectContextFiles({
    cwd,
    agentDir: join(cwd, ".prompt-inventory-no-agent-dir"),
  });
}

/**
 * pi's own normalization of tool prompt extras (`AgentSession` collapses a
 * snippet to one line and de-duplicates guidelines before assembly). With app
 * tools carrying none, this now reduces to pi's unshadowed builtins.
 */
export function piPromptExtras(tools: PiPromptTool[]): {
  toolSnippets: Record<string, string>;
  promptGuidelines: string[];
} {
  const toolSnippets: Record<string, string> = {};
  const guidelines = new Set<string>();
  for (const tool of tools) {
    const snippet = tool.promptSnippet
      ?.replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (snippet) toolSnippets[tool.name] = snippet;
    for (const line of tool.promptGuidelines ?? []) {
      const normalized = line.trim();
      if (normalized.length > 0) guidelines.add(normalized);
    }
  }
  return { toolSnippets, promptGuidelines: [...guidelines] };
}
