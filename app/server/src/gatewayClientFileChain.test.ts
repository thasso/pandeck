/**
 * Client mode's file tool end to end (Task-1441 P7a, G5/H3/H4): Pandeck's
 * `confluence_download_attachment` through the link, an enrolled relay, the
 * edge's client listener and its real tool host, with only `fetch` and the
 * Atlassian check faked. The result matches the local tool's frozen oracle
 * byte for byte; each edge text reaches the agent as the edge words it; each
 * refusal stages nothing. The test-only `fixture_file_read` verifies the
 * contract on a tool that is not Confluence (H3 c1-c4). Every value is fake.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import type { EdgeTools } from "./gateway/edgeTools.ts";
import type { RemoteFileAnswer } from "./remoteTools.ts";

const home = mkdtempSync(join(tmpdir(), "gateway-file-chain-home-"));
process.env.HOME = home;

const { startGatewayClientLink } = await import("./gatewayClientLink.ts");
const { startGateway } = await import("./gateway/gateway.ts");
const { enrollRelay, startRelay } = await import("./relay/relay.ts");
const { DATA_DIR } = await import("./config.ts");
const remoteTools = await import("./remoteTools.ts");
const { updateConfluenceSettings } = await import("./confluenceSettings.ts");
const { createEdgeTools } = await import("./gatewayTools/index.ts");
const { createToolHost, FILE_BUSY } = await import("./gatewayTools/host.ts");
const { DOWNLOAD_TEXT, confluenceDownloadAttachment } =
  await import("./gatewayTools/confluenceDownload.ts");
const { fixtureFileText, fixtureFileTool, fixtureBytes } =
  await import("./gatewayTools/fileFixtureTool.ts");
const { encodeAtlassianCredential } =
  await import("./gatewayTools/atlassian.ts");
const { remoteToolsFor } = await import("./tools/gateway/remoteToolGroup.ts");
const { FILE_ADAPTERS, settleFileAnswer } =
  await import("./tools/gateway/remoteFiles.ts");
const { CONFLUENCE_DOWNLOAD_URL_MAX_CHARS } =
  await import("./confluenceDownload.ts");
const { DISABLED, FILE_BUSY_HERE, UNEXPECTED_FILE_ANSWER } =
  await import("./tools/gateway/remoteReadRules.ts");
const { listSessionAttachments, readSessionAttachmentBytes } =
  await import("./sessionAttachments.ts");
const { DOWNLOAD_ORACLE, ORACLE_SITE, oracleFetch, oracleText } =
  await import("./test/confluenceDownloadOracle.ts");

const MiB = 1024 * 1024;
const CREDENTIAL = { site: ORACLE_SITE, email: "a@x.test", token: "fake-p7a" };

const open: { close(): unknown }[] = [];
const fixture = fixtureFileTool();
const edgeLines: string[] = [];
const linkLines: string[] = [];
let host!: ReturnType<typeof createToolHost>;

/**
 * F002: a ~300-character CJK file name, percent-encoded in its download
 * link as Confluence's `downloadLink` carries it (well over the old 2,048),
 * and a link that makes `downloadUrl` one character over the bound.
 */
const CJK_TITLE = `${"設計資料".repeat(75)}.pdf`;
const CJK_LINK = `/download/attachments/123/${encodeURIComponent(CJK_TITLE)}?version=1&api=v2`;
const SITE_WIKI = `https://${ORACLE_SITE}/wiki`;
const LONG_LINK_HEAD =
  "/download/attachments/123/long.bin?version=1&api=v2&pad=";
const LONG_LINK = `${LONG_LINK_HEAD}${"a".repeat(
  CONFLUENCE_DOWNLOAD_URL_MAX_CHARS +
    1 -
    SITE_WIKI.length -
    LONG_LINK_HEAD.length,
)}`;
let longServed = 0;

/** Held downloads, by attachment id; released by the test. */
const held = new Map<string, () => void>();

