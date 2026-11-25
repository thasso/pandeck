/**
 * Client-mode Confluence uploads end to end (Task-1441 P8a, AC10, v05 W2,
 * v06 X3/X4, v03 K3): Pandeck's remote `confluence_mutate_page` and the
 * approval runner, through the link, an enrolled relay, the edge's client
 * listener, its upload store and the real shared apply, with only `fetch` (a
 * fake Confluence that parses the multipart body) and the Atlassian check
 * faked. A proxy between the link and the relay can drop the connection.
 * Every value is fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalCard,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import type { EdgeTools } from "./gateway/edgeTools.ts";

const home = mkdtempSync(join(tmpdir(), "gateway-upload-chain-home-"));
process.env.HOME = home;

const { startGatewayClientLink } = await import("./gatewayClientLink.ts");
const { startGateway } = await import("./gateway/gateway.ts");
const { enrollRelay, startRelay } = await import("./relay/relay.ts");
const { DATA_DIR } = await import("./config.ts");
const remoteTools = await import("./remoteTools.ts");
const { updateConfluenceSettings } = await import("./confluenceSettings.ts");
const { createEdgeTools } = await import("./gatewayTools/index.ts");
const { createFileBudget, createToolHost } =
  await import("./gatewayTools/host.ts");
const { edgeTools } = await import("./gatewayTools/tools.ts");
const { confluenceDeleteSwitchFor } =
  await import("./gatewayTools/confluenceMutatePage.ts");
const { createUploadStore, UPLOAD_BUSY } =
  await import("./gatewayTools/uploads.ts");
const { BODY_NOT_COMPLETED } = await import("./confluenceAttachmentChange.ts");
const { remoteToolsFor } = await import("./tools/gateway/remoteToolGroup.ts");
const { UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN } =
  await import("./tools/gateway/remoteUploads.ts");
const { approvalForId, approvalsForSession, resolveApproval } =
  await import("./pendingApprovals.ts");
const { setApprovalBroadcastForTests, setAutoApprovalDrainForTests } =
  await import("./pendingApprovals.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { attachmentRow, fakeConfluenceAnswer, json } =
  await import("./test/confluenceMutateFetch.ts");
await import("./tools/confluence/confluenceTools.ts");

const SITE = "acme.atlassian.net";
const PAGE_URL = `https://${SITE}/wiki/spaces/ENG/pages/123`;
const CREDENTIAL = { site: SITE, email: "a@x.test", token: "fake-p8a" };
const MAY_HAVE_WRITTEN_UPLOAD =
  "The gateway did not confirm the result. Changes may have been written, and an upload already sent can still finish within about three minutes. Wait three minutes, then check the page; ask again only for what is missing. Don't approve the same upload again unchecked.";
const PARTIAL_EFFECTS =
  "Some failed changes may have been partly written before they failed; the card shows each item's outcome. Check the site and ask again only for what is missing. Don't approve the same change again unchecked.";

const open: { close(): unknown }[] = [];
const edgeLines: string[] = [];
const HOST = mkdtempSync(join(tmpdir(), "gateway-upload-chain-files-"));
let fileBudget!: ReturnType<typeof createFileBudget>;
/** The edge's Confluence write deadline, when a test shortens it. */
let writeDeadlineMs: number | undefined;
/** Ends the link's current connection; the link redials. */
let dropLink!: () => void;

// --- the fake Confluence -----------------------------------------------------

/** How the site treats the next upload POST. */
type Mode = "normal" | "midBody" | "early" | "early400" | "hold";

interface Seen {
  method: string;
  path: string;
  /** A parsed multipart upload, once read whole. */
  upload?: { fileName: string; mediaType: string; bytes: Buffer };
  signal: AbortSignal | undefined;
  /** Whether the request's signal was aborted when the site answered. */
  abortedAtAnswer?: boolean;
}

const site = {
  att1Version: 2,
  att1Status: "current",
  /** Whether page 123 already has a `report.bin`. */
  nameTaken: false,
  modes: [] as Mode[],
  held: [] as (() => void)[],
};
let seen: Seen[] = [];

