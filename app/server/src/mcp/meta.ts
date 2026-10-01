/**
 * MCP `_meta` key contract between the session tool server and its clients.
 * `pa/*` keys serve the pi bridge in `piSdk/mcpToolBridge.ts`; `anthropic/*`
 * keys are read by the Claude Agent SDK's native tool search. Everything
 * beyond the plain MCP tool surface rides under these keys so the wire stays
 * standard MCP.
 */

/** Request `_meta` key: the caller's tool-call id (else the MCP request id is used). */
export const TOOL_CALL_ID_META_KEY = "pa/toolCallId";

/** CallToolResult `_meta` key: pi's "stop after this tool batch" hint. */
export const TERMINATE_META_KEY = "pa/terminate";

/**
 * CallToolResult `_meta` key: the tool's `details`, whatever its shape. Details
 * never ride as MCP `structuredContent` — a client that prefers structured
 * output then drops the text content that IS the tool's answer, as the Claude
 * CLI does ([Task-439](pa://task/439)) — so they travel here, losslessly. No
 * client in this repo reads them back today; the key exists so an external MCP
 * client CAN take the structured copy without costing the model its text.
 */
export const DETAILS_META_KEY = "pa/details";

/** tools/list `_meta` key: pi-flavoured extras for a tool (see {@link PiToolExtrasMeta}). */
export const PI_EXTRAS_META_KEY = "pa/pi";

/**
 * tools/list `_meta` key: whether the tool is currently active for the session.
 * Only meaningful in `listMode: "all"` (the pi bridge registers every tool up
 * front — pi cannot add tools mid-session — and toggles the active set).
 */
export const ACTIVE_META_KEY = "pa/active";

/**
 * Shape stored under {@link PI_EXTRAS_META_KEY} in a listed tool's `_meta`.
 *
 * Task-282 deleted the prompt-extras fields that used to ride here; the key is
 * KEPT for `executionMode`, which is not part of the MCP tool surface and which
 * an MCP client still needs to know a tool must not run in parallel. The pi
 * harness itself no longer reads it (it uses the direct adapter), so this
 * serves the session MCP server's external clients.
 */
export interface PiToolExtrasMeta {
  executionMode?: "sequential" | "parallel";
}

/**
 * tools/list `_meta` key read by the Claude Agent SDK's native tool search:
 * `true` = always include this tool's definition in the prompt (never deferred
 * behind ToolSearch). Emitted for the persona's eager-tier catalog tools.
 * Equivalent to `defer_loading: false` on the API.
 */
export const ANTHROPIC_ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

/**
 * tools/list `_meta` key read by the Claude Agent SDK's native tool search:
 * extra keywords matched by ToolSearch alongside the tool name/description.
 * Populated from {@link import("./tool.ts").AgentTool.searchHint}.
 */
export const ANTHROPIC_SEARCH_HINT_META_KEY = "anthropic/searchHint";
