/**
 * The edge's standalone MCP endpoint (Task-1397): stateless Streamable HTTP
 * with JSON responses, one fresh SDK server and transport per POST. The
 * gateway's `/mcp` gate (`clientListener.ts`) has already checked the
 * client's certificate, the absent `Origin` and the client's MCP token, and
 * hands the caller in.
 *
 * This adapter owns the HTTP exchange; the SDK only sees one parsed message
 * and answers a web `Response`, which is checked before anything is written:
 *
 * - One JSON-RPC message per POST. A batch, a body over 1 MiB (refused as
 *   soon as the cap is crossed) or an unsupported `mcp-protocol-version` is
 *   refused with fixed text before the SDK runs.
 * - Every JSON-RPC error the SDK answers is rewritten to a fixed text for its
 *   code, without `data`, so no SDK, schema or request text reaches a client.
 *   A tool failure is an `isError` result with the host's fixed text. Two
 *   exceptions (ADR-0005), never shown with credential material, sanitized
 *   and capped: Jira's own `errorMessages`/`errors` reasons for a rejected
 *   `jira_search_issues` (HTTP 400, D4-yes), and the write tools'
 *   (`jira_mutate_issue`, `confluence_mutate_page`) shared-code messages and
 *   the product's reasons for a write call's 4xx (D-W2).
 * - The whole exchange is bounded (the longest deadline a call can run plus a
 *   margin): at that point the call is aborted, the response ends with a
 *   fixed error and the SDK instances close, whatever the SDK still waits
 *   for. A response that closes early aborts the call too.
 * - Each POST is its own SDK server, so a `notifications/cancelled` on a
 *   separate POST never reaches a running call: only the call's own response
 *   closing aborts it.
 * - `/mcp` lists and runs what the host's `mcpList` admits (Task-1441 P7b):
 *   a file tool only with `file.mcp`. A call of any other name answers
 *   "No such tool." before any vault read.
 * - A file answer (P7b, `mcpFileResult.ts`) is a metadata text part and one
 *   file part: text, image or blob. An image or blob crosses the SDK as a
 *   per-call placeholder that must occur exactly once in the answer, and its
 *   base64 is spliced in as the body is written, never built whole. The
 *   exchange's bound ends when the SDK answers; the body then has its own
 *   output bound. The host's file permit settles once the response has
 *   finished or closed and the writer has stopped.
 */
import type http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { CredentialSource } from "./toolCredential.ts";
import { NO_SUCH_TOOL, type ToolHost } from "./host.ts";
import {
  classifyFile,
  createOutputHold,
  newPlaceholder,
  writeSplicedFile,
  type WriterEvent,
} from "./mcpFileResult.ts";

const MAX_BODY_BYTES = 1024 * 1024;
/** How long a refused upload may keep its connection after the answer. */
const REFUSED_UPLOAD_GRACE_MS = 1_000;
/** The exchange's bound beyond the host's own deadline. */
const LIFECYCLE_MARGIN_MS = 5_000;
/** Request headers the SDK sees; nothing else of the request reaches it. */
const SDK_HEADERS = ["accept", "content-type", "mcp-protocol-version"];

/** The fixed text a client sees for each JSON-RPC error code. */
const ERROR_TEXT: Record<number, string> = {
  [-32700]: "Parse error.",
  [-32600]: "Invalid request.",
  [-32601]: "Method not found.",
  [-32602]: "Invalid params.",
  [-32603]: "Internal error.",
  [-32001]: "Session not found.",
  [-32000]: "Bad request.",
};
const FALLBACK_ERROR_TEXT = "The request failed.";

/** The caller the gateway hands in: the client and its credential reads. */
export interface McpCaller extends CredentialSource {
  clientId: string;
}

export interface McpHandlerOptions {
  /**
   * The longest deadline a call can run (`longestDeadlineMs`); the exchange
   * is bounded a margin beyond it.
   */
  deadlineMs?: number;
  /** Test seam: the exchange's bound itself. */
  lifecycleMs?: number;
  /** Test seam: a file answer's output bound (120 s unless given). */
  fileOutputMs?: number;
  /** Test seams on a file answer's splice (P7b, v03 Y2, v04 W6). */
  fileSeams?: {
    /** Makes each call's placeholder. */
    placeholder?: () => string;
    /** Rewrites the sanitized body before the placeholder is checked. */
    body?: (text: string) => string;
    /** Sees the writer's steps. */
    writer?: (event: WriterEvent) => void;
  };
}

