/**
 * Task 254: the per-session / per-turn usage and context-contributor report.
 *
 * This is the RUNTIME measurement instrument of the token sub-epic, the
 * counterpart to the static `promptInventory.ts`: given one session it says how
 * many provider calls it made, what each turn cost, which categories of content
 * occupy the context, which tool results were the expensive ones, where context
 * jumped, and which tool definitions the session carried without ever calling
 * them. `measureSession.ts` prints it; the `session_audit` tool returns a
 * bounded projection of the same fields, so a before/after in a later subtask is
 * the same numbers under the same names.
 *
 * ## Sources, and what each one can answer
 *
 * - `DATA_DIR/sessions/<id>/log.jsonl` — the app's own normalized log. It is
 *   authoritative for TURN structure, content sizes, tool calls/results,
 *   failures and host-command (compaction) events, and its assistant entries
 *   carry the per-turn usage the persisted `session_usage_totals` was summed
 *   from. It collapses a whole turn into ONE assistant entry, so it cannot
 *   resolve provider CALLS.
 * - pi's `native.jsonl` — one assistant message per provider call, each with its
 *   own usage (including `reasoning`, which the app log does not model). This is
 *   the only source that resolves per-call context jumps for pi sessions.
 * - The Claude CLI transcript under `~/.claude/projects`, joined through
 *   `session_index.provider_session_id`, is the same thing for Claude sessions
 *   when it still exists; `DATA_DIR/claude-sdk/<id>.json` does not resolve calls
 *   at all.
 *
 * A session whose per-call transcript is gone still gets the whole report except
 * the call-resolved parts, which are reported as unavailable rather than
 * guessed at ({@link SessionAuditReport.unavailable}).
 *
 * ## Processed input is not context occupancy
 *
 * The two are reported separately and never summed, in the terminology of the
 * post-turn stats row (Task-251): PROCESSED (billed) input is
 * `uncached + cacheRead + cacheWrite` accumulated over every request, which a
 * tool loop makes far larger than the conversation; OCCUPANCY is the prompt-side
 * snapshot after one run (`usage.contextTokens`) and is what the context window
 * actually holds.
 *
 * ## Estimation assumptions
 *
 * Content sizes are measured in CHARACTERS (the same unit and rationale as
 * `promptInventory.ts`: no offline tokenizer is available for either provider).
 * Character counts are converted to tokens with a single stated divisor
 * ({@link CHARS_PER_TOKEN}) and every such number is named `estTokens`. Provider
 * numbers (`tokens`, `costUSD`) are never estimated — they come from the
 * transcript or not at all. The report carries the calibration between the two
 * ({@link SessionAuditReport.calibration}) so a reader can see how far the
 * estimate is off for this session rather than trusting the divisor.
 *
 * The static contributors (system prompt, tool definitions) are measured against
 * THIS CHECKOUT's prompt assets and catalog, not against what the session
 * actually sent: an old session is reported with today's prompt sizes, which is
 * a lower bound of the reduction work, never a reconstruction. Rows say so in
 * `basis`.
 */
import { statSync } from "node:fs";
import { type AgentType, isAgentType } from "@assistant/shared";
import type { PromptConditions } from "./promptConditions.ts";
import { FIND_TOOLS_NAME, MCP_SERVER_NAME } from "./mcp/names.ts";
import { personaPromptInventory } from "./promptAssets.ts";
import { forEachJsonlLine } from "./tools/sessions/sessionInspection.ts";

/** Report shape version — bump when a consumer-visible field changes meaning. */
const SESSION_AUDIT_VERSION = 1;

/**
 * Characters per token used for every `estTokens`. Deliberately ONE constant,
 * applied to prose, JSON arguments and tool output alike: it is the same
 * heuristic the live current-turn estimate uses (`session/runtime/stats.ts`),
 * and a per-category divisor would imply a precision no offline measurement here
 * has. JSON tokenizes denser than prose, so tool-argument and tool-result rows
 * are UNDER-estimated relative to text rows.
 */
export const CHARS_PER_TOKEN = 4;

/* ------------------------------- inputs ---------------------------------- */

/** Where per-provider-call usage was read from. */
export type AuditCallSource =
  "pi-native" | "claude-transcript" | "claude-store";

/** Session metadata the report needs; a projection of `SessionMeta`. */
interface AuditSessionMeta {
  title: string;
  harness: string;
  agentType: string;
  createdAtMs: number;
  updatedAtMs: number;
  model?: string;
  provider?: string;
  thinkingLevel?: string;
  archived?: boolean;
  messageCount?: number;
}

/** The persisted per-session usage totals (`session_usage_totals`). */
export interface PersistedUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costMicros?: number;
  usageTurns: number;
  assistantTurns: number;
  contextTokens?: number;
  contextWindow?: number;
}

/**
 * Everything the analysis reads, resolved by a caller. Injecting this (rather
 * than reaching for the store) is what lets the regression test run the whole
 * report over a committed fixture with no database.
 */
export interface SessionAuditSource {
  sessionId: string;
  meta: AuditSessionMeta;
  /** Absolute path to the app-owned `log.jsonl`; may be missing. */
  logPath: string;
  /** The per-provider-call transcript, when one exists for this session. */
  callTranscript?: { source: AuditCallSource; path: string };
  persistedUsage?: PersistedUsageTotals;
  promptConditions?: PromptConditions;
  attachedTaskId?: string;
  /** Non-fatal notes from resolution (missing log, unreadable transcript, …). */
  warnings?: string[];
}

/**
 * The persona tool inventory an audit measures a session against: what the
 * catalog exposes for a persona, and which of it starts in the model's context.
 *
 * Handed IN rather than imported. `tools/catalog.ts` composes every tool module
 * — `session_audit` among them — so an audit that read the catalog back would
 * close a cycle. The catalog therefore hands its own inventory to the tool it
 * registers (`sessionAuditTools`); every other caller sits above the catalog
 * and passes `catalogAuditInventory` itself. Omitting it is legal and reported
 * in {@link SessionAuditReport.unavailable}, never silently empty.
 */
export interface AuditToolInventory {
  /** The persona's catalog tools, in registration order, with their group. */
  toolsFor(agentType: AgentType): AuditInventoryTool[];
  /** Names of the persona's session-start tools under these frozen conditions. */
  eagerToolNames(
    agentType: AgentType,
    conditions?: PromptConditions,
  ): ReadonlySet<string>;
}

/** One catalog tool as the audit measures it. */
interface AuditInventoryTool {
  name: string;
  description: string;
  parameters: unknown;
  /** Id of the catalog group registering the tool. */
  group: string;
  /** The group's loading tier. */
  loading: ToolActivityRow["loading"];
}

export interface SessionAuditOptions {
  /** Turn rows to return, most recent kept. Default: every turn. */
  maxTurns?: number;
  /** Largest individual tool results to list. Default 5. */
  topToolResults?: number;
  /** Biggest provider-request context jumps to list. Default 5. */
  topContextJumps?: number;
  /** Per-tool call counts to list, largest first. Default 15. */
  topTools?: number;
  /** Bounded structural drill-down; never returns message bodies. */
  drilldown?: { entryId?: string; providerRun?: number };
  /** Catalog inventory to measure tool activity against. */
  inventory?: AuditToolInventory;
}

/* ------------------------------- outputs --------------------------------- */

/** Token/cost accounting under the post-turn stats row's names (Task-251). */
export interface AuditUsage {
  /** Input billed at the full uncached rate. */
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `uncached + cacheRead + cacheWrite` — everything the provider read. */
  processedInputTokens: number;
  outputTokens: number;
  /** Provider-reported reasoning tokens; undefined when not reported. */
  reasoningTokens?: number;
  costUSD: number;
}

interface AuditContext {
  /** Prompt-side occupancy after the last run that reported it. */
  tokens?: number;
  window?: number;
  percent?: number;
  /**
   * `reported` = the harness's own `contextTokens` snapshot. `prompt-token-sum`
   * = the run's `uncached + cacheRead + cacheWrite`, the same fallback the
   * persisted stats use, which OVER-counts a multi-request tool loop.
   */
  basis?: "reported" | "prompt-token-sum";
}

