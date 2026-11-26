/**
 * `/mcp` and the file tool (Task-1441 P7b, v09 U1/U2, rv-p7b-v09-d N2): the
 * edge lists `confluence_download_attachment` with its `/mcp` description and
 * limit, a call reaches the host's `/mcp` entry and answers the file in the
 * result, and the exchange's bound counts the download's 150 s. On `/mcp` the
 * download runs under 11534336 bytes and every over-limit text names that,
 * never the client cap. A file tool without `file.mcp` stays off `/mcp`. The
 * client route is unchanged. Every value is fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { afterEach, test, vi } from "vitest";
import {
  CONFLUENCE_ATTACHMENT_MAX_BYTES,
  CONFLUENCE_DOWNLOAD_DEFAULT_BYTES,
  CONFLUENCE_DOWNLOAD_DESCRIPTION,
  CONFLUENCE_DOWNLOAD_SCHEMA,
} from "../confluenceDownload.ts";
import {
  DOWNLOAD_ORACLE,
  ORACLE_SITE,
  oracleFetch,
} from "../test/confluenceDownloadOracle.ts";
import { pngOf } from "../test/imageHeaders.ts";
import { encodeAtlassianCredential } from "./atlassian.ts";
import {
  DOWNLOAD_TEXT,
  confluenceDownloadAttachment,
} from "./confluenceDownload.ts";
import {
  MCP_UPLOAD_UNAVAILABLE,
  UPLOAD_UNAVAILABLE,
} from "./confluenceMutatePage.ts";
import type { AtlassianToolDescriptor, ToolDescriptor } from "./descriptor.ts";
import { fixtureFileTool } from "./fileFixtureTool.ts";
import {
  FILE_BUSY,
  createFileBudget,
  createToolHost,
  type ToolCaller,
  type ToolHost,
} from "./host.ts";
import { createMcpHandler, type McpHandlerOptions } from "./mcp.ts";
import { MCP_FILE_MAX_BYTES } from "./mcpFileResult.ts";

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

const MiB = 1024 * 1024;
const FILE = MCP_FILE_MAX_BYTES;
const CLIENT_CAP = CONFLUENCE_ATTACHMENT_MAX_BYTES;
const SENTINEL = "SENTINEL-z4-9c1e";
const CREDENTIAL = encodeAtlassianCredential({
  site: ORACLE_SITE,
  email: "a@x.test",
  token: "fake-1",
});

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

interface Served {
  url: string;
  reads: () => number;
  lines: string[];
}

async function listen(
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: Parameters<ReturnType<typeof createMcpHandler>>[2],
  ) => void,
  lines: string[],
): Promise<Served> {
  let reads = 0;
  const server = http.createServer((req, res) =>
    handle(req, res, {
      clientId: "client-1",
      credential: () => {
        reads += 1;
        return Promise.resolve({ ok: true, credential: CREDENTIAL });
      },
    }),
  );
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, reads: () => reads, lines };
}

/** The edge as the gateway runs it, its host's `/mcp` entry spied on. */
async function serveEdge(): Promise<
  Served & {
    host: ToolHost;
    uploads: ReturnType<typeof createEdgeTools>["uploads"];
    mcpCalls: () => number;
    calls: () => number;
  }
> {
  const lines: string[] = [];
  const tools = createEdgeTools({ log: (line) => lines.push(line) });
  const mcpCall = vi.spyOn(tools.host, "mcpCall");
  const call = vi.spyOn(tools.host, "call");
  const served = await listen(tools.handleMcp, lines);
  return {
    ...served,
    host: tools.host,
    uploads: tools.uploads,
    mcpCalls: () => mcpCall.mock.calls.length,
    calls: () => call.mock.calls.length,
  };
}

/** A bare host with `tools` behind the real `/mcp` handler. */
async function serveHost(tools: ToolDescriptor[]): Promise<Served> {
  const lines: string[] = [];
  const host = createToolHost(tools, { log: (line) => lines.push(line) });
  return listen(
    createMcpHandler(host, (line) => lines.push(line)),
    lines,
  );
}

