/**
 * What a tool-group DEFINITION is made of, and the machinery a definition uses:
 * the pack shapes (native vs. proxied onto an external MCP server, see
 * ./proxiedServer.ts), the shared execution path for a proxied call, and the
 * session-artifact side store that call sites capture into.
 *
 * This is the leaf of the tool-group layer: `./browserGroups.ts` builds its
 * definitions on it and `./registry.ts` registers those definitions, so nothing
 * here may import either of them.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import type { SessionArtifact, ToolGroupId } from "@assistant/shared";
import { getBrowserToolSettings } from "../../browserSettings.ts";
import { DATA_DIR } from "../../config.ts";
import { defineAgentTool, type AgentTool, type ToolResult } from "../tool.ts";
import {
  getProxiedConnection,
  openProxiedConnection,
  type McpToolResult,
  type ProxiedMcpConnection,
  type ProxiedServerSpec,
} from "./proxiedServer.ts";

const MAX_ARTIFACTS = 80;

/* ------------------------------- definitions ------------------------------ */

interface ToolGroupDefinitionBase {
  id: ToolGroupId;
  label: string;
  description: string;
}

/** A tool group whose tools are ordinary in-process {@link AgentTool}s. */
export interface NativeToolGroupDefinition extends ToolGroupDefinitionBase {
  kind: "native";
  tools: AgentTool[];
}

/** One curated tool proxied onto the pack's external MCP server. */
export interface ProxiedToolSpec {
  name: string;
  label: string;
  description: string;
  /** JSON Schema exposed to the agent (may differ from the upstream tool's). */
  parameters: Record<string, unknown>;
  /** Perform the upstream call(s), including any param/tool-name mapping. */
  call(
    connection: ProxiedMcpConnection,
    params: Record<string, unknown>,
  ): Promise<McpToolResult>;
}

/** Hooks around every proxied call (e.g. artifact capture for the browser pack). */
export interface McpProxyMiddleware {
  /** Snapshot state before the call; passed back to {@link after}. */
  before(sessionId: string): unknown;
  /** Record side effects after the call; returns artifacts to surface. */
  after(
    sessionId: string,
    label: string,
    result: McpToolResult,
    state: unknown,
  ): SessionArtifact[];
}

/** A tool group that curates tools of an external MCP server. */
export interface McpProxyToolGroupDefinition extends ToolGroupDefinitionBase {
  kind: "mcp-proxy";
  server: ProxiedServerSpec;
  tools: ProxiedToolSpec[];
  middleware?: McpProxyMiddleware;
}

export type ToolGroupDefinition =
  NativeToolGroupDefinition | McpProxyToolGroupDefinition;

/* ---------------------------- proxied execution ---------------------------- */

/** The session's proxied connection for a proxy pack, spun up lazily on first use. */
async function ensureProxiedPackConnection(
  sessionId: string,
  def: McpProxyToolGroupDefinition,
): Promise<ProxiedMcpConnection> {
  const existing = getProxiedConnection(sessionId);
  if (existing) return existing;
  const headed = getBrowserToolSettings().headed;
  return openProxiedConnection(sessionId, def.server, headed);
}

/**
 * Shared execution path for every call that goes through a pack's external MCP
 * server: lazy connection, middleware (artifact capture), and result
 * formatting. Used by the materialized proxy tools AND by native tools that
 * piggyback on a proxy pack's connection (browser_mcp_call).
 */
