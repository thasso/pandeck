/**
 * Mappers for the committed SDK messages (`assistant` / `user` / `result`).
 *
 * These helpers extract the raw pieces this session uses: content blocks
 * (text/thinking/tool_use with full input), tool_results, the captured
 * session_id, the stop reason, and a flat string for a tool's output.
 */
import type { ClaudeSdkMessage } from "./sdkSeam.ts";

export type ClaudeAssistantMessage = Extract<
  ClaudeSdkMessage,
  { type: "assistant" }
>;
export type ClaudeUserMessage = Extract<ClaudeSdkMessage, { type: "user" }>;
export type ClaudeResultMessage = Extract<ClaudeSdkMessage, { type: "result" }>;

/** A content block extracted from an `assistant` message, in arrival order. */
export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolUse"; id: string; name: string; input: unknown };

/** One tool result carried by a `user` message. */
export interface ToolResult {
  toolCallId: string;
  /** Flattened output string for the `tool` display block's `output` field. */
  content: string;
  isError: boolean;
}

/** Token usage figures, all optional. */
export interface ClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

/** The provider's inner message id (`message.id`), stable across a turn. */
export function assistantMessageId(message: ClaudeAssistantMessage): string {
  const apiMessage = message.message as { id?: unknown };
  return typeof apiMessage?.id === "string" && apiMessage.id
    ? apiMessage.id
    : String(message.uuid);
}

