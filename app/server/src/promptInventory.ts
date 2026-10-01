/**
 * Task 281: the per-persona, per-layer prompt and tool-schema inventory.
 *
 * This is the sub-epic's measurement instrument: for every persona on BOTH
 * harnesses it reports how many characters each prompt layer and each part of
 * the tool block contributes to a session's first request, and which source
 * each layer resolved from (tracked file vs code-built vs vendor-owned).
 *
 * ## Characters, not tokens (decided for Task-281)
 *
 * Every number here is CHARACTERS. Characters are the input we control and the
 * only unit a committed budget (Task-288) can assert deterministically; a token
 * count needs a tokenizer we do not have offline — Claude's is not published,
 * and a GPT BPE would be a different model's answer wearing ours. The caveat
 * when reading the table: JSON schema text tokenizes denser than prose, so the
 * schema rows are worth relatively MORE tokens than their character share
 * suggests. Comparisons across layers here are character comparisons.
 *
 * ## How the numbers are obtained
 *
 * Prompt layers are measured by DIFFING real assemblies, never by summing
 * hand-copied constants: pi's own `buildSystemPrompt` is called with the inputs
 * `piSdk/options.ts` gives it, once per variant, and each layer is the delta
 * between two variants. The counted prompt rows therefore reconcile exactly to
 * the assembled prompt length (`reconciled`), which the tests assert.
 *
 * ## What is deliberately NOT counted
 *
 * - The `claude_code` preset: expanded inside the vendor CLI and not visible
 *   in-process. Reported as an uncounted marker, so the Claude totals are "our
 *   contribution", not the model's full context.
 * - Claude's NATIVE tool definitions (`CLAUDE_SDK_NATIVE_TOOLS`), for the same
 *   reason: they ship inside the CLI. pi's builtin definitions ARE counted
 *   (`tools:eager:harness-builtin`) because we construct them here, so the pi
 *   coding totals include a vendor block the Claude ones cannot.
 * - Skills and the agent-dir global context file: excluded so a baseline does
 *   not depend on the measuring machine's `~/.pi`.
 * - Integration gates: the tool universe is measured UNGATED, so the numbers do
 *   not move with the measuring user's Settings.
 * - Project-context files outside the measured cwd: listed, never counted, for
 *   the same reproducibility reason.
 *
 * Two absolute paths pi embeds in the prompt are NORMALIZED rather than
 * excluded, because the text around them is real and the paths themselves are
 * not the machine's business: the working directory (the caller's `cwdLabel`)
 * and pi's own install directory
 * ({@link import("./piSdk/piPromptMeasure.ts").PI_PACKAGE_LABEL}). Without that, the
 * same commit measures differently in a CI container than in a developer's
 * checkout and the committed baseline is unusable as a tripwire.
 */
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TYPES, type AgentType } from "./agentTypes.ts";
import {
  claudeSdkSystemPrompt,
  CLAUDE_SDK_NATIVE_TOOLS,
} from "./claudeSdk/options.ts";
import { PROMPTS_DIR } from "./config.ts";
import { MCP_SERVER_NAME, FIND_TOOLS_NAME } from "./mcp/names.ts";
import type { AgentTool } from "./mcp/tool.ts";
import { permanentAssistantProfileInstructions } from "./permanentAssistantProfile.ts";
import {
  loadPiPromptBuilder,
  piBuiltinDefinitionChars,
  piBuiltinPromptTools,
  piProjectContextFiles,
  piPromptExtras,
  type PiContextFile,
  type PiPromptBuilder,
  type PiPromptInput,
  type PiPromptTool,
} from "./piSdk/piPromptMeasure.ts";
import { PI_BACKGROUND_TOOL_DEFINITIONS } from "./piSdk/backgroundWorkToolDefinitions.ts";
import {
  personaPromptInventory,
  personaPromptText,
  type PersonaPromptInventory,
} from "./promptAssets.ts";
import {
  maximalPromptConditions,
  PROMPT_CONDITION_KEYS,
  type PromptConditionKey,
  type PromptConditions,
} from "./promptConditions.ts";
import { eagerToolNamesFor, toolGroupsFor } from "./tools/catalog.ts";
import { createFindToolsTool } from "./tools/findTools.ts";