export async function runProxiedPackCall(options: {
  /** The proxy pack whose external server serves the call. */
  connectionPack: McpProxyToolGroupDefinition;
  sessionId: string;
  /** The AgentTool name the caller knows — what a message about it must say. */
  toolName: string;
  /** Label recorded on captured artifacts. */
  artifactLabel: string;
  call(connection: ProxiedMcpConnection): Promise<McpToolResult>;
}): Promise<ToolResult> {
  const connection = await ensureProxiedPackConnection(
    options.sessionId,
    options.connectionPack,
  );
  const middleware = options.connectionPack.middleware;
  const state = middleware?.before(options.sessionId);
  const result = await options.call(connection);
  const naming = callNaming(options.toolName, result.name);
  if (result.isError)
    throw new Error(
      formatMcpResult(result, [], `${naming} failed without an error message.`),
    );
  const artifacts =
    middleware?.after(
      options.sessionId,
      options.artifactLabel,
      result,
      state,
    ) ?? [];
  return {
    content: [
      {
        type: "text",
        text: formatMcpResult(
          result,
          artifacts,
          `${naming} returned no content.`,
        ),
      },
    ],
    details: { mcpTool: result.name, artifacts },
  };
}

/**
 * How a message names one proxied call. The agent only knows the AgentTool
 * name, so that one always leads; the upstream name follows when it differs
 * (browser_console → browser_console_messages) because it is what a Playwright
 * MCP error or log will be about.
 */
function callNaming(toolName: string, upstreamName: string): string {
  return toolName === upstreamName
    ? toolName
    : `${toolName} (upstream ${upstreamName})`;
}

/** Wrap one curated {@link ProxiedToolSpec} as an {@link AgentTool}. */
export function proxiedAgentTool(
  def: McpProxyToolGroupDefinition,
  spec: ProxiedToolSpec,
): AgentTool {
  return defineAgentTool<Record<string, unknown>>({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    executionMode: "sequential",
    async execute(params, ctx) {
      return runProxiedPackCall({
        connectionPack: def,
        sessionId: ctx.session.sessionId,
        toolName: spec.name,
        artifactLabel:
          typeof params.label === "string" ? params.label : spec.label,
        call: (connection) => spec.call(connection, params),
      });
    },
  });
}

/* ----------------------------- artifact capture ---------------------------- */

interface ArtifactSideStore {
  artifacts: SessionArtifact[];
}

const storeCache = new Map<string, ArtifactSideStore>();

function storeFile(sessionId: string): string {
  return join(DATA_DIR, "session-tool-groups", `${sessionId}.json`);
}

function loadStore(sessionId: string): ArtifactSideStore {
  const cached = storeCache.get(sessionId);
  if (cached) return cached;
  let store: ArtifactSideStore = { artifacts: [] };
  try {
    const raw = JSON.parse(
      readFileSync(storeFile(sessionId), "utf8"),
    ) as Partial<ArtifactSideStore>;
    store = { artifacts: raw.artifacts ?? [] };
  } catch {
    // No persisted state yet — start empty.
  }
  storeCache.set(sessionId, store);
  return store;
}

function saveStore(sessionId: string): void {
  const store = storeCache.get(sessionId);
  if (!store) return;
  mkdirSync(join(DATA_DIR, "session-tool-groups"), { recursive: true });
  writeFileSync(
    storeFile(sessionId),
    `${JSON.stringify(store, null, 2)}\n`,
    "utf8",
  );
}

function appendArtifact(sessionId: string, artifact: SessionArtifact): void {
  const store = loadStore(sessionId);
  const previous = store.artifacts;
  store.artifacts = [...previous, artifact];
  const dropped =
    store.artifacts.length > MAX_ARTIFACTS
      ? store.artifacts.splice(0, store.artifacts.length - MAX_ARTIFACTS)
      : [];
  try {
    saveStore(sessionId);
  } catch (err) {
    // An unsaved record must not advertise a file its caller will remove.
    store.artifacts = previous;
    throw err;
  }
  for (const removed of dropped) removeArtifactFile(sessionId, removed);
}

function artifactFilePath(
  sessionId: string,
  artifact: SessionArtifact,
): string | undefined {
  try {
    const segments = new URL(
      artifact.url,
      "http://session-artifact.local",
    ).pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (
      segments[0] !== "api" ||
      segments[1] !== "session-artifacts" ||
      segments[2] !== sessionId ||
      segments.length < 4
    )
      return undefined;
    const root = join(DATA_DIR, "session-artifacts", sessionId);
    const path = join(root, ...segments.slice(3));
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith("../")) return undefined;
    return path;
  } catch {
    // A malformed or external artifact URL is not a local file.
    return undefined;
  }
}

