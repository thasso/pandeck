/**
 * The edge's standalone MCP endpoint (Task-1397): stateless Streamable HTTP
 * with JSON responses, one fresh SDK server and transport per POST, closed
 * when the response closes. The gateway's `/mcp` gate (`clientListener.ts`)
 * has already checked the client's certificate, the absent `Origin` and the
 * client's MCP token, and hands the caller in.
 *
 * A tool failure answers an `isError` result with the host's fixed text:
 * `host.call` never throws, so no handler error reaches the client as a
 * JSON-RPC error carrying a message. A response that closes before it
 * finished aborts the call.
 */
import type http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CredentialSource } from "./toolCredential.ts";
import type { ToolHost } from "./host.ts";

const MAX_BODY_BYTES = 1024 * 1024;

/** The caller the gateway hands in: the client and its credential reads. */
export interface McpCaller extends CredentialSource {
  clientId: string;
}

function rpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** The request body, or undefined once it passed the cap or failed. */
function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) over = true;
      if (!over) chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? undefined : Buffer.concat(chunks)));
    req.on("error", () => resolve(undefined));
    // A client that goes away mid-body: settled, never left pending.
    req.on("close", () => resolve(undefined));
  });
}

export function createMcpHandler(
  host: ToolHost,
  log: (line: string) => void,
): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  caller: McpCaller,
) => void {
  const serve = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: McpCaller,
  ): Promise<void> => {
    if (req.method !== "POST") {
      req.resume();
      return rpcError(res, 405, -32000, "Method not allowed.", {
        allow: "POST",
      });
    }
    const raw = await readBody(req);
    if (raw === undefined && !req.complete) return void res.destroy();
    if (raw === undefined)
      return rpcError(res, 413, -32600, "The request is too large.", {
        connection: "close",
      });
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return rpcError(res, 400, -32700, "The request is not JSON.");
    }
    if (res.destroyed) return;

    const controller = new AbortController();
    const server = new Server(
      { name: "pandeck-gateway", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    let closed = false;
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
      if (closed) return;
      closed = true;
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: host.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.effect === "read" },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const answer = await host.call(
        request.params.name,
        request.params.arguments,
        {
          clientId: caller.clientId,
          credential: (integration, signal) =>
            caller.credential(integration, signal),
          signal: AbortSignal.any([controller.signal, extra.signal]),
        },
      );
      return answer.ok
        ? { content: [{ type: "text", text: answer.text }] }
        : { content: [{ type: "text", text: answer.message }], isError: true };
    });
    // The SDK's own class misses `exactOptionalPropertyTypes` on `onclose`.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
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
