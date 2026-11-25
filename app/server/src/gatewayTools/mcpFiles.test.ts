/**
 * `/mcp` and the file tool (Task-1441 P7a, J2): the listing is the edge's
 * tools without the file tool, a call of it answers "No such tool." before
 * any vault read or upstream request, and the exchange's bound is still
 * computed from the `/mcp`-visible tools (45 s, so 50 s with the margin)
 * while the download's own deadline is 150 s. Every value is fake.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test, vi } from "vitest";
import type { McpHandlerOptions } from "./mcp.ts";

const handlerOptions: McpHandlerOptions[] = [];

vi.mock("./mcp.ts", async (importActual) => {
  const actual = await importActual<typeof import("./mcp.ts")>();
  return {
    ...actual,
    createMcpHandler: (...args: Parameters<typeof actual.createMcpHandler>) => {
      handlerOptions.push(args[2] ?? {});
      return actual.createMcpHandler(...args);
    },
  };
});

const { createEdgeTools } = await import("./index.ts");

const open: http.Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function serveEdge(): Promise<{
  url: string;
  reads: () => number;
  hostCalls: () => number;
}> {
  const tools = createEdgeTools({ log: () => {} });
  const call = vi.spyOn(tools.host, "call");
  let reads = 0;
  const server = http.createServer((req, res) =>
    tools.handleMcp(req, res, {
      clientId: "client-1",
      credential: () => {
        reads += 1;
        return Promise.resolve({ ok: false, absent: true });
      },
    }),
  );
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    reads: () => reads,
    hostCalls: () => call.mock.calls.length,
  };
}

function post(url: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("the /mcp listing leaves the file tool out and is otherwise the edge's", async () => {
  const { url } = await serveEdge();
  const listed = (await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  })) as { result: { tools: { name: string }[] } };
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "jira_get_issue",
      "jira_search_issues",
      "jira_lookup",
      "confluence_search",
      "confluence_get_page",
      "confluence_lookup",
      "slack_search",
      "slack_conversation_read",
      "slack_thread_read",
      "slack_unread",
      "jira_mutate_issue",
      "confluence_mutate_page",
    ],
  );
  assert.ok(
    createEdgeTools({ log: () => {} })
      .host.list()
      .some((tool) => tool.name === "confluence_download_attachment"),
    "the host itself still lists it for client mode",
  );
});

test("a /mcp call of the file tool answers No such tool before any vault read or host call", async () => {
  const fetch = vi.fn(() => Promise.reject(new Error("no request expected")));
  vi.stubGlobal("fetch", fetch);
  const { url, reads, hostCalls } = await serveEdge();
  const answer = await post(url, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "confluence_download_attachment",
      arguments: { attachmentId: "att101" },
    },
  });
  assert.deepEqual(answer, {
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ type: "text", text: "No such tool." }],
      isError: true,
    },
  });
  assert.equal(reads(), 0);
  assert.equal(hostCalls(), 0);
  assert.equal(fetch.mock.calls.length, 0);
});

test("the /mcp exchange's bound counts the /mcp-visible tools only: 45 s, 50 s with its margin", () => {
  handlerOptions.length = 0;
  createEdgeTools({ log: () => {} });
  assert.equal(handlerOptions.length, 1);
  assert.equal(handlerOptions[0]!.deadlineMs, 45_000);
});