/** `fetch` for the oracle, plus attachments that refuse or wait. */
function chainFetch(): (
  input: URL | string,
  init?: RequestInit,
) => Promise<Response> {
  const oracle = oracleFetch();
  const meta = (id: string, extra: Record<string, unknown> = {}) =>
    Response.json({
      id,
      title: "held.bin",
      pageId: "123",
      fileSize: 4,
      version: { number: 1 },
      downloadLink: `/download/attachments/123/${id}.bin?version=1&api=v2`,
      ...extra,
    });
  return async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/ex\/confluence\/[^/]+/, "");
    const id = /\/attachments\/(att9\d+)$/.exec(path)?.[1];
    if (id === "att900404") return Response.json({}, { status: 404 });
    if (id === "att900401") return Response.json({}, { status: 401 });
    if (id === "att900500") return Response.json({}, { status: 500 });
    if (id === "att900001") return meta(id, { downloadLink: undefined });
    if (id === "att900002") return meta(id, { fileSize: 101 * MiB });
    if (id === "att900300")
      return meta(id, {
        title: CJK_TITLE,
        mediaType: "application/pdf",
        fileSize: 7,
        downloadLink: CJK_LINK,
      });
    if (id === "att900301")
      return meta(id, { title: "long.bin", downloadLink: LONG_LINK });
    if (id) return meta(id);
    if (path === "/wiki/api/v2/pages/777/attachments")
      return Response.json({ results: [] });
    if (path.endsWith(CJK_LINK.split("?")[0]!))
      return new Response(new TextEncoder().encode("cjk-pdf"));
    if (path.endsWith("/download/attachments/123/long.bin")) {
      longServed += 1;
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }
    const waiting = /\/download\/attachments\/123\/(att9\d+)\.bin$/.exec(path);
    if (waiting) {
      await new Promise<void>((resolve, reject) => {
        held.set(waiting[1]!, resolve);
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason as Error),
        );
      });
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }
    return oracle(input, init);
  };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(chainFetch()));
  const real = createEdgeTools({ log: () => {} });
  host = createToolHost([confluenceDownloadAttachment, fixture], {
    log: (line) => edgeLines.push(line),
  });
  const tools: EdgeTools = {
    ...real,
    host,
    integrations: {
      ...real.integrations,
      atlassian: {
        ...real.integrations.atlassian,
        check: () => Promise.resolve({ ok: true }),
      },
    },
  };
  mkdirSync(DATA_DIR, { recursive: true });
  const gateway = await startGateway({
    stateDir: mkdtempSync(join(DATA_DIR, "edge-")),
    log: (line) => edgeLines.push(line),
    clients: {},
    tools,
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("thasso");
  const relayDir = mkdtempSync(join(tmpdir(), "relay-"));
  open.push({
    close: () => rmSync(relayDir, { recursive: true, force: true }),
  });
  await enrollRelay({
    stateDir: relayDir,
    host: "127.0.0.1",
    enrollPort: gateway.clients!.enrollPort,
    caPem: gateway.clients!.caPem,
    code: gateway.clients!.registry.createCode("thasso", "devbox"),
  });
  const relay = await startRelay({
    stateDir: relayDir,
    port: 0,
    socketPath: join(relayDir, "relay.sock"),
    log: () => {},
  });
  open.push(relay);
  await gateway.clients!.userOperations.setAtlassian("thasso", CREDENTIAL);
  const link = startGatewayClientLink({
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: (line) => linkLines.push(line),
  });
  open.push(link);
  assert.equal(await link.ready, true);
  updateConfluenceSettings({ enabled: true });
});

afterEach(() => {
  updateConfluenceSettings({ enabled: true });
});

