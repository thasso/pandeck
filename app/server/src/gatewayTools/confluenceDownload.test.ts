/**
 * The edge's `confluence_download_attachment` (Task-1441 P7a, G3) through
 * the real host's file path, with only `fetch` stubbed: the local tool's
 * schema and description, the oracle's result fields with the file beside
 * them, and every failure branch as its fixed text. A marker in each body,
 * id, name and URL Confluence or the caller sends never reaches an answer or
 * a log line. Input refusals send nothing and read no credential. Every
 * value is fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import {
  DOWNLOAD_ORACLE,
  ORACLE_SITE,
  oracleFetch,
} from "../test/confluenceDownloadOracle.ts";
import { FAKE_ACCESS, FAKE_CLOUD_ID } from "../test/atlassianFake.ts";
import {
  CONFLUENCE_ATTACHMENT_MAX_BYTES,
  CONFLUENCE_DOWNLOAD_DESCRIPTION,
  CONFLUENCE_DOWNLOAD_SCHEMA,
} from "../confluenceDownload.ts";
import { encodeAtlassianCredential } from "./atlassian.ts";
import {
  DOWNLOAD_TEXT,
  FILE_DEADLINE_MS,
  confluenceDownloadAttachment,
} from "./confluenceDownload.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { EDGE_TOOLS } from "./tools.ts";

const MARK = "MARKER-7f3a";
const FAKE = { site: ORACLE_SITE, email: "a@x.test", token: "fake-1" };
const BASIC_REJECTED =
  "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.";
const OAUTH_REJECTED =
  "Atlassian rejected the credential; sign in with Atlassian again on the gateway's page.";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A caller with the output seam, settled at once; counts credential reads. */
function caller(
  options: { signal?: AbortSignal; oauth?: boolean } = {},
): ToolCaller & { reads: number } {
  const credential = options.oauth
    ? JSON.stringify({
        kind: "atlassian-oauth",
        site: FAKE.site,
        cloudId: FAKE_CLOUD_ID,
        accessToken: FAKE_ACCESS,
        expiresAt: Date.now() + 60_000,
      })
    : encodeAtlassianCredential(FAKE);
  const result = {
    clientId: "client-1",
    reads: 0,
    credential: () => {
      result.reads += 1;
      return Promise.resolve({ ok: true as const, credential });
    },
    onSettled: (fn: () => void) => queueMicrotask(fn),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  return result;
}

function edge(tool = confluenceDownloadAttachment) {
  const lines: string[] = [];
  const host = createToolHost([tool], { log: (line) => lines.push(line) });
  return { host, lines };
}

/** `fetch` stubbed by `answer`, else the oracle; records each URL. */
function stubFetch(
  answer?: (
    url: URL,
    signal?: AbortSignal,
  ) => Response | Promise<Response> | undefined,
): URL[] {
  const seen: URL[] = [];
  const fallback = oracleFetch();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(url);
      return (
        (await answer?.(url, init?.signal ?? undefined)) ??
        fallback(input, init)
      );
    }),
  );
  return seen;
}

const isMetadata = (url: URL) => url.pathname.includes("/wiki/api/v2/");
const isDownload = (url: URL) => url.pathname.includes("/wiki/download/");

test("the edge tool has the local tool's schema and description, a 150 s deadline and the file limits", async () => {
  const { confluenceDownloadAttachmentTool } =
    await import("../tools/confluence/confluenceTools.ts");
  assert.equal(
    confluenceDownloadAttachment.inputSchema,
    CONFLUENCE_DOWNLOAD_SCHEMA,
  );
  assert.deepEqual(
    confluenceDownloadAttachmentTool.parameters,
    confluenceDownloadAttachment.inputSchema,
  );
  assert.equal(
    confluenceDownloadAttachmentTool.description,
    confluenceDownloadAttachment.description,
  );
  assert.equal(
    confluenceDownloadAttachment.description,
    CONFLUENCE_DOWNLOAD_DESCRIPTION,
  );
  assert.equal(confluenceDownloadAttachment.deadlineMs, FILE_DEADLINE_MS);
  assert.equal(FILE_DEADLINE_MS, 150_000);
  assert.equal(confluenceDownloadAttachment.effect, "read");
  assert.equal(confluenceDownloadAttachment.actionKey, "confluence:read");
  const { limitParam, defaultBytes, maxBytes, mcp } =
    confluenceDownloadAttachment.file!;
  assert.deepEqual(
    { limitParam, defaultBytes, maxBytes },
    {
      limitParam: "maxBytes",
      defaultBytes: 50 * 1024 * 1024,
      maxBytes: 100 * 1024 * 1024,
    },
  );
  // Its `/mcp` form (Task-1441 P7b), pinned in `mcpFiles.test.ts`.
  assert.ok(mcp);
  const listed = createToolHost(EDGE_TOOLS, { log: () => {} })
    .list()
    .find((tool) => tool.name === "confluence_download_attachment");
  assert.ok(listed?.file);
});

