/**
 * Session-scoped connections to EXTERNAL MCP servers (currently Playwright
 * MCP), consumed by mcp-proxy toolGroups. Replaces the old hand-rolled
 * stdio JSON-RPC client with the official MCP SDK `Client` +
 * `StdioClientTransport`.
 *
 * One connection per session, created lazily on the first proxied tool call
 * and closed on toolGroup disable, session unbind, or an explicit close tool
 * (browser_close). The module keeps the per-session connection map plus the
 * bookkeeping the session drawer's runtime list needs ({@link BrowserRuntimeInfo}).
 */
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrowserRuntimeInfo } from "@assistant/shared";
import { errorText } from "../../errors.ts";
import { releaseChildOomScore } from "../../childOomScore.ts";
import {
  externalSubprocessEnv,
  type TrustedSubprocessEnvOverrides,
} from "../../subprocessEnv.ts";

/** Per-call timeout for proxied MCP tool calls (matches the old client). */
const PROXIED_CALL_TIMEOUT_MS = 30_000;

/** Resolved spawn parameters for one proxied server process. */
export interface ProxiedSpawnSpec {
  command: string;
  args: string[];
  /** Server-owned settings overlaid on the external-process allowlist. */
  trustedEnv?: TrustedSubprocessEnvOverrides;
  cwd?: string;
}

/** How a toolGroup's external MCP server is spawned for a session. */
export interface ProxiedServerSpec {
  /** Human-readable name for error messages (e.g. "Playwright MCP"). */
  name: string;
  /** Session-scoped output/artifact directory (created before spawn). */
  outputDir(sessionId: string): string;
  /** Build the spawn spec for a session. */
  spawn(ctx: {
    sessionId: string;
    outputDir: string;
    headed: boolean;
  }): ProxiedSpawnSpec;
}

/** Result of one proxied MCP tool call. */
export interface McpToolResult {
  name: string;
  content: Array<{
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/** Minimal MCP client seam used by a connection (fake-able in tests). */
export interface ProxiedMcpClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content?: unknown; isError?: unknown }>;
  close(): Promise<void>;
  /** Child process pid, when the transport exposes one. */
  readonly pid?: number | undefined;
  /** Subscribe to the server going away without us closing it. */
  onUnexpectedClose(handler: (reason?: string) => void): void;
}

/** Factory for a connected {@link ProxiedMcpClient}. */
export type ProxiedMcpClientFactory = (
  spawn: ProxiedSpawnSpec,
) => Promise<ProxiedMcpClient>;

const connections = new Map<string, ProxiedMcpConnection>();
const runtimeListeners = new Set<() => void>();
let clientFactoryOverride: ProxiedMcpClientFactory | undefined;

/** Test seam: replace the real stdio client factory for every new connection. */
export function setProxiedClientFactoryForTests(
  factory?: ProxiedMcpClientFactory,
): void {
  clientFactoryOverride = factory;
}

/** Subscribe to any proxied-runtime lifecycle/usage change (drawer refresh). */
export function subscribeProxiedRuntimeChanges(
  listener: () => void,
): () => void {
  runtimeListeners.add(listener);
  return () => runtimeListeners.delete(listener);
}

function emitRuntimeChange(): void {
  for (const listener of runtimeListeners) listener();
}

/** One live proxied MCP server connection for a session. */
export class ProxiedMcpConnection {
  private client: ProxiedMcpClient | undefined;
  private closing = false;
  readonly outputDir: string;
  readonly startedAt = Date.now();
  lastUsedAt = Date.now();
  lastTool: string | undefined;
  status: BrowserRuntimeInfo["status"] = "starting";
  error: string | undefined;

  constructor(
    readonly sessionId: string,
    private readonly spec: ProxiedServerSpec,
    readonly headed: boolean,
    private readonly clientFactory: ProxiedMcpClientFactory,
  ) {
    this.outputDir = spec.outputDir(sessionId);
  }

  get pid(): number | undefined {
    return this.client?.pid ?? undefined;
  }

