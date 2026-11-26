/**
 * Applying a client-mode Confluence upload card (Task-1441 P8a, v02 AC5/AC9,
 * v03 K1/K3) through the real approval runner with a scripted uploads port:
 * open, then each source in 1 MiB puts with one outstanding, sealed only
 * after the last, then the fence and `tools.apply` naming the upload. Up to
 * the apply attempt any failure releases the upload and says nothing was
 * written; from the attempt on nothing is released and an unconfirmed
 * result says an upload may still finish within three minutes.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import type {
  ApprovalCard,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared";
import { afterEach, beforeEach, test, vi } from "vitest";
import { updateConfluenceSettings } from "../../confluenceSettings.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import {
  createApproval,
  resolveApproval,
  setApprovalBroadcastForTests,
  setAutoApprovalDrainForTests,
} from "../../pendingApprovals.ts";
import {
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  markDisconnected,
  type RemoteApplyOutcome,
  type RemoteApplyUpload,
  type RemoteToolPort,
  type RemoteUploadPort,
  type RemoteUploadStream,
} from "../../remoteTools.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";
import "../confluence/confluenceTools.ts";
import {
  UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
  UPLOAD_TOO_LARGE_NOTHING_WRITTEN,
} from "./remoteUploads.ts";
import { GATEWAY_CONTEXT } from "./remoteWriteRules.ts";

const MIB = 1024 * 1024;
const SITE = "acme.atlassian.net";
const PAGE_URL = `https://${SITE}/wiki/spaces/ENG/pages/123`;
const UNREACHABLE =
  "The credential gateway is unreachable. Nothing was written; ask for the change again.";
const NOT_CLIENT_MODE =
  "This change was prepared on the credential gateway, which this server no longer uses. Nothing was written; ask for it again.";
const NOT_OFFERED =
  "The gateway no longer offers this change. Nothing was written.";
const DISABLED =
  "Confluence tools are disabled. Enable them in Settings → Confluence. Nothing was written.";
const MAY_HAVE_WRITTEN =
  "The gateway did not confirm the result. Changes may have been written, and a change already sent can still finish within about a minute. Wait a minute, then check the site; ask again only for what is missing. Don't approve the same change again unchecked.";
const MAY_HAVE_WRITTEN_UPLOAD =
  "The gateway did not confirm the result. Changes may have been written, and an upload already sent can still finish within about three minutes. Wait three minutes, then check the page; ask again only for what is missing. Don't approve the same upload again unchecked.";
// The edge's fixed text (gatewayTools/uploads.ts), shown as is (P8A-V10-O1).
const UPLOAD_BUSY =
  "The gateway is already transferring a file; try again when it finishes. Nothing was uploaded.";
const UPLOAD_EXPIRED =
  "The gateway no longer holds the file for this upload; nothing was written. Ask for the upload again.";
const UPLOAD_INVALID =
  "The upload request is not valid; the gateway discarded the upload and nothing was written.";

const LISTING = [
  {
    name: "confluence_mutate_page",
    effect: "write",
    actionKey: "confluence:write",
    twoPhase: true,
  },
];

/** What the port saw, in order. */
type Event =
  | { call: "open"; streams: RemoteUploadStream[]; work: number }
  | {
      call: "put";
      uploadId: string;
      stagedAttachmentId: string;
      offset: number;
      length: number;
    }
  | { call: "release"; uploadId: string }
  | {
      call: "apply";
      items: ConfluencePageMutationItemDisplay[];
      upload: RemoteApplyUpload | undefined;
    };

let events: Event[];
let sessionId: string;
let uninstall: () => void = () => {};
/** Scripted answers; each returns undefined for the faithful default. */
let onOpen: () => ReturnType<RemoteUploadPort["open"]> | undefined;
let onPut: (n: number) => ReturnType<RemoteUploadPort["put"]> | undefined;
let onApply: () => Promise<RemoteApplyOutcome>;
let outstanding: number;
let maxOutstanding: number;

