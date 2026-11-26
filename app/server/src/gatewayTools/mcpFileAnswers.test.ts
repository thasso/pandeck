/**
 * A file answer through the real `/mcp` adapter (Task-1441 P7b): the test
 * fixture file tool, given a `file.mcp` (rv-p7b-v09-d N1), behind the real
 * host and `createMcpHandler` on a loopback server. It checks the spliced
 * body (AC5, v03 Y2), the placeholder's failure paths, the permit's two
 * holds and its release once (v02 Z2, v03 Y1, v09 U6), the output bound and
 * the lifecycle (v02 Z3), backpressure and an abort mid-body on a 32 MiB
 * test-only fixture (v04 W6 2, v05 V3c), and the SDK client's own result
 * check as the independent oracle (AC4). Every value is fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, test } from "vitest";
import { encodeAtlassianCredential } from "./atlassian.ts";
import {
  FileResult,
  type AtlassianToolDescriptor,
  type McpFileSpec,
} from "./descriptor.ts";
import { fixtureBytes, fixtureFileTool } from "./fileFixtureTool.ts";
import {
  FILE_BUSY,
  createFileBudget,
  createToolHost,
  type FileBudget,
} from "./host.ts";
import { createMcpHandler, type McpHandlerOptions } from "./mcp.ts";
import type { WriterEvent } from "./mcpFileResult.ts";
import { pngOf } from "../test/imageHeaders.ts";

const MiB = 1024 * 1024;
const CREDENTIAL = encodeAtlassianCredential({
  site: "example.atlassian.net",
  email: "a@x.test",
  token: "fake-1",
});
const RESERVE_OVERHEAD = 2 * MiB;
const VERSION = { "mcp-protocol-version": "2025-06-18" };

const open: http.Server[] = [];

afterEach(async () => {
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

/** The fixture's `/mcp` form: a closed projection and a fixed URI. */
const FIXTURE_MCP: McpFileSpec = {
  description: "A test-only file tool on /mcp.",
  limitDescription: "Largest file. Defaults to 1000 bytes, at most 4000.",
  defaultBytes: 1000,
  maxBytes: 4000,
  project: (json) => ({
    status: (json as { status?: unknown }).status ?? null,
  }),
  uri: () => "pandeck-gateway://fixture/F0FIXTURE",
};

/** The fixture with a `file.mcp`, its `/mcp` limits given. */
function mcpFixture(
  mcp: Partial<McpFileSpec> = {},
  overrides: Partial<AtlassianToolDescriptor> = {},
) {
  const spec = { ...FIXTURE_MCP, ...mcp };
  return fixtureFileTool({
    file: {
      limitParam: "maxDownloadBytes",
      defaultBytes: 10 * MiB,
      maxBytes: Math.max(20 * MiB, spec.maxBytes),
      mcp: spec,
    },
    ...overrides,
  });
}

/** A budget that counts its releases, around the real one. */
function countingBudget(): FileBudget & { releases: number } {
  const inner = createFileBudget();
  const budget = {
    releases: 0,
    reserve(bytes: number) {
      const release = inner.reserve(bytes);
      if (!release) return undefined;
      return () => {
        budget.releases += 1;
        release();
      };
    },
    get reserved() {
      return inner.reserved;
    },
  };
  return budget;
}

interface Served {
  url: string;
  port: number;
  reads: () => number;
  /** The last response the handler was given. */
  response: () => http.ServerResponse | undefined;
  lines: string[];
}

async function serve(
  tools: AtlassianToolDescriptor[],
  budget: FileBudget,
  options: McpHandlerOptions = {},
): Promise<Served> {
  const lines: string[] = [];
  const host = createToolHost(tools, {
    log: (line) => lines.push(line),
    fileBudget: budget,
  });
  const handle = createMcpHandler(host, (line) => lines.push(line), options);
  let reads = 0;
  let last: http.ServerResponse | undefined;
  const server = http.createServer((req, res) => {
    last = res;
    handle(req, res, {
      clientId: "client-1",
      credential: () => {
        reads += 1;
        return Promise.resolve({ ok: true, credential: CREDENTIAL });
      },
    });
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    reads: () => reads,
    response: () => last,
    lines,
  };
}

const callOf = (args: Record<string, unknown>, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "fixture_file_read", arguments: args },
});