afterAll(async () => {
  updateConfluenceSettings({ enabled: false });
  while (open.length) await open.pop()!.close();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

let sessions = 0;
const newSession = () => `p7a-chain-${sessions++}`;

function downloadTool() {
  const tool = remoteToolsFor("confluence").find(
    (t) => t.name === "confluence_download_attachment",
  );
  assert.ok(tool);
  return tool;
}

const run = (
  args: Record<string, unknown>,
  sessionId: string,
  signal?: AbortSignal,
) =>
  downloadTool().execute(args, {
    session: { sessionId },
    toolCallId: "call-1",
    ...(signal ? { signal } : {}),
  } as never);

const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content[0]?.text ?? "";

test("client mode lists the download as the local tool, its sideEffects from the catalog's entry", async () => {
  const { confluenceDownloadAttachmentTool } =
    await import("./tools/confluence/confluenceTools.ts");
  const tool = downloadTool();
  assert.equal(tool.label, confluenceDownloadAttachmentTool.label);
  assert.equal(tool.description, confluenceDownloadAttachmentTool.description);
  assert.equal(tool.parameters, confluenceDownloadAttachmentTool.parameters);
  assert.equal(tool.searchHint, confluenceDownloadAttachmentTool.searchHint);
  assert.equal(
    (tool as { classifiedByCatalog?: true }).classifiedByCatalog,
    true,
  );
  assert.ok(!("sideEffects" in tool));
});

for (const entry of DOWNLOAD_ORACLE)
  test(`client mode answers the local oracle byte for byte: ${entry.name}`, async () => {
    const sessionId = newSession();
    const result = await run(entry.args, sessionId);
    const staged = listSessionAttachments(sessionId);
    assert.equal(staged.length, 1);
    assert.equal(oracleText(textOf(result), staged[0]!), entry.expected);
    const read = readSessionAttachmentBytes(sessionId, staged[0]!.id);
    assert.equal(read?.bytes.toString("utf8"), entry.content);
  });

test("a ~300-character CJK file name, percent-encoded in its downloadUrl past the old 2,048, round-trips and stages (F002)", async () => {
  const sessionId = newSession();
  const result = await run({ attachmentId: "att900300" }, sessionId);
  const answer = JSON.parse(textOf(result)) as {
    attachment: { title: string; downloadUrl: string };
    sessionAttachment: { id: string; name: string; size: number };
  };
  assert.equal(answer.attachment.title, CJK_TITLE);
  assert.equal(answer.attachment.downloadUrl, `${SITE_WIKI}${CJK_LINK}`);
  assert.ok(answer.attachment.downloadUrl.length > 2048);
  assert.ok(
    answer.attachment.downloadUrl.length <= CONFLUENCE_DOWNLOAD_URL_MAX_CHARS,
  );
  const staged = listSessionAttachments(sessionId);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]!.name, CJK_TITLE);
  assert.equal(answer.sessionAttachment.id, staged[0]!.id);
  const read = readSessionAttachmentBytes(sessionId, staged[0]!.id);
  assert.equal(read?.bytes.toString("utf8"), "cjk-pdf");
});

test("a downloadUrl one character over the bound is refused as today: the unexpected-file text, nothing staged (F002)", async () => {
  assert.equal(CONFLUENCE_DOWNLOAD_URL_MAX_CHARS, 16_384);
  assert.equal(
    `${SITE_WIKI}${LONG_LINK}`.length,
    CONFLUENCE_DOWNLOAD_URL_MAX_CHARS + 1,
  );
  const sessionId = newSession();
  const before = longServed;
  await assert.rejects(run({ attachmentId: "att900301" }, sessionId), {
    message: UNEXPECTED_FILE_ANSWER,
  });
  assert.deepEqual(listSessionAttachments(sessionId), []);
  // The edge does not bound the link: the file was fetched and sent, then
  // refused here.
  assert.equal(longServed, before + 1);
});

