/**
 * The `claude-sdk` harness's model and thinking layer: the harness-wide
 * settings applied to EVERY run, the curated model list with its alias
 * normalization, and the mapping from a {@link ThinkingLevel} onto the SDK's
 * thinking shape.
 *
 * Split out of `./options.ts` because it is PERSONA-FREE. Helper runs
 * (`./oneShot.ts`) are reached from tool modules by contract
 * (`../tools/CLAUDE.md`), so their path must not drag in the persona registry —
 * which composes the tool catalog, which composes those very tool modules.
 */
import {
  CLAUDE_SDK_PROVIDER,
  type ModelOption,
  type ThinkingLevel,
} from "@assistant/shared";
import type { ClaudeSdkOptions, ClaudeSdkSettings } from "./sdkSeam.ts";

/**
 * How long the CLI keeps a native transcript under `CLAUDE_CONFIG_DIR` before
 * its own sweep deletes it. The native `.jsonl` is the ONLY thing a fork can be
 * cut from (`forkSession` copies from it), so the vendor default of 30 days
 * silently expires forkability — and a session's own uuid anchors with it.
 * Retention of PA-owned session data is PA's decision, so hold the file for ten
 * years and let the app's own deletion path be the one that removes it.
 */
const NATIVE_TRANSCRIPT_RETENTION_DAYS = 3650;

/**
 * The GLOBAL, harness-wide settings layer applied to every `claude-sdk` run —
 * interactive sessions and headless one-shot runs alike. Two decisions live
 * here: Claude's own native "auto-memory" is off, and native transcript
 * retention is PA's, not the CLI's.
 *
 * This app has its own first-class Memory system (the `memory_*` tools + the
 * memory domain), which is authoritative. Claude's separate on-disk auto-memory
 * store (default `~/.claude/projects/<cwd>/memory/`) would be redundant and
 * could diverge/conflict, so we disable both its reads/writes
 * (`autoMemoryEnabled`) and the background consolidation pass
 * (`autoDreamEnabled`). Applied as an inline flag-layer `settings` object — the
 * highest-priority user-controlled settings tier — so it holds regardless of
 * any on-disk `~/.claude` settings and independently of `settingSources`.
 */
export const CLAUDE_SDK_HARNESS_SETTINGS = {
  autoMemoryEnabled: false,
  autoDreamEnabled: false,
  cleanupPeriodDays: NATIVE_TRANSCRIPT_RETENTION_DAYS,
} as const satisfies ClaudeSdkSettings;

/**
 * Curated Claude SDK models. The picker advertises stable aliases (opus/sonnet/
 * haiku); the SDK is given the concrete model id because the in-process SDK takes
 * a concrete `--model` string.
 */
export const CLAUDE_SDK_MODELS: Array<ModelOption & { sdkModelId: string }> = [
  // Opus 5.5: same adaptive-thinking surface as Opus 5, a larger real context
  // window, and cheaper per token ($4/$20 per MTok against $5/$25). Like the
  // `fable` entry below, `opus` is an ALIAS re-resolved on every run, so
  // repointing it moves existing opus sessions onto 5.5 on their next turn —
  // accepted on resume with history retained, but the first turn re-reads the
  // transcript uncached because the prompt cache is per-model.
  //
  // `contextWindow` stays at the harness default: the CLI takes the 1M window
  // only through the explicit `claude-opus-5-5[1m]` id, and a session that
  // learns a different window reports it through `claudeSdkModelOption`.
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "opus",
    name: "Claude Opus",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
    sdkModelId: "claude-opus-5-5",
  },
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
    sdkModelId: "claude-sonnet-5",
  },
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "haiku",
    name: "Claude Haiku",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
    sdkModelId: "claude-haiku-4-5",
  },
  // Fable's thinking is ALWAYS on (see reasoningToThinking): the API rejects a
  // disabled/fixed-budget thinking config, so `off` is intentionally omitted
  // from its levels. 1M context window.
  //
  // The `fable` alias — not a concrete id — is what a session persists, and the
  // id is re-resolved on every run, resumes included. So repointing this
  // carries EXISTING fable sessions onto the new model on their next turn:
  // sound (the wire id is accepted on resume and history is retained) but it
  // re-reads the whole history uncached, because the prompt cache is
  // per-model. The Agent SDK's own `supportedModels()` does not advertise 5.1
  // yet; the explicit id is passed through to the API and honored.
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "fable",
    name: "Claude Fable",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
    contextWindow: 1_000_000,
    sdkModelId: "claude-fable-5-1",
  },
];

export type ClaudeSdkModelAlias = "opus" | "sonnet" | "haiku" | "fable";

