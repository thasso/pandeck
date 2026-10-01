/**
 * Approved peer runtimes ([Task-595](pa://task/595)): the small roster of exact
 * account/model/thinking options a human has pre-approved for agents to start
 * ordinary peer sessions on, plus the user-owned selection metadata agents may
 * read when choosing between those approved rows.
 *
 * The USER owns the whole roster: every row names one exact enabled account,
 * model and thinking level, a coarse relative-cost label, and an optional short
 * description of when to choose it. Nothing resolves, ranks or substitutes on
 * their behalf. The host infers only the canonical model family, so a
 * coordinator asked for cross-family review can pick from a fact rather than by
 * guessing at model names.
 */
import type { AccountModelOption } from "./protocol.ts";
import {
  isThinkingLevel,
  supportedThinkingLevelsForModel,
  type ThinkingLevel,
} from "./thinkingLevels.ts";

/**
 * The thinking level as PERSISTED on an approved row.
 *
 * Wider than `ThinkingLevel` on purpose. What a row records is what the human
 * selected, and a stored value this build does not recognize — a hand-edited
 * settings file, a level a later build removed — must survive READABLE so the
 * user can see and repair it. Coercing it to a valid level would be the one
 * unacceptable outcome: the row would then authorize a runtime nobody chose.
 * `peerRuntimeUnavailableReason` refuses every value outside `ThinkingLevel`,
 * so an unrecognized one can be displayed but never run.
 */
export type StoredThinkingLevel = ThinkingLevel | (string & {});

/**
 * One approved runtime row as it is persisted in app settings.
 *
 * Runtime authorization plus selection metadata only: no role, allowed project
 * or budget. Two thinking levels for one model are two explicit rows, because
 * the level is part of what the human approved.
 */
export interface PeerSpawnRuntime {
  /** Stable generated id; what an agent names in a direct spawn. */
  id: string;
  /** Optional short label for legibility. Empty means "describe it by model". */
  name?: string;
  /** User-set coarse guidance for comparing approved options. Never a price. */
  relativeCost: PeerRuntimeRelativeCost;
  /** Optional user hint shown to agents deciding when to select this runtime. */
  description?: string;
  credentialProfileId: string;
  provider: string;
  modelId: string;
  thinkingLevel: StoredThinkingLevel;
  enabled: boolean;
}

/** A roster nobody can read is not an approval: keep it small enough to review. */
export const MAX_PEER_SPAWN_RUNTIMES = 12;

/**
 * Bounds for one uninterrupted causal agent-to-agent prompt chain. The default
 * permits long implement/review workflows while the finite ceiling still stops
 * an unattended loop. A human prompt closes the current chain.
 */
export const MIN_SESSION_PEER_PROMPT_MAX_HOPS = 1;
export const DEFAULT_SESSION_PEER_PROMPT_MAX_HOPS = 50;
export const MAX_SESSION_PEER_PROMPT_MAX_HOPS = 200;

/**
 * Conservative canonical model family. `unknown` is a real answer: an explicit
 * cross-family preference cannot be satisfied by a guess.
 */
export type PeerRuntimeFamily = "claude" | "gpt" | "unknown";

/** User-set coarse relative cost for one exact option. Never a price. */
export const PEER_RUNTIME_RELATIVE_COSTS = [
  "low",
  "medium",
  "high",
  "unknown",
] as const;
export type PeerRuntimeRelativeCost =
  (typeof PEER_RUNTIME_RELATIVE_COSTS)[number];

/** A selection hint must stay compact in both Settings and model context. */
export const MAX_PEER_RUNTIME_DESCRIPTION_CHARS = 240;

export function isPeerRuntimeRelativeCost(
  value: unknown,
): value is PeerRuntimeRelativeCost {
  return PEER_RUNTIME_RELATIVE_COSTS.includes(value as PeerRuntimeRelativeCost);
}

/**
 * Family from the picker provider and model id, inferred ONLY where the mapping
 * is unambiguous. Everything else is `unknown`, which is a usable answer.
 */
export function peerRuntimeFamilyOf(
  provider: string,
  modelId: string,
): PeerRuntimeFamily {
  const model = modelId.trim().toLowerCase();
  if (provider === "claude-sdk" || model.startsWith("claude")) return "claude";
  if (/^(opus|sonnet|haiku|fable)$/.test(model)) return "claude";
  if (model.startsWith("gpt-") || model.startsWith("gpt5")) return "gpt";
  return "unknown";
}

/**
 * Why this approved row cannot run right now, or undefined when it can.
 *
 * Deliberately about runtime FACTS only — the account, the model, the thinking
 * level — so Settings can keep an enabled-but-broken row visible with its reason
 * and a disabled row can read as a deliberate choice rather than a fault. A row
 * that cannot run never migrates to another runtime.
 */
export function peerRuntimeUnavailableReason(
  runtime: Pick<
    PeerSpawnRuntime,
    "credentialProfileId" | "provider" | "modelId" | "thinkingLevel"
  >,
  options: readonly AccountModelOption[],
): string | undefined {
  // A row can be persisted incomplete — settings keep a broken approval rather
  // than deleting it — so say which half is missing instead of reporting it as
  // a withdrawn model.
  if (!runtime.credentialProfileId || !runtime.provider)
    return "This row records no account or provider — pick its account and model again.";
  const account = options.filter(
    (option) => option.credentialProfileId === runtime.credentialProfileId,
  );
  if (account.length === 0)
    return "Its account is disabled, removed, or currently offers no models.";
  const model = account.find(
    (option) =>
      option.provider === runtime.provider && option.id === runtime.modelId,
  );
  if (!model)
    return `That account no longer offers ${runtime.provider}/${runtime.modelId}.`;
  if (model.accountDisabled) return `“${model.accountName}” is disabled.`;
  // An unrecognized stored level is named rather than reported as unsupported:
  // the row records something this build cannot run at all, and the user is the
  // only one who may replace it.
  if (!isThinkingLevel(runtime.thinkingLevel))
    return runtime.thinkingLevel
      ? `“${runtime.thinkingLevel}” is not a thinking level this build knows — pick one again.`
      : "This row records no thinking level — pick one again.";
  if (!supportedThinkingLevelsForModel(model).includes(runtime.thinkingLevel))
    return `${model.name} does not support ${runtime.thinkingLevel} thinking.`;
  return undefined;
}

/** What to call a row that has no name of its own. */
export function peerRuntimeDisplayName(
  runtime: Pick<
    PeerSpawnRuntime,
    "name" | "provider" | "modelId" | "thinkingLevel"
  >,
): string {
  const named = runtime.name?.trim();
  if (named) return named;
  return `${runtime.modelId} · ${runtime.thinkingLevel} thinking`;
}