test("each edge text reaches the agent as the edge words it, and nothing is staged", async () => {
  const rejected =
    "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.";
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ attachmentId: "att900404" }, DOWNLOAD_TEXT.notFound],
    [{ attachmentId: "att900401" }, rejected],
    [{ attachmentId: "att900500" }, DOWNLOAD_TEXT.downloadFailed],
    [{ attachmentId: "att900001" }, DOWNLOAD_TEXT.noDownloadLink],
    [
      { attachmentId: "att900002", maxBytes: 100 * MiB },
      DOWNLOAD_TEXT.tooLarge(100 * MiB),
    ],
    // The default limit when maxBytes is absent, and a fraction truncated.
    [{ attachmentId: "att900002" }, DOWNLOAD_TEXT.tooLarge(50 * MiB)],
    [
      { attachmentId: "att900002", maxBytes: 4096.9 },
      DOWNLOAD_TEXT.tooLarge(4096),
    ],
    [{ page: "777", fileName: "none.txt" }, DOWNLOAD_TEXT.notOnPage],
    [{}, DOWNLOAD_TEXT.inputMissing],
    [{ attachmentId: "not an id" }, DOWNLOAD_TEXT.invalidAttachmentId],
  ];
  for (const [args, text] of cases) {
    const sessionId = newSession();
    await assert.rejects(run(args, sessionId), { message: text }, text);
    assert.deepEqual(listSessionAttachments(sessionId), [], text);
  }
});

test("the edge's busy text while another client holds its file permit; the local busy text while this server's own call is unretired", async () => {
  // Another caller takes the edge's one permit.
  let settle!: () => void;
  const other = host.callForClient(
    "fixture_file_read",
    { id: "hold" },
    {
      clientId: "client-other",
      credential: () =>
        Promise.resolve({
          ok: true as const,
          credential: encodeAtlassianCredential(CREDENTIAL),
        }),
      onSettled: (fn) => {
        settle = fn;
      },
    },
  );
  await vi.waitFor(() => assert.equal(fixture.started, 1));
  const sessionId = newSession();
  await assert.rejects(run({ attachmentId: "att101" }, sessionId), {
    message: FILE_BUSY,
  });
  assert.deepEqual(listSessionAttachments(sessionId), []);
  fixture.release();
  await other;
  settle();

  // This server's own: a download still running here.
  const first = newSession();
  const running = run({ attachmentId: "att900777" }, first);
  await vi.waitFor(() => assert.ok(held.has("att900777")));
  await assert.rejects(run({ attachmentId: "att101" }, newSession()), {
    message: FILE_BUSY_HERE,
  });
  held.get("att900777")!();
  const done = await running;
  assert.equal(JSON.parse(textOf(done)).sessionAttachment.size, 4);
  assert.equal(listSessionAttachments(first).length, 1);
});

test("the gate is checked again on the answer: Confluence turned off meanwhile stages nothing", async () => {
  const sessionId = newSession();
  const running = run({ attachmentId: "att900778" }, sessionId);
  await vi.waitFor(() => assert.ok(held.has("att900778")));
  updateConfluenceSettings({ enabled: false });
  held.get("att900778")!();
  await assert.rejects(running, { message: DISABLED.confluence });
  assert.deepEqual(listSessionAttachments(sessionId), []);
});

test("a cancelled download stages nothing, and the next one runs once the edge has answered", async () => {
  const sessionId = newSession();
  const caller = new AbortController();
  const running = run({ attachmentId: "att900779" }, sessionId, caller.signal);
  await vi.waitFor(() => assert.ok(held.has("att900779")));
  caller.abort();
  await assert.rejects(running, { message: "The call was cancelled." });
  assert.deepEqual(listSessionAttachments(sessionId), []);
  const next = newSession();
  await vi.waitFor(async () => {
    await run({ attachmentId: "att101" }, next);
  });
  assert.equal(listSessionAttachments(next).length, 1);
});

test("no log line on either side names a file, an id, a site or the credential", () => {
  const secrets = [
    CREDENTIAL.token,
    CREDENTIAL.email,
    ORACLE_SITE,
    "notes.txt",
    "diagram.png",
    "att101",
    "att900",
  ];
  for (const line of [...edgeLines, ...linkLines])
    for (const secret of secrets) assert.ok(!line.includes(secret), line);
});

// --- H3 c1-c4: the contract on a tool that is not Confluence ----------------