interface AuditTotals extends AuditUsage {
  turns: number;
  /** Assistant entries in the app log. One per TURN for both harnesses. */
  assistantRuns: number;
  /** Provider requests; undefined when no per-call transcript resolved them. */
  providerCalls?: number;
  /** Provider requests no turn could be attributed (a transcript with no timestamps). */
  providerCallsUnattributed?: number;
  toolCalls: number;
  toolResults: number;
  failedToolResults: number;
  /** Turns that ended in a provider error or an abort. */
  failedRuns: number;
  compactions: number;
  latestContext: AuditContext;
  /**
   * Cost in MICROS under the PER-ENTRY accumulation: each entry's `costUSD`
   * rounded, then summed as integers. This is what a pi session's persisted
   * total was built by. `costUSD` is the float sum of the same entries and is
   * for display.
   */
  costMicros: number;
  /**
   * Cost in MICROS under the SINGLE-ROUNDING accumulation: the floats summed
   * first, rounded once. This is what a Claude session's persisted total was
   * built by (`claudeSdkStore` → `replaceUsage` rounds the SDK record's
   * accumulated cost). The two regimes differ by up to half a micro per entry,
   * so the report carries both and the persisted value must equal one of them.
   */
  costMicrosSingleRounding: number;
  /** Assistant entries the store would count as usage turns. */
  usageBearingRuns: number;
  /** Wall clock from the session's first to its last log entry. */
  elapsedMs: number;
  /**
   * Summed assistant generation spans (`startedAt`→`completedAt`). Undefined
   * when no entry carried both — older logs did not record the span.
   */
  generationMs?: number;
  /** Bytes of the log file itself. */
  transcriptBytes: number;
  /** Bytes of tool-result content across the session. */
  toolResultBytes: number;
}

type ContributorCategory =
  | "system-prompt"
  | "tool-definitions"
  | "user-content"
  | "context-attachments"
  | "binary-attachments"
  | "injected-context"
  | "tool-call-arguments"
  | "tool-results"
  | "reasoning"
  | "assistant-text";

/** How a contributor row was obtained — never guess which numbers are measured. */
type ContributorBasis =
  /** Characters counted in this session's log. */
  | "transcript-chars"
  /** Attachment byte sizes recorded in the log (bodies are not stored there). */
  | "attachment-bytes"
  /** Assembled from THIS CHECKOUT's prompt assets / tool catalog. */
  | "current-checkout";

interface ContributorRow {
  category: ContributorCategory;
  /** Characters, or BYTES for a row whose basis is `attachment-bytes`. */
  chars: number;
  /**
   * Estimated tokens, or 0 for a row whose size does not convert — binary
   * attachments are sized in bytes that say nothing about image tokens.
   */
  estTokens: number;
  /** Share of the report's estimated total, 0–1. */
  share: number;
  basis: ContributorBasis;
  /** Items behind the row (blocks, attachments, tools). */
  items: number;
  note?: string;
}

export interface TurnRow {
  index: number;
  startedAt?: string;
  /** `human`, `agent`, `system`, … — the prompt origin that opened the turn. */
  origin?: string;
  hiddenPrompt?: boolean;
  elapsedMs?: number;
  providerCalls?: number;
  toolCalls: number;
  failedToolResults: number;
  usage: AuditUsage;
  /** Occupancy after this turn's last run. */
  contextAfter?: number;
  /** Change in occupancy since the previous turn that reported one. */
  contextDelta?: number;
  toolResultBytes: number;
  /** Tools whose definitions were activated during this turn. */
  toolsActivated: string[];
  /** Tool definitions active in the model's context at the turn's end. */
  activeToolCount: number;
  activeToolEstTokens: number;
  /** Provider error / abort text, when the turn failed. */
  failure?: string;
  compacted?: boolean;
}

interface ToolResultRow {
  entryId: string;
  toolName: string;
  turn: number;
  bytes: number;
  estTokens: number;
  isError: boolean;
}

interface ContextJumpRow {
  /** 1-based provider call (or turn, when calls are unresolved) AFTER the jump. */
  at: number;
  scope: "provider-call" | "turn";
  turn: number;
  fromTokens: number;
  toTokens: number;
  deltaTokens: number;
  /** Tool calls made by the preceding request, whose results caused the jump. */
  precededBy: string[];
  /** Output tokens the preceding request generated (also appended to context). */
  precedingOutputTokens: number;
}

interface ToolActivityRow {
  name: string;
  group: string;
  loading: "eager" | "deferred";
  /** Definition size (wire name + description + schema) in this checkout. */
  defChars: number;
  defEstTokens: number;
  calls: number;
  /** How the definition entered the model context, when it did. */
  loaded: "session-start" | "activated" | "never";
  /** Turn the definition was activated in (deferred tools only). */
  activatedInTurn?: number;
}

interface ToolActivityReport {
  /** Tool definitions in the first request (persona eager tier + `find_tools`). */
  eagerCount: number;
  eagerDefChars: number;
  eagerDefEstTokens: number;
  activatedCount: number;
  activatedDefChars: number;
  /** Definitions carried but never called (eager or activated). */
  unusedCount: number;
  unusedDefChars: number;
  unusedDefEstTokens: number;
  /**
   * Calls to names THIS CHECKOUT's catalog does not contain: harness builtins
   * (`Bash`, `Read`, pi's `bash`/`edit`) and app tools that have since been
   * renamed or removed (`task_workflow_read`, `send_session_relay`, …). The two
   * are not distinguishable from a transcript, and for an instrument that
   * measures before/after across tool removals the honest label is "not in this
   * catalog" rather than "harness builtin".
   */
  callsNotInThisCatalog: Record<string, number>;
  rows: ToolActivityRow[];
}

type AuditEventKind =
  "compaction" | "host-command" | "tool-activation" | "run-failure";

interface AuditEvent {
  kind: AuditEventKind;
  turn: number;
  at?: string;
  detail: string;
}

interface UsageAgreement {
  field: string;
  report: number;
  persisted: number;
  delta: number;
  /** For `costMicros`: the other accumulation, which also did not match. */
  alternative?: number;
}

/**
 * How a session's persisted cost total was accumulated. The two harnesses
 * genuinely differ, and the difference is deterministic, not float noise:
 *
 * - `per-entry` — pi: `recordUsageTurn` rounds each entry's `costUSD` to micros
 *   and `addUsageTotals` sums the integers, so the stored value is `Σ round(c)`.
 * - `single-rounding` — Claude: `claudeSdkStore` hands `replaceUsage` the SDK
 *   record's already-accumulated float, rounded ONCE, so the stored value is
 *   `round(Σ c)`.
 *
 * The report computes both from the log and reconciles against whichever
 * matches, naming it. Surveyed over the live data dir, every session whose two
 * regimes differ matched its harness's regime exactly; a session matching
 * NEITHER is a real divergence and is reported as a difference.
 */
type CostAccumulation = "per-entry" | "single-rounding";

interface DrilldownBlock {
  kind: string;
  name?: string;
  chars: number;
  estTokens: number;
}

interface DrilldownResult {
  target: string;
  found: boolean;
  entryId?: string;
  role?: string;
  turn?: number;
  at?: string;
  /** Per-block structure and SIZES only — bodies are never returned. */
  blocks?: DrilldownBlock[];
  usage?: AuditUsage;
  contextAfter?: number;
  toolCalls?: string[];
}

export interface SessionAuditReport {
  version: number;
  session: {
    sessionId: string;
    title: string;
    harness: string;
    persona: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
    createdAt: string;
    updatedAt: string;
    archived: boolean;
    attachedTaskId?: string;
    promptConditions?: PromptConditions;
  };
  sources: {
    log: { path: string; available: boolean; lines: number; bytes: number };
    providerCalls: {
      source: AuditCallSource | "none";
      path?: string;
      available: boolean;
      resolvesCalls: boolean;
    };
  };
  totals: AuditTotals;
  /** Transcript-resolved per-call totals; present only when calls resolved. */
  providerCallTotals?: AuditUsage & {
    calls: number;
    /** False when the transcript records no cost (the Claude CLI's does not). */
    costReported: boolean;
  };
  persisted?: {
    totals: PersistedUsageTotals;
    /**
     * Every compared field matches, allowing ONLY the cost tolerance below.
     * Token counts are integers on both sides and must match exactly.
     */
    agrees: boolean;
    differences: UsageAgreement[];
    /**
     * Which cost accumulation reconciled ({@link CostAccumulation}), or
     * undefined when neither did — in which case `costMicros` is a real
     * difference. There is no tolerance anywhere: every compared field is an
     * integer on both sides and must match exactly.
     */
    costAccumulation?: CostAccumulation;
    /** Exactly which fields `agrees` covers — the rest of `totals` is not compared. */
    comparedFields: string[];
  };
  contributors: ContributorRow[];
  /** Estimated vs measured, so the divisor is auditable per session. */
  calibration: {
    /** Static first-request estimate: system prompt + eager tool definitions. */
    estimatedFirstRequestTokens: number;
    /** Processed input of the session's first provider request, when known. */
    measuredFirstRequestTokens?: number;
    /** measured / estimated; >1 means the estimate is low. */
    ratio?: number;
    /** Sum of every contributor row. */
    estimatedTotalTokens: number;
    /** Why the two sides are not the same quantity. */
    note: string;
  };
  turns: TurnRow[];
  largestToolResults: ToolResultRow[];
  contextJumps: ContextJumpRow[];
  tools: ToolActivityReport;
  events: AuditEvent[];
  drilldown?: DrilldownResult;
  assumptions: string[];
  warnings: string[];
  /** Fields this session's sources cannot answer, and why. */
  unavailable: string[];
  bounds: {
    maxTurns?: number;
    turnsOmitted: number;
    topToolResults: number;
    topContextJumps: number;
    topTools: number;
  };
}