async function siteFetch(
  input: URL | string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/ex\/confluence\/[^/]+/, "");
  const request: Seen = { method, path, signal: init?.signal ?? undefined };
  seen.push(request);
  const answer = () =>
    fakeConfluenceAnswer({
      url,
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      signal: init?.signal ?? undefined,
    });
  if (method === "GET" && path === "/wiki/api/v2/attachments/att1")
    return json({
      ...attachmentRow(),
      status: site.att1Status,
      version: { number: site.att1Version },
    });
  if (
    method === "GET" &&
    path === "/wiki/api/v2/pages/123/attachments" &&
    url.searchParams.get("filename") === "report.bin" &&
    site.nameTaken
  )
    return json({
      results: [
        {
          id: "att5",
          title: "report.bin",
          pageId: "123",
          status: "current",
          mediaType: "application/octet-stream",
          fileSize: 3,
          version: { number: 1 },
        },
      ],
    });
  if (method === "POST" && path.includes("/child/attachment")) {
    const mode = site.modes.shift() ?? "normal";
    const body = init?.body as ReadableStream<Uint8Array>;
    if (mode === "early") return answer();
    if (mode === "early400") return json({ message: "Bad request" }, 400);
    if (mode === "midBody") {
      const reader = body.getReader();
      await reader.read();
      await reader.cancel();
      throw new TypeError("fetch failed");
    }
    const type = new Headers(init?.headers).get("content-type") ?? "";
    const form = await new Response(body, {
      headers: { "content-type": type },
    }).formData();
    const file = form.get("file") as File;
    request.upload = {
      fileName: file.name,
      mediaType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    };
    if (mode === "hold")
      await new Promise<void>((resolve, reject) => {
        site.held.push(resolve);
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason as Error),
        );
      });
    request.abortedAtAnswer = init?.signal?.aborted ?? false;
  }
  return answer();
}

const writes = () => seen.filter((request) => request.method !== "GET");

// --- the chain ---------------------------------------------------------------

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(siteFetch));
  setApprovalBroadcastForTests(() => {});
  setAutoApprovalDrainForTests(async () => {});
  const real = createEdgeTools({ log: () => {} });
  // The real tools, deletes of attachments on; Confluence's write deadline
  // read per call, so one test can shorten it (X3).
  const tools = edgeTools({
    confluenceDeletes: confluenceDeleteSwitchFor([
      "delete:attachment:confluence",
    ]),
  }).map((tool) => {
    if (tool.name !== "confluence_mutate_page") return tool;
    const own = tool.deadlineMs;
    const copy = { ...tool };
    Object.defineProperty(copy, "deadlineMs", {
      get: () => writeDeadlineMs ?? own,
    });
    return copy;
  });
  fileBudget = createFileBudget();
  const log = (line: string) => edgeLines.push(line);
  const host = createToolHost(tools, { log, fileBudget });
  const edge: EdgeTools = {
    ...real,
    host,
    uploads: createUploadStore({ fileBudget }),
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
    log,
    clients: {},
    tools: edge,
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
  // A proxy the link dials, so a test can end the connection.
  const piped = new Set<net.Socket>();
  const proxy = net.createServer((local) => {
    const remote = net.connect(relay.socketPath);
    const end = () => {
      local.destroy();
      remote.destroy();
      piped.delete(local);
      piped.delete(remote);
    };
    for (const socket of [local, remote]) {
      piped.add(socket);
      socket.on("error", end);
      socket.on("close", end);
    }
    local.pipe(remote);
    remote.pipe(local);
  });
  const proxyPath = join(relayDir, "proxy.sock");
  await new Promise<void>((resolve) => proxy.listen(proxyPath, resolve));
  open.push({
    close: () => {
      for (const socket of piped) socket.destroy();
      return new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  });
  dropLink = () => {
    for (const socket of piped) socket.destroy();
  };
  await gateway.clients!.userOperations.setAtlassian("thasso", CREDENTIAL);
  const link = startGatewayClientLink({
    socketPath: proxyPath,
    relayPort: relay.port,
    log: () => {},
  });
  open.push(link);
  assert.equal(await link.ready, true);
  updateConfluenceSettings({ enabled: true });
});

afterAll(async () => {
  updateConfluenceSettings({ enabled: false });
  setApprovalBroadcastForTests(null);
  setAutoApprovalDrainForTests(null);
  while (open.length) await open.pop()!.close();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  rmSync(HOST, { recursive: true, force: true });
});

let sessions = 0;
let sessionId = "";

beforeEach(async () => {
  seen = [];
  site.att1Version = 2;
  site.att1Status = "current";
  site.nameTaken = false;
  site.modes = [];
  site.held = [];
  writeDeadlineMs = undefined;
  sessionId = `p8a-upload-chain-${sessions++}`;
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "assistant",
    title: sessionId,
  });
  // Each test starts with the edge's file permit free.
  await vi.waitFor(() => assert.equal(fileBudget.reserved, 0), {
    timeout: 5_000,
  });
});

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