interface Posted {
  status: number;
  text: string;
  json: {
    result?: {
      content: Array<Record<string, unknown>>;
      isError?: boolean;
      tools?: Array<{
        name: string;
        description: string;
        inputSchema: { properties: Record<string, { description?: string }> };
      }>;
    };
  };
}

function post(url: string, body: unknown): Promise<Posted> {
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
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            text,
            json: JSON.parse(text) as Posted["json"],
          });
        });
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

const listing = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const download = (args: Record<string, unknown>, name?: string) => ({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: name ?? "confluence_download_attachment", arguments: args },
});

const failure = (text: string) => ({
  content: [{ type: "text", text }],
  isError: true,
});

const metaOf = (posted: Posted) =>
  JSON.parse(posted.json.result!.content[0]!.text as string) as Record<
    string,
    unknown
  >;

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** One attachment the stubbed Confluence serves. */
interface Served1 {
  meta: Record<string, unknown>;
  bytes: Uint8Array;
  contentType?: string;
}

/**
 * `fetch` answering `att`'s metadata read and its download wherever the
 * metadata points; records each URL.
 */
function stubConfluence(att: Served1): URL[] {
  const seen: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      seen.push(url);
      if (url.pathname === `/wiki/api/v2/attachments/${String(att.meta.id)}`)
        return Response.json(att.meta);
      if (url.pathname.startsWith("/wiki/download/"))
        return new Response(
          new Uint8Array(att.bytes),
          att.contentType
            ? { headers: { "content-type": att.contentType } }
            : {},
        );
      return new Response("", { status: 404 });
    }),
  );
  return seen;
}

const attachmentOf = (
  id: string,
  title: string,
  bytes: Uint8Array,
  mediaType: string,
  fileSize: number = bytes.byteLength,
): Served1 => ({
  meta: {
    id,
    title,
    pageId: "123",
    mediaType,
    fileSize,
    version: { number: 3 },
    downloadLink: `/download/attachments/123/${title}?version=3&api=v2`,
  },
  bytes,
});

const isDownload = (url: URL) => url.pathname.startsWith("/wiki/download/");

test("the /mcp listing has the download in descriptor order with its /mcp description and limit", async () => {
  const { url } = await serveEdge();
  const tools = (await post(url, listing)).json.result!.tools!;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "jira_get_issue",
      "jira_search_issues",
      "jira_lookup",
      "confluence_search",
      "confluence_get_page",
      "confluence_lookup",
      "confluence_download_attachment",
      "slack_search",
      "slack_conversation_read",
      "slack_thread_read",
      "slack_unread",
      "jira_mutate_issue",
      "confluence_mutate_page",
    ],
  );
  const entry = tools.find(
    (tool) => tool.name === "confluence_download_attachment",
  )!;
  assert.notEqual(entry.description, CONFLUENCE_DOWNLOAD_DESCRIPTION);
  assert.match(entry.description, /return its bytes in this result/);
  assert.equal(
    entry.inputSchema.properties.maxBytes!.description,
    "Largest file downloaded. Defaults to 11534336 bytes, at most 11534336.",
  );
  assert.ok(!JSON.stringify(entry).includes(String(CLIENT_CAP)));
});

test("a /mcp call of the download reaches the host's /mcp entry and answers the file in the result", async () => {
  vi.stubGlobal("fetch", vi.fn(oracleFetch()));
  const edge = await serveEdge();
  // A parameterized text type: a text resource with the normalized type.
  const text = await post(edge.url, download({ attachmentId: "att103" }));
  assert.equal(edge.mcpCalls(), 1);
  assert.equal(edge.calls(), 0);
  assert.equal(edge.reads(), 1);
  assert.deepEqual(text.json.result!.content[1], {
    type: "resource",
    resource: {
      uri: "pandeck-gateway://confluence/attachment/att103",
      mimeType: "text/plain",
      text: "text",
    },
  });
  assert.deepEqual(metaOf(text), {
    status: "downloaded_attachment",
    pageId: "123",
    attachment: {
      id: "att103",
      title: "readme",
      mediaType: "Text/Plain; charset=UTF-8",
      fileSize: 4,
      version: 3,
    },
    file: {
      name: "readme",
      mimeType: "Text/Plain; charset=UTF-8",
      size: 4,
      sha256: sha256(new TextEncoder().encode("text")),
      deliveredAs: "text",
    },
  });
  // No type at all: the bytes as a blob, never guessed from the name.
  const blob = await post(edge.url, download({ attachmentId: "att101" }));
  assert.deepEqual(blob.json.result!.content[1], {
    type: "resource",
    resource: {
      uri: "pandeck-gateway://confluence/attachment/att101",
      mimeType: "application/octet-stream",
      blob: Buffer.from("hello").toString("base64"),
    },
  });
  assert.ok(!blob.text.includes("downloadUrl"));
  assert.ok(!blob.text.includes("sessionAttachment"));
});