/* ----------------------------- log scanning ------------------------------ */

type Row = Record<string, any>;

function isRecord(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function emptyUsage(): AuditUsage {
  return {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    processedInputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
  };
}

function addUsage(into: AuditUsage, from: AuditUsage): void {
  into.uncachedInputTokens += from.uncachedInputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  into.processedInputTokens += from.processedInputTokens;
  into.outputTokens += from.outputTokens;
  into.costUSD += from.costUSD;
  if (from.reasoningTokens !== undefined)
    into.reasoningTokens = (into.reasoningTokens ?? 0) + from.reasoningTokens;
}

/** `AgentUsage` (app log) → the report's usage names. */
function usageFromLog(raw: unknown): AuditUsage {
  const u = isRecord(raw) ? raw : {};
  const uncached = num(u.inputTokens);
  const cacheRead = num(u.cacheReadTokens);
  const cacheWrite = num(u.cacheCreationTokens);
  return {
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    processedInputTokens: uncached + cacheRead + cacheWrite,
    outputTokens: num(u.outputTokens),
    costUSD: num(u.costUSD),
  };
}

/** Characters of the text-bearing blocks of one content array, by kind. */
interface BlockSizes {
  text: number;
  thinking: number;
  toolCallArgs: number;
  toolCalls: { name: string; chars: number }[];
  attachments: { role?: string; size: number; textLike: boolean }[];
}

/**
 * Whether an attachment's BYTES can honestly be read as characters. The log
 * stores a reference and a byte size, never the body: for a text-like file
 * (the inlined Task/Project/Knowledge context, a `.txt`/`.md`/`.json` upload)
 * bytes ≈ characters and the usual divisor applies. For anything else — a PNG
 * screenshot is the common case — bytes have NO relation to what the model is
 * charged (image tokens scale with pixels, roughly `w·h/750`), so those sizes
 * are reported in their own row and never tokenized.
 */
function isTextLikeAttachment(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeType.toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

function blockSizes(content: unknown): BlockSizes {
  const out: BlockSizes = {
    text: 0,
    thinking: 0,
    toolCallArgs: 0,
    toolCalls: [],
    attachments: [],
  };
  if (!Array.isArray(content)) return out;
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type === "text") out.text += (str(raw.text) ?? "").length;
    else if (raw.type === "thinking")
      out.thinking += (str(raw.text) ?? "").length;
    else if (raw.type === "toolCall") {
      const name = str(raw.name) ?? "unknown";
      let chars = name.length;
      try {
        chars += JSON.stringify(raw.input ?? raw.arguments ?? null).length;
      } catch {
        chars += 0;
      }
      out.toolCallArgs += chars;
      out.toolCalls.push({ name, chars });
    } else if (raw.type === "image") {
      const roleValue = str(raw.role);
      out.attachments.push({
        ...(str(raw.role)
          ? { ...(roleValue !== undefined ? { role: roleValue } : {}) }
          : {}),
        size: num(raw.size),
        textLike: isTextLikeAttachment(str(raw.mimeType)),
      });
    }
  }
  return out;
}

/** Names a tool result reports as newly loaded (pi `find_tools`, Claude ToolSearch). */
function activatedToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const raw of content) {
    if (!isRecord(raw) || raw.type !== "text") continue;
    const text = str(raw.text) ?? "";
    if (!text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    // pi's find_tools result.
    if (Array.isArray(parsed.loaded))
      for (const name of parsed.loaded) if (str(name)) names.push(str(name)!);
    // Claude's native ToolSearch reference result.
    if (parsed.type === "tool_reference" && str(parsed.tool_name))
      names.push(str(parsed.tool_name)!);
  }
  return names;
}

/** Everything one pass over the app log yields. */
interface LogScan {
  available: boolean;
  lines: number;
  bytes: number;
  turns: MutableTurn[];
  toolResults: ToolResultRow[];
  events: AuditEvent[];
  contributors: Record<ContributorCategory, { chars: number; items: number }>;
  toolCallCounts: Map<string, number>;
  firstAtMs?: number;
  lastAtMs?: number;
  generationMs: number;
  /** Assistant entries that carried a generation span at all. */
  generationSpans: number;
  /**
   * Cost in MICROS, rounded per assistant entry and summed as integers — the
   * accumulation a pi session's persisted total was built by
   * (`recordUsageTurn` → `addUsageTotals`).
   */
  costMicros: number;
  /**
   * The same costs summed as FLOATS in entry order, for the other accumulation
   * regime (see {@link CostAccumulation}). Kept flat rather than derived from
   * the per-turn sums because floating addition is not associative.
   */
  costUsdSum: number;
  /** Entries the store would have counted as a usage turn (`usageDelta.hasUsage`). */
  usageBearingRuns: number;
  /** The last `contextWindowTokens` any run reported. */
  contextWindow?: number;
  compactions: number;
  malformed: number;
  drilldown?: DrilldownResult;
}

interface MutableTurn {
  index: number;
  startedAt?: string;
  origin?: string;
  hiddenPrompt: boolean;
  startMs?: number;
  endMs?: number;
  assistantRuns: number;
  toolCalls: number;
  failedToolResults: number;
  usage: AuditUsage;
  contextAfter?: number;
  contextBasis?: "reported" | "prompt-token-sum";
  toolResultBytes: number;
  toolsActivated: string[];
  failure?: string;
  compacted: boolean;
  /** Tool names called, in order, for context-jump attribution. */
  calledTools: string[];
}

function newTurn(index: number): MutableTurn {
  return {
    index,
    hiddenPrompt: false,
    assistantRuns: 0,
    toolCalls: 0,
    failedToolResults: 0,
    usage: emptyUsage(),
    toolResultBytes: 0,
    toolsActivated: [],
    compacted: false,
    calledTools: [],
  };
}

