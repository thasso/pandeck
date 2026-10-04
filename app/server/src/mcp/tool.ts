/**
 * The app's own, harness-neutral tool interface. Every domain tool (see
 * `src/tools/`) is an {@link AgentTool}; the per-session MCP server exposes them
 * over MCP. Nothing in this folder may import the pi or Claude SDKs — the pi
 * harness runs these tools through its direct adapter
 * (`piSdk/agentToolAdapter.ts`), the Claude harness by mounting the server
 * in-process (`claudeSdk/`).
 */
import type { AgentKind, Harness } from "@assistant/shared";

/** Content returned to the model. Structurally identical in MCP and pi. */
type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Final or partial (progress) result of a tool call.
 *
 * The TEXT content is what the model and the UI see: the web UI's rich tool
 * cards parse a JSON payload (`renderKind`, …) out of it — keep that
 * byte-stable when editing tools — and a tool whose answer is not in its text
 * has no answer. `details` is a structured copy for logs/programmatic clients
 * and rides MCP `_meta["pa/details"]`, never `structuredContent`; `terminate`
 * hints the agent to stop after the current tool batch (also `_meta`).
 */
export interface ToolResult {
  content: ToolContentBlock[];
  details?: unknown;
  terminate?: boolean;
}

/** The narrow session-manager surface tools may use (pi- and claude-backed). */
export interface ToolSessionManager {
  getSessionId(): string;
  getBranch(): unknown[];
  /** Returns the appended entry's id when the backing store provides one. */
  appendCustomEntry(type: string, data: unknown): string | undefined;
}

/**
 * The identity of the calling session. Always fully populated by the harness
 * integration — tools must NOT fall back to duck-typing or defaults; created
 * tasks stamp this identity so they link back to the session.
 */
export interface ToolSession {
  sessionId: string;
  harness: Harness;
  agentType: AgentKind;
  sessionFile?: string;
  title?: string;
  cwd?: string;
  sessionManager?: ToolSessionManager;
}

/** Per-call context handed to {@link AgentTool.execute}. */
export interface ToolCallContext {
  toolCallId: string;
  session: ToolSession;
  signal?: AbortSignal;
  /**
   * Stream a partial result while executing (rendered live in the UI). Emitted
   * as an MCP progress notification; undefined when the caller sent no
   * progress token.
   */
  progress?: (partial: ToolResult) => void;
}

/** Whether a tool can change durable local state or a system outside the app. */
export type ToolSideEffects = "none" | "local" | "external";

/**
 * A tool definition. `parameters` is plain JSON Schema (an object schema, as
 * all current tools already use). `label`/`executionMode` ride MCP `_meta` —
 * see `mcp/meta.ts`. Throw on failure instead of encoding errors in `content`.
 *
 * `sideEffects` is assigned deliberately by the catalog. It remains optional
 * on the base interface because tool definitions are authored independently of
 * persona composition; every catalog projection requires it (and tests reject
 * a newly registered tool until it is classified).
 *
 * There is deliberately NO prompt-extras channel here (Task-282 deleted
 * `promptSnippet`/`promptGuidelines`): a rule an agent must follow belongs in
 * `description` or in the `parameters` prose, the two surfaces BOTH harnesses
 * render for eager and deferred tools alike. Cross-tool behaviour belongs in a
 * persona prompt layer, not on a tool.
 */
export interface AgentTool<
  P extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Extra keywords for deferred-tool discovery (pi `find_tools` scoring and
   * Claude's native tool search via `_meta["anthropic/searchHint"]`). Optional;
   * name + description are always searched.
   */
  searchHint?: string;
  executionMode?: "sequential" | "parallel";
  sideEffects?: ToolSideEffects;
  execute(params: P, ctx: ToolCallContext): Promise<ToolResult>;
}

/** Preserve parameter inference when assigning a tool to a variable. */
export function defineAgentTool<P extends Record<string, unknown>>(
  tool: AgentTool<P>,
): AgentTool<P> & AgentTool {
  return tool as AgentTool<P> & AgentTool;
}

/** A consistent denial surfaced by both harnesses for stale/forged tool calls. */
export function planModeToolUnavailableMessage(name: string): string {
  return `Tool ${name} is not available in Plan mode because it can make changes.`;
}

/** The common "JSON payload as text + structured details" result shape. */
export function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

/** Drop duplicate tool names, keeping the first occurrence. */
export function uniqueAgentTools(tools: AgentTool[]): AgentTool[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}