/** This checkout's root, independent of `ASSISTANT_CWD`. */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** This checkout's tracked prompt assets, independent of `ASSISTANT_CWD`. */
export const REPO_PROMPTS_DIR = fileURLToPath(
  new URL("../../../config/prompts", import.meta.url),
);

export type InventoryHarness = "pi" | "claude";

export const INVENTORY_HARNESSES: readonly InventoryHarness[] = [
  "pi",
  "claude",
];

/** Which block of the first request a layer belongs to. */
export type InventorySection = "prompt" | "tools";

/** One measured layer of one persona's first request. */
export interface InventoryLayer {
  id: string;
  section: InventorySection;
  chars: number;
  /**
   * Where the layer's text came from: a tracked file path, `builtin-code`, a
   * vendor marker, or `catalog` for tool-derived rows.
   */
  source: string;
  /**
   * False for rows that are reported but excluded from the totals: vendor text
   * we cannot measure, and text that never reaches the model.
   */
  counted: boolean;
  note?: string;
}

export interface PersonaInventory {
  agentType: AgentType;
  harness: InventoryHarness;
  layers: InventoryLayer[];
  /** Counted prompt rows: the system prompt we contribute. */
  promptChars: number;
  /** Counted tool rows: the eager tool block. */
  eagerToolChars: number;
  /** `promptChars + eagerToolChars` — what every first request carries. */
  firstRequestChars: number;
  /**
   * The assembled prompt's real length. The counted prompt rows are derived
   * from it by subtraction, so a mismatch is a measurement bug, not a finding.
   */
  assembledPromptChars: number;
  reconciled: boolean;
}

/**
 * What ONE session-start condition costs the sessions that carry it: the
 * measured saving for a session that does not (Task 287). Reported per persona
 * and harness because the eager tool block is wire-named per harness.
 */
interface ConditionSaving {
  agentType: AgentType;
  harness: InventoryHarness;
  condition: PromptConditionKey;
  /** Prompt characters dropped when the condition is off. */
  promptChars: number;
  /** Eager tool-block characters (name + description + schema) dropped. */
  toolChars: number;
  /** `promptChars + toolChars` — what the first request loses. */
  chars: number;
}

export interface PromptInventoryReport {
  /** Directory the file-backed prompt layers resolved against. */
  promptsDir: string;
  /**
   * Working directory the measured prompt was built with — the real cwd, or
   * the {@link PromptInventoryOptions.cwdLabel} it was normalized to.
   */
  cwd: string;
  /** The pi module the measurement read `buildSystemPrompt` from. */
  piPromptModulePath: string;
  /** Project-context files counted for the coding personas. */
  countedContextFiles: string[];
  /** Context files pi would also load here, excluded for reproducibility. */
  excludedContextFiles: string[];
  personas: PersonaInventory[];
  /**
   * Per-persona, per-condition savings. The `personas` rows above are measured
   * with every conditional section ON, so these are what a real session takes
   * OFF that maximum.
   */
  conditionSavings: ConditionSaving[];
}

export interface PromptInventoryOptions {
  /** Defaults to {@link PROMPTS_DIR} — what this process itself would ship. */
  promptsDir?: string;
  /** Defaults to {@link REPO_ROOT}. */
  cwd?: string;
  /**
   * Measure as if `cwd` were this path. The working directory reaches the
   * prompt twice — pi's own cwd line and the `<project_context>` file path — so
   * an un-normalized run counts the checkout's own path length twice over: a
   * machine-dependent number a committed budget cannot assert (Task 288). The
   * tool block is unaffected; pi's builtin descriptions do not carry the cwd.
   * Context files are still discovered at the real `cwd`; only their reported
   * paths are rebased onto the label.
   */
  cwdLabel?: string;
}

const CODING_PERSONAS = new Set<AgentType>(["workshop", "developer"]);

/** Measured with the DEFAULT profile: no user data in a committed baseline. */
const DEFAULT_PROFILE_INSTRUCTIONS = permanentAssistantProfileInstructions({
  name: "Personal Assistant",
  provider: "",
  modelId: "",
  thinkingLevel: "off",
  additionalInstructions: "",
});