function scanLog(
  logPath: string,
  drilldownEntryId: string | undefined,
): LogScan {
  const contributors = {
    "system-prompt": { chars: 0, items: 0 },
    "tool-definitions": { chars: 0, items: 0 },
    "user-content": { chars: 0, items: 0 },
    "context-attachments": { chars: 0, items: 0 },
    "binary-attachments": { chars: 0, items: 0 },
    "injected-context": { chars: 0, items: 0 },
    "tool-call-arguments": { chars: 0, items: 0 },
    "tool-results": { chars: 0, items: 0 },
    reasoning: { chars: 0, items: 0 },
    "assistant-text": { chars: 0, items: 0 },
  } as LogScan["contributors"];

  const scan: LogScan = {
    available: true,
    lines: 0,
    bytes: 0,
    turns: [],
    toolResults: [],
    events: [],
    contributors,
    toolCallCounts: new Map(),
    generationMs: 0,
    generationSpans: 0,
    costMicros: 0,
    costUsdSum: 0,
    usageBearingRuns: 0,
    compactions: 0,
    malformed: 0,
  };

  // The report opens a turn at the first entry even when a session's log starts
  // with a host-command card (a provisioned worktree) rather than a prompt.
  let turn = newTurn(1);
  scan.turns.push(turn);
  let turnOpened = false;
  const toolNameByCallId = new Map<string, string>();

  const track = (ms: number | undefined): void => {
    if (ms === undefined || Number.isNaN(ms)) return;
    scan.firstAtMs = Math.min(scan.firstAtMs ?? ms, ms);
    scan.lastAtMs = Math.max(scan.lastAtMs ?? ms, ms);
  };

  // The file's real size, not a per-line sum: a log without a trailing newline
  // would otherwise read one byte long.
  scan.bytes = statSync(logPath).size;

  forEachJsonlLine(logPath, 0, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return "continue";
    let row: Row;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) return "continue";
      row = parsed;
    } catch {
      scan.malformed += 1;
      return "continue";
    }
    // The header line carries `v` but no entry type/seq.
    if (typeof row.type !== "string" || typeof row.seq !== "number")
      return "continue";
    scan.lines += 1;
    const createdAt = str(row.createdAt);
    track(createdAt ? Date.parse(createdAt) : undefined);

    if (row.type === "message" && row.role === "user") {
      // A user prompt starts a turn; the first one adopts the pre-opened row.
      if (turnOpened) {
        turn = newTurn(scan.turns.length + 1);
        scan.turns.push(turn);
      }
      turnOpened = true;
      if (createdAt !== undefined) turn.startedAt = createdAt;
      if (createdAt) turn.startMs = Date.parse(createdAt);
      const origin = str(isRecord(row.origin) ? row.origin.kind : undefined);
      if (origin !== undefined) turn.origin = origin;
      turn.hiddenPrompt = row.hidden === true;
      const sizes = blockSizes(row.content);
      const bucket = row.hidden === true ? "injected-context" : "user-content";
      contributors[bucket].chars += sizes.text;
      contributors[bucket].items += 1;
      for (const attachment of sizes.attachments) {
        // Bytes only convert to characters for a text-like file; anything else
        // gets its own row so it cannot skew a share or the estimated total.
        const category = !attachment.textLike
          ? "binary-attachments"
          : attachment.role
            ? "context-attachments"
            : "user-content";
        contributors[category].chars += attachment.size;
        contributors[category].items += 1;
      }
      if (drilldownEntryId && str(row.id) === drilldownEntryId)
        scan.drilldown = {
          target: drilldownEntryId,
          found: true,
          entryId: drilldownEntryId,
          role: "user",
          turn: turn.index,
          ...(createdAt ? { at: createdAt } : {}),
          blocks: drilldownBlocks(row.content),
        };
      return "continue";
    }

    if (row.type === "message" && row.role === "assistant") {
      turnOpened = true;
      turn.assistantRuns += 1;
      const usage = usageFromLog(row.usage);
      addUsage(turn.usage, usage);
      // Cost is accumulated BOTH ways at once (see {@link CostAccumulation}):
      // the harnesses persist it under different regimes, and the agreement
      // check reconciles against whichever one this session was stored under.
      // The usage-turn counter mirrors `usageDelta.hasUsage`.
      const hasCost =
        isRecord(row.usage) && typeof row.usage.costUSD === "number";
      // `usageDelta.totalTokens`: input + output + cache read + cache write.
      const totalTokens = usage.processedInputTokens + usage.outputTokens;
      if (totalTokens > 0 || hasCost) {
        scan.usageBearingRuns += 1;
        if (hasCost) {
          scan.costMicros += Math.round(usage.costUSD * 1_000_000);
          scan.costUsdSum += usage.costUSD;
        }
      }
      // Occupancy after this run: the harness snapshot when it reports one,
      // else the run's prompt-token sum — the same fallback the persisted
      // stats use, flagged so the two are never confused.
      const reported = isRecord(row.usage)
        ? num(row.usage.contextTokens) || undefined
        : undefined;
      const context = reported ?? (usage.processedInputTokens || undefined);
      if (context !== undefined) {
        turn.contextAfter = context;
        turn.contextBasis =
          reported !== undefined ? "reported" : "prompt-token-sum";
      }
      const window = isRecord(row.usage)
        ? num(row.usage.contextWindowTokens) || undefined
        : undefined;
      if (window !== undefined) scan.contextWindow = window;
      const started = str(row.startedAt);
      const completed = str(row.completedAt) ?? createdAt;
      if (started && completed) {
        const span = Date.parse(completed) - Date.parse(started);
        if (Number.isFinite(span) && span >= 0) {
          scan.generationMs += span;
          scan.generationSpans += 1;
        }
        track(Date.parse(started));
      }
      // Only a completed row moves endMs; otherwise the previous value stands.
      if (completed) turn.endMs = Date.parse(completed);
      const sizes = blockSizes(row.content);
      contributors["assistant-text"].chars += sizes.text;
      contributors["assistant-text"].items += 1;
      contributors.reasoning.chars += sizes.thinking;
      if (sizes.thinking > 0) contributors.reasoning.items += 1;
      contributors["tool-call-arguments"].chars += sizes.toolCallArgs;
      contributors["tool-call-arguments"].items += sizes.toolCalls.length;
      turn.toolCalls += sizes.toolCalls.length;
      for (const call of sizes.toolCalls) {
        turn.calledTools.push(call.name);
        scan.toolCallCounts.set(
          call.name,
          (scan.toolCallCounts.get(call.name) ?? 0) + 1,
        );
      }
      for (const raw of Array.isArray(row.content) ? row.content : []) {
        if (isRecord(raw) && raw.type === "toolCall" && str(raw.toolCallId))
          toolNameByCallId.set(
            str(raw.toolCallId)!,
            str(raw.name) ?? "unknown",
          );
      }
      const error = str(row.error);
      const stopReason = str(row.stopReason);
      if (error || stopReason === "error" || stopReason === "aborted") {
        turn.failure = error ?? `stopReason: ${stopReason}`;
        scan.events.push({
          kind: "run-failure",
          turn: turn.index,
          ...(createdAt ? { at: createdAt } : {}),
          detail: turn.failure.slice(0, 200),
        });
      }
      if (drilldownEntryId && str(row.id) === drilldownEntryId)
        scan.drilldown = {
          target: drilldownEntryId,
          found: true,
          entryId: drilldownEntryId,
          role: "assistant",
          turn: turn.index,
          ...(createdAt ? { at: createdAt } : {}),
          blocks: drilldownBlocks(row.content),
          usage,
          ...(context !== undefined ? { contextAfter: context } : {}),
          toolCalls: sizes.toolCalls.map((call) => call.name),
        };
      return "continue";
    }

    if (row.type === "message" && row.role === "toolResult") {
      turnOpened = true;
      const callId = str(row.toolCallId) ?? "";
      const toolName =
        str(row.toolName) ?? toolNameByCallId.get(callId) ?? "unknown";
      let chars = 0;
      for (const raw of Array.isArray(row.content) ? row.content : []) {
        if (isRecord(raw) && raw.type === "text")
          chars += (str(raw.text) ?? "").length;
      }
      contributors["tool-results"].chars += chars;
      contributors["tool-results"].items += 1;
      turn.toolResultBytes += chars;
      const isError = row.isError === true;
      if (isError) turn.failedToolResults += 1;
      scan.toolResults.push({
        entryId: str(row.id) ?? callId,
        toolName,
        turn: turn.index,
        bytes: chars,
        estTokens: estTokens(chars),
        isError,
      });
      // Activations are recorded under the BARE tool name, the same spelling
      // the turn rows and the tool table use; the wire name a Claude
      // ToolSearch result carries would otherwise read as a second tool.
      for (const wireName of activatedToolNames(row.content)) {
        const name = bareToolName(wireName);
        if (turn.toolsActivated.includes(name)) continue;
        turn.toolsActivated.push(name);
        scan.events.push({
          kind: "tool-activation",
          turn: turn.index,
          ...(createdAt ? { at: createdAt } : {}),
          detail: name,
        });
      }
      if (drilldownEntryId && str(row.id) === drilldownEntryId)
        scan.drilldown = {
          target: drilldownEntryId,
          found: true,
          entryId: drilldownEntryId,
          role: "toolResult",
          turn: turn.index,
          ...(createdAt ? { at: createdAt } : {}),
          blocks: [
            {
              kind: "toolResult",
              name: toolName,
              chars,
              estTokens: estTokens(chars),
            },
          ],
        };
      return "continue";
    }

    if (row.type === "command.result") {
      const card = isRecord(row.card) ? row.card : {};
      const name = str(row.name) ?? "command";
      if (card.kind === "compaction") {
        const compaction = isRecord(card.compaction) ? card.compaction : {};
        scan.compactions += 1;
        turn.compacted = true;
        const before = num(compaction.tokensBefore);
        const after = num(compaction.tokensAfter);
        scan.events.push({
          kind: "compaction",
          turn: turn.index,
          ...(createdAt ? { at: createdAt } : {}),
          detail: after
            ? `context ${before} → ${after} tokens`
            : `context ${before} tokens replaced by a summary`,
        });
      } else {
        scan.events.push({
          kind: "host-command",
          turn: turn.index,
          ...(createdAt ? { at: createdAt } : {}),
          detail: `/${name}`,
        });
      }
      return "continue";
    }
    return "continue";
  });

  // A log whose first entry never opened a turn leaves the pre-opened row empty.
  if (!turnOpened) scan.turns = [];
  return scan;
}