/** Extract the assistant message's content blocks (text/thinking/tool_use). */
export function mapAssistantBlocks(
  message: ClaudeAssistantMessage,
): AssistantBlock[] {
  const apiMessage = message.message as { content?: unknown };
  const content = apiMessage.content;
  if (!Array.isArray(content)) return [];
  const out: AssistantBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text":
        out.push({ type: "text", text: String(b.text ?? "") });
        break;
      case "thinking":
        out.push({
          type: "thinking",
          text: String(b.thinking ?? b.text ?? ""),
        });
        break;
      case "tool_use":
        out.push({
          type: "toolUse",
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          input: b.input,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Assistant message's model id, if present. */
export function assistantModel(
  message: ClaudeAssistantMessage,
): string | undefined {
  const apiMessage = message.message as { model?: unknown };
  return typeof apiMessage.model === "string" ? apiMessage.model : undefined;
}

/** Assistant message's usage figures, if present. */
export function assistantUsage(message: ClaudeAssistantMessage): ClaudeUsage {
  const apiMessage = message.message as { usage?: unknown };
  return mapUsage(apiMessage.usage);
}

/** Extract the tool_results carried by a `user` message (empty if none). */
export function mapToolResults(message: ClaudeUserMessage): ToolResult[] {
  const content = (message.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (block): block is Record<string, unknown> =>
        !!block && typeof block === "object" && block.type === "tool_result",
    )
    .map((block) => ({
      toolCallId: String(block.tool_use_id ?? ""),
      content: formatToolOutput(block.content),
      isError: block.is_error === true,
    }))
    .filter((result) => result.toolCallId.length > 0);
}

/** Whether a `user` message is actually a tool_result delivery. */
export function isToolResultUserMessage(message: ClaudeUserMessage): boolean {
  return mapToolResults(message).length > 0;
}

/** Capture the provider `session_id` (for resume) from any message that carries one. */
export function captureSessionId(
  message: ClaudeSdkMessage,
): string | undefined {
  const maybe = message as { session_id?: unknown };
  return typeof maybe.session_id === "string" && maybe.session_id.length > 0
    ? maybe.session_id
    : undefined;
}

/** What a `system`/`compact_boundary` message reports about a completed compaction. */
export interface CompactBoundary {
  /** `manual` for a `/compact` command, `auto` for the CLI's own threshold compaction. */
  trigger: "manual" | "auto";
  /** Context tokens before compaction. */
  pre: number;
  /** Context tokens after compaction (absent on older CLIs). */
  post?: number;
  /** First message the CLI kept verbatim after the boundary, when it names one. */
  firstKept?: string;
}

/**
 * Read a compaction boundary off any SDK message, or undefined for every other
 * message. This is the ONLY signal that a Claude session's context was actually
 * replaced — it arrives for both the manual `/compact` command and the CLI's own
 * automatic compaction. The summary text is NOT part of it (that comes from the
 * `PostCompact` hook).
 */
export function compactBoundaryMetadata(
  message: ClaudeSdkMessage,
): CompactBoundary | undefined {
  const maybe = message as {
    type?: unknown;
    subtype?: unknown;
    compact_metadata?: unknown;
  };
  if (maybe.type !== "system" || maybe.subtype !== "compact_boundary")
    return undefined;
  const meta = (maybe.compact_metadata ?? {}) as Record<string, unknown>;
  const preserved = meta.preserved_messages as { uuids?: unknown } | undefined;
  const firstKept =
    Array.isArray(preserved?.uuids) && typeof preserved.uuids[0] === "string"
      ? preserved.uuids[0]
      : undefined;
  return {
    trigger: meta.trigger === "manual" ? "manual" : "auto",
    pre: typeof meta.pre_tokens === "number" ? meta.pre_tokens : 0,
    ...(typeof meta.post_tokens === "number" ? { post: meta.post_tokens } : {}),
    ...(firstKept ? { firstKept } : {}),
  };
}

/** Final (query-aggregate) usage from the `result` message. */
export function mapResultUsage(message: ClaudeResultMessage): ClaudeUsage {
  return mapUsage((message as { usage?: unknown }).usage);
}

/**
 * The provider failure an `assistant` message reports, or undefined for an
 * ordinary one.
 *
 * The CLI answers an API failure with a synthetic assistant message: model
 * `<synthetic>`, a typed `error` kind, and one text block carrying the wording
 * the user needs ("You've hit your org's monthly spend limit ..."). It is never
 * streamed, so the live-delta path that builds visible text never sees it — this
 * is the only place that wording exists.
 */
export function assistantProviderError(
  message: ClaudeAssistantMessage,
): { kind: string; text: string } | undefined {
  const kind = message.error;
  if (!kind) return undefined;
  const text = mapAssistantBlocks(message)
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
  return { kind, text };
}

/**
 * The failure a `result` message reports, or undefined for a successful run.
 *
 * Both result shapes carry `is_error`; the error shape names the failure in
 * `subtype`/`errors`, while an API failure keeps `subtype: "success"` and puts
 * the status in `api_error_status` with the wording in `result`.
 */
export function resultProviderError(
  message: ClaudeResultMessage,
): { reason: string; text: string } | undefined {
  const m = message as {
    subtype?: unknown;
    is_error?: unknown;
    api_error_status?: unknown;
    result?: unknown;
    errors?: unknown;
  };
  const status =
    typeof m.api_error_status === "number" ? m.api_error_status : undefined;
  const failed =
    m.is_error === true ||
    status !== undefined ||
    (typeof m.subtype === "string" && m.subtype.startsWith("error"));
  if (!failed) return undefined;
  const parts: string[] = [];
  if (typeof m.result === "string" && m.result.trim())
    parts.push(m.result.trim());
  if (Array.isArray(m.errors))
    for (const entry of m.errors)
      if (typeof entry === "string" && entry.trim()) parts.push(entry.trim());
  const reason =
    typeof m.subtype === "string" && m.subtype.startsWith("error")
      ? m.subtype
      : status !== undefined
        ? `HTTP ${status}`
        : "error";
  return { reason, text: parts.join("\n") };
}

/**
 * The TRUE token totals this `result` reports, summed from its `modelUsage` map.
 *
 * `modelUsage[model]` accumulates the tokens billed to that model across EVERY
 * internal request (the whole tool loop) AND across every model that ran (the
 * main model plus any helper/background/subagent models). Its
 * `costUSD`/`inputTokens` are what `total_cost_usd` is derived from.
 *
 * These are the RUNNING TOTALS for the `query()` epoch, not for one turn: on a
 * streaming-input session each result restates what the epoch has billed so far.
 * Rebase onto the latest (`applyResultTotals`); summing them across results
 * re-bills every earlier turn of the epoch.
 *
 * The top-level `result.usage` is NOT this sum: it carries the final request's
 * per-message usage (the same shape `assistantUsage` reads as a live context-size
 * SNAPSHOT), so reading it undercounts every intermediate tool-loop request and
 * misses non-primary models. We therefore take session totals from `modelUsage`,
 * falling back to the top-level usage only when the map is absent or empty (older
 * emitters, degenerate runs).
 */
export function mapResultEpochUsage(message: ClaudeResultMessage): ClaudeUsage {
  const modelUsage = (message as { modelUsage?: unknown }).modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let sawEntry = false;
    for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      sawEntry = true;
      input += numberValue(e.inputTokens) ?? 0;
      output += numberValue(e.outputTokens) ?? 0;
      cacheRead += numberValue(e.cacheReadInputTokens) ?? 0;
      cacheWrite += numberValue(e.cacheCreationInputTokens) ?? 0;
    }
    if (sawEntry) {
      return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        totalTokens: input + output,
      };
    }
  }
  return mapResultUsage(message);
}

