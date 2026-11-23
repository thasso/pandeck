/**
 * The MCP adapter's own bounds (`mcp.ts`, Task-1397 review rv-1397-code-1):
 * one message per POST, a bounded exchange, fixed error texts whatever the
 * SDK says, and an early answer to an oversized upload. The handler runs on a
 * plain HTTP server; the gate in front of it is `mcpEdge.test.ts`'s. Every
 * value is fake.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, test, vi } from "vitest";
import type { ToolDescriptor } from "./descriptor.ts";
import { createToolHost, type ToolHost } from "./host.ts";
import { createEdgeTools } from "./index.ts";
import { createMcpHandler, type McpHandlerOptions } from "./mcp.ts";

const open: { close(): unknown }[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  vi.restoreAllMocks();
});

const listedHost = (call: ToolHost["call"]): ToolHost => ({
  list: () => [
    {
      name: "probe",
      description: "A test tool.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      effect: "read",
      actionKey: "probe:read",
    },
  ],
  call,
});

async function serve(
  host: ToolHost,
  options: McpHandlerOptions = {},
): Promise<{ url: string; lines: string[] }> {
  const lines: string[] = [];
  const handle = createMcpHandler(host, (line) => lines.push(line), options);
  const server = http.createServer((req, res) =>
    handle(req, res, {
      clientId: "client-1",
      credential: () => Promise.resolve({ ok: false, absent: true }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, lines };
}

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: "POST", agent: false, headers: { ...HEADERS, ...headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

const call = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "probe", arguments: {} },
});

/** Counts SDK servers connected and transports and servers closed. */
function spies() {
  return {
    connects: vi.spyOn(Server.prototype, "connect"),
    serverCloses: vi.spyOn(Server.prototype, "close"),
    transportCloses: vi.spyOn(
      WebStandardStreamableHTTPServerTransport.prototype,
      "close",
    ),
  };
}

test("a batch, the review's cancellation one included, is refused before the SDK runs", async () => {
  const counts = spies();
  const hostCall = vi.fn<ToolHost["call"]>(() => new Promise(() => {}));
  const { url } = await serve(listedHost(hostCall));
  const answer = await post(url, [
    call(1),
    {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    },
  ]);
  assert.equal(answer.status, 400);
  assert.deepEqual(JSON.parse(answer.text), {
    jsonrpc: "2.0",
    error: { code: -32600, message: "Batches are not supported." },
    id: null,
  });
  assert.equal(hostCall.mock.calls.length, 0);
  assert.equal(counts.connects.mock.calls.length, 0);
});

test("a response that never comes is ended by the exchange's bound; the call is aborted and the SDK instances close", async () => {
  const counts = spies();
  let seen: AbortSignal | undefined;
  // A host that ignores its signal and never answers: the adapter must not
  // depend on it.
  const { url, lines } = await serve(
    listedHost((_name, _args, caller) => {
      seen = caller.signal;
      return new Promise(() => {});
    }),
    { lifecycleMs: 100 },
  );
  const started = Date.now();
  const answer = await post(url, call(7), {
    "mcp-protocol-version": "2025-06-18",
  });
  assert.equal(answer.status, 504);
  assert.deepEqual(JSON.parse(answer.text), {
    jsonrpc: "2.0",
    error: { code: -32603, message: "The request timed out." },
    id: null,
  });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(seen?.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(counts.connects.mock.calls.length, 1);
  assert.equal(counts.serverCloses.mock.calls.length, 1);
  assert.equal(counts.transportCloses.mock.calls.length, 1);
  assert.deepEqual(lines, ["mcp request of client client-1 timed out"]);
});

test("an unsupported protocol version header is refused with fixed text, never echoed", async () => {
  const counts = spies();
  const { url, lines } = await serve(listedHost(() => new Promise(() => {})));
  const answer = await post(url, call(1), {
    "mcp-protocol-version": "SENTINEL-REQUEST-SECRET",
  });
  assert.equal(answer.status, 400);
  assert.deepEqual(JSON.parse(answer.text), {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Unsupported protocol version." },
    id: null,
  });
  assert.doesNotMatch(answer.text + lines.join("\n"), /SENTINEL/);
  assert.equal(counts.connects.mock.calls.length, 0);
});

test("SDK-generated errors reach the client only as fixed text without data", async () => {
  const { url, lines } = await serve(listedHost(() => new Promise(() => {})));
  const invalid = await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { experimental: { "SENTINEL-BODY-SECRET": 7 } },
      clientInfo: { name: "probe", version: "1" },
    },
  });
  const parsed = JSON.parse(invalid.text) as {
    id: unknown;
    error: { code: number; message: string; data?: unknown };
  };
  assert.equal(parsed.id, 1);
  assert.equal(parsed.error.data, undefined);
  assert.ok(
    ["Internal error.", "Invalid params."].includes(parsed.error.message),
    parsed.error.message,
  );
  const unknown = await post(
    url,
    { jsonrpc: "2.0", id: 2, method: "SENTINEL-METHOD/x", params: {} },
    { "mcp-protocol-version": "2025-06-18" },
  );
  assert.deepEqual(JSON.parse(unknown.text), {
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32601, message: "Method not found." },
  });
  for (const text of [invalid.text, unknown.text, lines.join("\n")])
    assert.doesNotMatch(text, /SENTINEL/);
});