/** A faithful edge store: received per stream, sealed after every stream. */
function uploadsPort(): RemoteUploadPort {
  let streams: RemoteUploadStream[] = [];
  const received = new Map<string, number>();
  let puts = 0;
  return {
    open(requested, work) {
      events.push({
        call: "open",
        streams: structuredClone([...requested]),
        work,
      });
      streams = [...requested];
      received.clear();
      puts = 0;
      return onOpen() ?? Promise.resolve({ ok: true, uploadId: "upl-1" });
    },
    async put(uploadId, stagedAttachmentId, offset, chunk) {
      events.push({
        call: "put",
        uploadId,
        stagedAttachmentId,
        offset,
        length: chunk.byteLength,
      });
      outstanding += 1;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      try {
        puts += 1;
        const scripted = onPut(puts);
        if (scripted) return await scripted;
        await Promise.resolve();
        const now = offset + chunk.byteLength;
        received.set(stagedAttachmentId, now);
        const size = streams.find(
          (stream) => stream.stagedAttachmentId === stagedAttachmentId,
        )!.size;
        return {
          ok: true,
          received: now,
          streamComplete: now === size,
          sealed: streams.every(
            (stream) => received.get(stream.stagedAttachmentId) === stream.size,
          ),
        };
      } finally {
        outstanding -= 1;
      }
    },
    release(uploadId) {
      events.push({ call: "release", uploadId });
    },
  };
}

function port(): RemoteToolPort {
  return {
    callFile: () => Promise.reject(new Error("unused")),
    call: () => Promise.reject(new Error("unused")),
    prepare: () => Promise.reject(new Error("unused")),
    uploads: uploadsPort(),
    apply: (_name, _site, items, upload) => {
      events.push({
        call: "apply",
        items: structuredClone(items) as ConfluencePageMutationItemDisplay[],
        upload,
      });
      return onApply();
    },
  };
}

const answered = (results: object[]) => (): Promise<RemoteApplyOutcome> =>
  Promise.resolve({
    outcome: "answer",
    answer: { ok: true, results, effects: "possible" },
  });

beforeEach(() => {
  events = [];
  outstanding = 0;
  maxOutstanding = 0;
  onOpen = () => undefined;
  onPut = () => undefined;
  onApply = answered([]);
  sessionId = `remote-apply-uploads-${randomUUID()}`;
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "assistant",
    title: sessionId,
  });
  setApprovalBroadcastForTests(() => {});
  setAutoApprovalDrainForTests(async () => {});
  vi.stubGlobal("fetch", () =>
    Promise.reject(new Error("no local fetch in client mode")),
  );
  uninstall = installRemoteToolPort(port());
  updateConfluenceSettings({ enabled: true });
  applyListing(acceptRemoteTools(LISTING));
});

afterEach(() => {
  uninstall();
  uninstall = () => {};
  vi.unstubAllGlobals();
  updateConfluenceSettings({ enabled: false });
  setApprovalBroadcastForTests(null);
  setAutoApprovalDrainForTests(null);
});

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Bytes whose every MiB differs, so a misplaced chunk changes the digest. */
function bytesOf(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1)
    bytes[i] = (i * 31 + seed + (i >> 20)) & 255;
  return bytes;
}

interface Source {
  id: string;
  path: string;
  bytes: Uint8Array;
}

function staged(name: string, bytes: Uint8Array): Source {
  const record = stageSessionAttachment(sessionId, {
    name,
    mimeType: "application/octet-stream",
    bytes,
    source: "agent",
  });
  return { id: record.id, path: record.path, bytes };
}

const uploadItem = (
  n: number,
  source: Source,
  extra: Partial<ConfluencePageMutationItemDisplay["attachment"]> = {},
): ConfluencePageMutationItemDisplay => ({
  clientId: `cfl_${n}`,
  operation: "uploadAttachment",
  pageId: "123",
  pageUrl: PAGE_URL,
  title: "Page 123",
  spaceKey: "ENG",
  spaceName: "Engineering",
  attachment: {
    fileName: `file-${n}.bin`,
    mediaType: "application/octet-stream",
    size: source.bytes.byteLength,
    source: `/host/file-${n}.bin`,
    stagedAttachmentId: source.id,
    sha256: sha(source.bytes),
    ...extra,
  },
});

const commentItem = (n: number): ConfluencePageMutationItemDisplay => ({
  clientId: `cfl_${n}`,
  operation: "comment",
  pageId: "123",
  pageUrl: PAGE_URL,
  title: "Page 123",
  body: "Note",
});

function card(items: ConfluencePageMutationItemDisplay[]): ApprovalCard {
  return createApproval({
    sessionId,
    kind: "confluencePage",
    title: "Upload",
    body: { kind: "confluencePage", confluenceHost: SITE, items },
    context: { ...GATEWAY_CONTEXT },
  });
}