/**
 * Cumulative cost (USD) and the real model context window from a `result`
 * message's `modelUsage` map. `total_cost_usd` is what this `query()` epoch has
 * cost so far, which the session rebases onto rather than accumulating (see
 * `mapResultEpochUsage`). `contextWindow` is
 * taken from the `modelUsage` entry that did the most work this turn (so a
 * helper model — e.g. for title generation — doesn't override the main model's
 * window), which lets us report e.g. the 1M window for Sonnet[1m] instead of a
 * hardcoded 200k.
 */
export function mapResultMeta(message: ClaudeResultMessage): {
  cost: number;
  contextWindow?: number;
} {
  const m = message as { total_cost_usd?: unknown; modelUsage?: unknown };
  const cost = numberValue(m.total_cost_usd) ?? 0;
  let contextWindow: number | undefined;
  if (m.modelUsage && typeof m.modelUsage === "object") {
    let bestWork = -1;
    for (const entry of Object.values(
      m.modelUsage as Record<string, unknown>,
    )) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const cw = numberValue(e.contextWindow);
      if (cw === undefined) continue;
      const work =
        (numberValue(e.inputTokens) ?? 0) + (numberValue(e.outputTokens) ?? 0);
      if (work > bestWork) {
        bestWork = work;
        contextWindow = cw;
      }
    }
  }
  return { cost, ...(contextWindow !== undefined ? { contextWindow } : {}) };
}

/** The input-side context size (tokens occupying the window) for a usage snapshot. */
export function contextSizeFromUsage(usage: ClaudeUsage): number {
  return (
    (usage.inputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/**
 * Flatten a `tool_result` block's `content` to a string for the `tool` display
 * block's `output` field: text parts are joined; anything non-text is JSON.
 */
function formatToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringify(content);
  const parts: string[] = [];
  let sawText = false;
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
        sawText = true;
        continue;
      }
    }
    parts.push(stringify(block));
  }
  return sawText && parts.length > 0
    ? parts.join("\n")
    : parts.join("\n") || stringify(content);
}

export function mapUsage(usage: unknown): ClaudeUsage {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;
  const inputTokens = numberValue(u.input_tokens);
  const outputTokens = numberValue(u.output_tokens);
  const cacheReadTokens = numberValue(u.cache_read_input_tokens);
  const cacheWriteTokens = numberValue(u.cache_creation_input_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(inputTokens !== undefined || outputTokens !== undefined
      ? { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }
      : {}),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