test("an upload over 1 MiB is answered 413 as soon as it crosses the cap, before it ends", async () => {
  const { url } = await serve(listedHost(() => new Promise(() => {})));
  const answer = await new Promise<number>((resolve, reject) => {
    const request = http.request(url, {
      method: "POST",
      agent: false,
      headers: { ...HEADERS, "transfer-encoding": "chunked" },
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", (err) => reject(err));
    // More than the cap, and the request never ends.
    request.write(Buffer.alloc(1024 * 1024 + 1024, 0x20));
  });
  assert.equal(answer, 413);
});

test("the SDK client's own exchange still works: initialize, list and call", async () => {
  const { url } = await serve(
    listedHost(() => Promise.resolve({ ok: true, text: '{"fine":true}' })),
  );
  const init = await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "probe", version: "1" },
    },
  });
  assert.equal(init.status, 200);
  const notified = await post(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-protocol-version": "2025-06-18" },
  );
  assert.equal(notified.status, 202);
  assert.equal(notified.text, "");
  const called = await post(url, call(3), {
    "mcp-protocol-version": "2025-06-18",
  });
  assert.deepEqual(JSON.parse(called.text), {
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "text", text: '{"fine":true}' }] },
  });
});

test("the listing marks jira_mutate_issue as not read-only and the read tools as read-only (Task-1463 AC3)", async () => {
  const { url } = await serve(createEdgeTools({ log: () => {} }).host);
  const listed = await post(
    url,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { "mcp-protocol-version": "2025-06-18" },
  );
  assert.equal(listed.status, 200);
  const tools = (
    JSON.parse(listed.text) as {
      result: {
        tools: Array<{
          name: string;
          annotations?: { readOnlyHint?: boolean };
        }>;
      };
    }
  ).result.tools;
  const hint = (name: string) =>
    tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint;
  assert.equal(hint("jira_mutate_issue"), false);
  assert.equal(hint("jira_get_issue"), true);
});

/** The `/mcp` listing of an edge built with `atlassianScopes`. */
async function listedBy(atlassianScopes?: readonly string[]) {
  const { url } = await serve(
    createEdgeTools({
      log: () => {},
      ...(atlassianScopes ? { atlassianScopes } : {}),
    }).host,
  );
  const listed = await post(
    url,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { "mcp-protocol-version": "2025-06-18" },
  );
  assert.equal(listed.status, 200);
  return (
    JSON.parse(listed.text) as {
      result: {
        tools: Array<{
          name: string;
          annotations?: { readOnlyHint?: boolean };
        }>;
      };
    }
  ).result.tools;
}

test("confluence_mutate_page is listed not read-only, the same whether deletes are on or off (Task-1463 P5b)", async () => {
  const on = await listedBy([
    "delete:page:confluence",
    "delete:attachment:confluence",
  ]);
  const off = await listedBy();
  const mutate = on.find((tool) => tool.name === "confluence_mutate_page");
  assert.equal(mutate?.annotations?.readOnlyHint, false);
  assert.equal(
    on.find((tool) => tool.name === "confluence_get_page")?.annotations
      ?.readOnlyHint,
    true,
  );
  // The switch acts at call time only: the descriptor never changes.
  assert.deepEqual(on, off);
});

test("a cancellation notification on another POST does not reach a running write call (Task-1463 AC18)", async () => {
  let signal: AbortSignal | undefined;
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => (started = resolve));
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const slowWrite: ToolDescriptor = {
    name: "slow_write",
    description: "A slow fake write tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    effect: "write",
    actionKey: "jira:write",
    integration: "atlassian",
    async execute(_params, ctx) {
      signal = ctx.signal;
      started();
      await released;
      return { written: true, aborted: ctx.signal.aborted };
    },
  };
  const { url } = await serve(createToolHost([slowWrite], { log: () => {} }));
  const version = { "mcp-protocol-version": "2025-06-18" };
  const answer = post(
    url,
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "slow_write", arguments: {} },
    },
    version,
  );
  await running;
  const notified = await post(
    url,
    {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 9, reason: "The user interrupted." },
    },
    version,
  );
  // What the SDK answers any notification: accepted, no body.
  assert.equal(notified.status, 202);
  assert.equal(notified.text, "");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal?.aborted, false);
  release();
  const called = await answer;
  assert.equal(called.status, 200);
  const body = JSON.parse(called.text) as {
    id: number;
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  assert.equal(body.id, 9);
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(JSON.parse(body.result.content[0]!.text), {
    written: true,
    aborted: false,
  });
});