for (const entry of DOWNLOAD_ORACLE)
  test(`the edge answers the oracle's fields and the file: ${entry.name}`, async () => {
    stubFetch();
    const { host } = edge();
    const answer = await host.callForClient(
      "confluence_download_attachment",
      entry.args,
      caller(),
    );
    assert.ok(answer.ok && answer.file, JSON.stringify(answer));
    const { sessionAttachment: _staged, ...fields } = JSON.parse(
      entry.expected,
    ) as Record<string, unknown>;
    assert.equal(answer.text, JSON.stringify(fields));
    const bytes = new TextEncoder().encode(entry.content);
    assert.equal(answer.file.name, entry.attachment.title);
    assert.equal(
      answer.file.mimeType,
      entry.attachment.mediaType ?? entry.contentType ?? "",
    );
    assert.equal(answer.file.size, bytes.byteLength);
    assert.equal(
      answer.file.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(answer.file.bytes, bytes);
  });

test("the OAuth path downloads through the API gateway prefix", async () => {
  const seen = stubFetch();
  const { host } = edge();
  const answer = await host.callForClient(
    "confluence_download_attachment",
    { attachmentId: "att101" },
    caller({ oauth: true }),
  );
  assert.ok(answer.ok && answer.file?.size === 5);
  assert.ok(
    seen.every((url) =>
      url.pathname.startsWith(`/ex/confluence/${FAKE_CLOUD_ID}/`),
    ),
  );
});

const marked = (status: number) =>
  new Response(`${MARK} body https://${MARK}.invalid/x`, { status });

/** One branch: the call's args, the fetch answer, the expected text. */
interface Branch {
  name: string;
  args?: Record<string, unknown>;
  answer?: (url: URL) => Response | Promise<Response> | undefined;
  oauth?: boolean;
  expected: string;
}

const BRANCHES: Branch[] = [
  ...([401, 403] as const).flatMap((status) => [
    {
      name: `metadata ${status}`,
      answer: (url: URL) => (isMetadata(url) ? marked(status) : undefined),
      expected: BASIC_REJECTED,
    },
    {
      name: `metadata ${status} (OAuth)`,
      oauth: true,
      answer: (url: URL) => (isMetadata(url) ? marked(status) : undefined),
      expected: OAUTH_REJECTED,
    },
    {
      name: `download ${status}`,
      answer: (url: URL) => (isDownload(url) ? marked(status) : undefined),
      expected: BASIC_REJECTED,
    },
  ]),
  {
    name: "metadata 404",
    answer: (url) => (isMetadata(url) ? marked(404) : undefined),
    expected: DOWNLOAD_TEXT.notFound,
  },
  {
    name: "metadata 500",
    answer: (url) => (isMetadata(url) ? marked(500) : undefined),
    expected: DOWNLOAD_TEXT.downloadFailed,
  },
  {
    name: "metadata 400",
    answer: (url) => (isMetadata(url) ? marked(400) : undefined),
    expected: DOWNLOAD_TEXT.downloadFailed,
  },
  {
    name: "metadata unparsable",
    answer: (url) =>
      isMetadata(url) ? new Response(`{${MARK}`, { status: 200 }) : undefined,
    expected: DOWNLOAD_TEXT.downloadFailed,
  },
  {
    name: "download 404",
    answer: (url) => (isDownload(url) ? marked(404) : undefined),
    expected: DOWNLOAD_TEXT.notFound,
  },
  {
    name: "download 500",
    answer: (url) => (isDownload(url) ? marked(500) : undefined),
    expected: DOWNLOAD_TEXT.downloadFailed,
  },
  {
    name: "a network failure",
    answer: (url) =>
      isDownload(url)
        ? Promise.reject(new TypeError(`fetch failed ${MARK}`))
        : undefined,
    expected: DOWNLOAD_TEXT.downloadFailed,
  },
  {
    name: "no attachment by that name on the page",
    args: { page: "123", fileName: `${MARK}.txt` },
    answer: (url) =>
      isMetadata(url) ? Response.json({ results: [] }) : undefined,
    expected: DOWNLOAD_TEXT.notOnPage,
  },
  {
    name: "no download link",
    answer: (url) =>
      isMetadata(url)
        ? Response.json({ id: "att101", title: `${MARK}.txt`, fileSize: 5 })
        : undefined,
    expected: DOWNLOAD_TEXT.noDownloadLink,
  },
  {
    name: "the metadata's size over E",
    args: { attachmentId: "att101", maxBytes: 4 },
    answer: (url) =>
      isMetadata(url)
        ? Response.json({
            id: "att101",
            title: `${MARK}.txt`,
            fileSize: 5,
            downloadLink: `/download/attachments/123/${MARK}.txt`,
          })
        : undefined,
    expected: DOWNLOAD_TEXT.tooLarge(4, CONFLUENCE_ATTACHMENT_MAX_BYTES),
  },
  {
    name: "the declared size over E",
    args: { attachmentId: "att101", maxBytes: 4 },
    answer: (url) =>
      isMetadata(url)
        ? Response.json({
            id: "att101",
            title: `${MARK}.txt`,
            downloadLink: `/download/attachments/123/${MARK}.txt`,
          })
        : isDownload(url)
          ? new Response("hello", { headers: { "content-length": "5" } })
          : undefined,
    expected: DOWNLOAD_TEXT.tooLarge(4, CONFLUENCE_ATTACHMENT_MAX_BYTES),
  },
  {
    name: "the streamed size over E",
    args: { attachmentId: "att101", maxBytes: 4 },
    answer: (url) =>
      isMetadata(url)
        ? Response.json({
            id: "att101",
            title: `${MARK}.txt`,
            downloadLink: `/download/attachments/123/${MARK}.txt`,
          })
        : isDownload(url)
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(`${MARK}!`));
                  controller.close();
                },
              }),
            )
          : undefined,
    expected: DOWNLOAD_TEXT.tooLarge(4, CONFLUENCE_ATTACHMENT_MAX_BYTES),
  },
];