function piBackgroundMeasurementTools() {
  return PI_BACKGROUND_TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    execute: () => Promise.reject(new Error("measurement-only tool")),
  }));
}

/** The persona's tools split by loading tier (integration gates NOT applied). */
function toolsByTier(
  agentType: AgentType,
  harness: InventoryHarness,
): {
  eager: AgentTool[];
  deferred: AgentTool[];
} {
  const eagerNames = eagerToolNamesFor(agentType);
  const eager: AgentTool[] = [];
  const deferred: AgentTool[] = [];
  for (const group of toolGroupsFor(agentType))
    for (const tool of group.tools)
      (eagerNames.has(tool.name) ? eager : deferred).push(tool);
  if (harness === "pi" && CODING_PERSONAS.has(agentType))
    eager.push(...piBackgroundMeasurementTools());
  return { eager, deferred };
}

/** Characters the eager tool block costs under one condition set. */
function eagerToolBlockChars(
  agentType: AgentType,
  harness: InventoryHarness,
  conditions: PromptConditions,
): number {
  const eagerNames = eagerToolNamesFor(agentType, conditions);
  const tools = toolGroupsFor(agentType)
    .flatMap((group) => group.tools)
    .filter((tool) => eagerNames.has(tool.name));
  if (harness === "pi" && CODING_PERSONAS.has(agentType))
    tools.push(...piBackgroundMeasurementTools());
  return sum(
    tools,
    (tool) =>
      (harness === "claude"
        ? `mcp__${MCP_SERVER_NAME}__${tool.name}`
        : tool.name
      ).length +
      tool.description.length +
      JSON.stringify(tool.parameters).length,
  );
}

/**
 * What each session-start condition contributes to this persona's first
 * request, measured by assembling the prompt and the eager tool block WITH and
 * WITHOUT it. A condition the persona never carries (a Slack paragraph for a
 * coding persona, the memory write rules for one that may not write) produces
 * no row.
 */
function conditionSavingsFor(
  agentType: AgentType,
  promptsDir: string,
): ConditionSaving[] {
  const maximal = maximalPromptConditions(agentType);
  const basePromptChars = personaPromptText(agentType, {
    promptsDir,
    conditions: maximal,
  }).length;
  const rows: ConditionSaving[] = [];
  for (const condition of PROMPT_CONDITION_KEYS) {
    if (!maximal[condition]) continue;
    const without = { ...maximal, [condition]: false };
    const promptChars =
      basePromptChars -
      personaPromptText(agentType, { promptsDir, conditions: without }).length;
    for (const harness of INVENTORY_HARNESSES) {
      const toolChars =
        eagerToolBlockChars(agentType, harness, maximal) -
        eagerToolBlockChars(agentType, harness, without);
      if (promptChars === 0 && toolChars === 0) continue;
      rows.push({
        agentType,
        harness,
        condition,
        promptChars,
        toolChars,
        chars: promptChars + toolChars,
      });
    }
  }
  return rows;
}

/** A `find_tools` instance to measure (pi appends one to every session). */
function measurementFindTools(agentType: AgentType): AgentTool {
  const none: ReadonlySet<string> = new Set();
  return createFindToolsTool({
    agentType,
    usableToolNames: () => none,
    activeToolNames: () => none,
    activate: () => [],
  });
}

function sum(tools: AgentTool[], of: (tool: AgentTool) => number): number {
  return tools.reduce((n, tool) => n + of(tool), 0);
}

/**
 * The harness's OWN tool definitions in the first request — the block that is
 * not ours and not in the prompt (pi's prompt carries only their one-line
 * snippets, so the `pi-tool-list:builtin` row prices them at a few dozen chars).
 * pi's are measurable because we construct them ourselves; Claude's native ones
 * ship inside the CLI (extracted from bunfs at runtime, absent from the SDK
 * package), so that row is honestly zero-and-uncounted rather than guessed.
 */
