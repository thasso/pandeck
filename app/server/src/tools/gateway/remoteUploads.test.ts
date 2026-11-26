/**
 * A client-mode Confluence upload's proposal (Task-1441 P8a, v02 AC1/AC4,
 * v03 K2/K4) through the remote `confluence_mutate_page` tool with a fake
 * link: the stat pre-check, the progressive 100 MiB work budget, owned
 * staging and its cleanup, the frozen sources beside `tools.prepare`, and
 * the binding of the prepared rows to them. Hooks around the stat, the
 * freeze, `open` and `writeFileSync` place growth, cancellation and staging
 * failures between the steps, and count what was opened and read.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  /** Runs after each real `statUploadSource`, with its 1-based call count. */
  afterStat: undefined as ((call: number) => void) | undefined,
  stats: 0,
  /** Runs after each real `freezeUploadSource` returned. */
  afterFreeze: undefined as ((call: number) => void) | undefined,
  freezes: 0,
  /** Every path `open` was asked for, and the bytes read from each. */
  opened: [] as string[],
  bytesRead: new Map<string, number>(),
  /** A one-shot staging failure for a `p8a-` copy. */
  failWrite: undefined as "partial" | "index" | undefined,
}));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const path = String(args[0]);
    hooks.opened.push(path);
    const read = handle.read.bind(handle) as (
      ...a: unknown[]
    ) => Promise<{ bytesRead: number }>;
    (handle as unknown as { read: typeof read }).read = async (...a) => {
      const result = await read(...a);
      hooks.bytesRead.set(
        path,
        (hooks.bytesRead.get(path) ?? 0) + result.bytesRead,
      );
      return result;
    };
    return handle;
  };
  return { ...actual, default: { ...actual, open }, open };
});

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  const writeFileSync: typeof actual.writeFileSync = (path, data, options) => {
    const target = String(path);
    if (hooks.failWrite === "partial" && /-p8a-[0-9a-f]{16}-/.test(target)) {
      hooks.failWrite = undefined;
      const bytes = data as Uint8Array;
      actual.writeFileSync(target, bytes.subarray(0, bytes.byteLength >> 1));
      throw new Error("The disk is full.");
    }
    if (
      hooks.failWrite === "index" &&
      target.endsWith("index.json") &&
      String(data).includes('"p8a-')
    ) {
      hooks.failWrite = undefined;
      throw new Error("The index could not be written.");
    }
    actual.writeFileSync(path, data, options);
  };
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

vi.mock("../confluence/confluenceAttachments.ts", async (importActual) => {
  const actual =
    await importActual<
      typeof import("../confluence/confluenceAttachments.ts")
    >();
  return {
    ...actual,
    statUploadSource: (...args: Parameters<typeof actual.statUploadSource>) => {
      const result = actual.statUploadSource(...args);
      hooks.stats += 1;
      hooks.afterStat?.(hooks.stats);
      return result;
    },
    freezeUploadSource: async (
      ...args: Parameters<typeof actual.freezeUploadSource>
    ) => {
      const result = await actual.freezeUploadSource(...args);
      hooks.freezes += 1;
      hooks.afterFreeze?.(hooks.freezes);
      return result;
    },
  };
});

const fs = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { updateConfluenceSettings } =
  await import("../../confluenceSettings.ts");