const uploadResult = (resultId: string) => ({
  effects: "possible",
  resultPageId: "123",
  resultPageUrl: PAGE_URL,
  attachment: { resultId, resultVersion: 1 },
});

const calls = () => events.map((event) => event.call);

/** Approves and answers the failed card's error. */
async function fails(target: ApprovalCard): Promise<string> {
  const { card: decided } = await resolveApproval(target.id, "approved");
  assert.equal(decided.status, "failed");
  return decided.error!;
}

// --- the send ---------------------------------------------------------------

test("two sources stream in order in 1 MiB puts, one outstanding, sealed after the last; apply names the upload (AC5, K1)", async () => {
  const big = staged("big.bin", bytesOf(2 * MIB + 512 * 1024, 1));
  const small = staged("small.bin", bytesOf(3, 2));
  onApply = answered([
    uploadResult("att9"),
    { effects: "possible", resultPageId: "123", resultPageUrl: PAGE_URL },
    uploadResult("att10"),
  ]);
  const target = card([
    uploadItem(0, big),
    commentItem(1),
    uploadItem(2, small),
  ]);

  const { card: decided } = await resolveApproval(target.id, "approved");

  assert.equal(decided.status, "executed", decided.error);
  const work = big.bytes.byteLength + 3;
  assert.deepEqual(events[0], {
    call: "open",
    streams: [
      {
        stagedAttachmentId: big.id,
        size: big.bytes.byteLength,
        sha256: sha(big.bytes),
      },
      { stagedAttachmentId: small.id, size: 3, sha256: sha(small.bytes) },
    ],
    work,
  });
  const puts = events.filter((event) => event.call === "put");
  assert.deepEqual(
    puts.map(({ stagedAttachmentId, offset, length }) => [
      stagedAttachmentId === big.id ? "big" : "small",
      offset,
      length,
    ]),
    [
      ["big", 0, MIB],
      ["big", MIB, MIB],
      ["big", 2 * MIB, 512 * 1024],
      ["small", 0, 3],
    ],
  );
  assert.equal(maxOutstanding, 1);
  assert.deepEqual(calls().slice(-1), ["apply"]);
  const apply = events.at(-1) as Extract<Event, { call: "apply" }>;
  assert.deepEqual(apply.upload, { uploadId: "upl-1", work });
  assert.ok(!calls().includes("release"));
  const items = (decided.body as { items: ConfluencePageMutationItemDisplay[] })
    .items;
  assert.deepEqual(items[0]?.attachment?.resultId, "att9");
  assert.deepEqual(items[2]?.attachment?.resultId, "att10");
});

test("a source two items share streams once, and W counts both", async () => {
  const shared = staged("logo.png", bytesOf(10, 3));
  onApply = answered([uploadResult("att1"), uploadResult("att2")]);
  const target = card([uploadItem(0, shared), uploadItem(1, shared)]);
  const { card: decided } = await resolveApproval(target.id, "approved");
  assert.equal(decided.status, "executed", decided.error);
  assert.deepEqual(calls(), ["open", "put", "apply"]);
  assert.equal((events[0] as { work: number }).work, 20);
  assert.deepEqual((events[2] as { upload: unknown }).upload, {
    uploadId: "upl-1",
    work: 20,
  });
});

test("a card without uploads opens nothing and keeps the one-minute text", async () => {
  onApply = () => Promise.resolve({ outcome: "lost" });
  assert.equal(await fails(card([commentItem(0)])), MAY_HAVE_WRITTEN);
  assert.deepEqual(calls(), ["apply"]);
  assert.equal((events[0] as { upload: unknown }).upload, undefined);
});

// --- preflight: nothing written, the upload released ------------------------

test("a refused open shows the edge's text with nothing written; nothing else is sent (P8A-V10-O1)", async () => {
  const source = staged("a.bin", bytesOf(5, 4));
  onOpen = () => Promise.resolve({ ok: false, message: UPLOAD_BUSY });
  assert.equal(
    await fails(card([uploadItem(0, source)])),
    `${UPLOAD_BUSY} Nothing was written.`,
  );
  assert.deepEqual(calls(), ["open"]);
});

test("an open that never answers is unreachable, nothing written", async () => {
  const source = staged("a.bin", bytesOf(5, 4));
  onOpen = () => Promise.reject(new Error("timeout"));
  assert.equal(await fails(card([uploadItem(0, source)])), UNREACHABLE);
  assert.deepEqual(calls(), ["open"]);
});