function drilldownBlocks(content: unknown): DrilldownBlock[] {
  if (!Array.isArray(content)) return [];
  const out: DrilldownBlock[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const kind = str(raw.type) ?? "unknown";
    let chars = 0;
    let name: string | undefined;
    if (kind === "text" || kind === "thinking")
      chars = (str(raw.text) ?? "").length;
    else if (kind === "toolCall") {
      // Same accounting as the `tool-call-arguments` contributor: the wire cost
      // of a call is its name plus its serialized arguments.
      name = str(raw.name);
      chars = (name ?? "").length;
      try {
        chars += JSON.stringify(raw.input ?? raw.arguments ?? null).length;
      } catch {
        // An unserializable argument contributes its name only.
      }
    } else if (kind === "image") {
      name = str(raw.name);
      chars = num(raw.size);
    }
    out.push({
      kind,
      ...(name ? { name } : {}),
      chars,
      estTokens: estTokens(chars),
    });
  }
  return out;
}

/* -------------------------- provider-call scanning ------------------------ */

/** One resolved provider request. */
interface ProviderCall {
  usage: AuditUsage;
  /** Occupancy the provider read for this request (its processed prompt side). */
  contextTokens: number;
  toolCalls: string[];
  atMs?: number;
}

interface CallScan {
  calls: ProviderCall[];
  resolvesCalls: boolean;
  /** Whether the transcript records a per-call cost at all. */
  costReported: boolean;
  malformed: number;
}

/** pi's `native.jsonl`: one assistant message per provider call. */
function scanPiNative(path: string): CallScan {
  const calls: ProviderCall[] = [];
  let malformed = 0;
  forEachJsonlLine(path, 0, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return "continue";
    let row: Row;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) return "continue";
      row = parsed;
    } catch {
      malformed += 1;
      return "continue";
    }
    if (row.type !== "message") return "continue";
    const message = isRecord(row.message) ? row.message : {};
    if (message.role !== "assistant") return "continue";
    const raw = isRecord(message.usage) ? message.usage : {};
    const uncached = num(raw.input);
    const cacheRead = num(raw.cacheRead);
    const cacheWrite = num(raw.cacheWrite);
    const cost = isRecord(raw.cost) ? num(raw.cost.total) : 0;
    const timestamp = str(row.timestamp);
    calls.push({
      usage: {
        uncachedInputTokens: uncached,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        processedInputTokens: uncached + cacheRead + cacheWrite,
        outputTokens: num(raw.output),
        reasoningTokens: num(raw.reasoning),
        costUSD: cost,
      },
      contextTokens: uncached + cacheRead + cacheWrite,
      toolCalls: (Array.isArray(message.content) ? message.content : [])
        .filter(
          (block: unknown) => isRecord(block) && block.type === "toolCall",
        )
        .map((block: Row) => str(block.name) ?? "unknown"),
      ...(timestamp ? { atMs: Date.parse(timestamp) } : {}),
    });
    return "continue";
  });
  return { calls, resolvesCalls: true, costReported: true, malformed };
}

/**
 * The Claude CLI transcript: one `assistant` line per provider response, keyed
 * by `requestId` so a response split across lines counts once. Sidechain
 * (subagent) lines are a different conversation and are skipped.
 */
function scanClaudeTranscript(path: string): CallScan {
  const calls: ProviderCall[] = [];
  const byRequest = new Map<string, ProviderCall>();
  let malformed = 0;
  forEachJsonlLine(path, 0, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return "continue";
    let row: Row;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) return "continue";
      row = parsed;
    } catch {
      malformed += 1;
      return "continue";
    }
    if (row.type !== "assistant" || row.isSidechain === true) return "continue";
    const message = isRecord(row.message) ? row.message : {};
    const raw = isRecord(message.usage) ? message.usage : {};
    const requestId = str(row.requestId);
    let call = requestId ? byRequest.get(requestId) : undefined;
    if (!call) {
      const uncached = num(raw.input_tokens);
      const cacheRead = num(raw.cache_read_input_tokens);
      const cacheWrite = num(raw.cache_creation_input_tokens);
      const timestamp = str(row.timestamp);
      call = {
        usage: {
          uncachedInputTokens: uncached,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          processedInputTokens: uncached + cacheRead + cacheWrite,
          outputTokens: num(raw.output_tokens),
          costUSD: num(row.costUSD),
        },
        contextTokens: uncached + cacheRead + cacheWrite,
        toolCalls: [],
        ...(timestamp ? { atMs: Date.parse(timestamp) } : {}),
      };
      calls.push(call);
      if (requestId) byRequest.set(requestId, call);
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (isRecord(block) && block.type === "tool_use")
        call.toolCalls.push(str(block.name) ?? "unknown");
    }
    return "continue";
  });
  // The CLI transcript records tokens but no cost; the app log's per-turn
  // `costUSD` stays the only cost source for a Claude session.
  return { calls, resolvesCalls: true, costReported: false, malformed };
}

function scanCallTranscript(
  transcript: { source: AuditCallSource; path: string } | undefined,
): CallScan | undefined {
  if (!transcript) return undefined;
  if (transcript.source === "pi-native") return scanPiNative(transcript.path);
  if (transcript.source === "claude-transcript")
    return scanClaudeTranscript(transcript.path);
  // `claude-sdk/<id>.json` holds whole turns, so it adds nothing the app log
  // does not already have; it is reported as not resolving calls.
  return { calls: [], resolvesCalls: false, costReported: false, malformed: 0 };
}

/* ------------------------------ tool activity ----------------------------- */

const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function bareToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** Definition size of one catalog tool, in the `measure:prompts` accounting. */
function definitionChars(tool: {
  name: string;
  description: string;
  parameters: unknown;
  wireName: string;
}): number {
  let schema = 0;
  try {
    schema = JSON.stringify(tool.parameters).length;
  } catch {
    schema = 0;
  }
  return tool.wireName.length + tool.description.length + schema;
}

function buildToolActivity(
  meta: AuditSessionMeta,
  conditions: PromptConditions | undefined,
  turns: MutableTurn[],
  callCounts: Map<string, number>,
  topTools: number,
  inventory: AuditToolInventory | undefined,
): { report: ToolActivityReport; eagerDefChars: number } {
  const persona =
    inventory && isAgentType(meta.agentType) ? meta.agentType : undefined;
  const claudeWire = meta.harness === "claude-sdk";
  const rows: ToolActivityRow[] = [];
  const callsNotInThisCatalog: Record<string, number> = {};
  const counts = new Map<string, number>();
  for (const [name, count] of callCounts)
    counts.set(
      bareToolName(name),
      (counts.get(bareToolName(name)) ?? 0) + count,
    );

  const activatedInTurn = new Map<string, number>();
  for (const turn of turns)
    for (const name of turn.toolsActivated) {
      const bare = bareToolName(name);
      if (!activatedInTurn.has(bare)) activatedInTurn.set(bare, turn.index);
    }

  let eagerCount = 0;
  let eagerDefChars = 0;
  let activatedCount = 0;
  let activatedDefChars = 0;
  let unusedCount = 0;
  let unusedDefChars = 0;
  const known = new Set<string>();

  if (persona && inventory) {
    const eagerNames = inventory.eagerToolNames(persona, conditions);
    for (const tool of inventory.toolsFor(persona)) {
      known.add(tool.name);
      const wireName = claudeWire ? `${MCP_PREFIX}${tool.name}` : tool.name;
      const defChars = definitionChars({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        wireName,
      });
      const calls = counts.get(tool.name) ?? 0;
      const eager = eagerNames.has(tool.name);
      const activatedTurn = activatedInTurn.get(tool.name);
      const loaded: ToolActivityRow["loaded"] = eager
        ? "session-start"
        : activatedTurn !== undefined || calls > 0
          ? "activated"
          : "never";
      if (eager) {
        eagerCount += 1;
        eagerDefChars += defChars;
      } else if (loaded === "activated") {
        activatedCount += 1;
        activatedDefChars += defChars;
      }
      if (loaded !== "never" && calls === 0) {
        unusedCount += 1;
        unusedDefChars += defChars;
      }
      rows.push({
        name: tool.name,
        group: tool.group,
        loading: tool.loading,
        defChars,
        defEstTokens: estTokens(defChars),
        calls,
        loaded,
        ...(activatedTurn !== undefined
          ? { activatedInTurn: activatedTurn }
          : {}),
      });
    }
    // pi appends its loader to every session; it is eager and always present.
    if (meta.harness === "pi") {
      eagerCount += 1;
      const calls = counts.get(FIND_TOOLS_NAME) ?? 0;
      rows.push({
        name: FIND_TOOLS_NAME,
        group: "loader",
        loading: "eager",
        defChars: 0,
        defEstTokens: 0,
        calls,
        loaded: "session-start",
      });
      known.add(FIND_TOOLS_NAME);
    }
  }

  for (const [name, count] of counts)
    if (!known.has(name)) callsNotInThisCatalog[name] = count;

  // Called tools first (largest first), then the loaded-but-unused definitions:
  // the two questions the report exists to answer.
  const ordered = rows
    .filter((row) => row.calls > 0 || row.loaded !== "never")
    .sort((a, b) => b.calls - a.calls || b.defChars - a.defChars)
    .slice(0, topTools);

  return {
    eagerDefChars,
    report: {
      eagerCount,
      eagerDefChars,
      eagerDefEstTokens: estTokens(eagerDefChars),
      activatedCount,
      activatedDefChars,
      unusedCount,
      unusedDefChars,
      unusedDefEstTokens: estTokens(unusedDefChars),
      callsNotInThisCatalog,
      rows: ordered,
    },
  };
}

