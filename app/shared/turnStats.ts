/**
 * Pure helpers for the chat transcript's turn boundaries and per-turn/per-run
 * usage stats (Task 118). A "turn" is one user prompt plus every assistant/tool
 * message that follows it until the next user prompt; within a turn each
 * usage-bearing assistant `DisplayMessage` is one completed provider RUN, and its
 * durable `usage` is that run's OWN token/cost delta (never a session cumulative
 * — see `AgentUsage`), so summing runs/turns yields correct totals.
 *
 * Lives in the shared package because the transcript is WINDOWED: the renderer
 * only holds a suffix of the timeline, so the server has to compute the running
 * totals for everything before it ({@link turnStatsSeedForEntries}) with exactly
 * this math. Everything here is deterministic and framework-free.
 */
import type { DisplayMessage } from "./protocol.ts";
import { entriesToDisplayMessages } from "./displayMapping.ts";
import { timelineEntryStartsTurn } from "./runtimeEvents.ts";
import type { ClientTimelineEntry } from "./runtimeEvents.ts";

/** One completed provider run within a turn (a usage-bearing assistant message). */
export interface TurnRun {
  id: string;
  /** 1-based position of this run within its turn. */
  index: number;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
}

/** Token/cost totals shared by a turn and the running session cumulative. */
export interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Aggregated stats for a whole turn. */
export interface TurnTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  toolCalls: number;
  /** Generation span across the turn's runs, when timing is reported. */
  durationMs?: number;
  /** Model of the turn's last run, when reported. */
  model?: string;
  /** Number of completed provider runs that reported usage. */
  runCount: number;
  /**
   * Prompt-side context size after the turn's LAST run — the conversation size
   * the model carried after this turn. Prefers the harness-reported
   * `usage.contextTokens` snapshot; falls back to the run's prompt-token sum
   * (`input + cacheRead + cacheWrite`), which over-counts a multi-request tool
   * loop. Used to derive the per-turn context-occupancy delta.
   */
  contextSize: number;
  /**
   * True when `contextSize` came from the fallback sum rather than a reported
   * snapshot, so it is an upper-bound ESTIMATE. Renderers must mark such a value
   * as approximate instead of presenting it as measured.
   */
  contextSizeIsEstimate: boolean;
  /** Context-window capacity reported by the turn's last run, when available. */
  contextWindow?: number;
  /** Prompt cache hit ratio over the turn's runs — see `promptCacheHitRatio`. */
  cacheHitRatio: number | null;
}

/**
 * Running turn stats AS OF a point in the timeline: what a renderer that starts
 * there must add its own turns to. Without it a windowed transcript would show a
 * Session cumulative that silently restarts at the window and a first context
 * delta equal to the whole context.
 */
export interface TurnStatsSeed {
  /** Session cumulative over every turn before the window. */
  cumulative: SessionTotals;
  /** Context occupancy after the last usage-bearing run before the window. */
  prevContextSize: number;
  /** Turns before the window that reported usage (the Session line's threshold). */
  usageTurnCount: number;
  /**
   * The window starts INSIDE a turn: its first rows are the tail of a turn whose
   * prompt and earlier runs are behind the window. Read off the actual start
   * entry, so it holds however that start was picked — a turn longer than the
   * wire budget, a turn boundary the entry floor rejected as too close to the
   * tail, or a cached range that itself began mid-turn. It is what stops the
   * renderer from showing a fragment's numbers as that turn's — see
   * {@link accumulateTurnStats}.
   */
  partialTurn?: boolean;
}

export const EMPTY_TURN_STATS_SEED: TurnStatsSeed = {
  cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  prevContextSize: 0,
  usageTurnCount: 0,
};

/** One rendered turn-end row: the turn plus the running stats as of its end. */
export interface RunningTurnStats {
  turn: Turn;
  totals: TurnTotals;
  /** Session cumulative up to and INCLUDING this turn. */
  cumulative: SessionTotals;
  /** Context-occupancy growth over the previous usage-bearing turn. */
  contextDelta: number;
  /** Whether a Session line is meaningful yet (more than one usage turn seen). */
  showSessionCumulative: boolean;
  /**
   * This "turn" is only the visible TAIL of one (the window opened inside it),
   * so its own totals are a fragment's. Renderers must not draw a turn-end row
   * for it: the numbers would be wrong now and would change the moment the rest
   * of the turn is loaded. The running totals it carries are still correct — the
   * seed already accounts for the part before the window.
   */
  partial: boolean;
}

