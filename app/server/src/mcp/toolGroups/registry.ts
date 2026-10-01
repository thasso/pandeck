/**
 * The tool-group registry: which groups exist, their materialized
 * {@link AgentTool}s, and their per-session teardown. Both browser packs are
 * ordinary catalog tool groups (`tools/catalog.ts`): `browser` is always usable
 * (deferred, discovered like any other tool via `find_tools`/native ToolSearch),
 * `browser-raw-mcp` is gated by the `browserRawMcp` Settings toggle exactly like
 * any other integration (`browserSettings.ts` + `IntegrationToolGates`) — there
 * is no separate per-session enable/approval step or audit trail.
 *
 * What a definition is BUILT from lives in ./packRuntime.ts, so the layering is
 * one-way: registry -> definitions (./browserGroups.ts) -> machinery. This
 * module also owns the post-reload continuation (an unrelated dev-supervisor
 * concept: queue a follow-up prompt for after the server reloads).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AgentKind,
  BrowserRuntimeInfo,
  PendingPostReloadContinuation,
  ToolGroupId,
} from "@assistant/shared";
import { DATA_DIR } from "../../config.ts";
import { defineAgentTool, type AgentTool } from "../tool.ts";
import {
  closeProxiedConnection,
  getProxiedConnection,
  listProxiedConnections,
  subscribeProxiedRuntimeChanges,
} from "./proxiedServer.ts";
import {
  deleteSessionArtifacts,
  proxiedAgentTool,
  type ToolGroupDefinition,
} from "./packRuntime.ts";
import { browserToolGroup, rawBrowserToolGroup } from "./browserGroups.ts";

const POST_RELOAD_FILE = join(DATA_DIR, "post-reload-continuation.json");

/** Every tool group the catalog can register, in catalog order. */
const TOOL_GROUP_DEFINITIONS: ToolGroupDefinition[] = [
  browserToolGroup,
  rawBrowserToolGroup,
];

/** Materialized AgentTools per mcp-proxy pack (built once). */
const materializedProxyTools = new Map<ToolGroupId, AgentTool[]>();

function packAgentTools(def: ToolGroupDefinition): AgentTool[] {
  if (def.kind === "native") return def.tools;
  let tools = materializedProxyTools.get(def.id);
  if (!tools) {
    tools = def.tools.map((spec) => proxiedAgentTool(def, spec));
    materializedProxyTools.set(def.id, tools);
  }
  return tools;
}

function definition(id: ToolGroupId): ToolGroupDefinition {
  const def = TOOL_GROUP_DEFINITIONS.find((p) => p.id === id);
  if (!def) throw new Error(`Unknown tool group: ${id}`);
  return def;
}

/** A pack's materialized AgentTools, for the catalog to register as an ordinary tool group. */
export function toolsForToolGroup(id: ToolGroupId): AgentTool[] {
  return packAgentTools(definition(id));
}

/* --------------------------------- teardown -------------------------------- */

/** Close a session's proxied connection (no-op when none is open). Call on session teardown. */
export function closeToolGroupSession(sessionId: string): void {
  void closeProxiedConnection(sessionId).catch(() => undefined);
}

/**
 * Whether a session holds a LIVE proxied connection (a browser runtime) that
 * teardown would close. One that failed or exited stays tracked for the drawer
 * but has nothing left to lose.
 */
export function hasToolGroupSession(sessionId: string): boolean {
  const status = getProxiedConnection(sessionId)?.status;
  return status === "starting" || status === "running";
}

/** Tear down a deleted session's proxied connection, artifact side-store, and artifact files. */
export function deleteToolGroupSessionData(sessionId: string): void {
  closeToolGroupSession(sessionId);
  deleteSessionArtifacts(sessionId);
}

/** Runtime-list change subscription (proxied server lifecycle/usage). */
export const subscribeBrowserRuntimeChanges = subscribeProxiedRuntimeChanges;