function builtinToolRow(
  agentType: AgentType,
  harness: InventoryHarness,
  cwd: string,
): InventoryLayer {
  const isCoding = CODING_PERSONAS.has(agentType);
  if (harness === "claude")
    return {
      id: "tools:eager:harness-builtin",
      section: "tools",
      chars: 0,
      source: "vendor (Claude CLI)",
      counted: false,
      note: isCoding
        ? `${CLAUDE_SDK_NATIVE_TOOLS.join(", ")} — definitions live inside the CLI and are NOT measurable in-process`
        : "assistant personas expose no native tools",
    };
  const builtins = isCoding ? piBuiltinDefinitionChars(cwd) : [];
  return {
    id: "tools:eager:harness-builtin",
    section: "tools",
    chars: builtins.reduce((n, tool) => n + tool.chars, 0),
    source: "vendor (pi builtin definitions)",
    counted: true,
    note: isCoding
      ? builtins.map((tool) => `${tool.name} ${tool.chars}`).join(", ")
      : 'assistant personas run noTools: "builtin"',
  };
}

/** The tool-block rows for one harness. */
function toolLayers(
  agentType: AgentType,
  harness: InventoryHarness,
  cwd: string,
): InventoryLayer[] {
  const { eager, deferred } = toolsByTier(agentType, harness);
  // pi appends find_tools to every deferring session; Claude uses its native
  // tool search instead and never lists it.
  const eagerTools =
    harness === "pi" ? [...eager, measurementFindTools(agentType)] : eager;
  // Both harnesses now ship a deferred tool as name + description + schema:
  // there are no prompt extras left to fold in for pi (Task-282).
  const deferredTools = deferred;
  const wireName = (tool: AgentTool) =>
    harness === "claude" ? `mcp__${MCP_SERVER_NAME}__${tool.name}` : tool.name;

  return [
    {
      id: "tools:eager:names",
      section: "tools",
      chars: sum(eagerTools, (t) => wireName(t).length),
      source: "catalog",
      counted: true,
      note: `${eagerTools.length} eager tools${harness === "pi" ? " (incl. find_tools)" : ""}`,
    },
    {
      id: "tools:eager:descriptions",
      section: "tools",
      chars: sum(eagerTools, (t) => t.description.length),
      source: "catalog",
      counted: true,
    },
    {
      id: "tools:eager:schemas",
      section: "tools",
      chars: sum(eagerTools, (t) => JSON.stringify(t.parameters).length),
      source: "catalog",
      counted: true,
    },
    builtinToolRow(agentType, harness, cwd),
    {
      id: "tools:deferred:universe",
      section: "tools",
      chars: sum(
        deferredTools,
        (t) =>
          wireName(t).length +
          t.description.length +
          JSON.stringify(t.parameters).length,
      ),
      source: "catalog",
      counted: false,
      note: `${deferredTools.length} deferred tools — reaches the model only on activation/search`,
    },
  ];
}

/** Persona-file / registry / KB / memory rows, from the resolution report. */
function personaLayerRows(inventory: PersonaPromptInventory): InventoryLayer[] {
  return inventory.layers.map((layer) => ({
    id: layer.id,
    section: "prompt" as const,
    chars: layer.chars,
    source: layer.source === "file" ? (layer.path ?? "file") : "builtin-code",
    counted: true,
  }));
}

/** The permanent-profile suffix row (only the singleton carries one). */
function profileRow(agentType: AgentType): InventoryLayer {
  const applies = agentType === "personal-assistant";
  return {
    id: "profile-suffix",
    section: "prompt",
    chars: applies ? DEFAULT_PROFILE_INSTRUCTIONS.length : 0,
    source: applies ? "settings (default profile)" : "n/a",
    counted: true,
    note: applies
      ? "default profile only; the user's additionalInstructions add to this"
      : "only the permanent personal-assistant carries a profile suffix",
  };
}

/**
 * Whatever assembly adds around the layers: separators, the profile heading,
 * the `<project_context>` framing. Derived as the remainder, so the counted
 * rows always reconcile to the real assembled length instead of drifting.
 */
function assemblyOverheadRow(
  assembledChars: number,
  layers: InventoryLayer[],
): InventoryLayer {
  const counted = layers
    .filter((l) => l.counted && l.section === "prompt")
    .reduce((n, l) => n + l.chars, 0);
  return {
    id: "assembly-overhead",
    section: "prompt",
    chars: assembledChars - counted,
    source: "composition",
    counted: true,
    note: "layer separators and section framing added by prompt assembly",
  };
}

