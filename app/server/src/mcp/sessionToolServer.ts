/**
 * The generic per-session MCP server exposing the app's own {@link AgentTool}s
 * over MCP. The Claude SDK mounts `server` in-process (`mcpServers.pa`, type
 * "sdk"); no other client connects today. The pi harness does not use it: it
 * runs the same tools through the direct adapter in
 * `piSdk/agentToolAdapter.ts`.
 *
 * Wire contract beyond plain MCP (all under `_meta`, see ./meta.ts):
 *  - request `_meta["pa/toolCallId"]`: caller-supplied tool-call id (falls back
 *    to the MCP request id);
 *  - progress: when the caller sends a `progressToken`, tool `ctx.progress`
 *    partials are emitted as `notifications/progress` with the partial
 *    {@link ToolResult} JSON-encoded in `message`;
 *  - result `_meta["pa/terminate"]`: the tool's stop-after-this-batch flag;
 *  - result `_meta["pa/details"]`: the tool's `details` (never
 *    `structuredContent` — see {@link toCallToolResult});
 *  - listed tool `_meta["pa/pi"]`: the tool's `executionMode`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Harness } from "@assistant/shared";
import { subscribeIntegrationToolChanges } from "../integrationToolChanges.ts";
import type { AgentTool, ToolResult, ToolSession } from "./tool.ts";
import {
  ANTHROPIC_ALWAYS_LOAD_META_KEY,
  ANTHROPIC_SEARCH_HINT_META_KEY,
  DETAILS_META_KEY,
  PI_EXTRAS_META_KEY,
  TERMINATE_META_KEY,
  TOOL_CALL_ID_META_KEY,
  type PiToolExtrasMeta,
} from "./meta.ts";

export interface SessionToolServerConfig {
  sessionId: string;
  harness: Harness;
  /** Resolve the toolset fresh on every list/call (catalog + integration-gate state). */
  tools(): AgentTool[];
  /** Currently-active tool names; null/undefined = every listed tool is active. */
  activeToolNames?(): ReadonlySet<string> | null;
  /** Optional policy-specific explanation for an inactive tool call. */
  inactiveToolMessage?(tool: AgentTool): string | undefined;
  /**
   * Claude ToolSearch metadata for one listed tool, when the caller can enrich
   * the tool's own `searchHint` with its catalog family vocabulary. Passed in
   * rather than read here: the catalog composes every tool module, so a tool
   * that reaches this server must not be able to reach the catalog back.
   */
  searchHint?(tool: AgentTool): string | undefined;
  /**
   * Eager-tier tool names (the persona's initial-context core). Listed with
   * `_meta["anthropic/alwaysLoad"]: true` so the Claude SDK's native tool
   * search never defers them; all other tools are deferred and discovered on
   * demand. null/undefined = no always-load marking (every tool deferrable).
   */
  eagerToolNames?(): ReadonlySet<string> | null;
  /** Live session identity (sessionFile/title can appear after persistence). */
  session(): ToolSession;
  /** Called after every tool call, success or error (e.g. broadcastState). */
  onToolExecuted?(): void;
}

export interface SessionToolServer {
  /** The low-level MCP server to mount/connect. */
  server: Server;
  /** Push a tools/list_changed notification (no-op when not connected). */
  notifyToolsChanged(): void;
  close(): Promise<void>;
}

/**
 * Map an {@link AgentTool} result onto the MCP CallToolResult wire shape.
 *
 * `details` NEVER ride as `structuredContent`: the Claude CLI we run drops a
 * result's text blocks whenever a `structuredContent` is present and sends its
 * JSON instead, so every tool whose payload lives in the text and whose
 * `details` are a thin envelope — the proxied browser tools, `ls`, … — reached
 * the model as the envelope alone ([Task-439](pa://task/439)). That is observed
 * CLI behaviour, not a documented MCP contract, so do not reintroduce
 * `structuredContent` on the strength of the spec alone. The text content is
 * the tool's answer; details are a structured copy and ride `_meta`.
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  const meta: Record<string, unknown> = {};
  if (result.terminate) meta[TERMINATE_META_KEY] = true;
  if (result.details !== undefined) meta[DETAILS_META_KEY] = result.details;
  return {
    content: result.content as CallToolResult["content"],
    isError: false,
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

export function createSessionToolServer(
  config: SessionToolServerConfig,
): SessionToolServer {
  const server = new Server(
    { name: "personal-assistant", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const active = config.activeToolNames?.() ?? null;
    const eager = config.eagerToolNames?.() ?? null;
    const isActive = (tool: AgentTool) => !active || active.has(tool.name);
    // Only the currently usable tools: a client refreshes its list on
    // tools/list_changed rather than toggling a registered universe.
    const listed = config.tools().filter(isActive);
    return {
      tools: listed.map((tool) => {
        const extras: PiToolExtrasMeta = {
          ...(tool.executionMode !== undefined
            ? { executionMode: tool.executionMode }
            : {}),
        };
        const searchHint = config.searchHint?.(tool) ?? tool.searchHint;
        return {
          name: tool.name,
          title: tool.label,
          description: tool.description,
          // AgentTool.parameters is plain JSON Schema — MCP inputSchema is the same shape.
          inputSchema: tool.parameters as {
            type: "object";
            [k: string]: unknown;
          },
          _meta: {
            [PI_EXTRAS_META_KEY]: extras,
            ...(eager?.has(tool.name)
              ? { [ANTHROPIC_ALWAYS_LOAD_META_KEY]: true }
              : {}),
            ...(searchHint
              ? { [ANTHROPIC_SEARCH_HINT_META_KEY]: searchHint }
              : {}),
          },
        };
      }),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      const name = req.params.name;
      const tool = config.tools().find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const active = config.activeToolNames?.() ?? null;
      if (active && !active.has(name))
        throw new Error(
          config.inactiveToolMessage?.(tool) ??
            `Tool ${name} is not enabled for this session.`,
        );

      const meta = req.params._meta;
      const requestedId = meta?.[TOOL_CALL_ID_META_KEY];
      const toolCallId =
        typeof requestedId === "string" && requestedId
          ? requestedId
          : String(extra.requestId);
      const progressToken = meta?.progressToken;
      let progressCount = 0;
      const progress =
        progressToken === undefined
          ? undefined
          : (partial: ToolResult) => {
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: ++progressCount,
                    message: JSON.stringify(partial),
                  },
                })
                .catch(() => {});
            };

      const result = await tool.execute(
        (req.params.arguments ?? {}) as Record<string, unknown>,
        {
          toolCallId,
          session: config.session(),
          signal: extra.signal,
          ...(progress !== undefined ? { progress } : {}),
        },
      );
      return toCallToolResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: message }], isError: true };
    } finally {
      config.onToolExecuted?.();
    }
  });

  const notifyToolsChanged = () => {
    void server.sendToolListChanged().catch(() => {
      // Not connected yet (or already closed) — the next tools/list is fresh anyway.
    });
  };
  // Integration-gate changes → tools/list_changed, so every connected client
  // (Claude today) re-lists and picks up the new active set. Owned here so no
  // harness wiring can forget it.
  const unsubscribeIntegrations =
    subscribeIntegrationToolChanges(notifyToolsChanged);

  return {
    server,
    notifyToolsChanged,
    close: async () => {
      unsubscribeIntegrations();
      await server.close();
    },
  };
}