const { updateJiraSettings } = await import("../../jiraSettings.ts");
const { approvalsForSession, resolveApproval, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");
const { acceptRemoteTools, applyListing, installRemoteToolPort } =
  await import("../../remoteTools.ts");
type RemotePrepareAnswer = import("../../remoteTools.ts").RemotePrepareAnswer;
type RemoteUploadSource = import("../../remoteTools.ts").RemoteUploadSource;
const {
  listSessionAttachments,
  stageSessionAttachment,
  sessionAttachmentsDir,
} = await import("../../sessionAttachments.ts");
const { remoteToolsFor } = await import("./remoteToolGroup.ts");
const {
  UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
  UPLOAD_TOO_LARGE_NOTHING_WRITTEN,
  cardUploads,
} = await import("./remoteUploads.ts");
type ToolCallContext = import("../../mcp/tool.ts").ToolCallContext;

setApprovalBroadcastForTests(() => {});

const MIB = 1024 * 1024;
const SITE = "acme.atlassian.net";
const PAGE_URL = `https://${SITE}/wiki/spaces/ENG/pages/123`;
const UNEXPECTED_ANSWER =
  "The gateway answered something this server can't show as a proposal; nothing was prepared.";
const CANCELLED = "The call was cancelled. Nothing was written.";
const DISABLED =
  "Confluence tools are disabled. Enable them in Settings → Confluence. Nothing was written.";
const STAGED_ID = /^p8a-[0-9a-f]{16}$/;

const HOST = fs.mkdtempSync(join(tmpdir(), "remote-uploads-"));

interface Prepared {
  args: { items: Record<string, unknown>[] };
  uploads: readonly RemoteUploadSource[] | undefined;
}
let prepared: Prepared[] = [];
let answer: (request: Prepared) => Promise<RemotePrepareAnswer>;
let uninstall: () => void = () => {};
let sessionId = "";
let caller: AbortController;

/** The edge's prepared rows for `request`, as `stageUploadChange` builds them. */
function rows(request: Prepared): ConfluencePageMutationItemDisplay[] {
  return request.args.items.map((item, index) => {
    const clientId = `cfl_${index}`;
    if (item.operation !== "uploadAttachment")
      return {
        clientId,
        operation: "comment",
        pageId: "123",
        pageUrl: PAGE_URL,
        title: "Page 123",
        spaceKey: "ENG",
        spaceName: "Engineering",
        body: "Note",
      };
    const source = request.uploads?.find(
      (entry) => entry.stagedAttachmentId === item.sourceAttachmentId,
    );
    assert.ok(source, "every upload item names a declared source");
    const named = typeof item.fileName === "string" ? item.fileName.trim() : "";
    return {
      clientId,
      operation: "uploadAttachment",
      pageId: "123",
      pageUrl: PAGE_URL,
      title: "Page 123",
      spaceKey: "ENG",
      spaceName: "Engineering",
      attachment: {
        ...(item.attachmentId
          ? {
              fileName: named || "spec.pdf",
              existingId: "att2",
              baseVersion: 4,
            }
          : { fileName: named || source.name }),
        mediaType: source.mimeType,
        size: source.size,
        source: source.source,
        stagedAttachmentId: source.stagedAttachmentId,
        sha256: source.sha256,
      },
    };
  });
}

const echo = (request: Prepared): Promise<RemotePrepareAnswer> =>
  Promise.resolve({ ok: true, site: SITE, items: rows(request), warnings: [] });

beforeEach(async () => {
  prepared = [];
  hooks.afterStat = undefined;
  hooks.afterFreeze = undefined;
  hooks.stats = 0;
  hooks.freezes = 0;
  hooks.opened = [];
  hooks.bytesRead = new Map();
  hooks.failWrite = undefined;
  caller = new AbortController();
  sessionId = `remote-uploads-${randomUUID()}`;
  answer = echo;
  uninstall = installRemoteToolPort({
    callFile: () => Promise.reject(new Error("unused")),
    uploads: {
      open: () => Promise.reject(new Error("unused")),
      put: () => Promise.reject(new Error("unused")),
      release: () => {},
    },
    call: () => Promise.reject(new Error("unused")),
    prepare: (_name, args, _signal, uploads) => {
      const request = {
        args: structuredClone(args) as Prepared["args"],
        uploads: uploads && structuredClone(uploads),
      };
      prepared.push(request);
      return answer(request);
    },
    apply: () => Promise.resolve({ outcome: "notSent" }),
  });
  await updateJiraSettings({ enabled: false });
  updateConfluenceSettings({ enabled: true });
  applyListing(
    acceptRemoteTools([
      {
        name: "confluence_mutate_page",
        description: "The edge's text.",
        inputSchema: { type: "object", properties: {} },
        effect: "write",
        actionKey: "confluence:write",
        twoPhase: true,
      },
    ]),
  );
});

afterEach(() => {
  uninstall();
  updateConfluenceSettings({ enabled: false });
});

afterAll(() => {
  fs.rmSync(HOST, { recursive: true, force: true });
});

const tool = () =>
  remoteToolsFor("confluence").find(
    (entry) => entry.name === "confluence_mutate_page",
  )!;

const ctx = () =>
  ({
    session: { sessionId },
    toolCallId: "call-1",
    signal: caller.signal,
  }) as ToolCallContext;

const propose = (items: object[]) => tool().execute({ items }, ctx());

/** A host file of `content`, or `size` sparse bytes. */
function hostFile(name: string, content: string | number): string {
  const path = join(HOST, `${randomUUID()}-${name}`);
  if (typeof content === "string") fs.writeFileSync(path, content);
  else {
    fs.writeFileSync(path, "");
    fs.truncateSync(path, content);
  }
  return path;
}

const upload = (sourcePath: string, extra: object = {}) => ({
  operation: "uploadAttachment",
  page: "123",
  sourcePath,
  ...extra,
});

const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The call fails with `message`: no card, nothing prepared, no copy left. */
async function refused(
  items: object[],
  message: string,
  { prepares = 0, kept = [] as string[] } = {},
): Promise<void> {
  await assert.rejects(propose(items), (err: unknown) => {
    assert.equal((err as Error).message, message);
    return true;
  });
  assert.deepEqual(approvalsForSession(sessionId), []);
  assert.equal(prepared.length, prepares, "prepare calls");
  assert.deepEqual(
    listSessionAttachments(sessionId).map((record) => record.id),
    kept,
    "session attachments left",
  );
}

const stagedBytes = () =>
  listSessionAttachments(sessionId).reduce(
    (sum, record) => sum + record.size,
    0,
  );

// --- the freeze and the prepare ------------------------------------------

test("a host file is copied under an owned staging id and declared beside prepare; the card keeps the copy (AC1)", async () => {
  const path = hostFile("source.bin", "\u0000\u0001binary");
  const result = await propose([upload(path, { fileName: " report.bin " })]);

  assert.equal(prepared.length, 1);
  const [{ args, uploads }] = prepared as [Prepared];
  const id = args.items[0]!.sourceAttachmentId as string;
  assert.match(id, STAGED_ID);
  // The item names its frozen source only; the host path never travels as one.
  assert.deepEqual(args.items, [
    {
      operation: "uploadAttachment",
      page: "123",
      fileName: " report.bin ",
      sourceAttachmentId: id,
    },
  ]);
  const bytes = fs.readFileSync(path);
  assert.deepEqual(uploads, [
    {
      stagedAttachmentId: id,
      name: path.slice(HOST.length + 1),
      mimeType: "application/octet-stream",
      size: bytes.byteLength,
      sha256: sha(bytes),
      source: path,
    },
  ]);
  const [card] = approvalsForSession(sessionId);
  assert.ok(card);
  const [item] = (card.body as { items: ConfluencePageMutationItemDisplay[] })
    .items;
  assert.equal(item?.attachment?.fileName, "report.bin");
  assert.equal(item?.attachment?.stagedAttachmentId, id);
  assert.equal(result.terminate, true);
  const [record] = listSessionAttachments(sessionId);
  assert.equal(record?.id, id);
  assert.deepEqual(fs.readFileSync(record!.path), bytes);

  // A denied card keeps its copy, as the local tool's card does.
  await resolveApproval(card.id, "rejected");
  assert.deepEqual(
    listSessionAttachments(sessionId).map((entry) => entry.id),
    [id],
  );
});

test("a session attachment is pinned where it is: its own id, no copy", async () => {
  const record = stageSessionAttachment(sessionId, {
    name: "notes.txt",
    mimeType: "text/plain",
    bytes: Buffer.from("hello"),
    source: "upload",
  });
  await propose([
    {
      operation: "uploadAttachment",
      page: "123",
      sourceAttachmentId: record.id,
    },
  ]);
  assert.deepEqual(prepared[0]!.uploads, [
    {
      stagedAttachmentId: record.id,
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      sha256: sha("hello"),
      source: "session attachment notes.txt",
    },
  ]);
  assert.deepEqual(prepared[0]!.args.items[0], {
    operation: "uploadAttachment",
    page: "123",
    sourceAttachmentId: record.id,
  });
  assert.deepEqual(
    listSessionAttachments(sessionId).map((entry) => entry.id),
    [record.id],
  );
  assert.equal(approvalsForSession(sessionId).length, 1);
});

test("a call without uploads declares none and freezes nothing", async () => {
  await propose([{ operation: "comment", page: "123", body: "Note" }]);
  assert.equal(prepared[0]!.uploads, undefined);
  assert.equal(hooks.stats, 0);
  assert.equal(approvalsForSession(sessionId).length, 1);
});

test("a source the local tool refuses is refused with its text, before any read (AC1 step 2)", async () => {
  const empty = hostFile("empty.bin", "");
  const huge = hostFile("huge.bin", 100 * MIB + 1);
  const cases: [object, string][] = [
    [
      { operation: "uploadAttachment", page: "123" },
      "uploadAttachment needs exactly one of sourceAttachmentId or sourcePath. Nothing was written.",
    ],
    [
      upload(empty, { sourceAttachmentId: "x" }),
      "uploadAttachment needs exactly one of sourceAttachmentId or sourcePath. Nothing was written.",
    ],
    [
      upload("relative/file.bin"),
      "sourcePath must be an absolute path on this host. Nothing was written.",
    ],
    [upload(HOST), `"${HOST}" is not a file. Nothing was written.`],
    [
      upload(join(HOST, "missing.bin")),
      `"${join(HOST, "missing.bin")}" is not a file. Nothing was written.`,
    ],
    [
      {
        operation: "uploadAttachment",
        page: "123",
        sourceAttachmentId: "nope",
      },
      'No session attachment found for id "nope". Use list_attachments to see available attachments. Nothing was written.',
    ],
    [upload(empty), `"${empty}" is empty. Nothing was written.`],
    [
      upload(huge),
      `"${huge}" is larger than 104857600 bytes; attachments above that are not uploaded. Nothing was written.`,
    ],
  ];
  for (const [item, message] of cases) await refused([item], message);
  assert.deepEqual(hooks.opened, []);
});

test("uploads totalling more than 100 MiB are refused before any copy (AC1 step 2)", async () => {
  const one = hostFile("one.bin", 60 * MIB);
  const two = hostFile("two.bin", 60 * MIB);
  await refused([upload(one), upload(two)], UPLOAD_TOO_LARGE_NOTHING_WRITTEN);
  assert.equal(hooks.freezes, 0);
  assert.deepEqual(hooks.opened, []);
});

// --- the progressive budget (v03 K4) ---------------------------------------

test("growth race: ten files stat 1 MiB and grow to 100 MiB; the first exhausts the budget, the rest are never opened", async () => {
  const paths = Array.from({ length: 10 }, (_, n) =>
    hostFile(`grow-${n}.bin`, MIB),
  );
  let peak = 0;
  hooks.afterStat = (call) => {
    peak = Math.max(peak, stagedBytes());
    // The pre-check saw ten files of 1 MiB; now every one is 100 MiB.
    if (call === 10) for (const path of paths) fs.truncateSync(path, 100 * MIB);
  };
  await refused(
    paths.map((path) => upload(path)),
    UPLOAD_TOO_LARGE_NOTHING_WRITTEN,
  );
  assert.equal(hooks.freezes, 1);
  assert.deepEqual(hooks.opened, [paths[0]]);
  assert.equal(hooks.bytesRead.get(paths[0]!), 100 * MIB);
  assert.equal(peak, 100 * MIB, "the peak of newly staged bytes");
});

test("read-time growth past the per-file cap gives the local text; nothing is staged", async () => {
  const path = hostFile("grows.bin", MIB);
  hooks.afterStat = (call) => {
    if (call === 2) fs.truncateSync(path, 100 * MIB + 1);
  };
  await refused(
    [upload(path)],
    `"${path}" is larger than 104857600 bytes; attachments above that are not uploaded. Nothing was written.`,
  );
  assert.ok(hooks.bytesRead.get(path)! <= 101 * MIB);
});

test("read-time growth past the budget left gives the aggregate text; the earlier copy goes", async () => {
  const first = hostFile("first.bin", 40 * MIB);
  const second = hostFile("second.bin", 10 * MIB);
  hooks.afterStat = (call) => {
    // The second item's fresh stat said 10 MiB; it is read at 70 MiB.
    if (call === 4) fs.truncateSync(second, 70 * MIB);
  };
  await refused(
    [upload(first), upload(second)],
    UPLOAD_TOO_LARGE_NOTHING_WRITTEN,
  );
  assert.equal(hooks.bytesRead.get(first), 40 * MIB);
  assert.ok(hooks.bytesRead.get(second)! <= 61 * MIB);
  assert.ok(hooks.bytesRead.get(second)! > 60 * MIB);
});

test("three 30 MiB copies are discarded when the fourth grows past the 10 MiB left; the fifth is never opened", async () => {
  const thirty = [1, 2, 3].map((n) => hostFile(`thirty-${n}.bin`, 30 * MIB));
  const fourth = hostFile("fourth.bin", 5 * MIB);
  const fifth = hostFile("fifth.bin", MIB);
  let peak = 0;
  hooks.afterStat = (call) => {
    peak = Math.max(peak, stagedBytes());
    if (call === 9) fs.truncateSync(fourth, 40 * MIB);
  };
  await refused(
    [...thirty, fourth, fifth].map((path) => upload(path)),
    UPLOAD_TOO_LARGE_NOTHING_WRITTEN,
  );
  assert.equal(peak, 90 * MIB);
  assert.equal(hooks.freezes, 3);
  assert.ok(!hooks.opened.includes(fifth));
  assert.ok(hooks.bytesRead.get(fourth)! <= 11 * MIB);
});

test("a session attachment repeated four times at 30 MiB is read once and refused on the fourth use; it stays", async () => {
  const record = stageSessionAttachment(sessionId, {
    name: "big.bin",
    mimeType: "application/octet-stream",
    bytes: new Uint8Array(MIB),
    source: "upload",
  });
  hooks.afterStat = (call) => {
    if (call === 4) fs.truncateSync(record.path, 30 * MIB);
  };
  const item = {
    operation: "uploadAttachment",
    page: "123",
    sourceAttachmentId: record.id,
  };
  await refused([item, item, item, item], UPLOAD_TOO_LARGE_NOTHING_WRITTEN, {
    kept: [record.id],
  });
  assert.equal(hooks.freezes, 1);
  assert.deepEqual(hooks.opened, [record.path]);
  assert.equal(fs.statSync(record.path).size, 30 * MIB);
});

test("a session attachment repeated within the budget is declared once and read once", async () => {
  const record = stageSessionAttachment(sessionId, {
    name: "logo.png",
    mimeType: "image/png",
    bytes: Buffer.from("png-bytes"),
    source: "upload",
  });
  const item = { operation: "uploadAttachment", sourceAttachmentId: record.id };
  await propose([
    { ...item, page: "123" },
    { ...item, page: "456" },
  ]);
  assert.equal(hooks.freezes, 1);
  assert.equal(prepared[0]!.uploads?.length, 1);
  assert.equal(approvalsForSession(sessionId).length, 1);
});

// --- fences and cleanup -----------------------------------------------------

test("a cancel or a toggle off between freezes stops the call and discards the copies made so far", async () => {
  const one = hostFile("one.bin", "one");
  const two = hostFile("two.bin", "two");
  hooks.afterFreeze = (call) => {
    if (call === 1) caller.abort();
  };
  await refused([upload(one), upload(two)], CANCELLED);
  assert.equal(hooks.freezes, 1);

  caller = new AbortController();
  hooks.freezes = 0;
  hooks.afterFreeze = (call) => {
    if (call === 1) updateConfluenceSettings({ enabled: false });
  };
  await refused([upload(one), upload(two)], DISABLED);
  assert.equal(hooks.freezes, 1);
});

test("a cancel after the last freeze is caught by the fence before prepare", async () => {
  hooks.afterFreeze = () => caller.abort();
  await refused([upload(hostFile("one.bin", "one"))], CANCELLED);
});

test("a refused or failed prepare discards the copies and raises no card", async () => {
  const path = hostFile("one.bin", "one");
  answer = () =>
    Promise.resolve({
      ok: false,
      code: "tool_error",
      message: "Page 123 was not found.",
    });
  await refused(
    [upload(path)],
    "Page 123 was not found. Nothing was written.",
    {
      prepares: 1,
    },
  );
  answer = () => Promise.reject(new Error("socket closed"));
  prepared = [];
  await refused(
    [upload(path)],
    "The credential gateway is unreachable. Nothing was written.",
    { prepares: 1 },
  );
});

test("a staging failure mid-write or at the index leaves no partial copy; other attachments stay byte-identical", async () => {
  stageSessionAttachment(sessionId, {
    name: "kept.txt",
    mimeType: "text/plain",
    bytes: Buffer.from("indexed"),
    source: "upload",
  });
  const orphan = join(sessionAttachmentsDir(sessionId), "123-orphan-file.bin");
  fs.writeFileSync(orphan, "orphan");
  const files = () =>
    fs
      .readdirSync(sessionAttachmentsDir(sessionId))
      .sort()
      .map((name) => [
        name,
        sha(fs.readFileSync(join(sessionAttachmentsDir(sessionId), name))),
      ]);
  const before = files();
  const path = hostFile("payload.bin", "payload-bytes");
  assert.equal(listSessionAttachments(sessionId).length, 2);

  hooks.failWrite = "partial";
  await assert.rejects(propose([upload(path)]), {
    message: "The disk is full. Nothing was written.",
  });
  assert.deepEqual(files(), before);

  hooks.failWrite = "index";
  await assert.rejects(propose([upload(path)]), {
    message: "The index could not be written. Nothing was written.",
  });
  assert.deepEqual(files(), before);
  assert.deepEqual(prepared, []);
});

// --- binding (v03 K2) -------------------------------------------------------

test("a prepared row not bound to its frozen source is refused before any card, and the copy goes", async () => {
  const path = hostFile("source.bin", "bytes");
  const mutations: [
    string,
    (row: ConfluencePageMutationItemDisplay) => void,
  ][] = [
    [
      "staged id",
      (row) => (row.attachment!.stagedAttachmentId = "p8a-0000000000000000"),
    ],
    ["digest", (row) => (row.attachment!.sha256 = "0".repeat(64))],
    ["size", (row) => (row.attachment!.size = 6)],
    ["source", (row) => (row.attachment!.source = "/etc/passwd")],
    ["media type", (row) => (row.attachment!.mediaType = "text/html")],
    ["name", (row) => (row.attachment!.fileName = "other.bin")],
    ["operation", (row) => (row.operation = "comment")],
  ];
  for (const [what, mutate] of mutations) {
    prepared = [];
    answer = async (request) => {
      const items = rows(request);
      mutate(items[0]!);
      return { ok: true, site: SITE, items, warnings: [] };
    };
    await refused([upload(path)], UNEXPECTED_ANSWER, { prepares: 1 }).catch(
      (err: unknown) => {
        throw new Error(`${what}: ${(err as Error).message}`);
      },
    );
  }
  // A stray upload row, or a dropped one.
  for (const change of ["stray", "dropped"] as const) {
    prepared = [];
    answer = async (request) => {
      const items = rows(request);
      return {
        ok: true,
        site: SITE,
        items: change === "stray" ? [...items, { ...items[0]! }] : [],
        warnings: [],
      };
    };
    await refused([upload(path)], UNEXPECTED_ANSWER, { prepares: 1 });
  }
});

test("an upload row on a call that froze nothing is refused", async () => {
  const record = stageSessionAttachment(sessionId, {
    name: "secret.txt",
    mimeType: "text/plain",
    bytes: Buffer.from("secret"),
    source: "upload",
  });
  answer = () =>
    Promise.resolve({
      ok: true,
      site: SITE,
      items: [
        {
          clientId: "cfl_0",
          operation: "uploadAttachment",
          pageId: "123",
          pageUrl: PAGE_URL,
          title: "Page 123",
          attachment: {
            fileName: "secret.txt",
            mediaType: "text/plain",
            size: 6,
            source: "session attachment secret.txt",
            stagedAttachmentId: record.id,
            sha256: sha("secret"),
          },
        },
      ],
      warnings: [],
    });
  await refused(
    [{ operation: "comment", page: "123", body: "Note" }],
    UNEXPECTED_ANSWER,
    { prepares: 1, kept: [record.id] },
  );
});

test("a new version shows the site's title, which an override must equal (K2)", async () => {
  const path = hostFile("draft.pdf", "%PDF-draft");
  await propose([upload(path, { attachmentId: "att2" })]);
  const [card] = approvalsForSession(sessionId);
  const [item] = (card!.body as { items: ConfluencePageMutationItemDisplay[] })
    .items;
  assert.equal(item?.attachment?.fileName, "spec.pdf");

  for (const fileName of ["", "x".repeat(1_025), "renamed.pdf"]) {
    prepared = [];
    answer = async (request) => {
      const items = rows(request);
      items[0]!.attachment!.fileName = fileName;
      return { ok: true, site: SITE, items, warnings: [] };
    };
    await assert.rejects(
      propose([upload(path, { attachmentId: "att2", fileName: "spec.pdf" })]),
      { message: UNEXPECTED_ANSWER },
    );
  }
});

// --- the card's sources at apply ---------------------------------------------

test("cardUploads: one stream per staged id, W over every item, and a card that disagrees is refused", () => {
  const row = (
    stagedAttachmentId: string,
    size: number,
    digest = sha(stagedAttachmentId),
  ): ConfluencePageMutationItemDisplay => ({
    clientId: `c-${stagedAttachmentId}`,
    operation: "uploadAttachment",
    pageId: "1",
    title: "P",
    attachment: {
      fileName: "f",
      mediaType: "application/octet-stream",
      size,
      source: "/s",
      stagedAttachmentId,
      sha256: digest,
    },
  });
  const comment = {
    clientId: "c",
    operation: "comment",
    pageId: "1",
    title: "P",
  } as ConfluencePageMutationItemDisplay;
  assert.equal(cardUploads([comment]), undefined);
  assert.deepEqual(
    cardUploads([row("a", 3), comment, row("b", 5), row("a", 3)]),
    {
      streams: [
        { stagedAttachmentId: "a", size: 3, sha256: sha("a") },
        { stagedAttachmentId: "b", size: 5, sha256: sha("b") },
      ],
      work: 11,
    },
  );
  assert.throws(() => cardUploads([row("a", 3), row("a", 4)]), {
    message: UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
  });
  assert.throws(() => cardUploads([row("a", 3), row("a", 3, "0".repeat(64))]), {
    message: UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
  });
  for (const bad of [row("", 3), row("a", 0), row("a", 1.5), row("a", 3, "x")])
    assert.throws(() => cardUploads([bad]), {
      message: UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
    });
  assert.throws(() => cardUploads([row("a", 60 * MIB), row("a", 60 * MIB)]), {
    message: UPLOAD_TOO_LARGE_NOTHING_WRITTEN,
  });
  assert.deepEqual(cardUploads([row("a", 100 * MIB)])?.work, 100 * MIB);
});