/* ------------------------------- the report ------------------------------- */

/** Static system-prompt characters for this persona, in THIS checkout. */
function systemPromptChars(
  meta: AuditSessionMeta,
  conditions: PromptConditions | undefined,
): number {
  if (!isAgentType(meta.agentType)) return 0;
  try {
    return personaPromptInventory(meta.agentType, {
      ...(conditions ? { conditions } : {}),
    }).chars;
  } catch {
    // A persona whose prompt assets cannot be resolved here is reported as 0
    // with the row's `note` saying so, rather than failing the whole audit.
    return 0;
  }
}

/**
 * The contributor table: the two STATIC rows measured against this checkout,
 * then one row per measured category, each with its share of the estimated
 * total. Shares are computed here so no caller can publish a table whose
 * percentages do not add up.
 */
function buildContributors(
  measuredChars: LogScan["contributors"],
  promptChars: number,
  toolDefChars: number,
  toolDefCount: number,
): ContributorRow[] {
  const rows: ContributorRow[] = [
    {
      category: "system-prompt",
      chars: promptChars,
      estTokens: estTokens(promptChars),
      share: 0,
      basis: "current-checkout",
      items: 1,
      note: "persona prompt layers as they are TODAY, sent once per REQUEST; excludes the harness's own base prompt, its builtin tool definitions and project-context files (`pnpm run measure:prompts` prices those)",
    },
    {
      category: "tool-definitions",
      chars: toolDefChars,
      estTokens: estTokens(toolDefChars),
      share: 0,
      basis: "current-checkout",
      items: toolDefCount,
      note: "eager tier at session start plus every definition activated later",
    },
  ];
  const measured: [ContributorCategory, ContributorBasis, string?][] = [
    ["user-content", "transcript-chars"],
    [
      "context-attachments",
      "attachment-bytes",
      "Task/Project/Knowledge context inlined into a prompt",
    ],
    [
      "binary-attachments",
      "attachment-bytes",
      "images and other non-text uploads: BYTES, deliberately not converted to tokens (image tokens scale with pixels, roughly w·h/750) and therefore excluded from the share column",
    ],
    ["injected-context", "transcript-chars", "hidden prompts (memory, system)"],
    ["tool-call-arguments", "transcript-chars"],
    ["tool-results", "transcript-chars"],
    ["reasoning", "transcript-chars", "thinking text the log retained"],
    ["assistant-text", "transcript-chars"],
  ];
  for (const [category, basis, note] of measured) {
    const bucket = measuredChars[category];
    rows.push({
      category,
      chars: bucket.chars,
      // Binary attachment bytes do not convert; leaving them at zero keeps them
      // out of every share and out of `estimatedTotalTokens`.
      estTokens:
        category === "binary-attachments" ? 0 : estTokens(bucket.chars),
      share: 0,
      basis,
      items: bucket.items,
      ...(note ? { note } : {}),
    });
  }
  const total = rows.reduce((n, row) => n + row.estTokens, 0);
  for (const row of rows)
    row.share =
      total > 0 ? Math.round((row.estTokens / total) * 1000) / 1000 : 0;
  return rows;
}

/**
 * One row per turn, carrying the running occupancy delta and the size of the
 * tool definitions ACTIVE at that boundary: the eager tier the session started
 * with, grown by every definition activated up to and including this turn.
 */
function buildTurnRows(
  meta: AuditSessionMeta,
  conditions: PromptConditions | undefined,
  turns: MutableTurn[],
  calls: ProviderCall[],
  inventory: AuditToolInventory | undefined,
): TurnRow[] {
  const persona =
    inventory && isAgentType(meta.agentType) ? meta.agentType : undefined;
  const wireName = (name: string): string =>
    meta.harness === "claude-sdk" ? `${MCP_PREFIX}${name}` : name;
  const activeNames = new Set<string>();
  const defCharsByName = new Map<string, number>();
  if (persona && inventory) {
    for (const name of inventory.eagerToolNames(persona, conditions))
      activeNames.add(name);
    if (meta.harness === "pi") activeNames.add(FIND_TOOLS_NAME);
    for (const tool of inventory.toolsFor(persona))
      defCharsByName.set(
        tool.name,
        definitionChars({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          wireName: wireName(tool.name),
        }),
      );
  }
  const activeChars = (): number => {
    let sum = 0;
    for (const name of activeNames) sum += defCharsByName.get(name) ?? 0;
    return sum;
  };

  // Provider calls per turn, resolved once by timestamp rather than per row.
  const callsPerTurn = new Map<number, number>();
  for (const call of calls) {
    const index = turnOfCall(turns, call.atMs);
    callsPerTurn.set(index, (callsPerTurn.get(index) ?? 0) + 1);
  }

  const rows: TurnRow[] = [];
  let previousContext: number | undefined;
  for (const turn of turns) {
    for (const name of turn.toolsActivated) activeNames.add(bareToolName(name));
    const contextDelta =
      turn.contextAfter !== undefined && previousContext !== undefined
        ? turn.contextAfter - previousContext
        : undefined;
    if (turn.contextAfter !== undefined) previousContext = turn.contextAfter;
    rows.push({
      index: turn.index,
      ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
      ...(turn.origin ? { origin: turn.origin } : {}),
      ...(turn.hiddenPrompt ? { hiddenPrompt: true } : {}),
      ...(turn.startMs !== undefined && turn.endMs !== undefined
        ? { elapsedMs: Math.max(0, turn.endMs - turn.startMs) }
        : {}),
      ...(calls.length > 0
        ? { providerCalls: callsPerTurn.get(turn.index) ?? 0 }
        : {}),
      toolCalls: turn.toolCalls,
      failedToolResults: turn.failedToolResults,
      usage: turn.usage,
      ...(turn.contextAfter !== undefined
        ? { contextAfter: turn.contextAfter }
        : {}),
      ...(contextDelta !== undefined ? { contextDelta } : {}),
      toolResultBytes: turn.toolResultBytes,
      toolsActivated: turn.toolsActivated.map(bareToolName),
      activeToolCount: activeNames.size,
      activeToolEstTokens: estTokens(activeChars()),
      ...(turn.failure ? { failure: turn.failure.slice(0, 200) } : {}),
      ...(turn.compacted ? { compacted: true } : {}),
    });
  }
  return rows;
}

function contextJumps(
  calls: ProviderCall[],
  turns: MutableTurn[],
  top: number,
): ContextJumpRow[] {
  const rows: ContextJumpRow[] = [];
  if (calls.length > 1) {
    for (let i = 1; i < calls.length; i++) {
      const previous = calls[i - 1]!;
      const current = calls[i]!;
      // A request with no usage (an aborted or errored call) is not a baseline:
      // measuring "growth" from zero would invent the session's biggest jump.
      if (previous.contextTokens <= 0 || current.contextTokens <= 0) continue;
      const delta = current.contextTokens - previous.contextTokens;
      if (delta <= 0) continue;
      rows.push({
        at: i + 1,
        scope: "provider-call",
        turn: turnOfCall(turns, current.atMs),
        fromTokens: previous.contextTokens,
        toTokens: current.contextTokens,
        deltaTokens: delta,
        precededBy: [...new Set(previous.toolCalls)].slice(0, 6),
        precedingOutputTokens: previous.usage.outputTokens,
      });
    }
  } else {
    // No per-call transcript: the turn boundaries are the finest resolution the
    // app log offers, and the jump is then a whole turn's growth.
    let previous: { turn: MutableTurn; context: number } | undefined;
    for (const turn of turns) {
      if (turn.contextAfter === undefined) continue;
      if (previous) {
        const delta = turn.contextAfter - previous.context;
        if (delta > 0)
          rows.push({
            at: turn.index,
            scope: "turn",
            turn: turn.index,
            fromTokens: previous.context,
            toTokens: turn.contextAfter,
            deltaTokens: delta,
            precededBy: [...new Set(turn.calledTools)]
              .map(bareToolName)
              .slice(0, 6),
            precedingOutputTokens: turn.usage.outputTokens,
          });
      }
      previous = { turn, context: turn.contextAfter };
    }
  }
  return rows.sort((a, b) => b.deltaTokens - a.deltaTokens).slice(0, top);
}