export function listBrowserRuntimes(
  currentSessionId: string,
  sessionInfo: (
    sessionId: string,
  ) =>
    | Pick<
        BrowserRuntimeInfo,
        "agentKind" | "agentStatus" | "sessionFile" | "sessionTitle"
      >
    | undefined,
): BrowserRuntimeInfo[] {
  return listProxiedConnections()
    .map((connection) => {
      const info = sessionInfo(connection.sessionId);
      return {
        sessionId: connection.sessionId,
        ...(info?.sessionFile !== undefined
          ? { sessionFile: info?.sessionFile }
          : {}),
        ...(info?.sessionTitle !== undefined
          ? { sessionTitle: info?.sessionTitle }
          : {}),
        agentKind: info?.agentKind ?? "workshop",
        agentStatus: info?.agentStatus ?? "not-live",
        connectedToCurrentSession: connection.sessionId === currentSessionId,
        ...(connection.pid !== undefined ? { pid: connection.pid } : {}),
        status: connection.status,
        headed: connection.headed,
        outputDir: connection.outputDir,
        startedAt: connection.startedAt,
        lastUsedAt: connection.lastUsedAt,
        ...(connection.lastTool !== undefined
          ? { lastTool: connection.lastTool }
          : {}),
        ...(connection.error !== undefined ? { error: connection.error } : {}),
      } satisfies BrowserRuntimeInfo;
    })
    .sort(
      (a, b) =>
        Number(b.connectedToCurrentSession) -
          Number(a.connectedToCurrentSession) || b.lastUsedAt - a.lastUsedAt,
    );
}

/* ------------------------- post-reload continuation ------------------------ */

export function getPendingPostReloadContinuation(
  sessionId: string,
): PendingPostReloadContinuation | undefined {
  if (!existsSync(POST_RELOAD_FILE)) return undefined;
  try {
    const data = JSON.parse(
      readFileSync(POST_RELOAD_FILE, "utf8"),
    ) as PostReloadContinuation;
    if (data?.sessionId !== sessionId) return undefined;
    return {
      id: data.id,
      message: data.message,
      ...(data.reason !== undefined ? { reason: data.reason } : {}),
      createdAt: data.createdAt,
    };
  } catch {
    return undefined;
  }
}

export function consumePostReloadContinuation():
  PostReloadContinuation | undefined {
  if (!existsSync(POST_RELOAD_FILE)) return undefined;
  try {
    const data = JSON.parse(
      readFileSync(POST_RELOAD_FILE, "utf8"),
    ) as PostReloadContinuation;
    rmSync(POST_RELOAD_FILE, { force: true });
    if (!data || !data.sessionFile || !data.message) return undefined;
    return data;
  } catch {
    rmSync(POST_RELOAD_FILE, { force: true });
    return undefined;
  }
}

export function cancelPostReloadContinuation(): void {
  rmSync(POST_RELOAD_FILE, { force: true });
}

export interface PostReloadContinuation {
  id: string;
  kind: AgentKind;
  sessionId: string;
  sessionFile: string;
  message: string;
  reason?: string;
  createdAt: number;
}

function queuePostReloadContinuation(options: {
  sessionId: string;
  kind: AgentKind;
  sessionFile: string | undefined;
  message: string;
  reason?: string;
}): PostReloadContinuation {
  if (!options.sessionFile)
    throw new Error(
      "The current session is not persisted yet; send a normal follow-up after reload instead.",
    );
  const reasonValue = cleanText(options.reason);
  const continuation: PostReloadContinuation = {
    id: `reload-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: options.kind,
    sessionId: options.sessionId,
    sessionFile: options.sessionFile,
    message: options.message.trim(),
    ...(reasonValue !== undefined ? { reason: reasonValue } : {}),
    createdAt: Date.now(),
  };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    POST_RELOAD_FILE,
    `${JSON.stringify(continuation, null, 2)}\n`,
    "utf8",
  );
  return continuation;
}

function cleanText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

/* ------------------------------- meta tools -------------------------------- */

type DeferAfterReloadParams = { message?: string; reason?: string };

export const queuePostReloadContinuationTool =
  defineAgentTool<DeferAfterReloadParams>({
    name: "workshop_defer_after_reload",
    label: "Defer After Reload",
    description:
      "Queue an automatic workshop follow-up prompt to run after the dev server reloads. Use after editing server/shared code when verification must wait for the supervisor restart.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
          description:
            "Follow-up prompt to send after the server reloads. Be specific about what to verify.",
        },
        reason: {
          type: "string",
          description: "Short reason shown in the UI.",
        },
      },
      required: ["message"],
    },
    executionMode: "sequential",
    async execute(params, ctx) {
      const message = cleanText(params.message);
      if (!message) throw new Error("Deferred message is required.");
      const reasonValue = cleanText(params.reason);
      const continuation = queuePostReloadContinuation({
        sessionId: ctx.session.sessionId,
        kind: ctx.session.agentType,
        sessionFile: ctx.session.sessionFile,
        message,
        ...(reasonValue !== undefined ? { reason: reasonValue } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: "Post-reload continuation queued. Finish this turn so the dev supervisor can reload the server; the follow-up will run after reconnect unless the user cancels it.",
          },
        ],
        details: { continuation },
      };
    },
  });