function hostFile(name: string, content: string | Uint8Array): string {
  const dir = mkdtempSync(join(HOST, "f-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** Proposes `items` with the remote tool and answers the pending card. */
async function propose(items: object[]): Promise<ApprovalCard> {
  const tool = remoteToolsFor("confluence").find(
    (entry) => entry.name === "confluence_mutate_page",
  );
  assert.ok(tool);
  await tool.execute({ items }, {
    session: { sessionId },
    toolCallId: "call-1",
  } as never);
  const pending = approvalsForSession(sessionId).filter(
    (card) => card.status === "pending",
  );
  assert.equal(pending.length, 1);
  return pending[0]!;
}

const approve = async (card: ApprovalCard) =>
  (await resolveApproval(card.id, "approved")).card;

const itemsOf = (card: ApprovalCard) =>
  (card.body as { items: ConfluencePageMutationItemDisplay[] }).items;

const uploadsSeen = () =>
  writes().filter((request) => request.path.includes("/child/attachment"));

// --- AC10: results through P6a's matrix --------------------------------------

test("a new attachment from a host file: the approved bytes, the local card and P6a's result fields", async () => {
  const path = hostFile("source.bin", "\u0000\u0001binaryÿ");
  const card = await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      fileName: "report.bin",
      sourcePath: path,
    },
  ]);
  const [proposed] = itemsOf(card);
  assert.equal(proposed?.attachment?.fileName, "report.bin");
  assert.equal(proposed?.attachment?.source, path);
  assert.equal(proposed?.attachment?.mediaType, "application/octet-stream");
  assert.match(proposed?.attachment?.stagedAttachmentId ?? "", /^p8a-/);
  // Prepare wrote nothing.
  assert.deepEqual(writes(), []);

  const decided = await approve(card);
  assert.equal(decided.status, "executed", decided.error);
  assert.equal(decided.resultSummary, "Applied 1 Confluence change(s)");
  assert.equal(decided.resultUrl, PAGE_URL);
  const [item] = itemsOf(decided);
  assert.equal(item?.resultPageId, "123");
  assert.equal(item?.resultPageUrl, PAGE_URL);
  assert.deepEqual(
    [item?.attachment?.resultId, item?.attachment?.resultVersion],
    ["att9", 1],
  );
  const [post] = uploadsSeen();
  assert.equal(post?.path, "/wiki/rest/api/content/123/child/attachment");
  assert.equal(post?.upload?.fileName, "report.bin");
  assert.equal(post?.upload?.mediaType, "application/octet-stream");
  assert.equal(
    sha(post!.upload!.bytes),
    sha(Buffer.from("\u0000\u0001binaryÿ")),
  );
  assert.equal(fileBudget.reserved, 0);
});

test("a new version of an attachment, from a session attachment, two items sharing it", async () => {
  const { stageSessionAttachment } = await import("./sessionAttachments.ts");
  const bytes = Buffer.from("%PNG-new-diagram");
  const record = stageSessionAttachment(sessionId, {
    name: "diagram.png",
    mimeType: "image/png",
    bytes,
    source: "upload",
  });
  const card = await propose([
    {
      operation: "uploadAttachment",
      attachmentId: "att1",
      sourceAttachmentId: record.id,
    },
    {
      operation: "uploadAttachment",
      page: "456",
      fileName: "copy.png",
      sourceAttachmentId: record.id,
    },
  ]);
  const decided = await approve(card);
  assert.equal(decided.status, "executed", decided.error);
  const [version, created] = itemsOf(decided);
  assert.deepEqual(
    [version?.attachment?.resultId, version?.attachment?.resultVersion],
    ["att1", 3],
  );
  assert.deepEqual(
    [created?.attachment?.resultId, created?.attachment?.resultVersion],
    ["att9", 1],
  );
  assert.deepEqual(
    uploadsSeen().map((post) => [post.path, sha(post.upload!.bytes)]),
    [
      ["/wiki/rest/api/content/123/child/attachment/att1/data", sha(bytes)],
      ["/wiki/rest/api/content/456/child/attachment", sha(bytes)],
    ],
  );
});