interface Received {
  status: number;
  contentLength: number;
  body: Buffer;
}

/** One POST, read in full as fast as it comes. */
function post(url: string, message: unknown): Promise<Received> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...VERSION,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            contentLength: Number(response.headers["content-length"]),
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(message));
  });
}

interface CallResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

const resultOf = (received: Received): CallResult =>
  (JSON.parse(received.body.toString("utf8")) as { result: CallResult }).result;

const metaOf = (result: CallResult) =>
  JSON.parse(result.content[0]!.text as string) as {
    status: unknown;
    file: Record<string, unknown>;
  };

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Waits until `check` holds, polling each turn, at most `ms`. */
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const size of [0, 1, 2, 3, 3 * MiB - 1, 3 * MiB, 3 * MiB + 1])
  test(`a blob of ${size} bytes: the body parses, the bytes and hash match, content-length equals what arrived, no placeholder is left`, async () => {
    const budget = countingBudget();
    const marker = "A".repeat(63) + "=";
    const { url } = await serve(
      [mcpFixture({ maxBytes: 4 * MiB, defaultBytes: 4 * MiB })],
      budget,
      { fileSeams: { placeholder: () => marker } },
    );
    const received = await post(url, callOf({ id: "bin", size }));
    assert.equal(received.status, 200);
    assert.equal(received.contentLength, received.body.length);
    const text = received.body.toString("utf8");
    assert.ok(!text.includes(marker));
    const result = resultOf(received);
    assert.equal(result.isError, undefined);
    const part = result.content[1] as {
      type: string;
      resource: { uri: string; mimeType: string; blob: string };
    };
    assert.equal(part.type, "resource");
    assert.equal(part.resource.mimeType, "application/octet-stream");
    assert.equal(part.resource.uri, "pandeck-gateway://fixture/F0FIXTURE");
    const decoded = Buffer.from(part.resource.blob, "base64");
    assert.deepEqual(new Uint8Array(decoded), fixtureBytes(size));
    assert.deepEqual(metaOf(result), {
      status: "downloaded",
      file: {
        name: "fixture.bin",
        mimeType: "application/octet-stream",
        size,
        sha256: sha256(fixtureBytes(size)),
        deliveredAs: "resource",
      },
    });
    await until(() => budget.releases === 1);
    assert.equal(budget.reserved, 0);
  });

/** The fixture answering `bytes` as `mimeType`. */
function answering(bytes: Uint8Array, mimeType: string, name = "f") {
  return mcpFixture(
    { maxBytes: 4 * MiB, defaultBytes: 4 * MiB },
    {
      async execute(_params, ctx) {
        await ctx.credential();
        return new FileResult(
          { status: "downloaded" },
          { name, mimeType, bytes },
        );
      },
    },
  );
}

test("an image goes as image content and a text file as a text resource, each byte-exact", async () => {
  const png = pngOf(64, 64, 2_000);
  const image = await serve([answering(png, "image/png")], countingBudget());
  const imageResult = resultOf(await post(image.url, callOf({ id: "x" })));
  const imagePart = imageResult.content[1] as {
    type: string;
    data: string;
    mimeType: string;
  };
  assert.equal(imagePart.type, "image");
  assert.equal(imagePart.mimeType, "image/png");
  assert.deepEqual(new Uint8Array(Buffer.from(imagePart.data, "base64")), png);
  assert.equal(metaOf(imageResult).file.deliveredAs, "image");

  const words = new TextEncoder().encode("﻿grüße\n");
  const text = await serve(
    [answering(words, "text/plain; charset=utf-8")],
    countingBudget(),
  );
  const textResult = resultOf(await post(text.url, callOf({ id: "x" })));
  assert.deepEqual(textResult.content[1], {
    type: "resource",
    resource: {
      uri: "pandeck-gateway://fixture/F0FIXTURE",
      mimeType: "text/plain",
      text: "﻿grüße\n",
    },
  });
  assert.deepEqual(metaOf(textResult).file, {
    name: "f",
    mimeType: "text/plain; charset=utf-8",
    size: words.length,
    sha256: sha256(words),
    deliveredAs: "text",
  });
});