test("an edge UPLOAD_EXPIRED put refusal shows the edge's text with nothing written, released, never applied (requester ruling k1dz2xl1 #2)", async () => {
  const source = staged("a.bin", bytesOf(2 * MIB, 5));
  onPut = (n) =>
    n === 2
      ? Promise.resolve({ ok: false, message: UPLOAD_EXPIRED })
      : undefined;
  const text = await fails(card([uploadItem(0, source)]));
  assert.equal(text, UPLOAD_EXPIRED);
  assert.notEqual(text, UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN);
  assert.deepEqual(calls(), ["open", "put", "put", "release"]);
});

test("a put answer whose sealed flag mismatches the stream shows source-changed, released, never applied (requester ruling k1dz2xl1 #2)", async () => {
  const source = staged("a.bin", bytesOf(2 * MIB, 5));
  onPut = (n) =>
    n === 2
      ? Promise.resolve({
          ok: true,
          received: 2 * MIB,
          streamComplete: true,
          sealed: false,
        })
      : undefined;
  assert.equal(
    await fails(card([uploadItem(0, source)])),
    UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
  );
  assert.deepEqual(calls(), ["open", "put", "put", "release"]);
});

test("a refused, lost or inconsistent put releases the upload and never applies (K3)", async () => {
  const source = staged("a.bin", bytesOf(2 * MIB, 5));
  const cases: [
    string,
    (n: number) => ReturnType<RemoteUploadPort["put"]> | undefined,
    string,
  ][] = [
    [
      "refused",
      (n) =>
        n === 2
          ? Promise.resolve({ ok: false, message: UPLOAD_INVALID })
          : undefined,
      UPLOAD_INVALID,
    ],
    [
      "refused, the edge's text without the nothing-written clause",
      (n) =>
        n === 1
          ? Promise.resolve({
              ok: false,
              message: "The upload does not match.",
            })
          : undefined,
      "The upload does not match. Nothing was written.",
    ],
    [
      "lost",
      (n) => (n === 2 ? Promise.reject(new Error("closed")) : undefined),
      UNREACHABLE,
    ],
    [
      "short count",
      (n) =>
        n === 1
          ? Promise.resolve({
              ok: true,
              received: 1,
              streamComplete: false,
              sealed: false,
            })
          : undefined,
      UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
    ],
    [
      "sealed early",
      (n) =>
        n === 1
          ? Promise.resolve({
              ok: true,
              received: MIB,
              streamComplete: false,
              sealed: true,
            })
          : undefined,
      UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
    ],
    [
      "never sealed",
      (n) =>
        n === 2
          ? Promise.resolve({
              ok: true,
              received: 2 * MIB,
              streamComplete: true,
              sealed: false,
            })
          : undefined,
      UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
    ],
  ];
  for (const [what, script, message] of cases) {
    events = [];
    onPut = script;
    assert.equal(await fails(card([uploadItem(0, source)])), message, what);
    assert.deepEqual(
      calls().filter((call) => call !== "put"),
      ["open", "release"],
      what,
    );
  }
});

test("a staged copy that is gone, changed or grown is refused after open, released, never applied", async () => {
  const cases: [string, (source: Source) => void][] = [
    ["gone", (source) => rmSync(source.path)],
    [
      "changed",
      (source) =>
        writeFileSync(source.path, bytesOf(source.bytes.byteLength, 99)),
    ],
    [
      "grown",
      (source) =>
        writeFileSync(
          source.path,
          Buffer.concat([source.bytes, Buffer.from("!")]),
        ),
    ],
    [
      "shrunk",
      (source) => writeFileSync(source.path, source.bytes.subarray(1)),
    ],
  ];
  for (const [what, alter] of cases) {
    events = [];
    const source = staged(`${what}.bin`, bytesOf(MIB + 7, 6));
    const target = card([uploadItem(0, source)]);
    alter(source);
    assert.equal(
      await fails(target),
      UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
      what,
    );
    const seen = calls();
    assert.equal(seen[0], "open", what);
    assert.equal(seen.at(-1), "release", what);
    assert.ok(!seen.includes("apply"), what);
    // A grown copy sends only bytes within the approved size.
    for (const event of events)
      if (event.call === "put")
        assert.ok(event.offset + event.length <= MIB + 7, what);
    // A same-size change is caught by the digest before the final put, so
    // the edge never answers for it (F006, requester ruling k1dz2xl1 #2).
    if (what === "changed")
      assert.deepEqual(
        events.flatMap((event) =>
          event.call === "put" ? [event.offset + event.length] : [],
        ),
        [MIB],
        what,
      );
  }
});

