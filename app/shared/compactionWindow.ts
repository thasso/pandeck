/**
 * A session's compaction window (`docs/compaction-window.md`): the context size,
 * in tokens, at which the harness compacts the conversation. Absent means the
 * provider's own default, which is today's behaviour.
 */

/**
 * The lowest window an AGENT may set, on every harness. The user's own range
 * can go lower on pi.
 */
export const COMPACTION_WINDOW_AGENT_FLOOR = 100_000;

/**
 * How a harness maps a window onto its engine, declared on its
 * `HarnessDescriptor`.
 *
 * - `window`: the engine takes the window itself (Claude's
 *   `autoCompactWindow`), between `min` and `max`, and never above the model's
 *   context window.
 * - `reserve`: the engine compacts when the context passes the model's window
 *   minus a reserve (pi), so the window is written as a per-model reserve. A
 *   lower window there also leaves a larger summary budget, which is the cost
 *   `summaryCostNote` tells the user about.
 */
export type CompactionWindowCapability =
  | { readonly mapping: "window"; readonly min: number; readonly max: number }
  | {
      readonly mapping: "reserve";
      readonly summaryCostNote: true;
      readonly defaultReserve: number;
    };

/** An inclusive token range; never empty. */
export interface CompactionWindowRange {
  min: number;
  max: number;
}

export type CompactionWindowRangeResult =
  { range: CompactionWindowRange } | { unavailable: string };

/**
 * The user's range for one model. `contextWindow` is the model's window;
 * `underlyingReserve` is the reserve the `reserve` mapping would use without
 * any Pandeck override, so `contextWindow − underlyingReserve` is the engine's
 * native trigger.
 */
export function compactionWindowRange(
  capability: CompactionWindowCapability,
  input: { contextWindow?: number; underlyingReserve?: number },
): CompactionWindowRangeResult {
  const contextWindow = positive(input.contextWindow);
  if (capability.mapping === "window") {
    const max = Math.min(contextWindow ?? capability.max, capability.max);
    return max >= capability.min
      ? { range: { min: capability.min, max } }
      : {
          unavailable: `This model's context window is below the ${formatTokens(capability.min)}-token minimum.`,
        };
  }
  if (contextWindow === undefined)
    return { unavailable: "The model's context window is not known." };
  const trigger = contextWindow - Math.max(0, input.underlyingReserve ?? 0);
  return trigger >= 1
    ? { range: { min: 1, max: trigger } }
    : {
        unavailable:
          "This model's compaction reserve already covers its whole context window.",
      };
}

/** The window the harness actually applies for a stored value. */
export function effectiveCompactionWindow(
  range: CompactionWindowRange,
  stored: number,
): number {
  return Math.min(Math.max(stored, range.min), range.max);
}

/**
 * Why the user may not set `tokens`, or `undefined` when they may. `null`
 * clears the window and is always allowed. Server and inspector share this
 * wording.
 */
export function compactionWindowUserRefusal(
  available: CompactionWindowRangeResult,
  tokens: number | null,
): string | undefined {
  if (tokens === null) return undefined;
  if (!Number.isSafeInteger(tokens) || tokens <= 0)
    return "The compaction window must be a whole number of tokens.";
  if ("unavailable" in available)
    return `The compaction window cannot be set: ${available.unavailable}`;
  const { min, max } = available.range;
  return tokens < min || tokens > max
    ? `The compaction window must be between ${formatTokens(min)} and ${formatTokens(max)} tokens.`
    : undefined;
}

/** A creation request, shared by the card preview and the server. */
export interface SpawnCompactionWindowRequest {
  tokens: number;
  source: "row" | "definition";
  rowAbove: "refuse" | "clamp";
  ceiling?: number;
}

export interface CompactionWindowEstimate {
  tokens: number | null;
  note?: string;
}

export interface SpawnCompactionWindow extends CompactionWindowEstimate {
  requested: number;
  source: "row" | "definition";
  estimated?: true;
}