test("version drift and name drift after approval are refused with nothing uploaded", async () => {
  const draft = hostFile("draft.png", "%PNG-draft");
  const versioned = await propose([
    { operation: "uploadAttachment", attachmentId: "att1", sourcePath: draft },
  ]);
  site.att1Version = 5;
  const drifted = await approve(versioned);
  assert.equal(drifted.status, "failed");
  assert.equal(
    drifted.error,
    "All 1 Confluence change(s) failed: diagram.png changed since this proposal was prepared (version 2 → 5). Re-read it and propose the change again. Nothing was written.",
  );
  assert.deepEqual(uploadsSeen(), []);

  const named = await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      fileName: "report.bin",
      sourcePath: hostFile("report.bin", "new"),
    },
  ]);
  site.nameTaken = true;
  const taken = await approve(named);
  assert.equal(taken.status, "failed");
  assert.equal(
    taken.error,
    "All 1 Confluence change(s) failed: An attachment named report.bin was added to the page since this proposal. Propose the upload again to make it a new version. Nothing was written.",
  );
  assert.deepEqual(uploadsSeen(), []);
  assert.equal(fileBudget.reserved, 0);
});

test("the delete guard is unchanged beside an upload: a trashed attachment is not deleted, the upload goes", async () => {
  const card = await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      fileName: "report.bin",
      sourcePath: hostFile("report.bin", "new"),
    },
    { operation: "deleteAttachment", attachmentId: "att1" },
  ]);
  site.att1Status = "trashed";
  const decided = await approve(card);
  assert.equal(decided.status, "executed");
  assert.equal(
    decided.resultSummary,
    "Applied 1 Confluence change(s); 1 failed",
  );
  assert.deepEqual(
    itemsOf(decided).map((item) => item.error),
    [
      undefined,
      "diagram.png is not confirmed current (status trashed); nothing was deleted.",
    ],
  );
  assert.equal(itemsOf(decided)[0]?.attachment?.resultId, "att9");
  assert.equal(uploadsSeen().length, 1);
  assert.ok(!writes().some((request) => request.method === "DELETE"));
});

// --- v05 W2, v06 X3/X4: body failures and deadlines ----------------------------

test("W2-1: an upload whose POST fails mid-body: all failed, partial effects (the POST counted as a write)", async () => {
  const card = await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      sourcePath: hostFile("a.bin", "aaaa"),
    },
  ]);
  site.modes = ["midBody"];
  const decided = await approve(card);
  assert.equal(
    itemsOf(decided)[0]?.error,
    "The request to Confluence failed; the change may or may not have been applied.",
  );
  assert.equal(
    decided.error,
    `All 1 Confluence change(s) failed: The request to Confluence failed; the change may or may not have been applied. ${PARTIAL_EFFECTS}`,
  );
  assert.equal(decided.status, "failed");
  assert.ok(decided.error?.endsWith(` ${PARTIAL_EFFECTS}`));
});

test("W2-2: a page edit, then an upload that fails mid-body: executed, partial effects", async () => {
  const card = await propose([
    { operation: "comment", page: "123", body: "Note" },
    {
      operation: "uploadAttachment",
      page: "123",
      sourcePath: hostFile("a.bin", "aaaa"),
    },
  ]);
  site.modes = ["midBody"];
  const decided = await approve(card);
  assert.equal(
    decided.resultSummary,
    `Applied 1 Confluence change(s); 1 failed ${PARTIAL_EFFECTS}`,
  );
  assert.deepEqual(
    itemsOf(decided).map((item) => item.error),
    [
      undefined,
      "The request to Confluence failed; the change may or may not have been applied.",
    ],
  );
  assert.equal(itemsOf(decided)[0]?.resultPageId, "123");
  assert.equal(decided.status, "executed");
});

test("W2-3/X4: an early 200 before the body completed: BODY_NOT_COMPLETED on the item, partial effects", async () => {
  const card = await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      sourcePath: hostFile("a.bin", "aaaa"),
    },
  ]);
  site.modes = ["early"];
  const decided = await approve(card);
  assert.equal(decided.status, "failed");
  assert.equal(
    decided.error,
    `All 1 Confluence change(s) failed: ${BODY_NOT_COMPLETED} ${PARTIAL_EFFECTS}`,
  );
  assert.equal(itemsOf(decided)[0]?.error, BODY_NOT_COMPLETED);
  assert.ok(decided.error?.endsWith(` ${PARTIAL_EFFECTS}`));
});