/**
 * Walk a message list's turns, continuing the running stats from `seed` — the
 * stats for everything BEFORE this list. The transcript renders from this, and
 * the server computes its seed with the same walk, so a windowed list produces
 * exactly the rows the unwindowed one would.
 *
 * The one row that cannot be reproduced that way is a leading turn FRAGMENT
 * (`seed.partialTurn`): its own totals cover only the part inside the window.
 * It is marked `partial` rather than corrected, because the missing runs are
 * simply not here — and it is not counted as a turn either, since the seed
 * already counted the turn it belongs to.
 */
export function accumulateTurnStats(
  messages: readonly DisplayMessage[],
  seed: TurnStatsSeed = EMPTY_TURN_STATS_SEED,
): RunningTurnStats[] {
  // Running session cumulative (durable, so a historical turn's Session line
  // reflects the total AS OF that turn).
  const cumulative: SessionTotals = { ...seed.cumulative };
  // Previous turn's context-window occupancy. Growth is a context delta, not
  // billed input: a tool loop may process the same context many times.
  let prevContextSize = seed.prevContextSize;
  let usageTurnCount = seed.usageTurnCount;
  const rows: RunningTurnStats[] = [];
  for (const turn of groupTurns(messages)) {
    const partial = rows.length === 0 && seed.partialTurn === true;
    const totals = turnTotals(turn);
    cumulative.input += totals.input;
    cumulative.output += totals.output;
    cumulative.cacheRead += totals.cacheRead;
    cumulative.cacheWrite += totals.cacheWrite;
    cumulative.cost += totals.cost;
    const contextDelta =
      totals.runCount > 0 ? totals.contextSize - prevContextSize : 0;
    if (totals.runCount > 0) {
      prevContextSize = totals.contextSize;
      // A fragment continues the turn the seed already counted.
      if (!partial) usageTurnCount += 1;
    }
    rows.push({
      turn,
      totals,
      cumulative: { ...cumulative },
      contextDelta,
      showSessionCumulative: usageTurnCount > 1,
      partial,
    });
  }
  return rows;
}

/**
 * The seed for a transcript that renders `timeline` from `start`: the running
 * stats for everything before it, and whether that cut landed INSIDE a turn.
 *
 * The single place both wire paths (snapshot window and `loadTimelineRange`)
 * derive a seed, so the partial-turn flag can never be forgotten on one of them.
 * `undefined` means the transcript starts at the session start — nothing
 * precedes it, so there is nothing to seed.
 */
export function turnStatsSeedForWindow(
  timeline: readonly ClientTimelineEntry[],
  start: number,
): TurnStatsSeed | undefined {
  if (start <= 0) return undefined;
  const seed = turnStatsSeedForEntries(timeline.slice(0, start));
  return timelineEntryStartsTurn(timeline[start])
    ? seed
    : { ...seed, partialTurn: true };
}

/**
 * The seed a renderer needs to continue the running stats after `entries` — the
 * timeline entries that PRECEDE its window. Prefer
 * {@link turnStatsSeedForWindow}, which also decides `partialTurn`.
 */
export function turnStatsSeedForEntries(
  entries: readonly ClientTimelineEntry[],
): TurnStatsSeed {
  return turnStatsSeedForMessages(entriesToDisplayMessages(entries));
}

/** {@link turnStatsSeedForEntries} for an already-projected message list. */
export function turnStatsSeedForMessages(
  messages: readonly DisplayMessage[],
): TurnStatsSeed {
  const rows = accumulateTurnStats(messages);
  const last = rows.at(-1);
  if (!last) return EMPTY_TURN_STATS_SEED;
  // The context after the last USAGE-bearing turn; trailing turns without usage
  // (an aborted run) leave it where it was.
  let prevContextSize = 0;
  let usageTurnCount = 0;
  for (const row of rows) {
    if (row.totals.runCount === 0) continue;
    prevContextSize = row.totals.contextSize;
    usageTurnCount += 1;
  }
  return { cumulative: last.cumulative, prevContextSize, usageTurnCount };
}

/** A pointer into a message's block list where the before-final-response rule sits. */
export interface FinalResponseBoundary {
  messageId: string;
  blockIndex: number;
}

/** A grouped turn: a leading (optional) user message plus its assistant messages. */
export interface Turn {
  /** All messages in the turn, in order (user first when present). */
  messages: DisplayMessage[];
  /** The assistant messages in the turn, in order. */
  assistantMessages: DisplayMessage[];
  /** Id of the last assistant message, where the turn-end row anchors. */
  lastAssistantId?: string;
  /** True once the turn has finished (no in-flight streaming message). */
  complete: boolean;
}

/**
 * Group a display message list into turns. Operate on the ALREADY-VISIBLE
 * message list so the turn-end row anchors after the last rendered row.
 */