/**
 * The turn a provider request belongs to, by timestamp. A request that predates
 * the first turn's prompt (a session-start request, a log whose first prompt
 * lost its timestamp) is attributed to the FIRST turn rather than to a turn 0
 * that no row renders — otherwise per-turn `providerCalls` would silently sum
 * to less than `totals.providerCalls`. Returns 0 only when there is no turn to
 * attribute to at all; callers count those as unattributed.
 */
function turnOfCall(turns: MutableTurn[], atMs: number | undefined): number {
  const first = turns[0]?.index ?? 0;
  if (atMs === undefined || Number.isNaN(atMs)) return 0;
  let index = 0;
  for (const turn of turns) {
    if (turn.startMs !== undefined && turn.startMs <= atMs) index = turn.index;
  }
  return index === 0 ? first : index;
}

function persistedAgreement(
  totals: AuditTotals,
  persisted: PersistedUsageTotals,
): {
  agrees: boolean;
  differences: UsageAgreement[];
  costAccumulation?: CostAccumulation;
  comparedFields: string[];
} {
  // Cost reconciles against EITHER accumulation, which is exact and needs no
  // knowledge of the harness here; the matching one is named for the reader.
  const persistedCost = persisted.costMicros ?? 0;
  const costAccumulation: CostAccumulation | undefined =
    totals.costMicros === persistedCost
      ? "per-entry"
      : totals.costMicrosSingleRounding === persistedCost
        ? "single-rounding"
        : undefined;
  const compare: UsageAgreement[] = [
    {
      field: "uncachedInputTokens",
      report: totals.uncachedInputTokens,
      persisted: persisted.inputTokens,
      delta: totals.uncachedInputTokens - persisted.inputTokens,
    },
    {
      field: "outputTokens",
      report: totals.outputTokens,
      persisted: persisted.outputTokens,
      delta: totals.outputTokens - persisted.outputTokens,
    },
    {
      field: "cacheReadTokens",
      report: totals.cacheReadTokens,
      persisted: persisted.cacheReadTokens,
      delta: totals.cacheReadTokens - persisted.cacheReadTokens,
    },
    {
      field: "cacheWriteTokens",
      report: totals.cacheWriteTokens,
      persisted: persisted.cacheWriteTokens,
      delta: totals.cacheWriteTokens - persisted.cacheWriteTokens,
    },
    {
      field: "costMicros",
      report:
        costAccumulation === "single-rounding"
          ? totals.costMicrosSingleRounding
          : totals.costMicros,
      persisted: persistedCost,
      delta:
        (costAccumulation === "single-rounding"
          ? totals.costMicrosSingleRounding
          : totals.costMicros) - persistedCost,
      ...(costAccumulation === undefined
        ? { alternative: totals.costMicrosSingleRounding }
        : {}),
    },
    {
      field: "contextTokens",
      report: totals.latestContext.tokens ?? 0,
      persisted: persisted.contextTokens ?? 0,
      delta:
        (totals.latestContext.tokens ?? 0) - (persisted.contextTokens ?? 0),
    },
  ];
  // `usageTurns`/`assistantTurns` are deliberately NOT compared: pi increments
  // them per app-log assistant entry, but `claudeSdkStore` derives them from
  // the SDK RECORD's entries, which is a different population — on the live
  // data dir 27 Claude sessions differ there while every token figure matches.
  // The persisted values are still returned in `persisted.totals`; the report's
  // own count is `totals.usageBearingRuns`.
  const differences = compare.filter((row) => row.delta !== 0);
  return {
    agrees: differences.length === 0,
    differences,
    ...(costAccumulation ? { costAccumulation } : {}),
    comparedFields: compare.map((row) => row.field),
  };
}

/**
 * Build the report for one resolved session. Pure over its {@link
 * SessionAuditSource}: it reads the two files the source names and nothing else,
 * so a committed fixture produces a byte-identical report.
 */
