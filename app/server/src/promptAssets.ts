/**
 * Prompt-asset resolution and its observability.
 *
 * Every persona system prompt is composed of LAYERS. Most are backed by tracked
 * markdown under {@link PROMPTS_DIR} (the persona file, `project-registry.md`
 * and the conditional integration sections); the rest are code constants built
 * in this process.
 *
 * Some layers are CONDITIONAL: they are included only when the session's frozen
 * {@link PromptConditions} say so (Task 287). The conditions are a session-START
 * decision made in `promptConditions.ts`; this module only reads them, and a
 * caller that passes none gets every section.
 *
 * There is NO fallback text: a tracked asset that cannot be read is a packaging
 * or installation defect, and silently substituting a built-in constant is what
 * shipped fallbacks for every persona in production for months (Task-262). A
 * missing asset therefore fails — at startup for the packaged directory
 * ({@link assertPromptAssets}), and at resolution time otherwise
 * ({@link PromptAssetError}).
 *
 * This module owns the resolution primitive AND the report over it, so the
 * resolved source of each layer is inspectable at startup
 * ({@link logPromptAssetDiagnostic}) and assertable in tests
 * ({@link promptAssetInventory}).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGED_PROMPTS_DIR, PROMPTS_DIR } from "./config.ts";
import { knowledgeBaseBehaviorGuidance } from "./knowledgeBasePrompt.ts";
import { memoryBehaviorGuidance } from "./memoryPrompt.ts";
import type { AgentType } from "@assistant/shared";
// Type-only: prompt-asset resolution stays free of the session store
// and the settings-backed integration gates that produce the conditions.
import type {
  PromptConditionKey,
  PromptConditions,
} from "./promptConditions.ts";

/**
 * Where a resolved prompt layer's text came from.
 *
 * - `file` — read from the tracked markdown asset (the only source for a
 *   file-backed layer; a miss throws rather than degrading).
 * - `builtin-code` — the layer has no file form; it is generated in code.
 */
type PromptLayerSource = "file" | "builtin-code";

/** One resolved prompt layer: where it came from and what it contributes. */
interface PromptLayerResolution {
  /** Stable layer id, e.g. `persona:developer`, `project-registry`. */
  id: string;
  source: PromptLayerSource;
  /** For file-backed layers: the path read, or the path looked for on a miss. */
  path?: string;
  /**
   * Characters this layer contributes to the composed prompt (the trimmed
   * text, which is what composition joins), not the raw file size.
   */
  chars: number;
  /** First 12 hex chars of the sha256 over the same contributed text. */
  hash: string;
}

/** Every layer of one persona's system prompt, in composition order. */
export interface PersonaPromptInventory {
  agentType: AgentType;
  layers: PromptLayerResolution[];
  /** Characters of the composed prompt (layers plus `\n\n` separators). */
  chars: number;
  hash: string;
}

export interface PromptAssetInventory {
  /** The directory file-backed layers resolved against. */
  promptsDir: string;
  personas: PersonaPromptInventory[];
}

/** Overrides for callers that must resolve against an explicit directory. */
export interface PromptAssetOptions {
  /** Defaults to {@link PROMPTS_DIR}. */
  promptsDir?: string;
  /**
   * The session's frozen conditional sections. Omitted (one-shot agents, the
   * measurement, tests) means EVERY conditional section is included, so a path
   * that does not know its session loses a saving rather than a rule.
   */
  conditions?: PromptConditions;
}