function removeArtifactFile(
  sessionId: string,
  artifact: SessionArtifact,
): void {
  const path = artifactFilePath(sessionId, artifact);
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Artifact cleanup is best effort.
  }
}

/** Remove one artifact when its durable owner rejected the capture. */
export function removeSessionArtifact(
  sessionId: string,
  artifactId: string,
): void {
  const store = loadStore(sessionId);
  const index = store.artifacts.findIndex(
    (artifact) => artifact.id === artifactId,
  );
  if (index < 0) return;
  const [removed] = store.artifacts.splice(index, 1);
  saveStore(sessionId);
  if (removed) removeArtifactFile(sessionId, removed);
}

export function listSessionArtifacts(sessionId: string): SessionArtifact[] {
  return loadStore(sessionId).artifacts.slice(-MAX_ARTIFACTS).reverse();
}

/** Resolve one registered artifact to the local file an agent may read. */
export function sessionArtifactFile(
  sessionId: string,
  artifactId: string,
): { artifact: SessionArtifact; path: string } | undefined {
  const artifact = loadStore(sessionId).artifacts.find(
    (candidate) => candidate.id === artifactId,
  );
  if (!artifact) return undefined;
  const path = artifactFilePath(sessionId, artifact);
  return path ? { artifact, path } : undefined;
}

type StagedArtifactInput = {
  name: string;
  mimeType: string;
  kind: SessionArtifact["kind"];
  label: string;
  sourceTool: string;
  directory?: string;
  download?: boolean;
};

/** Write server-fetched bytes and register them in the session artifact drawer. */
export function stageSessionArtifact(
  sessionId: string,
  input: StagedArtifactInput & { bytes: Uint8Array },
): SessionArtifact {
  const path = sessionArtifactTarget(sessionId, input);
  writeFileSync(path, input.bytes);
  return registerStagedArtifact(sessionId, input, path, input.bytes.byteLength);
}

/**
 * Stream a large capture straight to disk: `write` fills a private partial
 * file, which becomes the artifact only once it resolves. A failure removes
 * the partial file and registers nothing.
 */
export async function stageSessionArtifactFile(
  sessionId: string,
  input: StagedArtifactInput & { write: (path: string) => Promise<void> },
): Promise<{ artifact: SessionArtifact; path: string }> {
  const path = sessionArtifactTarget(sessionId, input);
  const partial = `${path}.partial`;
  try {
    await input.write(partial);
    renameSync(partial, path);
    const size = statSync(path).size;
    return {
      artifact: registerStagedArtifact(sessionId, input, path, size),
      path,
    };
  } catch (err) {
    for (const leftover of [partial, path]) {
      try {
        rmSync(leftover, { force: true });
      } catch {
        // Best effort: the capture's own failure is the one to report.
      }
    }
    throw err;
  }
}

function sessionArtifactTarget(
  sessionId: string,
  input: StagedArtifactInput,
): string {
  const directory = input.directory?.trim() || "files";
  if (
    !/^[A-Za-z0-9._-]+$/.test(directory) ||
    directory === "." ||
    directory === ".."
  )
    throw new Error("Invalid artifact directory.");
  const name = safeArtifactFileName(input.name);
  const root = join(DATA_DIR, "session-artifacts", sessionId, directory);
  mkdirSync(root, { recursive: true });
  return join(root, `${Date.now()}-${randomBytes(5).toString("hex")}-${name}`);
}