/** The `Pi documentation` block inside pi's default prompt, if still present. */
const PI_DOCS_MARKER = "\nPi documentation (read only when the user asks";

/** The close of pi's `<docs>` section, which ends that block since pi 0.87. */
const PI_DOCS_END = "\n</docs>";

function piDocsChars(base: string): number | undefined {
  const at = base.indexOf(PI_DOCS_MARKER);
  if (at < 0) return undefined;
  const end = base.lastIndexOf(PI_DOCS_END);
  return (end > at ? end : base.length) - at;
}

/** Prompt rows for a pi coding session (pi's default prompt is kept). */
function piCodingLayers(
  agentType: AgentType,
  resolution: PersonaPromptInventory,
  build: (input: PiPromptInput) => string,
  full: PiPromptInput,
  builtinExtras: ReturnType<typeof piPromptExtras>,
): InventoryLayer[] {
  // `bare` is `full` WITHOUT the appended system prompt, so the key has to be
  // removed rather than merely left unset — spreading `full` would carry it.
  const { appendSystemPrompt: _strippedPrompt, ...withoutAppend } = full;
  const bare: PiPromptInput = {
    ...withoutAppend,
    contextFiles: [],
    toolSnippets: {},
    promptGuidelines: [],
  };
  const base = build(bare);
  const snippetsBuiltin = build({
    ...bare,
    toolSnippets: builtinExtras.toolSnippets,
  });
  const snippetsAll = build({ ...bare, toolSnippets: full.toolSnippets });
  const guidelinesBuiltin = build({
    ...bare,
    toolSnippets: full.toolSnippets,
    promptGuidelines: builtinExtras.promptGuidelines,
  });
  const guidelinesAll = build({
    ...bare,
    toolSnippets: full.toolSnippets,
    promptGuidelines: full.promptGuidelines,
  });
  const withPersona = build({ ...full, contextFiles: [] });
  const assembled = build(full);

  const docs = piDocsChars(base);
  const layers: InventoryLayer[] = [
    {
      id: "harness-base",
      section: "prompt",
      chars: base.length,
      source: "vendor (pi buildSystemPrompt)",
      counted: true,
      note: "identity + empty tool list + bridge sentence + pi's own guidelines + pi docs + cwd line",
    },
    {
      id: "harness-base:pi-docs",
      section: "prompt",
      chars: docs ?? 0,
      source: "vendor (pi buildSystemPrompt)",
      counted: false,
      note: docs
        ? "sub-row of harness-base: pi's documentation-paths block"
        : "sub-row NOT FOUND — pi's default prompt changed shape",
    },
    {
      id: "pi-tool-list:builtin",
      section: "prompt",
      chars: snippetsBuiltin.length - base.length,
      source: "vendor (pi builtin promptSnippet)",
      counted: true,
    },
    {
      id: "pi-tool-list:app-eager",
      section: "prompt",
      chars: snippetsAll.length - snippetsBuiltin.length,
      source: "catalog (AgentTool.promptSnippet)",
      counted: true,
    },
    {
      id: "pi-guidelines:builtin",
      section: "prompt",
      chars: guidelinesBuiltin.length - snippetsAll.length,
      source: "vendor (pi builtin promptGuidelines)",
      counted: true,
    },
    {
      id: "pi-guidelines:app-eager",
      section: "prompt",
      chars: guidelinesAll.length - guidelinesBuiltin.length,
      source: "catalog (AgentTool.promptGuidelines)",
      counted: true,
    },
    ...personaLayerRows(resolution),
    profileRow(agentType),
    {
      id: "project-context",
      section: "prompt",
      chars: assembled.length - withPersona.length,
      source: full.contextFiles.map((f) => f.path).join(", ") || "none",
      counted: true,
      note: "<project_context> wrapper + the counted context files",
    },
  ];
  layers.push(assemblyOverheadRow(assembled.length, layers));
  return layers;
}