test("the /mcp exchange's bound counts the download's own 150 s", () => {
  handlerOptions.length = 0;
  createEdgeTools({ log: () => {} });
  assert.equal(handlerOptions.length, 1);
  assert.equal(handlerOptions[0]!.deadlineMs, 150_000);
});

test("a file tool without file.mcp is off the /mcp listing and answers No such tool before any vault read", async () => {
  const fixture = fixtureFileTool();
  const { file: _file, ...rest } = fixtureFileTool();
  const plain: ToolDescriptor = { ...rest, name: "plain_read" };
  const served = await serveHost([fixture, plain]);
  const names = (await post(served.url, listing)).json.result!.tools!.map(
    (tool) => tool.name,
  );
  assert.deepEqual(names, ["plain_read"]);
  const answer = await post(
    served.url,
    download({ id: "bin" }, "fixture_file_read"),
  );
  assert.deepEqual(answer.json.result, failure("No such tool."));
  assert.equal(served.reads(), 0);
  assert.equal(fixture.started, 0);
});

/** The real download, its context recorded at each run. */
function recordingDownload(seen: unknown[], budget = createFileBudget()) {
  const original = confluenceDownloadAttachment as AtlassianToolDescriptor;
  const tool: AtlassianToolDescriptor = {
    ...original,
    execute(params, ctx) {
      seen.push({
        limit: ctx.maxFileBytes,
        cap: ctx.maxFileCap,
        reserved: budget.reserved,
      });
      return original.execute(params, ctx);
    },
  };
  return { tool, budget };
}

test("on /mcp the download sees 11534336 as its limit and cap, reserves 2E + 2 MiB, and a larger limit is clamped", async () => {
  stubConfluence(
    attachmentOf("att201", "a.pdf", new Uint8Array(8), "application/pdf"),
  );
  const seen: unknown[] = [];
  const { tool, budget } = recordingDownload(seen);
  const lines: string[] = [];
  const host = createToolHost([tool], { log: () => {}, fileBudget: budget });
  const served = await listen(
    createMcpHandler(host, () => {}),
    lines,
  );
  await post(served.url, download({ attachmentId: "att201" }));
  await post(served.url, download({ attachmentId: "att201", maxBytes: 1e12 }));
  await post(served.url, download({ attachmentId: "att201", maxBytes: 100 }));
  const reserved = (limit: number) => 2 * limit + 2 * MiB;
  assert.deepEqual(seen, [
    { limit: FILE, cap: FILE, reserved: reserved(FILE) },
    { limit: FILE, cap: FILE, reserved: reserved(FILE) },
    { limit: 100, cap: FILE, reserved: reserved(100) },
  ]);
});

test("the client route is unchanged: 50 MiB and 100 MiB, no URI, the unprojected text", async () => {
  vi.stubGlobal("fetch", vi.fn(oracleFetch()));
  const seen: unknown[] = [];
  const { tool, budget } = recordingDownload(seen);
  const host = createToolHost([tool], { log: () => {}, fileBudget: budget });
  const caller: ToolCaller = {
    clientId: "client-1",
    credential: () => Promise.resolve({ ok: true, credential: CREDENTIAL }),
    onSettled: (fn) => queueMicrotask(fn),
  };
  const answer = await host.callForClient(
    "confluence_download_attachment",
    { attachmentId: "att101" },
    caller,
  );
  assert.deepEqual(seen, [
    {
      limit: CONFLUENCE_DOWNLOAD_DEFAULT_BYTES,
      cap: CLIENT_CAP,
      reserved: 2 * CONFLUENCE_DOWNLOAD_DEFAULT_BYTES + 2 * MiB,
    },
  ]);
  assert.ok(answer.ok && answer.file);
  assert.equal("uri" in answer.file, false);
  const { sessionAttachment: _staged, ...fields } = JSON.parse(
    DOWNLOAD_ORACLE[0]!.expected,
  ) as Record<string, unknown>;
  assert.equal(answer.text, JSON.stringify(fields));
});