/** A tracked prompt asset was missing or unreadable — never recovered from. */
export class PromptAssetError extends Error {
  constructor(
    readonly path: string,
    /** `missing`, `unreadable (<errno code>)` or `empty`. */
    readonly problem: string,
    cause?: unknown,
  ) {
    super(
      `prompt asset ${problem}: ${path}. The tracked prompt assets ship with ` +
        `the application; check the installation or ASSISTANT_PROMPTS_DIR.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "PromptAssetError";
  }
}

/** The persona markdown asset each agent type resolves. */
const PERSONA_ASSET_FILES: Record<AgentType, string> = {
  assistant: "assistant.md",
  "personal-assistant": "personal-assistant.md",
  workshop: "workshop.md",
  developer: "developer.md",
  "workflow-coordinator": "workflow-coordinator.md",
};

/** Shared by every persona, after the persona layer. */
const PROJECT_REGISTRY_FILE = "project-registry.md";

/**
 * How a session shows a FILE instead of naming the path it wrote (Task 636).
 * Shared and unconditional for the chat personas: every one of them can write a
 * file or be handed one, and the URL form is the same for all of them.
 */
const CHAT_FILES_FILE = "chat-files.md";

/**
 * The math syntax the chat renderer accepts. Shared and unconditional for the
 * same reason as the images layer: any persona can end up writing a formula,
 * and an agent that does not know `$$` is supported writes LaTeX the renderer
 * shows as source text. `app/web/src/components/Markdown.tsx` is the other half
 * of this contract — the delimiters here are the ones it parses.
 */
const CHAT_MATH_FILE = "chat-math.md";

/**
 * A persona section that ships only when its condition holds. The persona lists
 * are the personas whose prompt CARRIED this text before it was made
 * conditional (Task 287 moved it out of their `.md` files unchanged in
 * substance, re-flowed from bullets into a section) — a section never reaches a
 * persona that did not have it.
 */
interface ConditionalAssetLayer {
  id: string;
  file: string;
  condition: PromptConditionKey;
  personas: readonly AgentType[];
}

const CONDITIONAL_ASSET_LAYERS: readonly ConditionalAssetLayer[] = [
  {
    id: "integration:slack",
    file: "integration-slack.md",
    condition: "slack",
    personas: ["assistant"],
  },
  {
    id: "integration:google",
    file: "integration-google.md",
    condition: "google",
    personas: ["assistant"],
  },
  {
    id: "integration:tempo",
    file: "integration-tempo.md",
    condition: "tempo",
    personas: ["personal-assistant"],
  },
];

/** Every tracked asset this server expects to load, for the startup report. */
export const TRACKED_PROMPT_ASSETS: readonly string[] = [
  ...Object.values(PERSONA_ASSET_FILES),
  PROJECT_REGISTRY_FILE,
  CHAT_FILES_FILE,
  CHAT_MATH_FILE,
  ...CONDITIONAL_ASSET_LAYERS.map((layer) => layer.file),
];

const ALL_AGENT_TYPES = Object.keys(PERSONA_ASSET_FILES) as AgentType[];

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

interface ResolvedLayer extends PromptLayerResolution {
  text: string;
}

function layerOf(
  id: string,
  text: string,
  source: PromptLayerSource,
  path?: string,
): ResolvedLayer {
  const trimmed = text.trim();
  return {
    id,
    source,
    ...(path ? { path } : {}),
    chars: trimmed.length,
    hash: hashOf(trimmed),
    text: trimmed,
  };
}

/**
 * Read one tracked asset, or throw the reason it cannot be served. This is the
 * SINGLE place an asset is judged usable, so the startup check
 * ({@link promptAssetProblems}) and session-time resolution cannot disagree.
 *
 * Whitespace-only content counts as unusable: composition trims and drops empty
 * layers, so it would remove the persona layer silently — the exact degradation
 * Task-291 exists to end.
 */
function readPromptAsset(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new PromptAssetError(
      path,
      code === "ENOENT" ? "missing" : `unreadable (${code ?? "?"})`,
      err,
    );
  }
  if (text.trim().length === 0) throw new PromptAssetError(path, "empty");
  return text;
}

/**
 * Read a prompt markdown asset fresh, so edits apply to the next new session.
 * A miss throws: there is no text we could substitute that would not be a
 * silent behavior change (Task-291).
 */
function resolveAsset(
  id: string,
  file: string,
  promptsDir: string,
): ResolvedLayer {
  const path = join(promptsDir, file);
  return layerOf(id, readPromptAsset(path), "file", path);
}

/**
 * The layers of a persona's system prompt, in composition order. The persona,
 * Project Registry and conditional integration layers are file-backed; the KB
 * and Memory layers are generated in code and have no file form.
 *
 * A layer whose condition is off is left OUT entirely — this is where a
 * session's saving comes from. An absent condition set includes everything.
 */
function personaLayers(
  agentType: AgentType,
  opts?: PromptAssetOptions,
): ResolvedLayer[] {
  const promptsDir = opts?.promptsDir ?? PROMPTS_DIR;
  const on = (key: PromptConditionKey): boolean =>
    opts?.conditions?.[key] ?? true;
  if (agentType === "workflow-coordinator")
    return [
      resolveAsset(
        `persona:${agentType}`,
        PERSONA_ASSET_FILES[agentType],
        promptsDir,
      ),
    ];
  return [
    resolveAsset(
      `persona:${agentType}`,
      PERSONA_ASSET_FILES[agentType],
      promptsDir,
    ),
    ...CONDITIONAL_ASSET_LAYERS.filter(
      (layer) => layer.personas.includes(agentType) && on(layer.condition),
    ).map((layer) => resolveAsset(layer.id, layer.file, promptsDir)),
    ...(on("projectRegistryPointer")
      ? [resolveAsset("project-registry", PROJECT_REGISTRY_FILE, promptsDir)]
      : []),
    resolveAsset("chat-files", CHAT_FILES_FILE, promptsDir),
    resolveAsset("chat-math", CHAT_MATH_FILE, promptsDir),
    layerOf("kb-guidance", knowledgeBaseBehaviorGuidance(), "builtin-code"),
    ...(on("memoryEnabled")
      ? [
          layerOf(
            "memory-guidance",
            // Undefined conditions fall back to the persona's own write capability
            // inside the guidance, so an unconditioned caller cannot turn a coding
            // session's read-only memory rules into write rules.
            memoryBehaviorGuidance(agentType, opts?.conditions?.memoryWrite),
            "builtin-code",
          ),
        ]
      : []),
  ];
}

/**
 * A persona's full system-prompt text (our appended extension + context
 * prompts). The harness-level additions — the pi/`claude_code` base prompt and
 * the permanent profile suffix — are applied by the option builders, not here.
 */
export function personaPromptText(
  agentType: AgentType,
  opts?: PromptAssetOptions,
): string {
  return personaLayers(agentType, opts)
    .map((l) => l.text)
    .filter(Boolean)
    .join("\n\n");
}

/** The resolved layers of one persona, without their text. */
export function personaPromptInventory(
  agentType: AgentType,
  opts?: PromptAssetOptions,
): PersonaPromptInventory {
  const layers = personaLayers(agentType, opts);
  const composed = layers
    .map((l) => l.text)
    .filter(Boolean)
    .join("\n\n");
  return {
    agentType,
    layers: layers.map(({ text: _text, ...layer }) => layer),
    chars: composed.length,
    hash: hashOf(composed),
  };
}

/**
 * Per-persona, per-layer resolution report: the source, size and hash of every
 * layer. Task-281's prompt inventory reads the source per layer from here.
 * Throws {@link PromptAssetError} if any tracked asset is missing.
 */
export function promptAssetInventory(
  opts?: PromptAssetOptions,
): PromptAssetInventory {
  return {
    promptsDir: opts?.promptsDir ?? PROMPTS_DIR,
    personas: ALL_AGENT_TYPES.map((t) => personaPromptInventory(t, opts)),
  };
}

/** One tracked asset a session would fail on, and why. */
export interface PromptAssetProblem {
  /** Asset file name, relative to the prompt directory. */
  file: string;
  /** `missing`, `unreadable (<errno code>)`, or `empty`. */
  problem: string;
}

/**
 * The tracked assets a prompt directory cannot serve, relative to it. The
 * non-throwing counterpart of resolution, for diagnostics and startup checks.
 *
 * It runs {@link readPromptAsset}, the same judgement session-time resolution
 * makes, because existence is not usability: a directory, an unreadable file or
 * an empty file at an asset path all exist, and a presence-only check would
 * report a healthy install and then fail (or silently drop) the persona layer of
 * the first session that needs it.
 */
export function promptAssetProblems(
  opts?: PromptAssetOptions,
): PromptAssetProblem[] {
  const promptsDir = opts?.promptsDir ?? PROMPTS_DIR;
  const problems: PromptAssetProblem[] = [];
  for (const file of [...TRACKED_PROMPT_ASSETS].sort()) {
    try {
      readPromptAsset(join(promptsDir, file));
    } catch (err) {
      if (!(err instanceof PromptAssetError)) throw err;
      problems.push({ file, problem: err.problem });
    }
  }
  return problems;
}

/**
 * The startup diagnostic lines. A tracked asset that cannot be served is a
 * broken install, so it is reported as a warning naming every affected file and
 * its problem; {@link assertPromptAssets} decides whether it is also fatal.
 */
export function promptAssetDiagnostic(opts?: PromptAssetOptions): {
  level: "info" | "warn";
  lines: string[];
} {
  const promptsDir = opts?.promptsDir ?? PROMPTS_DIR;
  const total = TRACKED_PROMPT_ASSETS.length;
  const problems = promptAssetProblems({ promptsDir });
  const origin =
    promptsDir === PACKAGED_PROMPTS_DIR
      ? "packaged"
      : "ASSISTANT_PROMPTS_DIR override";
  if (problems.length === 0)
    return {
      level: "info",
      lines: [
        `[prompts] resolved ${total}/${total} tracked prompt assets from ${promptsDir} (${origin})`,
      ],
    };
  return {
    level: "warn",
    lines: [
      `[prompts] ${problems.length}/${total} tracked prompt assets NOT USABLE under ${promptsDir} (${origin}): ` +
        `${describeProblems(problems)}; sessions using them cannot start`,
    ],
  };
}

function describeProblems(problems: PromptAssetProblem[]): string {
  return problems.map((p) => `${p.file} (${p.problem})`).join(", ");
}

/** Emit {@link promptAssetDiagnostic} at server startup. */
function logPromptAssetDiagnostic(opts?: PromptAssetOptions): void {
  const { level, lines } = promptAssetDiagnostic(opts);
  for (const line of lines)
    if (level === "warn") console.warn(line);
    else console.log(line);
}

/**
 * Startup gate over the tracked assets: every one is READ here, so anything a
 * session would fail on is caught before the server binds. A PACKAGED directory
 * with such a defect is a broken install and nothing this process serves would
 * be correct, so it throws. Under the `ASSISTANT_PROMPTS_DIR` development
 * override it warns instead: the user is editing those files and the failure
 * surfaces per session, so a half-written directory must not kill the server.
 *
 * `packagedDir` exists so a test can exercise both branches; the server passes
 * nothing.
 */
export function assertPromptAssets(opts?: {
  promptsDir?: string;
  packagedDir?: string;
}): void {
  const promptsDir = opts?.promptsDir ?? PROMPTS_DIR;
  const packagedDir = opts?.packagedDir ?? PACKAGED_PROMPTS_DIR;
  logPromptAssetDiagnostic({ promptsDir });
  const problems = promptAssetProblems({ promptsDir });
  if (problems.length === 0 || promptsDir !== packagedDir) return;
  throw new Error(
    `[prompts] packaged prompt assets are not usable at ${promptsDir}: ` +
      `${describeProblems(problems)}. Refusing to start with degraded persona prompts.`,
  );
}