function registerStagedArtifact(
  sessionId: string,
  input: StagedArtifactInput,
  path: string,
  size: number,
): SessionArtifact {
  const root = join(DATA_DIR, "session-artifacts", sessionId);
  const segments = [sessionId, ...relative(root, path).split(sep)].map(
    encodeArtifactUrlPart,
  );
  const query = input.download
    ? `?download=1&name=${encodeArtifactUrlPart(input.name)}`
    : "";
  const artifact: SessionArtifact = {
    id: `artifact-${Date.now()}-${randomBytes(6).toString("hex")}`,
    sessionId,
    kind: input.kind,
    label: input.label,
    name: input.name,
    mimeType: input.mimeType,
    size,
    createdAt: Date.now(),
    url: `/api/session-artifacts/${segments.join("/")}${query}`,
    sourceTool: input.sourceTool,
  };
  appendArtifact(sessionId, artifact);
  return artifact;
}

function encodeArtifactUrlPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeArtifactFileName(name: string): string {
  const cleaned = [...name]
    .map((char) => {
      const code = char.charCodeAt(0);
      return char === "/" || char === "\\" || code < 32 || code === 127
        ? "_"
        : char;
    })
    .join("")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return cleaned || "download";
}

/** All files currently under `root` (recursive), for before/after diffing. */
export function snapshotArtifactFiles(root: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.add(path);
    }
  };
  walk(root);
  return out;
}

/**
 * Record every file under `root` that is not in `before` as a session artifact
 * (side-store entry + `/api/session-artifacts/...` URL). `root` must live under
 * `DATA_DIR/session-artifacts/<sessionId>` so the URL resolves.
 */
export function recordNewArtifacts(
  sessionId: string,
  root: string,
  before: Set<string>,
  label: string,
  sourceTool: string,
): SessionArtifact[] {
  const urlBase = join(DATA_DIR, "session-artifacts", sessionId);
  const created: SessionArtifact[] = [];
  for (const path of snapshotArtifactFiles(root)) {
    if (before.has(path)) continue;
    const stat = statSync(path);
    const artifact: SessionArtifact = {
      id: `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionId,
      kind: artifactKind(path),
      label,
      name: basename(path),
      mimeType: mimeFor(path),
      size: stat.size,
      createdAt: stat.mtimeMs || Date.now(),
      url: `/api/session-artifacts/${encodeURIComponent(sessionId)}/${relative(urlBase, path).split(/[\\/]/).map(encodeURIComponent).join("/")}`,
      sourceTool,
    };
    appendArtifact(sessionId, artifact);
    created.push(artifact);
  }
  return created;
}

function artifactKind(path: string): SessionArtifact["kind"] {
  const ext = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "screenshot";
  if (ext === ".zip") return "trace";
  if ([".webm", ".mp4"].includes(ext)) return "video";
  return "file";
}

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".zip") return "application/zip";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp4") return "video/mp4";
  if ([".log", ".txt", ".jsonl", ".ndjson"].includes(ext))
    return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** Drop a deleted session's artifact side-store and the artifact files themselves. */
export function deleteSessionArtifacts(sessionId: string): void {
  storeCache.delete(sessionId);
  rmSync(storeFile(sessionId), { force: true });
  rmSync(join(DATA_DIR, "session-artifacts", sessionId), {
    recursive: true,
    force: true,
  });
}

/**
 * The text an agent gets for one proxied call: the upstream content, the
 * artifacts it wrote, and — when the content is empty — `emptyFallback`, which
 * names both sides of the call so "the page had no console messages" cannot be
 * mistaken for a payload lost on the way ([Task-439](pa://task/439)).
 */
function formatMcpResult(
  result: McpToolResult,
  artifacts: SessionArtifact[],
  emptyFallback: string,
): string {
  const lines = result.content.length
    ? result.content
        .map(
          (item) =>
            item.text ??
            (item.data ? `[${item.type} content]` : JSON.stringify(item)),
        )
        .join("\n")
    : emptyFallback;
  const artifactLines = artifacts.length
    ? `\n\nSession artifacts:\n${artifacts.map((a) => `- ${a.id}: ${a.name} (${a.mimeType}, ${a.url})`).join("\n")}`
    : "";
  return `${lines}${artifactLines}`;
}