test("the client listing entry is P7a's byte for byte, its file limits exactly three members", () => {
  const entry = createEdgeTools({ log: () => {} })
    .host.list()
    .find((tool) => tool.name === "confluence_download_attachment")!;
  assert.equal(
    JSON.stringify(entry),
    JSON.stringify({
      name: "confluence_download_attachment",
      description: CONFLUENCE_DOWNLOAD_DESCRIPTION,
      inputSchema: CONFLUENCE_DOWNLOAD_SCHEMA,
      effect: "read",
      actionKey: "confluence:read",
      file: {
        limitParam: "maxBytes",
        defaultBytes: CONFLUENCE_DOWNLOAD_DEFAULT_BYTES,
        maxBytes: CLIENT_CAP,
      },
    }),
  );
  assert.deepEqual(Object.keys(entry.file!), [
    "limitParam",
    "defaultBytes",
    "maxBytes",
  ]);
});

test("over the /mcp limit, by the metadata before any download or by the streamed bytes, the text names 11534336 and never the client cap", async () => {
  const cases = [
    {
      // The metadata says FILE + 1: refused before the download request.
      att: attachmentOf(
        "att301",
        "big.pdf",
        new Uint8Array(1),
        "application/pdf",
        FILE + 1,
      ),
      args: {},
      limit: FILE,
      downloads: 0,
    },
    {
      // The metadata understates it: the stream stops past the limit.
      att: attachmentOf(
        "att302",
        "big.pdf",
        new Uint8Array(FILE + 1),
        "application/pdf",
        5,
      ),
      args: {},
      limit: FILE,
      downloads: 1,
    },
    {
      att: attachmentOf(
        "att303",
        "big.pdf",
        new Uint8Array(101),
        "application/pdf",
        5,
      ),
      args: { maxBytes: 100 },
      limit: 100,
      downloads: 1,
    },
  ];
  for (const entry of cases) {
    const seen = stubConfluence(entry.att);
    const edge = await serveEdge();
    const answer = await post(
      edge.url,
      download({ attachmentId: entry.att.meta.id, ...entry.args }),
    );
    const text = DOWNLOAD_TEXT.tooLarge(entry.limit, FILE);
    assert.deepEqual(answer.json.result, failure(text));
    assert.match(text, /at most 11534336\b/);
    assert.ok(!answer.text.includes(String(CLIENT_CAP)));
    assert.equal(seen.filter(isDownload).length, entry.downloads);
  }
});

test("the limit's edges on /mcp: FILE − 1 and FILE arrive as blobs, FILE + 1 is refused", async () => {
  for (const [size, ok] of [
    [FILE - 1, true],
    [FILE, true],
    [FILE + 1, false],
  ] as const) {
    const bytes = new Uint8Array(size).map((_b, i) => i % 253);
    stubConfluence(attachmentOf("att401", "f.pdf", bytes, "application/pdf"));
    const edge = await serveEdge();
    const answer = await post(edge.url, download({ attachmentId: "att401" }));
    if (!ok) {
      assert.deepEqual(
        answer.json.result,
        failure(DOWNLOAD_TEXT.tooLarge(FILE, FILE)),
      );
      continue;
    }
    const part = answer.json.result!.content[1] as {
      resource: { blob: string };
    };
    const decoded = Buffer.from(part.resource.blob, "base64");
    assert.equal(decoded.length, size);
    assert.equal(sha256(decoded), sha256(bytes));
    assert.equal(
      (metaOf(answer).file as { deliveredAs: string }).deliveredAs,
      "resource",
    );
  }
}, 60_000);