test("a card whose sources disagree or exceed 100 MiB is refused before open", async () => {
  const source = staged("a.bin", bytesOf(5, 7));
  assert.equal(
    await fails(
      card([uploadItem(0, source), uploadItem(1, source, { size: 6 })]),
    ),
    UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
  );
  assert.equal(
    await fails(
      card([
        uploadItem(0, source, { size: 60 * MIB }),
        uploadItem(1, source, { size: 60 * MIB }),
      ]),
    ),
    UPLOAD_TOO_LARGE_NOTHING_WRITTEN,
  );
  assert.deepEqual(events, []);
});

test("a toggle off, a lost listing, a dropped link or a mode switch during a put: released, never applied", async () => {
  const cases: [string, () => void, string][] = [
    ["toggle", () => updateConfluenceSettings({ enabled: false }), DISABLED],
    ["listing", () => applyListing(acceptRemoteTools([])), NOT_OFFERED],
    ["link", () => markDisconnected(), UNREACHABLE],
    [
      "mode switch",
      () => {
        // Another connected link: the upload's connection is not it.
        uninstall();
        uninstall = installRemoteToolPort(port());
        applyListing(acceptRemoteTools(LISTING));
      },
      NOT_CLIENT_MODE,
    ],
    [
      "local mode",
      () => {
        uninstall();
        uninstall = () => {};
      },
      NOT_CLIENT_MODE,
    ],
  ];
  for (const [what, change, message] of cases) {
    uninstall();
    uninstall = installRemoteToolPort(port());
    updateConfluenceSettings({ enabled: true });
    applyListing(acceptRemoteTools(LISTING));
    events = [];
    const source = staged(`${what}.bin`, bytesOf(2 * MIB, 8));
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    // The first put waits until the route changed, then answers truly.
    onPut = (n) =>
      n === 1
        ? (blocked.then(() => ({
            ok: true as const,
            received: MIB,
            streamComplete: false,
            sealed: false,
          })) as ReturnType<RemoteUploadPort["put"]>)
        : undefined;
    const pending = fails(card([uploadItem(0, source)]));
    await vi.waitFor(() => assert.equal(calls().at(-1), "put"));
    change();
    unblock();
    assert.equal(await pending, message, what);
    assert.ok(!calls().includes("apply"), what);
    assert.equal(calls().at(-1), "release", what);
    // The release went to the connection the upload was opened on.
    assert.deepEqual(events.at(-1), { call: "release", uploadId: "upl-1" });
  }
});

// --- after the apply attempt: nothing released, the upload's text ----------

test("an apply lost, timed out or undecodable after dispatch says an upload may still finish; nothing is released (AC9)", async () => {
  for (const outcome of ["lost", "timeout", "undecodable"] as const) {
    events = [];
    const source = staged(`${outcome}.bin`, bytesOf(5, 9));
    onApply = () => Promise.resolve({ outcome });
    assert.equal(
      await fails(card([uploadItem(0, source)])),
      MAY_HAVE_WRITTEN_UPLOAD,
      outcome,
    );
    assert.deepEqual(calls(), ["open", "put", "apply"], outcome);
  }
});

test("an answer that confirms nothing says the upload's text; one that certifies nothing written does not", async () => {
  const source = staged("a.bin", bytesOf(5, 10));
  onApply = () =>
    Promise.resolve({
      outcome: "answer",
      answer: {
        ok: true,
        results: [{ effects: "bogus" }],
        effects: "possible",
      },
    } as never);
  assert.equal(
    await fails(card([uploadItem(0, source)])),
    MAY_HAVE_WRITTEN_UPLOAD,
  );
  events = [];
  onApply = () =>
    Promise.resolve({
      outcome: "answer",
      answer: {
        ok: false,
        code: "tool_error",
        message: "The upload is no longer available.",
        effects: "none",
      },
    } as never);
  assert.equal(
    await fails(card([uploadItem(0, source)])),
    "The upload is no longer available. Nothing was written.",
  );
  assert.ok(!calls().includes("release"));
});