test("the placeholder removed after sanitization: a fixed 500 with no file byte, and the permit released once", async () => {
  const budget = countingBudget();
  const events: WriterEvent[] = [];
  const { url } = await serve([mcpFixture()], budget, {
    fileSeams: {
      body: () => '{"jsonrpc":"2.0","id":1,"result":{}}',
      writer: (event) => events.push(event),
    },
  });
  const received = await post(url, callOf({ id: "bin", size: 300 }));
  assert.equal(received.status, 500);
  assert.deepEqual(JSON.parse(received.body.toString("utf8")), {
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal error." },
    id: null,
  });
  assert.deepEqual(events, []);
  await until(() => budget.releases === 1);
});

test("the placeholder duplicated into the metadata: a fixed 500 with no file byte", async () => {
  const marker = "B".repeat(64);
  const budget = countingBudget();
  const { url } = await serve(
    [answering(fixtureBytes(300), "application/octet-stream", `x${marker}`)],
    budget,
    { fileSeams: { placeholder: () => marker } },
  );
  const received = await post(url, callOf({ id: "x" }));
  assert.equal(received.status, 500);
  assert.ok(!received.body.toString("utf8").includes(marker));
  assert.ok(!received.body.toString("utf8").includes("fixture"));
  await until(() => budget.releases === 1);
});

test("over the /mcp limit: the host's text names the /mcp cap and maxDownloadBytes, never the client cap, and no file part is sent", async () => {
  const budget = countingBudget();
  const { url } = await serve([mcpFixture()], budget);
  for (const [args, limit] of [
    [{ id: "bin", size: 1001 }, 1000],
    [{ id: "bin", size: 4001, maxDownloadBytes: 9_999_999 }, 4000],
  ] as const) {
    const result = resultOf(await post(url, callOf(args)));
    assert.deepEqual(result, {
      content: [
        {
          type: "text",
          text: `The file is larger than the ${limit}-byte limit; nothing was saved. Raise maxDownloadBytes (at most 4000) to fetch it.`,
        },
      ],
      isError: true,
    });
  }
  // Within the limit, at it exactly.
  const ok = resultOf(await post(url, callOf({ id: "bin", size: 1000 })));
  assert.equal(metaOf(ok).file.size, 1000);
  await until(() => budget.releases === 3);
});

test("the reservation is 2E + 2 MiB from the /mcp spec: E is its default, and a request above the cap is clamped to it", async () => {
  const seen: Array<{ limit?: number; cap?: number; reserved: number }> = [];
  const budget = countingBudget();
  const tool = mcpFixture(
    {},
    {
      async execute(_params, ctx) {
        seen.push({
          ...(ctx.maxFileBytes !== undefined
            ? { limit: ctx.maxFileBytes }
            : {}),
          ...(ctx.maxFileCap !== undefined ? { cap: ctx.maxFileCap } : {}),
          reserved: budget.reserved,
        });
        return { status: "inline" };
      },
    },
  );
  const { url } = await serve([tool], budget);
  await post(url, callOf({ id: "x" }));
  await until(() => budget.releases === 1);
  await post(url, callOf({ id: "x", maxDownloadBytes: 1e12 }));
  await until(() => budget.releases === 2);
  assert.deepEqual(seen, [
    { limit: 1000, cap: 4000, reserved: 2 * 1000 + RESERVE_OVERHEAD },
    { limit: 4000, cap: 4000, reserved: 2 * 4000 + RESERVE_OVERHEAD },
  ]);
});