for (const branch of BRANCHES)
  test(`a failure answers its fixed text, no marker in it or the log: ${branch.name}`, async () => {
    stubFetch(branch.answer);
    const { host, lines } = edge();
    const answer = await host.callForClient(
      "confluence_download_attachment",
      branch.args ?? { attachmentId: "att101" },
      caller(branch.oauth ? { oauth: true } : {}),
    );
    assert.deepEqual(answer, {
      ok: false,
      code: "tool_error",
      message: branch.expected,
    });
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.doesNotMatch(line, new RegExp(MARK));
      assert.doesNotMatch(line, /att101|example\.atlassian|https?:/);
    }
  });

for (const [name, args, expected] of [
  ["nothing given", {}, DOWNLOAD_TEXT.inputMissing],
  [
    "a blank attachment id and no file name",
    { attachmentId: "  " },
    DOWNLOAD_TEXT.inputMissing,
  ],
  [
    "a file name and no page",
    { fileName: "a.txt" },
    "A Confluence page id or URL is required.",
  ],
  [
    "an unreadable page",
    { page: `https://${MARK}.invalid/x`, fileName: "a.txt" },
    "Could not read a page id; pass the numeric page id or a Confluence page URL.",
  ],
  [
    "a bad attachment id",
    { attachmentId: MARK },
    DOWNLOAD_TEXT.invalidAttachmentId,
  ],
] as const)
  test(`an input refusal sends nothing and reads no credential: ${name}`, async () => {
    const seen = stubFetch();
    const { host, lines } = edge();
    const who = caller();
    const answer = await host.callForClient(
      "confluence_download_attachment",
      args,
      who,
    );
    assert.deepEqual(answer, {
      ok: false,
      code: "tool_error",
      message: expected,
    });
    assert.equal(seen.length, 0);
    assert.equal(who.reads, 0);
    assert.ok(lines.every((line) => !line.includes(MARK)));
  });

test("the attachment id wins over page and file name, as locally", async () => {
  const seen = stubFetch();
  const { host } = edge();
  const answer = await host.callForClient(
    "confluence_download_attachment",
    { attachmentId: "101", page: "nope", fileName: "x" },
    caller(),
  );
  assert.ok(answer.ok);
  assert.equal(
    seen[0]?.pathname.endsWith("/wiki/api/v2/attachments/att101"),
    true,
  );
});

/**
 * A download that sends a byte, then waits; its body errors when the
 * request's signal aborts, as `fetch`'s does. `ended` resolves then.
 */
function hangingDownload(): { started: Promise<void>; ended: Promise<void> } {
  let start = (): void => {};
  let end = (): void => {};
  const started = new Promise<void>((resolve) => (start = resolve));
  const ended = new Promise<void>((resolve) => (end = resolve));
  stubFetch((url, signal) => {
    if (!isDownload(url)) return undefined;
    start();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          signal?.addEventListener("abort", () => {
            controller.error(signal.reason);
            end();
          });
        },
      }),
    );
  });
  return { started, ended };
}

test("a cancel mid-download answers cancelled and reaches the request", async () => {
  const { started, ended } = hangingDownload();
  const { host } = edge();
  const controller = new AbortController();
  const pending = host.callForClient(
    "confluence_download_attachment",
    { attachmentId: "att101" },
    caller({ signal: controller.signal }),
  );
  await started;
  controller.abort();
  assert.deepEqual(await pending, {
    ok: false,
    code: "cancelled",
    message: "The call was cancelled.",
  });
  await ended;
});

test("the deadline mid-download answers timeout and reaches the request", async () => {
  const { started, ended } = hangingDownload();
  const { host } = edge({ ...confluenceDownloadAttachment, deadlineMs: 50 });
  const pending = host.callForClient(
    "confluence_download_attachment",
    { attachmentId: "att101" },
    caller(),
  );
  await started;
  assert.deepEqual(await pending, {
    ok: false,
    code: "timeout",
    message: "The tool timed out.",
  });
  await ended;
});