/** The fixture's adapter, as a future Slack file read's would be. */
const fixtureAdapter = {
  source: "slack" as const,
  validateFileText(text: string) {
    const value = JSON.parse(text) as Record<string, unknown>;
    return value.status === "downloaded" ? value : undefined;
  },
  buildFileResult(
    fields: Record<string, unknown>,
    staged: { id: string; name: string; mimeType: string; size: number },
  ) {
    return {
      ...fields,
      attachment: {
        id: staged.id,
        name: staged.name,
        mimeType: staged.mimeType,
        size: staged.size,
      },
    };
  },
  validatePlainText(text: string) {
    const value = JSON.parse(text) as Record<string, unknown>;
    return value.status === "inline" ||
      value.status === "download_limit_reached"
      ? value
      : undefined;
  },
};

/** The fixture's E as Pandeck computes it: its own limit argument. */
const fixtureE = (args: Record<string, unknown>) =>
  typeof args.maxDownloadBytes === "number"
    ? Math.min(20 * MiB, Math.max(1, Math.trunc(args.maxDownloadBytes)))
    : 10 * MiB;

async function fixtureCall(
  args: Record<string, unknown>,
  sessionId: string,
  adapter: Parameters<typeof settleFileAnswer>[1] = fixtureAdapter as never,
  maxBytes = fixtureE(args),
) {
  const port = remoteTools.remoteToolPort()!;
  return port.callFile(
    "fixture_file_read",
    args,
    new AbortController().signal,
    { maxBytes },
    (answer: RemoteFileAnswer) =>
      settleFileAnswer("fixture_file_read", adapter, answer, sessionId),
  );
}

test("c1: a binary file round-trips through host, listener, link and decoder, and its adapter stages it once", async () => {
  const sessionId = newSession();
  const result = await fixtureCall({ id: "bin", size: 1234 }, sessionId);
  const staged = listSessionAttachments(sessionId);
  assert.equal(staged.length, 1);
  const read = readSessionAttachmentBytes(sessionId, staged[0]!.id);
  assert.ok(read?.bytes.equals(Buffer.from(fixtureBytes(1234))));
  assert.deepEqual(JSON.parse(textOf(result)), {
    ...fixtureFileText(1234),
    attachment: {
      id: staged[0]!.id,
      name: "fixture.bin",
      mimeType: "application/octet-stream",
      size: 1234,
    },
  });
});

test("c2: inline content and download_limit_reached arrive as plain answers, nothing staged", async () => {
  for (const id of ["inline", "limit"]) {
    const sessionId = newSession();
    const result = await fixtureCall({ id }, sessionId);
    assert.equal(
      JSON.parse(textOf(result)).status,
      id === "inline" ? "inline" : "download_limit_reached",
    );
    assert.deepEqual(listSessionAttachments(sessionId), []);
  }
});

test("c3: the fixture's own limit argument drives E on both sides; maxBytes does not; over this side's E is refused with a valid digest", async () => {
  const over = newSession();
  await assert.rejects(
    fixtureCall(
      { id: "bin", size: 8, maxDownloadBytes: 4, maxBytes: 100 },
      over,
    ),
    {
      message:
        "The file is larger than the 4-byte limit; nothing was saved. Raise maxDownloadBytes (at most 20971520) to fetch it.",
    },
  );
  const within = newSession();
  await fixtureCall(
    { id: "bin", size: 8, maxDownloadBytes: 8, maxBytes: 1 },
    within,
  );
  assert.equal(listSessionAttachments(within).length, 1);
  const smaller = newSession();
  await assert.rejects(
    fixtureCall(
      { id: "bin", size: 8, maxDownloadBytes: 8 },
      smaller,
      fixtureAdapter as never,
      7,
    ),
    (err: unknown) =>
      err instanceof remoteTools.RemoteToolRefusal &&
      err.code === "unexpected_file",
  );
  assert.deepEqual(listSessionAttachments(smaller), []);
});

test("c4: the Confluence adapter refuses the fixture's file and a plain success, staging nothing", async () => {
  const confluence = FILE_ADAPTERS.confluence_download_attachment.adapter;
  for (const args of [{ id: "bin", size: 5 }, { id: "inline" }]) {
    const sessionId = newSession();
    await assert.rejects(fixtureCall(args, sessionId, confluence as never), {
      message: UNEXPECTED_FILE_ANSWER,
    });
    assert.deepEqual(listSessionAttachments(sessionId), []);
  }
});