  async start(): Promise<void> {
    mkdirSync(this.outputDir, { recursive: true });
    const client = await this.clientFactory(
      this.spec.spawn({
        sessionId: this.sessionId,
        outputDir: this.outputDir,
        headed: this.headed,
      }),
    );
    releaseChildOomScore(client.pid);
    client.onUnexpectedClose((reason) => {
      if (this.closing) return;
      this.status = "error";
      this.error = `${this.spec.name} exited unexpectedly${reason ? `: ${reason}` : "."}`;
      this.lastUsedAt = Date.now();
      emitRuntimeChange();
    });
    this.client = client;
    this.status = "running";
    this.lastUsedAt = Date.now();
    emitRuntimeChange();
  }

  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const client = this.client;
    if (!client) throw new Error(`${this.spec.name} is not running.`);
    this.lastTool = name;
    this.lastUsedAt = Date.now();
    emitRuntimeChange();
    const result = await client.callTool(name, args);
    this.lastUsedAt = Date.now();
    emitRuntimeChange();
    return {
      name,
      content: Array.isArray(result.content)
        ? (result.content as McpToolResult["content"])
        : [],
      isError: Boolean(result.isError),
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.closing = true;
    this.client = undefined;
    this.status = "exited";
    this.lastUsedAt = Date.now();
    emitRuntimeChange();
    await client.close().catch(() => undefined);
  }
}

/** The session's live proxied connection, if any (shared by every proxy pack). */
export function getProxiedConnection(
  sessionId: string,
): ProxiedMcpConnection | undefined {
  return connections.get(sessionId);
}

/** Every tracked connection, for the browser-runtimes drawer list. */
export function listProxiedConnections(): ProxiedMcpConnection[] {
  return [...connections.values()];
}

/**
 * Open (spawn + connect) a session's proxied server. The connection is tracked
 * immediately with status "starting" so the drawer shows the spin-up; a failed
 * start is untracked again so the next call retries cleanly.
 */
export async function openProxiedConnection(
  sessionId: string,
  spec: ProxiedServerSpec,
  headed: boolean,
): Promise<ProxiedMcpConnection> {
  const existing = connections.get(sessionId);
  if (existing) return existing;
  const connection = new ProxiedMcpConnection(
    sessionId,
    spec,
    headed,
    clientFactoryOverride ?? stdioClientFactory,
  );
  connections.set(sessionId, connection);
  emitRuntimeChange();
  try {
    await connection.start();
    return connection;
  } catch (err) {
    connections.delete(sessionId);
    connection.status = "error";
    connection.error = errorText(err);
    emitRuntimeChange();
    await connection.close().catch(() => undefined);
    throw err;
  }
}

/** Close and untrack a session's proxied connection (no-op when none). */
export async function closeProxiedConnection(sessionId: string): Promise<void> {
  const connection = connections.get(sessionId);
  if (!connection) return;
  connections.delete(sessionId);
  await connection.close();
}

/** Real client: official MCP SDK Client over a stdio child-process transport. */
const stdioClientFactory: ProxiedMcpClientFactory = async (spawn) => {
  const transport = new StdioClientTransport({
    command: spawn.command,
    args: spawn.args,
    env: externalSubprocessEnv(spawn.trustedEnv),
    ...(spawn.cwd !== undefined ? { cwd: spawn.cwd } : {}),
    stderr: "pipe",
  });
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-4000);
  });
  const client = new Client(
    { name: "personal-assistant-workshop", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  let closeHandler: ((reason?: string) => void) | undefined;
  let closedByUs = false;
  client.onclose = () => {
    if (!closedByUs) closeHandler?.(stderrTail.trim() || undefined);
  };
  return {
    get pid(): number | undefined {
      return transport.pid ?? undefined;
    },
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args }, undefined, {
        timeout: PROXIED_CALL_TIMEOUT_MS,
      })) as { content?: unknown; isError?: unknown };
    },
    onUnexpectedClose(handler) {
      closeHandler = handler;
    },
    async close() {
      closedByUs = true;
      await client.close();
    },
  };
};