type FileAnswer = Extract<
  Awaited<ReturnType<ToolHost["mcpCall"]>>,
  { ok: true }
>["file"] & {};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    ...(body ? { "content-type": "application/json" } : {}),
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function rpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  send(
    res,
    status,
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    headers,
  );
}

/** A JSON-RPC message with any error's text replaced by the fixed one. */
function sanitized(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return message;
  const record = message as Record<string, unknown>;
  if (typeof record.error !== "object" || record.error === null) return message;
  const code = (record.error as Record<string, unknown>).code;
  const fixed = typeof code === "number" ? code : -32603;
  return {
    jsonrpc: "2.0",
    id: record.id ?? null,
    error: { code: fixed, message: ERROR_TEXT[fixed] ?? FALLBACK_ERROR_TEXT },
  };
}

/** The SDK's answer as fixed-text JSON, or undefined when it is not JSON. */
async function sanitizedBody(response: Response): Promise<string | undefined> {
  const text = await response.text();
  if (text === "") return "";
  try {
    const parsed = JSON.parse(text) as unknown;
    return JSON.stringify(
      Array.isArray(parsed) ? parsed.map(sanitized) : sanitized(parsed),
    );
  } catch {
    return undefined;
  }
}

type Body = { ok: true; raw: Buffer } | { ok: false; tooLarge: boolean };

/**
 * The request body. Crossing the cap settles at once: nothing more is kept,
 * and the caller answers before the upload ends.
 */
function readBody(req: http.IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      req.off("data", onData);
      // Discard the rest until the connection is closed after the answer.
      req.resume();
      resolve({ ok: false, tooLarge: true });
    };
    req.on("data", onData);
    req.on("end", () => resolve({ ok: true, raw: Buffer.concat(chunks) }));
    req.on("error", () => resolve({ ok: false, tooLarge: false }));
    // A client that goes away mid-body: settled, never left pending.
    req.on("close", () => resolve({ ok: false, tooLarge: false }));
  });
}

/**
 * `/mcp` sees only the host's list and its one-call `call`: never a client's
 * `callForClient`, `prepare` or `apply` (Task-1463 P6a).
 */