/** Decide against either an estimated range or a session's actual range. */
export function spawnCompactionWindow(
  available: CompactionWindowRangeResult,
  request: SpawnCompactionWindowRequest,
): CompactionWindowEstimate | { refused: string } {
  const { tokens, source } = request;
  if (!Number.isSafeInteger(tokens) || tokens <= 0)
    return {
      refused: "The compaction window must be a whole number of tokens.",
    };
  if (source === "row" && tokens < COMPACTION_WINDOW_AGENT_FLOOR)
    return {
      refused:
        "A spawn row's compaction window must be at least 100,000 tokens.",
    };
  if ("unavailable" in available)
    return source === "row"
      ? {
          refused: `The compaction window cannot be set: ${available.unavailable}`,
        }
      : {
          tokens: null,
          note: `No compaction window was set: ${available.unavailable}`,
        };
  if (
    source === "row" &&
    (available.range.max < COMPACTION_WINDOW_AGENT_FLOOR ||
      (tokens > available.range.max && request.rowAbove === "refuse"))
  )
    return {
      refused: `A spawned session's compaction window must be between 100,000 and ${formatTokens(available.range.max)} tokens.`,
    };
  let value = effectiveCompactionWindow(available.range, tokens);
  if (request.ceiling !== undefined) value = Math.min(value, request.ceiling);
  return {
    tokens: value,
    ...(value !== tokens
      ? {
          note: `The ${source === "row" ? "row's" : "definition's"} ${formatTokens(tokens)}-token window was clamped to ${formatTokens(value)} for this model.`,
        }
      : {}),
  };
}

/** Build the note before the atomic value/note write. Empty estimates are distinct from absent estimates. */
export function compactionWindowEstimateNote(
  estimate: CompactionWindowEstimate | undefined,
  actual: number | null,
  decisionNote?: string,
): string | undefined {
  if (!estimate) return decisionNote;
  const sentences: string[] = [];
  if (actual !== estimate.tokens) {
    sentences.push(
      actual === null
        ? `Not set: this session's pi settings leave no range. The estimate showed ${formatTokens(estimate.tokens!)} tokens.`
        : estimate.tokens === null
          ? `Set to ${formatTokens(actual)} tokens: the estimate from pi's default reserve found no range for this model, and this session's pi settings allow it.`
          : `Lowered from the ${formatTokens(estimate.tokens)} tokens shown to ${formatTokens(actual)} by this session's pi settings.`,
    );
  }
  if (estimate.tokens !== null && estimate.note) sentences.push(estimate.note);
  if (actual === null && decisionNote) sentences.push(decisionNote);
  return [...new Set(sentences)].join(" ").slice(0, 500) || undefined;
}

/** Whether the harness's live process has taken the window. */
type CompactionWindowApplied = "pending" | "confirmed" | "unknown";

/**
 * Why a stored window is not applied yet.
 *
 * - `next-turn`: nothing is running; the next turn's process starts with it.
 * - `process-restart`: a running Claude process (a turn, or background work
 *   keeping it open) cannot change its window; the next process starts with
 *   it. The CLI fixes the window when a query starts.
 */
export type CompactionWindowPendingReason = "next-turn" | "process-restart";

/** What a live harness knows about its window; the rest comes from the row. */
export interface CompactionWindowLiveStatus {
  applied: CompactionWindowApplied;
  /** What the live process confirmed; `null` is the provider default. */
  appliedTokens?: number | null;
  pendingReason?: CompactionWindowPendingReason;
  /** Compaction is turned off in the provider's own settings. */
  disabled?: true;
  /** The last apply's failure; the stored value still applies at the next start. */
  applyError?: string;
  /**
   * The context size at which the provider last said it compacts. Not the
   * window: Claude reports a threshold below it.
   */
  providerTrigger?: number;
}

/** The compaction-window part of {@link SessionState}. */
export interface SessionCompactionWindow extends CompactionWindowLiveStatus {
  /** The stored (desired) window; absent means the provider's default. */
  tokens?: number;
  /** Creation-time clamp/reconciliation explanation, cleared by a later change. */
  note?: string;
  /** The user's range for the current model, or why there is none. */
  range?: CompactionWindowRange;
  unavailable?: string;
  /** `tokens` clamped into the current model's range. */
  effectiveTokens?: number;
}

/**
 * A session's compaction-window state, from its stored value, the range inputs
 * and what a live harness reports. Without a live harness nothing is applied
 * yet: the next start applies the stored value.
 */
export function sessionCompactionWindowState(
  capability: CompactionWindowCapability | undefined,
  input: {
    stored: number | undefined;
    note?: string | undefined;
    contextWindow?: number;
    underlyingReserve?: number;
    live?: CompactionWindowLiveStatus;
  },
): SessionCompactionWindow | undefined {
  if (!capability) return undefined;
  const available = compactionWindowRange(capability, input);
  const live = input.live ?? {
    applied: "pending",
    pendingReason: "next-turn",
  };
  return {
    ...live,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.stored !== undefined ? { tokens: input.stored } : {}),
    ...available,
    ...(input.stored !== undefined && "range" in available
      ? {
          effectiveTokens: effectiveCompactionWindow(
            available.range,
            input.stored,
          ),
        }
      : {}),
  };
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}
