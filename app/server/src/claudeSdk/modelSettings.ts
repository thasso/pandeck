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
 * store (default `<CLAUDE_CONFIG_DIR>/projects/<cwd>/memory/`) would be redundant and
 * could diverge/conflict, so we disable both its reads/writes
 * (`autoMemoryEnabled`) and the background consolidation pass
 * (`autoDreamEnabled`). Applied as an inline flag-layer `settings` object — the
 * highest-priority user-controlled settings tier — so it holds regardless of
 * any on-disk settings in the account's config directory and independently of
 * `settingSources`.
 */
export const CLAUDE_SDK_HARNESS_SETTINGS = {
  autoMemoryEnabled: false,
  autoDreamEnabled: false,
  cleanupPeriodDays: NATIVE_TRANSCRIPT_RETENTION_DAYS,
} as const satisfies ClaudeSdkSettings;

/**
 * A curated Claude model: the alias the picker advertises and a session
 * persists, plus the concrete ids it can run. The in-process SDK takes a
 * concrete `--model` string, chosen per account (`./modelResolution.ts`).
 */
export type CuratedClaudeModel = ModelOption & {
  /**
   * The concrete ids this alias runs, newest first. An account runs the first
   * one its model listing names; the first is also the account-free default.
   */
  sdkModelIds: readonly [string, ...string[]];
  /**
   * Whether an account whose listing is unknown (no successful read, gateway
   * off) may run this alias. False for an entitlement-gated model: it runs
   * only where a listing names one of its ids.
   */
  offeredWhenUnknown: boolean;
};

/**
 * Curated Claude SDK models. The picker advertises stable aliases (opus/sonnet/
 * haiku/fable/mythos); each run resolves the concrete id on its account.
 */
export const CLAUDE_SDK_MODELS: CuratedClaudeModel[] = [
  // Opus 5.5: same adaptive-thinking surface as Opus 5, a larger real context
  // window, and cheaper per token ($4/$20 per MTok against $5/$25). Like the
  // `fable` entry below, `opus` is an ALIAS re-resolved on every run, so
  // repointing it moves existing opus sessions onto 5.5 on their next turn —
  // accepted on resume with history retained, but the first turn re-reads the
  // transcript uncached because the prompt cache is per-model.
  //
  // Opus 5.5 runs with a 1M window under the plain id: sessions report 1M, so
  // the compaction-window range reaches 1M before the first `result`. A session
  // that learns a different window reports it through `claudeSdkModelOption`.
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "opus",
    name: "Claude Opus",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 1_000_000,
    sdkModelIds: ["claude-opus-5-5"],
    offeredWhenUnknown: true,
  },
  // Sonnet 5.5 and Haiku 5.5 are alias repoints like Opus above: existing
  // sessions move on their next turn and re-read history uncached. Both reject
  // the API's `{type:"disabled"}` (Sonnet always, Haiku above `high`), but the
  // bundled CLI translates `--thinking=disabled` per model, so `off` stays.
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
    sdkModelIds: ["claude-sonnet-5-5"],
    offeredWhenUnknown: true,
  },
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "haiku",
    name: "Claude Haiku",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
    sdkModelIds: ["claude-haiku-5-5"],
    offeredWhenUnknown: true,
  },
  // Fable's thinking is ALWAYS on (see reasoningToThinking): the API rejects a
  // disabled/fixed-budget thinking config, so `off` is intentionally omitted
  // from its levels. 1M context window, 128k output (measured `/v1/models`
  // objects of 5.1 and 5.2).
  //
  // The `fable` alias — not a concrete id — is what a session persists, and the
  // id is re-resolved on every run, resumes included: 5.2 where the account
  // lists it, else 5.1. So a session moves between versions on its next turn
  // when a newer one is listed or it changes account: sound (the wire id is
  // accepted on resume and history is retained) but it re-reads the whole
  // history uncached, because the prompt cache is per-model.
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "fable",
    name: "Claude Fable",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
    contextWindow: 1_000_000,
    sdkModelIds: ["claude-fable-5-2", "claude-fable-5-1"],
    offeredWhenUnknown: true,
  },
  // Mythos is entitlement-gated: only some subscriptions list it, so it runs
  // only on an account whose listing names a mythos id, never on an unknown
  // one. Its measured capabilities equal Fable's: adaptive thinking only (no
  // `off`), 1M context, 128k output.
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "mythos",
    name: "Claude Mythos",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
    contextWindow: 1_000_000,
    sdkModelIds: ["claude-mythos-5-2", "claude-mythos-5-1"],
    offeredWhenUnknown: false,
  },
];

export type ClaudeSdkModelAlias =
  "opus" | "sonnet" | "haiku" | "fable" | "mythos";

/** Normalize a recognized Claude model id to one of our curated aliases. */
export function knownClaudeSdkModelAlias(
  id: string | undefined,
): ClaudeSdkModelAlias | undefined {
  if (!id) return undefined;
  const value = id.toLowerCase();
  // Mythos first: any id naming it is Mythos, whatever else it contains.
  if (value.includes("mythos")) return "mythos";
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
export function claudeSdkModel(id: string | undefined): CuratedClaudeModel {
  const alias = claudeSdkModelAlias(id);
  return CLAUDE_SDK_MODELS.find((m) => m.id === alias) ?? CLAUDE_SDK_MODELS[1]!;
}

/**
 * The account-free concrete SDK `--model` string for an alias/id: its first
 * (newest) candidate. A run on an account resolves per account instead
 * (`./modelResolution.ts`).
 */
export function claudeSdkModelId(id: string | undefined): string {
  return claudeSdkModel(id).sdkModelIds[0];
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
  const {
    sdkModelIds: _sdkModelIds,
    offeredWhenUnknown: _offeredWhenUnknown,
    ...option
  } = claudeSdkModel(id);
  return contextWindow ? { ...option, contextWindow } : option;
}

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
 * Policy: every curated model (Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable /
 * Mythos) uses ADAPTIVE thinking with `effort` and `display:"summarized"` so
 * summaries stream (mirrors the pi harness). They REJECT a fixed `budgetTokens`
 * (400), so we never send one. A model whose levels lack `off` (Fable, Mythos)
 * can't disable thinking (400) — its `off` becomes lowest-effort adaptive; the
 * others send `off` as {type:"disabled"}, which the CLI maps to each model's
 * lowest thinking setting.
 */
export function reasoningToThinking(
  level: ThinkingLevel,
  modelId?: string,
): Pick<ClaudeSdkOptions, "thinking" | "effort"> {
  // A model without an `off` level always thinks; the others honor `off` as
  // disabled.
  const levels = claudeSdkModel(modelId).supportedThinkingLevels;
  const alwaysThinks = levels !== undefined && !levels.includes("off");
  if (level === "off" && !alwaysThinks) {
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