export function createMcpHandler(
  host: Pick<ToolHost, "mcpList" | "mcpCall">,
  log: (line: string) => void,
  options: McpHandlerOptions = {},
): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  caller: McpCaller,
) => void {
  const lifecycleMs =
    options.lifecycleMs ?? (options.deadlineMs ?? 30_000) + LIFECYCLE_MARGIN_MS;
  const supported = new Set<string>(SUPPORTED_PROTOCOL_VERSIONS);

  const serve = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: McpCaller,
  ): Promise<void> => {
    // Registered before any await, so no `finish` or `close` is missed.
    const output = createOutputHold(res);
    if (req.method !== "POST") {
      req.resume();
      return rpcError(res, 405, -32000, "Method not allowed.", {
        allow: "POST",
      });
    }
    const version = req.headers["mcp-protocol-version"];
    if (version !== undefined && !supported.has(String(version))) {
      req.resume();
      return rpcError(res, 400, -32000, "Unsupported protocol version.");
    }
    const body = await readBody(req);
    if (!body.ok) {
      if (!body.tooLarge) return void res.destroy();
      res.once("finish", () =>
        setTimeout(() => req.destroy(), REFUSED_UPLOAD_GRACE_MS).unref(),
      );
      return rpcError(res, 413, -32600, "The request is too large.", {
        connection: "close",
      });
    }
    let message: unknown;
    try {
      message = JSON.parse(body.raw.toString("utf8"));
    } catch {
      return rpcError(res, 400, -32700, "The request is not JSON.");
    }
    if (Array.isArray(message))
      return rpcError(res, 400, -32600, "Batches are not supported.");
    if (typeof message !== "object" || message === null)
      return rpcError(res, 400, -32600, "Invalid request.");
    if (res.destroyed) return;

    const controller = new AbortController();
    const server = new Server(
      { name: "pandeck-gateway", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    };
    // A file answer's bytes, kept only until this exchange has answered.
    let pending: { placeholder: string; bytes: Uint8Array } | undefined;
    let answered = false;
    /** The answer's content: the metadata, then the file part (AC4). */
    const fileContent = (text: string, file: FileAnswer) => {
      const { bytes, uri } = file;
      const classified = classifyFile(bytes, file.mimeType);
      const parsed: unknown = JSON.parse(text);
      const meta = {
        type: "text" as const,
        text: JSON.stringify({
          ...(isRecord(parsed) ? parsed : {}),
          file: {
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            sha256: file.sha256,
            deliveredAs: classified.as,
          },
        }),
      };
      if (classified.as === "text")
        return {
          content: [
            meta,
            {
              type: "resource" as const,
              resource: {
                uri,
                mimeType: classified.mimeType,
                text: classified.text,
              },
            },
          ],
        };
      const placeholder = (options.fileSeams?.placeholder ?? newPlaceholder)();
      if (!answered) pending = { placeholder, bytes };
      return {
        content: [
          meta,
          classified.as === "image"
            ? {
                type: "image" as const,
                data: placeholder,
                mimeType: classified.mimeType,
              }
            : {
                type: "resource" as const,
                resource: {
                  uri,
                  mimeType: "application/octet-stream",
                  blob: placeholder,
                },
              },
        ],
      };
    };
    let expire = (): void => {};
    const expired = new Promise<undefined>((resolve) => {
      expire = () => resolve(undefined);
    });
    const lifecycle = setTimeout(expire, lifecycleMs);
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
      expire();
      close();
    });
    // A file tool is listed and run only with `file.mcp` (Task-1441 P7b).
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: host.mcpList().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.effect === "read" },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      // A request string is only compared, never logged or echoed.
      if (!host.mcpList().some((tool) => tool.name === request.params.name))
        return {
          content: [{ type: "text", text: NO_SUCH_TOOL }],
          isError: true,
        };
      const answer = await host.mcpCall(
        request.params.name,
        request.params.arguments,
        {
          clientId: caller.clientId,
          credential: (integration, signal) =>
            caller.credential(integration, signal),
          signal: AbortSignal.any([controller.signal, extra.signal]),
          // The file permit's output hold: this response's end (v08 T3).
          onSettled: output.onSettled,
        },
      );
      if (!answer.ok)
        return {
          content: [{ type: "text", text: answer.message }],
          isError: true,
        };
      return answer.file
        ? fileContent(answer.text, answer.file)
        : { content: [{ type: "text", text: answer.text }] };
    });
    const headers = new Headers();
    for (const name of SDK_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    try {
      // The SDK's own class misses `exactOptionalPropertyTypes` on `onclose`.
      await server.connect(transport as Transport);
      const handled = transport.handleRequest(
        new Request("http://gateway.invalid/mcp", { method: "POST", headers }),
        { parsedBody: message },
      );
      handled.catch(() => {});
      const response = await Promise.race([handled, expired]);
      // The exchange's bound ends with the SDK's answer, before any output
      // (v02 Z3); a file body has its own bound.
      clearTimeout(lifecycle);
      if (!response) {
        answered = true;
        pending = undefined;
        controller.abort();
        if (!res.destroyed)
          log(`mcp request of client ${caller.clientId} timed out`);
        return rpcError(res, 504, -32603, "The request timed out.");
      }
      const text = await sanitizedBody(response);
      answered = true;
      let file = pending;
      pending = undefined;
      close();
      if (text === undefined)
        return rpcError(res, 500, -32603, "Internal error.");
      if (!file) return send(res, response.status, text);
      // Exactly one placeholder, or no file byte is written (v03 Y2).
      const parts = (options.fileSeams?.body?.(text) ?? text).split(
        file.placeholder,
      );
      if (parts.length !== 2)
        return rpcError(res, 500, -32603, "Internal error.");
      const exited = output.writerStarted();
      const bytes = file.bytes;
      file = undefined;
      try {
        await writeSplicedFile(
          res,
          {
            status: response.status,
            prefix: parts[0]!,
            suffix: parts[1]!,
            bytes,
          },
          {
            signal: controller.signal,
            ...(options.fileOutputMs !== undefined
              ? { outputMs: options.fileOutputMs }
              : {}),
            ...(options.fileSeams?.writer
              ? { probe: options.fileSeams.writer }
              : {}),
          },
        );
      } finally {
        exited();
      }
    } finally {
      clearTimeout(lifecycle);
      close();
    }
  };

  return (req, res, caller) => {
    serve(req, res, caller).catch(() => {
      log(`mcp request of client ${caller.clientId} failed`);
      if (!res.headersSent)
        rpcError(res, 500, -32603, "The gateway could not serve the request.");
      else res.destroy();
    });
  };
}