/**
 * Prompt rows for a pi assistant session. `buildSystemPrompt` returns early on
 * `customPrompt`, so pi's default prompt, its tool list and ALL tool guidance
 * are absent — the zero rows are the finding, not a gap in the measurement.
 */
function piAssistantLayers(
  agentType: AgentType,
  resolution: PersonaPromptInventory,
  build: (input: PiPromptInput) => string,
  full: PiPromptInput,
): InventoryLayer[] {
  const assembled = build(full);
  const layers: InventoryLayer[] = [
    {
      id: "harness-base",
      section: "prompt",
      chars: assembled.length - (full.customPrompt?.length ?? 0),
      source: "vendor (pi buildSystemPrompt)",
      counted: true,
      note: "customPrompt branch: pi's default prompt is replaced; only the cwd line remains",
    },
    {
      id: "harness-base:pi-docs",
      section: "prompt",
      chars: 0,
      source: "vendor (pi buildSystemPrompt)",
      counted: false,
      note: "not rendered on the customPrompt branch",
    },
    ...(
      [
        "pi-tool-list:builtin",
        "pi-tool-list:app-eager",
        "pi-guidelines:builtin",
        "pi-guidelines:app-eager",
      ] as const
    ).map((id) => ({
      id,
      section: "prompt" as const,
      chars: 0,
      source: "catalog",
      counted: true,
      note: "dropped: buildSystemPrompt returns early on customPrompt",
    })),
    ...personaLayerRows(resolution),
    profileRow(agentType),
    {
      id: "project-context",
      section: "prompt",
      chars: 0,
      source: "none",
      counted: true,
      note: "noContextFiles: the assistant personas load no project context",
    },
  ];
  layers.push(assemblyOverheadRow(assembled.length, layers));
  return layers;
}

/** Prompt rows for a Claude session of this persona. */
function claudeLayers(
  agentType: AgentType,
  resolution: PersonaPromptInventory,
  assembledChars: number,
  isCoding: boolean,
  claudeMd: PiContextFile | undefined,
): InventoryLayer[] {
  const layers: InventoryLayer[] = [
    {
      id: "harness-base",
      section: "prompt",
      chars: 0,
      source: "vendor (claude_code preset)",
      counted: false,
      note: isCoding
        ? "claude_code preset: expanded inside the vendor CLI, not measurable in-process"
        : "no preset: the assistant personas send our prompt as-is",
    },
    ...personaLayerRows(resolution),
    profileRow(agentType),
    {
      id: "project-context",
      section: "prompt",
      chars: isCoding ? (claudeMd?.content.length ?? 0) : 0,
      source: isCoding ? (claudeMd?.path ?? "none") : "none",
      counted: false,
      note: isCoding
        ? "read by the vendor CLI with vendor-owned framing — file size is informational"
        : "the assistant personas run without project context",
    },
  ];
  layers.push(assemblyOverheadRow(assembledChars, layers));
  return layers;
}

function finish(
  agentType: AgentType,
  harness: InventoryHarness,
  layers: InventoryLayer[],
  assembledPromptChars: number,
): PersonaInventory {
  const promptChars = layers
    .filter((l) => l.counted && l.section === "prompt")
    .reduce((n, l) => n + l.chars, 0);
  const eagerToolChars = layers
    .filter((l) => l.counted && l.section === "tools")
    .reduce((n, l) => n + l.chars, 0);
  return {
    agentType,
    harness,
    layers,
    promptChars,
    eagerToolChars,
    firstRequestChars: promptChars + eagerToolChars,
    assembledPromptChars,
    reconciled: promptChars === assembledPromptChars,
  };
}

