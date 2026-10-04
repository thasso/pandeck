/**
 * Normalized session stats. Builds the existing `ContextInfo` (message/tool
 * counts, token/cost usage, context-window %, live current-turn estimate) from
 * the normalized {@link SessionSnapshot} — durable entries + in-flight streams —
 * so EVERY harness reports stats the same way through the runtime, with no
 * provider-specific stat path.
 *
 * Split:
 *   - **Durable** token/cost usage comes from FINALIZED assistant entries' `usage`.
 *   - **Live** current-turn estimates come from the transient streams only.
 *   - **Counts** derive from the normalized timeline + active streams.
 */
import type { ContextInfo } from "@assistant/shared";
import type {
  AgentContentBlock,
  AgentUsage,
  SessionSnapshot,
} from "@assistant/shared/session";
import { estimateTokens } from "./liveBlocks.ts";

/** Default context window when no assistant entry has reported one yet. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface StatsOptions {
  updatedAt?: number;
  /** Project context inherited from a Task / selected for a standalone session. */
  project?: ContextInfo["project"];
}

/** Build a {@link ContextInfo} for a runtime-backed session from its snapshot. */
export function contextInfoFromSnapshot(
  snapshot: SessionSnapshot,
  opts: StatsOptions = {},
): ContextInfo {
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  let toolResults = 0;

  // Cumulative durable usage = sum over FINALIZED assistant entries' usage.
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  // Current context size = the LAST assistant entry's input-side tokens (a
  // snapshot, not a sum), with its reported context window if any.
  let contextTokens: number | null = null;
  let contextWindow = DEFAULT_CONTEXT_WINDOW;

  for (const entry of snapshot.entries) {
    if (entry.role === "user") {
      user++;
    } else if (entry.role === "assistant") {
      assistant++;
      for (const block of entry.content)
        if (block.type === "toolCall") toolCalls++;
      const u = entry.usage;
      if (u) {
        input += u.inputTokens ?? 0;
        output += u.outputTokens ?? 0;
        cacheRead += u.cacheReadTokens ?? 0;
        cacheWrite += u.cacheCreationTokens ?? 0;
        cost += u.costUSD ?? 0;
        const ctx = contextSize(u);
        if (ctx > 0) contextTokens = ctx;
        if (u.contextWindowTokens) contextWindow = u.contextWindowTokens;
      }
    } else {
      toolResults++;
    }
  }

  const currentTurnValue = currentTurnEstimate(snapshot);
  return {
    sessionId: snapshot.sessionId,
    updatedAt: opts.updatedAt ?? Date.now(),
    ...(opts.project ? { project: opts.project } : {}),
    messageCounts: {
      user,
      assistant,
      toolCalls,
      toolResults,
      total: user + assistant,
    },
    tokenUsage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
    cost,
    context: {
      tokens: contextTokens,
      contextWindow,
      percent:
        contextTokens != null
          ? Math.min(100, (contextTokens / contextWindow) * 100)
          : null,
    },
    ...(currentTurnEstimate(snapshot)
      ? {
          ...(currentTurnValue !== undefined
            ? { currentTurn: currentTurnValue }
            : {}),
        }
      : {}),
  };
}

/**
 * Input-side tokens occupying the context window after one run. Prefer the
 * harness-reported snapshot; the prompt-token sum is a fallback that over-counts
 * a multi-request tool loop (usage is per-run, summed across its requests).
 */
function contextSize(usage: AgentUsage): number {
  return (
    usage.contextTokens ??
    (usage.inputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheCreationTokens ?? 0)
  );
}

/** Live, in-flight estimate from the transient streams ONLY (length/4 heuristic, like pi). */
function currentTurnEstimate(
  snapshot: SessionSnapshot,
): ContextInfo["currentTurn"] | undefined {
  const messageStream = snapshot.streaming.find((s) => s.kind === "message");
  const toolStreams = snapshot.streaming.filter((s) => s.kind === "tool");
  if (!messageStream && toolStreams.length === 0) return undefined;
  let text = "";
  let thinking = "";
  if (messageStream && messageStream.kind === "message") {
    for (const block of messageStream.content as AgentContentBlock[]) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") thinking += block.text;
    }
  }
  return {
    output: estimateTokens(text),
    thinking: estimateTokens(thinking),
    toolCalls: toolStreams.length,
  };
}