test("a plain answer from a file tool is plain text, and its permit is released once", async () => {
  const budget = countingBudget();
  const { url } = await serve([mcpFixture()], budget);
  const result = resultOf(await post(url, callOf({ id: "inline" })));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  assert.equal(result.isError, undefined);
  await until(() => budget.releases === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(budget.releases, 1);
});

test("an early close before any writer: the permit waits for the execution, then is released once", async () => {
  const budget = countingBudget();
  const tool = mcpFixture();
  const { url } = await serve([tool], budget);
  const request = http.request(url, {
    method: "POST",
    agent: false,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...VERSION,
    },
  });
  request.on("error", () => {});
  request.end(JSON.stringify(callOf({ id: "hold" })));
  await until(() => tool.started === 1);
  request.destroy();
  // The output hold settled with the close; the execution still holds.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(budget.releases, 0);
  assert.ok(budget.reserved > 0);
  tool.release();
  await until(() => budget.releases === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(budget.releases, 1);
});

test("a never-settling executor keeps the permit past the 504: a second call is FILE_BUSY with no vault read", async () => {
  const budget = countingBudget();
  const events: WriterEvent[] = [];
  const tool = mcpFixture(
    {},
    {
      async execute(_params, ctx) {
        await ctx.credential();
        return new Promise(() => {});
      },
    },
  );
  const served = await serve([tool], budget, {
    lifecycleMs: 100,
    fileSeams: { writer: (event) => events.push(event) },
  });
  const first = await post(served.url, callOf({ id: "bin" }));
  assert.equal(first.status, 504);
  assert.deepEqual(events, [], "no writer starts after the lifecycle ends");
  const reads = served.reads();
  const second = await post(served.url, callOf({ id: "bin" }, 2));
  assert.deepEqual(resultOf(second), {
    content: [{ type: "text", text: FILE_BUSY }],
    isError: true,
  });
  assert.equal(served.reads(), reads);
  assert.equal(budget.releases, 0);
});

test("two concurrent calls never share state: one file streams, the other is FILE_BUSY", async () => {
  const budget = countingBudget();
  const tool = mcpFixture({ maxBytes: 4 * MiB, defaultBytes: 4 * MiB });
  const { url } = await serve([tool], budget);
  const first = post(url, callOf({ id: "hold", size: 2 * MiB }));
  await until(() => tool.started === 1);
  const second = await post(url, callOf({ id: "hold", size: 2 * MiB }, 2));
  assert.deepEqual(resultOf(second), {
    content: [{ type: "text", text: FILE_BUSY }],
    isError: true,
  });
  tool.release();
  const done = await first;
  assert.equal(done.contentLength, done.body.length);
  const part = resultOf(done).content[1] as { resource: { blob: string } };
  assert.equal(Buffer.from(part.resource.blob, "base64").length, 2 * MiB);
  await until(() => budget.releases === 1);
});

/** A raw socket POST whose reader the test drives. */
async function rawPost(
  port: number,
  message: unknown,
): Promise<{
  response: http.IncomingMessage;
  request: http.ClientRequest;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...VERSION,
        },
      },
      (response) => {
        response.pause();
        resolve({ response, request });
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(message));
  });
}

const BIG = 32 * MiB;
const bigFixture = () => mcpFixture({ maxBytes: BIG, defaultBytes: BIG }, {});