export function groupTurns(messages: readonly DisplayMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  const push = (message: DisplayMessage) => {
    if (!current) {
      current = { messages: [], assistantMessages: [], complete: true };
      turns.push(current);
    }
    current.messages.push(message);
    if (message.role === "assistant") {
      current.assistantMessages.push(message);
      current.lastAssistantId = message.id;
    }
    if (message.streaming) current.complete = false;
  };

  for (const message of messages) {
    // A user message starts a new turn.
    if (message.role === "user") current = null;
    push(message);
  }
  return turns;
}

/**
 * Prompt cache hit ratio over any token bundle: `cacheRead / (cacheRead + input
 * + cacheWrite)`, or null when there were no prompt tokens. Cache WRITE tokens
 * count as misses — they were processed uncached (at a billing premium) to seed
 * the cache — so leaving them out of the denominator overstates the hit rate.
 * The turn line and the session line MUST use this one function so they agree.
 */
export function promptCacheHitRatio(tokens: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number | null {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return prompt > 0 ? tokens.cacheRead / prompt : null;
}

/** Sum durable usage across the turn's completed provider runs. */
export function turnTotals(turn: Turn): TurnTotals {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let toolCalls = 0;
  let runCount = 0;
  let model: string | undefined;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  let contextSize = 0;
  let contextSizeIsEstimate = false;
  let contextWindow: number | undefined;

  for (const message of turn.assistantMessages) {
    for (const block of message.blocks) if (block.kind === "tool") toolCalls++;
    const u = message.usage;
    if (!u) continue;
    runCount++;
    input += u.inputTokens ?? 0;
    output += u.outputTokens ?? 0;
    cacheRead += u.cacheReadTokens ?? 0;
    cacheWrite += u.cacheCreationTokens ?? 0;
    cost += u.costUSD ?? 0;
    if (message.model) model = message.model;
    // Context after this run: the harness-reported snapshot when present, else
    // the run's prompt-token sum (an estimate). The turn's last run wins.
    contextSizeIsEstimate = u.contextTokens === undefined;
    contextSize =
      u.contextTokens ??
      (u.inputTokens ?? 0) +
        (u.cacheReadTokens ?? 0) +
        (u.cacheCreationTokens ?? 0);
    contextWindow = u.contextWindowTokens;
    const start = message.startedAt ? Date.parse(message.startedAt) : NaN;
    const end = message.completedAt ? Date.parse(message.completedAt) : NaN;
    if (!Number.isNaN(start)) minStart = Math.min(minStart, start);
    if (!Number.isNaN(end)) maxEnd = Math.max(maxEnd, end);
  }

  const durationMs =
    maxEnd >= minStart && Number.isFinite(minStart) && Number.isFinite(maxEnd)
      ? maxEnd - minStart
      : undefined;
  const cacheHitRatio = promptCacheHitRatio({ input, cacheRead, cacheWrite });
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    toolCalls,
    runCount,
    contextSize,
    contextSizeIsEstimate,
    cacheHitRatio,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(model ? { model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** One row per completed provider run in the turn, for the per-run cache breakdown. */
export function turnRuns(turn: Turn): TurnRun[] {
  const rows: TurnRun[] = [];
  for (const message of turn.assistantMessages) {
    const u = message.usage;
    if (!u) continue;
    rows.push({
      id: message.id,
      index: rows.length + 1,
      ...(message.model ? { model: message.model } : {}),
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      cacheRead: u.cacheReadTokens ?? 0,
      cacheWrite: u.cacheCreationTokens ?? 0,
      ...(u.costUSD !== undefined ? { cost: u.costUSD } : {}),
    });
  }
  return rows;
}

/**
 * Locate where the "before final response" separator goes: immediately before
 * the first text block that FOLLOWS the turn's last tool block. Returns null
 * when the turn had no tool activity (nothing to separate) or ended without a
 * trailing text answer.
 */
export function finalResponseBoundary(
  turn: Turn,
): FinalResponseBoundary | null {
  // Flatten the turn's assistant blocks in order, tracking their owning message.
  const flat: Array<{ messageId: string; blockIndex: number; kind: string }> =
    [];
  for (const message of turn.assistantMessages) {
    message.blocks.forEach((block, blockIndex) => {
      flat.push({ messageId: message.id, blockIndex, kind: block.kind });
    });
  }
  let lastToolAt = -1;
  for (let i = 0; i < flat.length; i++)
    if (flat[i]?.kind === "tool") lastToolAt = i;
  if (lastToolAt === -1) return null; // no tool activity → no loop end to mark
  for (let i = lastToolAt + 1; i < flat.length; i++) {
    const entry = flat[i];
    if (entry?.kind === "text")
      return { messageId: entry.messageId, blockIndex: entry.blockIndex };
  }
  return null; // turn ended on tool activity with no trailing answer text
}