/** Measure one persona on both harnesses. */
function personaInventories(
  agentType: AgentType,
  builder: PiPromptBuilder,
  promptsDir: string,
  cwd: string,
  contextFiles: PiContextFile[],
): PersonaInventory[] {
  const isCoding = CODING_PERSONAS.has(agentType);
  // Measured with every conditional section ON: the report's totals are the
  // maximum a session of this persona can carry, and `conditionSavings` says
  // what each condition takes off it (Task 287).
  const conditions = maximalPromptConditions(agentType);
  const resolution = personaPromptInventory(agentType, {
    promptsDir,
    conditions,
  });
  const personaText = personaPromptText(agentType, { promptsDir, conditions });
  const profileSuffix =
    agentType === "personal-assistant" ? DEFAULT_PROFILE_INSTRUCTIONS : "";

  const { eager } = toolsByTier(agentType, "pi");
  const builtins: PiPromptTool[] = isCoding ? piBuiltinPromptTools(cwd) : [];
  const eagerPromptTools: PiPromptTool[] = [
    ...eager,
    measurementFindTools(agentType),
  ];
  const builtinExtras = piPromptExtras(builtins);
  const allExtras = piPromptExtras([...builtins, ...eagerPromptTools]);

  const full: PiPromptInput = {
    cwd,
    // The assistant personas replace pi's prompt; the coding ones append to it.
    ...(!isCoding
      ? {
          customPrompt: profileSuffix
            ? `${personaText}\n\n## Personal profile instructions\n\n${profileSuffix}`
            : personaText,
        }
      : {}),
    ...(isCoding ? { appendSystemPrompt: personaText } : {}),
    contextFiles: isCoding ? contextFiles : [],
    selectedTools: [
      ...builtins.map((t) => t.name),
      ...eager.map((t) => t.name),
      FIND_TOOLS_NAME,
    ],
    toolSnippets: allExtras.toolSnippets,
    promptGuidelines: allExtras.promptGuidelines,
  };
  const build = (input: PiPromptInput) => builder.build(input);

  const piLayers = isCoding
    ? piCodingLayers(agentType, resolution, build, full, builtinExtras)
    : piAssistantLayers(agentType, resolution, build, full);

  const claudePrompt = claudeSdkSystemPrompt(agentType, profileSuffix, {
    promptsDir,
    conditions,
  });
  // A string for the assistant personas; the `claude_code` preset with our
  // extension in `append` for the coding ones.
  const claudeOurs =
    typeof claudePrompt === "string"
      ? claudePrompt
      : Array.isArray(claudePrompt)
        ? claudePrompt.join("\n\n")
        : claudePrompt.type === "preset"
          ? (claudePrompt.append ?? "")
          : [claudePrompt.prompt].flat().join("\n\n");

  return [
    finish(
      agentType,
      "pi",
      [...piLayers, ...toolLayers(agentType, "pi", cwd)],
      build(full).length,
    ),
    finish(
      agentType,
      "claude",
      [
        ...claudeLayers(
          agentType,
          resolution,
          claudeOurs.length,
          isCoding,
          contextFiles.at(-1),
        ),
        ...toolLayers(agentType, "claude", cwd),
      ],
      claudeOurs.length,
    ),
  ];
}

/** Measure every persona on both harnesses. */
export async function promptInventory(
  options?: PromptInventoryOptions,
): Promise<PromptInventoryReport> {
  const promptsDir = options?.promptsDir ?? PROMPTS_DIR;
  const cwd = options?.cwd ?? REPO_ROOT;
  const builder = await loadPiPromptBuilder();

  const available = piProjectContextFiles(cwd);
  const counted = available.filter((f) => f.path.startsWith(cwd));
  const excluded = available.filter((f) => !f.path.startsWith(cwd));

  // Everything the measurement hands to pi uses the label when one is given.
  const label = options?.cwdLabel;
  const measuredCwd = label ?? cwd;
  const measuredFiles = label
    ? counted.map((file) => ({
        ...file,
        path: join(label, relative(cwd, file.path)),
      }))
    : counted;

  return {
    promptsDir,
    cwd: measuredCwd,
    piPromptModulePath: builder.modulePath,
    countedContextFiles: measuredFiles.map((f) => f.path),
    excludedContextFiles: excluded.map((f) => f.path),
    personas: (Object.keys(AGENT_TYPES) as AgentType[]).flatMap((agentType) =>
      personaInventories(
        agentType,
        builder,
        promptsDir,
        measuredCwd,
        measuredFiles,
      ),
    ),
    conditionSavings: (Object.keys(AGENT_TYPES) as AgentType[]).flatMap(
      (agentType) => conditionSavingsFor(agentType, promptsDir),
    ),
  };
}