export function auditSession(
  source: SessionAuditSource,
  options: SessionAuditOptions = {},
): SessionAuditReport {
  const topToolResults = options.topToolResults ?? 5;
  const topContextJumps = options.topContextJumps ?? 5;
  const topTools = options.topTools ?? 15;
  const warnings = [...(source.warnings ?? [])];
  const unavailable: string[] = [];
  /** Assumptions that only apply to this session's sources. */
  const assumptionsExtra: string[] = [];

  let scan: LogScan;
  try {
    scan = scanLog(source.logPath, options.drilldown?.entryId);
  } catch (err) {
    scan = {
      available: false,
      lines: 0,
      bytes: 0,
      turns: [],
      toolResults: [],
      events: [],
      contributors: {
        "system-prompt": { chars: 0, items: 0 },
        "tool-definitions": { chars: 0, items: 0 },
        "user-content": { chars: 0, items: 0 },
        "context-attachments": { chars: 0, items: 0 },
        "binary-attachments": { chars: 0, items: 0 },
        "injected-context": { chars: 0, items: 0 },
        "tool-call-arguments": { chars: 0, items: 0 },
        "tool-results": { chars: 0, items: 0 },
        reasoning: { chars: 0, items: 0 },
        "assistant-text": { chars: 0, items: 0 },
      },
      toolCallCounts: new Map(),
      generationMs: 0,
      generationSpans: 0,
      costMicros: 0,
      costUsdSum: 0,
      usageBearingRuns: 0,
      compactions: 0,
      malformed: 0,
    };
    // Deliberately the error CODE, never the message: an ENOENT message
    // embeds the absolute DATA_DIR path, which this payload otherwise never
    // exposes to an agent. The missing-log case already has its own warning
    // from source resolution, so this one is not repeated for it.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT")
      warnings.push(
        `Conversation log could not be read (${code ?? "unreadable"}).`,
      );
    else if (warnings.length === 0)
      warnings.push("This session has no conversation log file.");
  }
  if (scan.malformed > 0)
    warnings.push(`Skipped ${scan.malformed} malformed log line(s).`);

  let callScan: CallScan | undefined;
  if (source.callTranscript) {
    try {
      callScan = scanCallTranscript(source.callTranscript);
    } catch (err) {
      warnings.push(
        `Provider transcript could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (callScan?.malformed)
    warnings.push(
      `Skipped ${callScan.malformed} malformed provider-transcript line(s).`,
    );
  const calls = callScan?.resolvesCalls ? callScan.calls : [];
  if (calls.length === 0) {
    unavailable.push(
      "providerCalls, per-call context jumps: no per-request transcript for this session (the app log records one assistant entry per TURN).",
    );
  }

  // Totals from the app log — the same per-turn usage the persisted session
  // stats were summed from, so the two must reconcile exactly.
  const totalsUsage = emptyUsage();
  let toolCalls = 0;
  let failedToolResults = 0;
  let failedRuns = 0;
  let assistantRuns = 0;
  let toolResultBytes = 0;
  let latestContext: number | undefined;
  let latestContextBasis: AuditContext["basis"];
  for (const turn of scan.turns) {
    addUsage(totalsUsage, turn.usage);
    toolCalls += turn.toolCalls;
    failedToolResults += turn.failedToolResults;
    assistantRuns += turn.assistantRuns;
    toolResultBytes += turn.toolResultBytes;
    if (turn.failure) failedRuns += 1;
    if (turn.contextAfter !== undefined) {
      latestContext = turn.contextAfter;
      latestContextBasis = turn.contextBasis;
    }
  }
  const contextWindow =
    scan.contextWindow ?? source.persistedUsage?.contextWindow;
  // Requests whose timestamp is missing entirely cannot be placed in a turn;
  // they still count in the session total, so the gap is reported rather than
  // left to be discovered as per-turn rows that do not add up.
  const unattributedCalls = calls.filter(
    (call) => call.atMs === undefined || Number.isNaN(call.atMs),
  ).length;
  const totals: AuditTotals = {
    ...totalsUsage,
    turns: scan.turns.length,
    assistantRuns,
    ...(calls.length > 0 ? { providerCalls: calls.length } : {}),
    ...(unattributedCalls > 0
      ? { providerCallsUnattributed: unattributedCalls }
      : {}),
    toolCalls,
    toolResults: scan.toolResults.length,
    failedToolResults,
    failedRuns,
    compactions: scan.compactions,
    latestContext: {
      ...(latestContext !== undefined ? { tokens: latestContext } : {}),
      ...(contextWindow ? { window: contextWindow } : {}),
      ...(latestContext !== undefined && contextWindow
        ? { percent: Math.min(100, (latestContext / contextWindow) * 100) }
        : {}),
      ...(latestContextBasis ? { basis: latestContextBasis } : {}),
    },
    elapsedMs:
      scan.firstAtMs !== undefined && scan.lastAtMs !== undefined
        ? scan.lastAtMs - scan.firstAtMs
        : 0,
    ...(scan.generationSpans > 0 ? { generationMs: scan.generationMs } : {}),
    costMicros: scan.costMicros,
    costMicrosSingleRounding: Math.round(scan.costUsdSum * 1_000_000),
    usageBearingRuns: scan.usageBearingRuns,
    transcriptBytes: scan.bytes,
    toolResultBytes,
  };
  if (unattributedCalls > 0)
    warnings.push(
      `${unattributedCalls} provider request(s) carry no timestamp and are counted in the session total but in no turn row.`,
    );
  if (scan.generationSpans === 0 && assistantRuns > 0)
    unavailable.push(
      "generationMs: no assistant entry in this log recorded a startedAt/completedAt span.",
    );

  let providerCallTotals: SessionAuditReport["providerCallTotals"];
  if (calls.length > 0) {
    const summed = emptyUsage();
    for (const call of calls) addUsage(summed, call.usage);
    providerCallTotals = {
      ...summed,
      calls: calls.length,
      costReported: callScan?.costReported === true,
    };
    if (!providerCallTotals.costReported)
      unavailable.push(
        "costUSD per provider call: this transcript records tokens but no cost; the app log's per-turn cost is the only source.",
      );
    // The app log has no reasoning field at all, so the session total for it
    // can only come from the transcript. Surfaced on `totals` (Task-254 lists
    // it among the canonical fields) with its origin stated.
    if (providerCallTotals.reasoningTokens !== undefined) {
      totals.reasoningTokens = providerCallTotals.reasoningTokens;
      assumptionsExtra.push(
        "totals.reasoningTokens comes from the PROVIDER TRANSCRIPT, not the app log, which has no reasoning field; every other totals figure is the log's.",
      );
    }
    // The two sources measure the same session; a large gap means one of them
    // is not what it claims (historically: an app log whose per-turn usage was
    // still the harness's CUMULATIVE total). Report it, never reconcile it away.
    const logged = totals.processedInputTokens;
    const transcript = summed.processedInputTokens;
    const larger = Math.max(logged, transcript);
    // Only a log that reported usage at all can disagree; an unreadable or
    // missing log has its own warning and must not also read as a mismatch.
    if (
      scan.usageBearingRuns > 0 &&
      larger > 0 &&
      Math.abs(logged - transcript) / larger > 0.05
    )
      warnings.push(
        `Processed input from the app log (${logged.toLocaleString("en-US")}) and from the provider transcript (${transcript.toLocaleString("en-US")}) disagree by more than 5%. The log's per-turn usage is what the persisted session stats were summed from; the transcript is per REQUEST.`,
      );
  }
  if (source.persistedUsage && !source.persistedUsage.reasoningTokens)
    unavailable.push(
      "reasoningTokens in persisted stats: the app log's usage model has no reasoning field (pi's provider transcript does, and is reported under providerCallTotals).",
    );

  // Contributors: measured transcript characters plus the two static rows.
  const conditions = source.promptConditions;
  if (!options.inventory)
    unavailable.push(
      "tool activity and per-turn definition sizes: no catalog inventory was passed to auditSession, so the persona's tool definitions could not be measured.",
    );
  const { report: toolReport, eagerDefChars } = buildToolActivity(
    source.meta,
    conditions,
    scan.turns,
    scan.toolCallCounts,
    topTools,
    options.inventory,
  );
  const promptChars = systemPromptChars(source.meta, conditions);
  const rows = buildContributors(
    scan.contributors,
    promptChars,
    eagerDefChars + toolReport.activatedDefChars,
    toolReport.eagerCount + toolReport.activatedCount,
  );
  const estimatedTotalTokens = rows.reduce((n, row) => n + row.estTokens, 0);

  const estimatedFirstRequestTokens =
    estTokens(promptChars) + estTokens(eagerDefChars);
  const measuredFirstRequestTokens = calls[0]?.usage.processedInputTokens;
  const calibration = {
    estimatedFirstRequestTokens,
    ...(measuredFirstRequestTokens !== undefined
      ? { measuredFirstRequestTokens }
      : {}),
    ...(measuredFirstRequestTokens !== undefined &&
    estimatedFirstRequestTokens > 0
      ? {
          ratio:
            Math.round(
              (measuredFirstRequestTokens / estimatedFirstRequestTokens) * 100,
            ) / 100,
        }
      : {}),
    estimatedTotalTokens,
    note: "The measured first request also carries the harness's own base prompt, its builtin tool definitions and the first prompt's content, none of which the estimate counts — a ratio above 1 is expected and is an upper bound on the divisor's error.",
  };

  const turnRows = buildTurnRows(
    source.meta,
    conditions,
    scan.turns,
    calls,
    options.inventory,
  );
  const maxTurns = options.maxTurns;
  const turnsOmitted =
    maxTurns !== undefined && turnRows.length > maxTurns
      ? turnRows.length - maxTurns
      : 0;
  const boundedTurns = turnsOmitted > 0 ? turnRows.slice(-maxTurns!) : turnRows;

  const drilldown = resolveDrilldown(options, scan, calls);

  return {
    version: SESSION_AUDIT_VERSION,
    session: {
      sessionId: source.sessionId,
      title: source.meta.title,
      harness: source.meta.harness,
      persona: source.meta.agentType,
      ...(source.meta.model ? { model: source.meta.model } : {}),
      ...(source.meta.provider ? { provider: source.meta.provider } : {}),
      ...(source.meta.thinkingLevel
        ? { thinkingLevel: source.meta.thinkingLevel }
        : {}),
      createdAt: new Date(source.meta.createdAtMs).toISOString(),
      updatedAt: new Date(source.meta.updatedAtMs).toISOString(),
      archived: source.meta.archived === true,
      ...(source.attachedTaskId
        ? { attachedTaskId: source.attachedTaskId }
        : {}),
      ...(conditions ? { promptConditions: conditions } : {}),
    },
    sources: {
      log: {
        path: source.logPath,
        available: scan.available,
        lines: scan.lines,
        bytes: scan.bytes,
      },
      providerCalls: {
        source: source.callTranscript?.source ?? "none",
        ...(source.callTranscript ? { path: source.callTranscript.path } : {}),
        available: callScan !== undefined,
        resolvesCalls: calls.length > 0,
      },
    },
    totals,
    ...(providerCallTotals ? { providerCallTotals } : {}),
    ...(source.persistedUsage
      ? {
          persisted: {
            totals: source.persistedUsage,
            ...persistedAgreement(totals, source.persistedUsage),
          },
        }
      : {}),
    contributors: rows,
    calibration,
    turns: boundedTurns,
    largestToolResults: [...scan.toolResults]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, topToolResults),
    contextJumps: contextJumps(calls, scan.turns, topContextJumps),
    tools: toolReport,
    events: scan.events,
    ...(drilldown ? { drilldown } : {}),
    assumptions: [
      `estTokens = chars / ${CHARS_PER_TOKEN} (rounded); JSON tokenizes denser than prose, so tool-argument and tool-result rows are under-estimated.`,
      "Attachment rows are BYTES from the log (it stores a reference, not the body); only text-like attachments are converted to estTokens, binary ones are reported unconverted because bytes say nothing about image tokens.",
      ...assumptionsExtra,
      "system-prompt and tool-definitions are measured against THIS checkout's prompt assets and catalog, not against what the session actually sent.",
      "Processed input is summed over every request; latest context occupancy is one prompt-side snapshot. They are never added together.",
      "Integration gates are not recorded per session, so a deferred tool is reported as loaded only when the transcript shows it activated or called.",
    ],
    warnings,
    unavailable,
    bounds: {
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      turnsOmitted,
      topToolResults,
      topContextJumps,
      topTools,
    },
  };
}

function resolveDrilldown(
  options: SessionAuditOptions,
  scan: LogScan,
  calls: ProviderCall[],
): DrilldownResult | undefined {
  const request = options.drilldown;
  if (!request) return undefined;
  if (request.entryId)
    return (
      scan.drilldown ?? {
        target: request.entryId,
        found: false,
      }
    );
  if (request.providerRun !== undefined) {
    const call = calls[request.providerRun - 1];
    const target = `provider-run:${request.providerRun}`;
    if (!call) return { target, found: false };
    return {
      target,
      found: true,
      ...(call.atMs !== undefined && !Number.isNaN(call.atMs)
        ? { at: new Date(call.atMs).toISOString() }
        : {}),
      usage: call.usage,
      contextAfter: call.contextTokens,
      toolCalls: call.toolCalls,
    };
  }
  return undefined;
}