/** Normalize a recognized Claude model id to one of our curated aliases. */
export function knownClaudeSdkModelAlias(
  id: string | undefined,
): ClaudeSdkModelAlias | undefined {
  if (!id) return undefined;
  const value = id.toLowerCase();
  if (value.includes("opus")) return "opus";
  if (value.includes("sonnet")) return "sonnet";
  if (value.includes("haiku")) return "haiku";
  if (value.includes("fable")) return "fable";
  return undefined;
}

/** Normalize arbitrary configuration input, defaulting unknown values to Sonnet. */
export function claudeSdkModelAlias(
  id: string | undefined,
): ClaudeSdkModelAlias {
  return knownClaudeSdkModelAlias(id) ?? "sonnet";
}

/** The curated model entry for an alias/id (defaults to sonnet). */
function claudeSdkModel(
  id: string | undefined,
): ModelOption & { sdkModelId: string } {
  const alias = claudeSdkModelAlias(id);
  return CLAUDE_SDK_MODELS.find((m) => m.id === alias) ?? CLAUDE_SDK_MODELS[1]!;
}

/** The concrete SDK `--model` string for an alias/id. */
export function claudeSdkModelId(id: string | undefined): string {
  return claudeSdkModel(id).sdkModelId;
}

/**
 * A {@link ModelOption} for the picker, given an alias/id. An optional
 * `contextWindow` override lets the session report the real provider window
 * (e.g. 1M for Sonnet[1m]) once it's learned from a `result` message, instead of
 * the curated 200k default.
 */
export function claudeSdkModelOption(
  id: string | undefined,
  contextWindow?: number,
): ModelOption {
  const { sdkModelId: _sdkModelId, ...option } = claudeSdkModel(id);
  return contextWindow ? { ...option, contextWindow } : option;
}

/** Approximate per-level thinking token budget (used for the `enabled` shape). */
const CLAUDE_THINKING_BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16_384,
  xhigh: 32_768,
  // `max` is pi-only in the picker; degrade defensively if received here.
  max: 32_768,
};

/**
 * THINKING OPTION SHAPE — per-model, settled against the installed SDK types and
 * each model's actual API constraints (see the adaptive/extended-thinking docs).
 *
 * The installed `@anthropic-ai/claude-agent-sdk` v0.3.281 `Options` accepts a
 * `thinking: ThinkingConfig` ({type:"adaptive",display?} | {type:"enabled",budgetTokens,display?}
 * | {type:"disabled"}) plus a separate `effort: EffortLevel`, and forwards them
 * to the CLI as `--thinking` / `--thinking-display` / `--max-thinking-tokens` /
 * `--effort`.
 *
 * Policy:
 *  - Opus 5.5 / Sonnet 5 / Fable 5 use ADAPTIVE thinking with `effort` and
 *    `display:"summarized"` so summaries stream (mirrors the pi harness). These
 *    models REJECT a fixed `budgetTokens` (400), so we never send one. Fable
 *    can't disable thinking (400) — its `off` becomes lowest-effort adaptive;
 *    Opus/Sonnet honor `off` as {type:"disabled"}.
 *  - Haiku 4.5 predates adaptive thinking: it can only think via a manual
 *    `budgetTokens` and REJECTS the `effort` parameter. It stays on manual mode
 *    (still `display:"summarized"`), never adaptive/effort.
 */
export function reasoningToThinking(
  level: ThinkingLevel,
  modelId?: string,
): Pick<ClaudeSdkOptions, "thinking" | "effort"> {
  const alias = claudeSdkModelAlias(modelId);
  if (alias === "haiku") {
    if (level === "off") return { thinking: { type: "disabled" } };
    return {
      thinking: {
        type: "enabled",
        budgetTokens: CLAUDE_THINKING_BUDGETS[level],
        display: "summarized",
      },
    };
  }
  // Opus/Sonnet honor `off` as disabled; Fable's thinking is always on.
  if (level === "off" && alias !== "fable") {
    return { thinking: { type: "disabled" } };
  }
  const effortLevel = level === "off" ? "low" : level;
  return {
    thinking: { type: "adaptive", display: "summarized" },
    effort: thinkingLevelToEffort(effortLevel),
  };
}

function thinkingLevelToEffort(
  level: Exclude<ThinkingLevel, "off">,
): NonNullable<ClaudeSdkOptions["effort"]> {
  switch (level) {
    case "medium":
    case "high":
    case "xhigh":
      return level;
    case "max":
      return "xhigh";
    case "minimal":
    case "low":
    default:
      return "low";
  }
}