test("backpressure on a 32 MiB test-only fixture: a write is refused, the writer waits for drain, and writableLength stays within 8 MiB", async () => {
  const budget = countingBudget();
  const events: WriterEvent[] = [];
  let maxQueued = 0;
  // The handler's response, read from the writer's probe once served.
  const box: { served?: Served } = {};
  box.served = await serve([bigFixture()], budget, {
    fileSeams: {
      writer: (event) => {
        events.push(event);
        const queued = box.served?.response()?.writableLength ?? 0;
        maxQueued = Math.max(maxQueued, queued);
      },
    },
  });
  const { response } = await rawPost(
    box.served.port,
    callOf({ id: "bin", size: BIG }),
  );
  // Paused from the first byte until the writer reports it is waiting.
  await until(() => events.includes("waiting"));
  assert.ok(events.includes("write-refused"));
  const index = events.indexOf("write-refused");
  assert.equal(events[index + 1], "waiting");
  let received = 0;
  response.on("data", (chunk: Buffer) => (received += chunk.length));
  const ended = new Promise((resolve) => response.on("end", resolve));
  response.resume();
  await ended;
  assert.equal(received, Number(response.headers["content-length"]));
  assert.ok(maxQueued <= 8 * MiB, `queued ${maxQueued}`);
  assert.ok(events.includes("drained"));
  assert.equal(events.at(-1), "exited");
  await until(() => budget.releases === 1);
}, 60_000);

test("an abort while the writer waits for drain: stopped, then exited, no further piece, and the release only after close", async () => {
  const budget = countingBudget();
  const events: string[] = [];
  const served = await serve([bigFixture()], budget, {
    fileSeams: { writer: (event) => events.push(event) },
  });
  const { request } = await rawPost(
    served.port,
    callOf({ id: "bin", size: BIG }),
  );
  await until(() => events.includes("waiting"));
  served.response()!.once("close", () => events.push("close"));
  const before = budget.releases;
  request.destroy();
  await until(() => budget.releases === before + 1);
  const stopped = events.indexOf("stopped");
  assert.ok(stopped >= 0);
  assert.ok(events.indexOf("exited") > stopped);
  assert.ok(events.indexOf("close") >= 0);
  assert.deepEqual(
    events
      .slice(stopped)
      .filter((event) => event === "write-refused" || event === "drained"),
    [],
    "no piece after the stop",
  );
}, 60_000);

test("a stalled reader is cut at the output bound and the permit released after the close", async () => {
  const budget = countingBudget();
  const events: WriterEvent[] = [];
  const served = await serve([bigFixture()], budget, {
    fileOutputMs: 300,
    fileSeams: { writer: (event) => events.push(event) },
  });
  const { response } = await rawPost(
    served.port,
    callOf({ id: "bin", size: BIG }),
  );
  response.on("error", () => {});
  await until(() => events.includes("stopped"));
  await until(() => budget.releases === 1);
  assert.deepEqual(events.slice(-2), ["stopped", "exited"]);
  assert.ok(served.response()!.destroyed);
}, 60_000);

test("the SDK client accepts each part and its own result check passes: blob, image and text decode to the bytes", async () => {
  const cases = [
    {
      bytes: fixtureBytes(70_000),
      mimeType: "application/pdf",
      as: "resource",
    },
    { bytes: pngOf(32, 32, 5_000), mimeType: "image/png", as: "image" },
    {
      bytes: new TextEncoder().encode("a,b\n1,2\n"),
      mimeType: "text/csv",
      as: "text",
    },
  ] as const;
  for (const entry of cases) {
    const { url } = await serve(
      [answering(entry.bytes, entry.mimeType)],
      countingBudget(),
    );
    const client = new Client({ name: "probe", version: "1" });
    // The SDK's own class misses `exactOptionalPropertyTypes` on its handlers.
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url)) as Transport,
    );
    try {
      const result = (await client.callTool({
        name: "fixture_file_read",
        arguments: { id: "x" },
      })) as CallResult;
      assert.equal(result.isError, undefined);
      const part = result.content[1]!;
      const decoded =
        entry.as === "image"
          ? Buffer.from(part.data as string, "base64")
          : entry.as === "resource"
            ? Buffer.from((part.resource as { blob: string }).blob, "base64")
            : Buffer.from((part.resource as { text: string }).text, "utf8");
      assert.deepEqual(new Uint8Array(decoded), entry.bytes);
      const meta = metaOf(result);
      assert.equal(meta.file.deliveredAs, entry.as);
      assert.equal(meta.file.sha256, sha256(entry.bytes));
    } finally {
      await client.close();
    }
  }
});