test("images on /mcp: a FILE-byte PNG and a 12000-pixel PNG are blobs, a FILE + 1 PNG is refused (W5)", async () => {
  for (const [bytes, expected] of [
    [pngOf(64, 64, FILE), "resource"],
    [pngOf(12_000, 12_000, 4_000), "resource"],
    [pngOf(7_900, 7_900, 4_000), "image"],
    [pngOf(64, 64, FILE + 1), "refused"],
  ] as const) {
    stubConfluence(attachmentOf("att501", "p.png", bytes, "image/png"));
    const edge = await serveEdge();
    const answer = await post(edge.url, download({ attachmentId: "att501" }));
    if (expected === "refused") {
      assert.deepEqual(
        answer.json.result,
        failure(DOWNLOAD_TEXT.tooLarge(FILE, FILE)),
      );
      continue;
    }
    const file = metaOf(answer).file as { deliveredAs: string; size: number };
    assert.equal(file.deliveredAs, expected);
    assert.equal(file.size, bytes.byteLength);
    const part = answer.json.result!.content[1]!;
    if (expected === "image") {
      assert.equal(part.type, "image");
      assert.equal(part.mimeType, "image/png");
    } else {
      assert.equal(
        (part.resource as { mimeType: string }).mimeType,
        "application/octet-stream",
      );
    }
  }
}, 60_000);

test("an attachment typed __proto__ arrives as a blob with its bytes, not an internal error (F004)", async () => {
  const bytes = new Uint8Array(4_096).map((_b, i) => i % 251);
  stubConfluence({
    ...attachmentOf("att551", "odd.bin", bytes, "__proto__"),
    contentType: "__proto__",
  });
  const edge = await serveEdge();
  const answer = await post(edge.url, download({ attachmentId: "att551" }));
  assert.equal(answer.json.result!.isError, undefined);
  assert.deepEqual(answer.json.result!.content[1], {
    type: "resource",
    resource: {
      uri: "pandeck-gateway://confluence/attachment/att551",
      mimeType: "application/octet-stream",
      blob: Buffer.from(bytes).toString("base64"),
    },
  });
  const file = metaOf(answer).file as Record<string, unknown>;
  assert.deepEqual(file, {
    name: "odd.bin",
    mimeType: "__proto__",
    size: bytes.byteLength,
    sha256: sha256(bytes),
    deliveredAs: "resource",
  });
});

test("a sentinel in either download link never reaches the /mcp body or a log line (Z4)", async () => {
  const bytes = new TextEncoder().encode("hello");
  const link = `/download/attachments/123/${SENTINEL}.txt?version=3`;
  for (const meta of [{ downloadLink: link }, { _links: { download: link } }]) {
    const att = attachmentOf("att601", "n.txt", bytes, "text/plain");
    delete att.meta.downloadLink;
    Object.assign(att.meta, meta);
    const seen = stubConfluence(att);
    const edge = await serveEdge();
    const answer = await post(edge.url, download({ attachmentId: "att601" }));
    assert.ok(
      seen.some((url) => url.pathname.includes(SENTINEL)),
      "the link was used",
    );
    assert.equal(
      (metaOf(answer).file as { deliveredAs: string }).deliveredAs,
      "text",
    );
    assert.ok(!answer.text.includes(SENTINEL));
    assert.ok(!edge.lines.join("\n").includes(SENTINEL));
  }
});

test("a client download holding its output keeps the permit: /mcp answers FILE_BUSY with no vault read or fetch, then proceeds after the release", async () => {
  const fetch = vi.fn(oracleFetch());
  vi.stubGlobal("fetch", fetch);
  const edge = await serveEdge();
  const outputs: (() => void)[] = [];
  const held = await edge.host.callForClient(
    "confluence_download_attachment",
    { attachmentId: "att101" },
    {
      clientId: "client-2",
      credential: () => Promise.resolve({ ok: true, credential: CREDENTIAL }),
      onSettled: (fn) => outputs.push(fn),
    },
  );
  assert.ok(held.ok && held.file);
  const fetched = fetch.mock.calls.length;
  const busy = await post(edge.url, download({ attachmentId: "att101" }));
  assert.deepEqual(busy.json.result, failure(FILE_BUSY));
  assert.equal(edge.reads(), 0);
  assert.equal(fetch.mock.calls.length, fetched);
  for (const fn of outputs.splice(0)) fn();
  const after = await post(edge.url, download({ attachmentId: "att101" }));
  assert.equal(after.json.result!.isError, undefined);
  assert.equal(edge.reads(), 1);
});