test("X3: the deadline during item 1's POST stops the call; item 2 never runs", async () => {
  const card = await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      sourcePath: hostFile("a.bin", "aaaa"),
    },
    {
      operation: "uploadAttachment",
      page: "456",
      sourcePath: hostFile("b.bin", "bbbb"),
    },
  ]);
  // 8.5 s for these bytes: item 1 starts (no item starts within the last
  // 7 s), and its POST is held until the deadline aborts it.
  writeDeadlineMs = 7_500;
  site.modes = ["hold"];
  const decided = await approve(card);
  assert.deepEqual(
    itemsOf(decided).map((item) => item.error),
    [
      "The request ended while this change was running; check the site before asking again.",
      "Not applied: the request ended before this change started.",
    ],
  );
  assert.equal(decided.status, "failed");
  assert.equal(decided.error, MAY_HAVE_WRITTEN_UPLOAD);
  assert.equal(uploadsSeen().length, 1);
});

test("X3 contrast and no poisoning: a mid-body failure or an early 400 on item 1 lets item 2 upload", async () => {
  for (const mode of ["midBody", "early400"] as const) {
    seen = [];
    const card = await propose([
      {
        operation: "uploadAttachment",
        page: "123",
        sourcePath: hostFile("a.bin", "aaaa"),
      },
      {
        operation: "uploadAttachment",
        page: "456",
        sourcePath: hostFile("b.bin", "bbbb"),
      },
    ]);
    site.modes = [mode];
    const decided = await approve(card);
    assert.equal(
      decided.resultSummary,
      `Applied 1 Confluence change(s); 1 failed ${PARTIAL_EFFECTS}`,
      mode,
    );
    assert.equal(
      itemsOf(decided)[0]?.error,
      mode === "midBody"
        ? "The request to Confluence failed; the change may or may not have been applied."
        : "Confluence refused the change (HTTP 400).",
    );
    assert.equal(itemsOf(decided)[1]?.attachment?.resultId, "att9", mode);
    assert.equal(decided.status, "executed", mode);
    const [, second] = uploadsSeen();
    assert.equal(second?.upload?.bytes.toString(), "bbbb", mode);
    assert.equal(second?.abortedAtAnswer, false, mode);
  }
});

// --- preflight on the edge -----------------------------------------------------

test("a busy edge refuses the open with its own text; nothing is uploaded, and the card can be proposed again", async () => {
  const card = await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      sourcePath: hostFile("a.bin", "aaaa"),
    },
  ]);
  const release = fileBudget.reserve(1);
  assert.ok(release);
  try {
    const decided = await approve(card);
    assert.equal(decided.status, "failed");
    assert.equal(decided.error, `${UPLOAD_BUSY} Nothing was written.`);
  } finally {
    release();
  }
  assert.deepEqual(writes(), []);
});

test("a staged copy changed after approval: the edge refuses the put, the upload is released, nothing is written", async () => {
  const card = await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      sourcePath: hostFile("a.bin", "aaaa"),
    },
  ]);
  const { resolveSessionAttachment } = await import("./sessionAttachments.ts");
  const staged = resolveSessionAttachment(
    sessionId,
    itemsOf(card)[0]!.attachment!.stagedAttachmentId!,
  );
  writeFileSync(staged!.path, "bbbb");
  const decided = await approve(card);
  assert.equal(decided.status, "failed");
  assert.equal(decided.error, UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN);
  assert.deepEqual(writes(), []);
  await vi.waitFor(() => assert.equal(fileBudget.reserved, 0));
});

// --- K3 / W2-4: the lost answer --------------------------------------------------

test("W2-4: the link drops while the edge's POST runs: the upload's uncertainty, no release, and the late completion changes nothing", async () => {
  const port = remoteTools.remoteToolPort()!;
  const release = vi.spyOn(port.uploads, "release");
  const card = await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      sourcePath: hostFile("a.bin", "aaaa"),
    },
  ]);
  site.modes = ["hold"];
  const deciding = approve(card);
  await vi.waitFor(() => assert.equal(site.held.length, 1), {
    timeout: 5_000,
  });
  dropLink();
  const decided = await deciding;
  assert.equal(decided.status, "failed");
  assert.equal(decided.error, MAY_HAVE_WRITTEN_UPLOAD);
  const snapshot = structuredClone(approvalForId(card.id));
  // The edge's POST completes after the answer was lost.
  site.held[0]!();
  await vi.waitFor(() => assert.equal(fileBudget.reserved, 0), {
    timeout: 5_000,
  });
  assert.equal(uploadsSeen().length, 1);
  assert.equal(uploadsSeen()[0]?.upload?.bytes.toString(), "aaaa");
  await vi.waitFor(
    () => assert.equal(remoteTools.remoteToolsConnected(), true),
    {
      timeout: 8_000,
    },
  );
  assert.deepEqual(approvalForId(card.id), snapshot);
  assert.equal(release.mock.calls.length, 0);
  release.mockRestore();
});