test("an open client upload holds the same permit: /mcp answers FILE_BUSY with no vault read or Atlassian request, then proceeds after its release (v08 T4)", async () => {
  const fetch = vi.fn(oracleFetch());
  vi.stubGlobal("fetch", fetch);
  const edge = await serveEdge();
  const scope = edge.uploads.scope("user-1");
  const bytes = new TextEncoder().encode("upload");
  const opened = scope.open({
    streams: [
      {
        stagedAttachmentId: "s1",
        size: bytes.byteLength,
        sha256: sha256(bytes),
      },
    ],
    work: bytes.byteLength,
  });
  assert.ok(opened.ok);
  const busy = await post(edge.url, download({ attachmentId: "att101" }));
  assert.deepEqual(busy.json.result, failure(FILE_BUSY));
  assert.equal(edge.reads(), 0);
  assert.equal(fetch.mock.calls.length, 0);
  assert.deepEqual(scope.release(opened.uploadId), { ok: true });
  const after = await post(edge.url, download({ attachmentId: "att101" }));
  assert.equal(after.json.result!.isError, undefined);
  assert.equal(edge.reads(), 1);
  assert.ok(fetch.mock.calls.length > 0);
});

test("a /mcp upload answers MCP_UPLOAD_UNAVAILABLE with no vault read and no Atlassian request (AC9)", async () => {
  const fetch = vi.fn(() => Promise.reject(new Error("no request expected")));
  vi.stubGlobal("fetch", fetch);
  const edge = await serveEdge();
  const answer = await post(
    edge.url,
    download(
      {
        items: [
          { page: "123", body: "Added" },
          { operation: "uploadAttachment", page: "123", sourcePath: "/x.png" },
        ],
      },
      "confluence_mutate_page",
    ),
  );
  assert.deepEqual(answer.json.result, failure(MCP_UPLOAD_UNAVAILABLE));
  assert.equal(
    MCP_UPLOAD_UNAVAILABLE,
    "Uploading attachments isn't available on this connection yet; upload from a Pandeck session in client mode instead. Nothing was written to Confluence.",
  );
  assert.notEqual(MCP_UPLOAD_UNAVAILABLE, UPLOAD_UNAVAILABLE);
  assert.equal(edge.reads(), 0);
  assert.equal(fetch.mock.calls.length, 0);
});

const DENYLIST = [
  "hidden",
  "not shown",
  "not visible",
  "opaque",
  "won't see",
  "never enter your context",
  "never enters",
];

/** The texts in `texts` naming a denylisted phrase, case-insensitively. */
const denied = (texts: readonly string[]) =>
  texts.filter((text) =>
    DENYLIST.some((phrase) => text.toLowerCase().includes(phrase)),
  );

test("the download's /mcp texts, P7b's fixed file texts and its upload sentence never say the bytes are hidden from the model", async () => {
  const { url } = await serveEdge();
  const tools = (await post(url, listing)).json.result!.tools!;
  const entry = tools.find(
    (tool) => tool.name === "confluence_download_attachment",
  )!;
  // Only the sentence P7b rewrites in confluence_mutate_page (v07 R5).
  const upload = tools
    .find((tool) => tool.name === "confluence_mutate_page")!
    .description.split(/(?<=\.) /)
    .filter((sentence) => sentence.includes("uploadAttachment"));
  assert.equal(upload.length, 1);
  const texts = [
    entry.description,
    ...Object.values(entry.inputSchema.properties).map(
      (property) => property.description ?? "",
    ),
    DOWNLOAD_TEXT.tooLarge(FILE, FILE),
    FILE_BUSY,
    ...upload,
    MCP_UPLOAD_UNAVAILABLE,
  ];
  assert.deepEqual(denied(texts), []);
  // The control: the check sees a denylisted phrase in any case.
  assert.deepEqual(denied(["An OPAQUE file."]), ["An OPAQUE file."]);
  assert.deepEqual(denied([CONFLUENCE_DOWNLOAD_DESCRIPTION]), [
    CONFLUENCE_DOWNLOAD_DESCRIPTION,
  ]);
});
