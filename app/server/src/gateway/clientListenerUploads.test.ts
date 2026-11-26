/**
 * The edge's upload store through the real client listener, in process
 * (Task-1441 P8a): v04 V3's in-PR test (100 pipelined `uploads.put` of a
 * 100 MiB upload: one allocation, answers in order, nothing retained after
 * release or apply), v05 W3 / v06 X1's retention of the edge store on the
 * paths applied, released, connection ended and refused, and v05 W1's permit
 * test with a fake Atlassian answering early (b) and pausing (d).
 *
 * Retention roles (v06 X2): the raw client's 100 MiB source is the pinned
 * baseline allocation, read in an assertion after the final sample; the
 * edge store's backing `ArrayBuffer` is the target, held only through a
 * `WeakRef` made from `probeUploadAllocations().takeBuffer()`. The X1 control
 * runs first; without it passing, the retention assertions here prove
 * nothing. Every value is fake; no request leaves the process.
 */
import { createHash, generateKeyPairSync, randomFillSync } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import https from "node:https";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, expect, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { BODY_NOT_COMPLETED } from "../confluenceAttachmentChange.ts";
import { encodeAtlassianCredential } from "../gatewayTools/atlassian.ts";
import { FILE_BUSY, createFileBudget } from "../gatewayTools/host.ts";
import { createEdgeTools } from "../gatewayTools/index.ts";
import { ITEMS_INVALID } from "../gatewayTools/twoPhase.ts";
import {
  UPLOAD_BUSY,
  probeUploadAllocations,
  uploadApplyDeadlineMs,
} from "../gatewayTools/uploads.ts";
import { WRITE_DEADLINE_MS } from "../gatewayTools/writeCall.ts";
import {
  fakeConfluenceAnswer,
  type SeenConfluenceWrite,
} from "../test/confluenceMutateFetch.ts";
import {
  MIB,
  retentionControl,
  settleGc,
  settledArrayBuffers,
} from "../test/forcedGc.ts";
import { WorkerConnection } from "../workerProtocol/connection.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import {
  CLIENT_METHODS,
  GATEWAY_CLIENT_PROTOCOL,
  encodeClientMessage,
} from "./clientMethods.ts";
import { startClientListener } from "./clientListener.ts";
import type { EdgeTools } from "./edgeTools.ts";
import { LeaseTable } from "./leases.ts";
import { ProfileRegistry } from "./profiles.ts";
import type { VaultPort } from "./vaultPort.ts";

/** Captured before any test fakes timers: the waits below stay real. */
const realSetTimeout = setTimeout;
const CREDENTIAL = encodeAtlassianCredential({
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-P8A-TOKEN-0123456789",
});
const CONFLUENCE = "confluence_mutate_page";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const open: { close(): unknown }[] = [];
const probes: { disarm(): void }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  while (probes.length) probes.pop()!.disarm();
  while (open.length) await open.pop()!.close();
});

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
}

// --- the listener, a vault holding u1's credential, enrolled clients ---

function counting() {
  const inner = createFileBudget();
  const budget = {
    releases: 0,
    reserve(bytes: number) {
      const release = inner.reserve(bytes);
      return release
        ? () => {
            budget.releases += 1;
            release();
          }
        : undefined;
    },
    get reserved() {
      return inner.reserved;
    },
  };
  return budget;
}

const vault = {
  login: () => undefined,
  newTokenFile: () => {
    throw new Error("no token files here");
  },
  discardCredential: () => {},
  integrationGet: () => Promise.resolve({ ok: true, credential: CREDENTIAL }),
  integrationPut: () => Promise.resolve({ ok: true }),
  integrationClear: () => Promise.resolve({ ok: true }),
  integrationConnect: () => Promise.resolve({ ok: false }),
} as unknown as VaultPort;

type Edge = Awaited<ReturnType<typeof startClientListener>>;

/**
 * The listener over the real edge tools, sharing one counted budget. While
 * `gate.hold` is set, an upload apply's output hold is kept until the test
 * runs `gate.release()`: the answer left, the hold not yet settled.
 */
async function uploadEdge() {
  const budget = counting();
  const set = createEdgeTools({
    log: () => {},
    atlassianScopes: [],
    fileBudget: budget,
  });
  const gate = {
    hold: false,
    held: [] as (() => void)[],
    release: () => gate.held.splice(0).forEach((settle) => settle()),
  };
  const host: typeof set.host = {
    ...set.host,
    apply: (name, request, caller, options) =>
      set.host.apply(
        name,
        request,
        gate.hold && caller.onSettled
          ? {
              ...caller,
              onSettled: (settle) =>
                caller.onSettled!(() => gate.held.push(settle)),
            }
          : caller,
        options,
      ),
  };
  const tools: EdgeTools = { ...set, host };
  await mkdir(DATA_DIR, { recursive: true });
  const edge = await startClientListener(
    {
      stateDir: await mkdtemp(join(DATA_DIR, "client-uploads-")),
      leases: new LeaseTable(),
      profiles: new ProfileRegistry(),
      needsLogin: () => [],
      forwarder: () => ({
        handleRequest: (_req, res) => res.end(),
        observeLocal: () => ({ refuse: () => {} }),
        refuseConnect: (_req, socket) => socket.destroy(),
      }),
      log: () => {},
      vault,
      tools,
    },
    {},
  );
  open.push(edge);
  edge.registry.addUser("u1");
  return { edge, budget, gate };
}

async function enroll(edge: Edge) {
  const code = edge.registry.createCode("u1", "test");
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
  const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: edge.enrollPort,
        ca: edge.caPem,
        method: "POST",
        path: "/enroll",
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve(
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >,
          ),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify({ code, publicKeyPem }));
  });
  return {
    key: pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: body.certificatePem as string,
  };
}

async function dial(edge: Edge): Promise<WorkerConnection> {
  const identity = await enroll(edge);
  const socket = tls.connect({
    host: "127.0.0.1",
    port: edge.clientPort,
    ca: edge.caPem,
    key: identity.key,
    cert: identity.cert,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  const connection = new WorkerConnection(socketEndpoint(socket), {
    handshake: { role: "worker", workerId: "test-client" },
    protocol: GATEWAY_CLIENT_PROTOCOL,
  });
  open.push({ close: () => connection.end("test done") });
  return connection;
}

const call = async (
  connection: WorkerConnection,
  method: string,
  json: object,
) => (await connection.request(method, encodeClientMessage(json))).json;

// --- the fake Atlassian ---

type Peer = "drain" | "early200" | "paused";

/**
 * Stubs `fetch` as the Confluence site. An upload POST meets `peer`: `drain`
 * reads the whole body before the site answers; `early200` reads 1 MiB, waits
 * for `answerEarly`, then answers 200 and never reads on; `paused` never
 * reads or answers and rejects only on its signal's abort.
 */
function fakeAtlassian(peer: Peer) {
  const site = {
    uploadPosts: 0,
    drained: 0,
    requests: 0,
    answerEarly: () => {},
  };
  const early = new Promise<void>((resolve) => {
    site.answerEarly = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      site.requests += 1;
      const url = new URL(String(input));
      const seen = {
        url,
        method: init?.method ?? "GET",
        path: url.pathname.replace(/^\/ex\/confluence\/[^/]+/, ""),
        query: Object.fromEntries(url.searchParams),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        signal: init?.signal ?? undefined,
      } satisfies SeenConfluenceWrite;
      const body = init?.body;
      if (body instanceof ReadableStream) {
        site.uploadPosts += 1;
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        if (peer === "paused")
          return new Promise<Response>((_resolve, reject) => {
            const signal = init!.signal!;
            const aborted = () =>
              reject(
                new DOMException("The request was aborted.", "AbortError"),
              );
            if (signal.aborted) aborted();
            signal.addEventListener("abort", aborted, { once: true });
          });
        const limit = peer === "early200" ? MIB : Infinity;
        while (site.drained < limit) {
          const { done, value } = await reader.read();
          if (done) break;
          site.drained += value.byteLength;
        }
        if (peer === "early200") await early;
      }
      return fakeConfluenceAnswer(seen);
    }),
  );
  return site;
}

// --- uploads through the listener ---

const STAGE = "STAGE-SENTINEL-1";

function entry(stagedAttachmentId: string, name: string, bytes: Uint8Array) {
  return {
    stagedAttachmentId,
    name,
    mimeType: "image/png",
    size: bytes.byteLength,
    sha256: sha(bytes),
    source: `/SOURCE-SENTINEL/${name}`,
  };
}

/** Prepares an upload item per entry on page 123; the proposal's site and items. */
async function prepare(
  connection: WorkerConnection,
  entries: ReturnType<typeof entry>[],
) {
  const answer = (await call(connection, CLIENT_METHODS.toolsPrepare, {
    name: CONFLUENCE,
    args: {
      items: entries.map((each) => ({
        operation: "uploadAttachment",
        page: "123",
        sourceAttachmentId: each.stagedAttachmentId,
      })),
    },
    uploads: entries,
  })) as { ok: boolean; site: string; items: unknown[]; message?: string };
  expect(answer.ok, answer.message).toBe(true);
  return { site: answer.site, items: answer.items };
}

async function openUpload(
  connection: WorkerConnection,
  entries: ReturnType<typeof entry>[],
): Promise<string> {
  const opened = (await call(connection, CLIENT_METHODS.uploadsOpen, {
    streams: entries.map(({ stagedAttachmentId, size, sha256 }) => ({
      stagedAttachmentId,
      size,
      sha256,
    })),
    work: entries.reduce((sum, each) => sum + each.size, 0),
  })) as { ok: boolean; uploadId?: string; message?: string };
  expect(opened.ok, opened.message).toBe(true);
  return opened.uploadId!;
}

/** Sends `bytes` as 1 MiB puts, each awaited. */
async function putAll(
  connection: WorkerConnection,
  uploadId: string,
  stagedAttachmentId: string,
  bytes: Uint8Array,
): Promise<unknown> {
  let last: unknown;
  for (let offset = 0; offset < bytes.byteLength; offset += MIB)
    last = (
      await connection.request(CLIENT_METHODS.uploadsPut, {
        json: { uploadId, stagedAttachmentId, offset },
        bytes: { chunk: bytes.subarray(offset, offset + MIB) },
      })
    ).json;
  return last;
}

/** The store's newest stream buffer, as a `WeakRef` only. */
function weakStore(
  probe: ReturnType<typeof probeUploadAllocations>,
): WeakRef<ArrayBuffer> {
  const buffer = probe.takeBuffer();
  if (!buffer) throw new Error("the store allocated nothing");
  return new WeakRef(buffer);
}

/**
 * Whether the target is gone. A boolean, so a failure never pretty-prints a
 * 100 MiB buffer into the diff.
 */
const collected = (target: WeakRef<ArrayBuffer>): boolean =>
  target.deref() === undefined;

function armProbe() {
  const probe = probeUploadAllocations();
  probes.push(probe);
  return probe;
}

/** A busy edge: a download answers FILE_BUSY and an open UPLOAD_BUSY. */
async function expectBusy(
  connection: WorkerConnection,
  site: { requests: number },
) {
  const before = site.requests;
  expect(
    await call(connection, CLIENT_METHODS.toolsCall, {
      name: "confluence_download_attachment",
      args: { attachmentId: "att101" },
    }),
  ).toEqual({ ok: false, code: "tool_error", message: FILE_BUSY });
  expect(
    await call(connection, CLIENT_METHODS.uploadsOpen, {
      streams: [{ stagedAttachmentId: "x", size: 1, sha256: "a".repeat(64) }],
      work: 1,
    }),
  ).toEqual({ ok: false, code: "tool_error", message: UPLOAD_BUSY });
  expect(site.requests, "nothing reached the site for a busy call").toBe(
    before,
  );
}

/** The first open after the permit came back is admitted, then let go. */
async function expectAdmitted(connection: WorkerConnection) {
  const uploadId = await openUpload(connection, [
    entry("x", "x.png", new Uint8Array([1])),
  ]);
  expect(
    await call(connection, CLIENT_METHODS.uploadsRelease, { uploadId }),
  ).toEqual({ ok: true });
}

test("control: a retained 1-byte view is seen, and dropping it clears both oracles (X1)", async () => {
  const control = await retentionControl();
  expect(control.retainedVisible).toBe(true);
  expect(control.retainedArrayBuffers).toBeGreaterThanOrEqual(90 * MIB);
  expect(control.clearedAfterDrop).toBe(true);
  expect(control.arrayBuffersAfterDrop).toBeLessThanOrEqual(2 * MIB);
});

/**
 * V3 asks 100 MiB for release and apply; the X1-only paths (ended, refused)
 * run the same sequence at 16 MiB to keep the file's runtime in proportion.
 */
test.each([
  { ending: "released", size: 100 * MIB },
  { ending: "applied", size: 100 * MIB },
  { ending: "connection ended", size: 16 * MIB },
  { ending: "refused", size: 16 * MIB },
] as const)(
  "V3 in-PR test, $ending: pipelined 1 MiB puts of $size bytes, one store allocation, answers in order, nothing retained",
  async ({ ending, size }) => {
    const PUTS = size / MIB;
    const { edge, budget } = await uploadEdge();
    const connection = await dial(edge);
    const site = fakeAtlassian("drain");
    // The pinned baseline allocation: the raw client's source.
    let source: Uint8Array | undefined = randomFillSync(new Uint8Array(size));
    const first = source[0];
    const meta = entry(STAGE, "chart.png", source);
    const proposal = await prepare(connection, [meta]);
    const probe = armProbe();
    const baseline = await settledArrayBuffers();

    const uploadId = await openUpload(connection, [meta]);
    const order: number[] = [];
    const answers = await Promise.all(
      Array.from({ length: PUTS }, (_, index) =>
        connection
          .request(CLIENT_METHODS.uploadsPut, {
            json: { uploadId, stagedAttachmentId: STAGE, offset: index * MIB },
            bytes: {
              chunk: source!.subarray(index * MIB, (index + 1) * MIB),
            },
          })
          .then((answer) => {
            order.push(index);
            return answer.json;
          }),
      ),
    );
    expect(order).toEqual(Array.from({ length: PUTS }, (_, index) => index));
    answers.forEach((answer, index) =>
      expect(answer).toEqual({
        ok: true,
        received: (index + 1) * MIB,
        streamComplete: index === PUTS - 1,
        sealed: index === PUTS - 1,
      }),
    );
    expect(probe.allocations).toBe(1);
    const target = weakStore(probe);
    expect(budget.reserved).toBeGreaterThan(0);

    const before = site.requests;
    if (ending === "released")
      expect(
        await call(connection, CLIENT_METHODS.uploadsRelease, { uploadId }),
      ).toEqual({ ok: true });
    if (ending === "applied") {
      expect(
        await call(connection, CLIENT_METHODS.toolsApply, {
          name: CONFLUENCE,
          ...proposal,
          uploadId,
        }),
      ).toMatchObject({ ok: true, effects: "possible" });
      expect(site.uploadPosts).toBe(1);
      expect(site.drained).toBeGreaterThan(size);
    }
    if (ending === "connection ended") connection.end("test");
    if (ending === "refused") {
      const items = structuredClone(proposal.items) as {
        attachment: { sha256: string };
      }[];
      items[0]!.attachment.sha256 = "0".repeat(64);
      expect(
        await call(connection, CLIENT_METHODS.toolsApply, {
          name: CONFLUENCE,
          site: proposal.site,
          items,
          uploadId,
        }),
      ).toEqual({
        ok: false,
        code: "invalid_params",
        message: ITEMS_INVALID,
        effects: "none",
      });
      expect(site.requests).toBe(before);
    }
    await waitFor(() => budget.reserved === 0);
    expect(budget.releases).toBe(1);

    await settleGc();
    expect(collected(target), "the edge store was collected").toBe(true);
    const delta = (await settledArrayBuffers()) - baseline;
    expect(delta).toBeLessThanOrEqual(2 * MIB);
    // The baseline allocation stayed live through the final sample.
    expect([source[0], source.byteLength]).toEqual([first, size]);
    source = undefined;
  },
  60_000,
);

test("W1 permit test (b): an early 200 holds the permit until the execution and the answer's output have both settled; released once", async () => {
  const { edge, budget, gate } = await uploadEdge();
  const owner = await dial(edge);
  const other = await dial(edge);
  const site = fakeAtlassian("early200");
  const bytes = randomFillSync(new Uint8Array(4 * MIB));
  const meta = entry(STAGE, "chart.png", bytes);
  const proposal = await prepare(owner, [meta]);
  const probe = armProbe();
  const baseline = await settledArrayBuffers();

  const uploadId = await openUpload(owner, [meta]);
  expect(await putAll(owner, uploadId, STAGE, bytes)).toMatchObject({
    sealed: true,
  });
  const target = weakStore(probe);
  await expectBusy(other, site);

  gate.hold = true;
  const applied = call(owner, CLIENT_METHODS.toolsApply, {
    name: CONFLUENCE,
    ...proposal,
    uploadId,
  });
  // Executing: the site has 1 MiB and has not answered.
  await waitFor(() => site.drained >= MIB);
  await expectBusy(other, site);
  site.answerEarly();
  const answer = await applied;
  // An item-level failure (W2): its record carries the fixed text.
  expect(answer).toMatchObject({ ok: true, effects: "possible" });
  expect(JSON.stringify(answer)).toContain(BODY_NOT_COMPLETED);
  expect(site.uploadPosts).toBe(1);
  // Executed and answered, the output hold not yet settled.
  await waitFor(() => gate.held.length === 1);
  await expectBusy(other, site);
  expect(budget.releases).toBe(0);
  gate.release();
  await waitFor(() => budget.reserved === 0);
  expect(budget.releases).toBe(1);
  await expectAdmitted(other);
  expect(budget.releases).toBe(2);

  await settleGc();
  expect(collected(target), "the edge store was collected").toBe(true);
  expect((await settledArrayBuffers()) - baseline).toBeLessThanOrEqual(2 * MIB);
  expect(bytes.byteLength).toBe(4 * MIB);
}, 30_000);

test("W1 permit test (d): a paused peer gets one POST, item 2 never starts, and the permit goes once, after both holds", async () => {
  const { edge, budget, gate } = await uploadEdge();
  const owner = await dial(edge);
  const other = await dial(edge);
  const site = fakeAtlassian("paused");
  const one = randomFillSync(new Uint8Array(2 * MIB));
  const two = randomFillSync(new Uint8Array(2 * MIB));
  const metas = [
    entry(STAGE, "chart.png", one),
    entry("stage-2", "b.png", two),
  ];
  const proposal = await prepare(owner, metas);
  const probe = armProbe();
  const baseline = await settledArrayBuffers();

  const uploadId = await openUpload(owner, metas);
  await putAll(owner, uploadId, STAGE, one);
  const firstStore = weakStore(probe);
  expect(await putAll(owner, uploadId, "stage-2", two)).toMatchObject({
    sealed: true,
  });
  const secondStore = weakStore(probe);
  expect(probe.allocations).toBe(2);

  // The apply's deadline runs on a fake clock; the sockets stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  gate.hold = true;
  const applied = call(owner, CLIENT_METHODS.toolsApply, {
    name: CONFLUENCE,
    ...proposal,
    uploadId,
  });
  await waitFor(() => site.uploadPosts === 1);
  await expectBusy(other, site);
  await vi.advanceTimersByTimeAsync(
    uploadApplyDeadlineMs(4 * MIB, WRITE_DEADLINE_MS) + 1_000,
  );
  const answer = await applied;
  vi.useRealTimers();
  expect(answer).toMatchObject({ ok: false, code: "timeout" });
  expect(site.uploadPosts, "item 2 never started").toBe(1);
  await waitFor(() => gate.held.length === 1);
  await expectBusy(other, site);
  expect(budget.releases).toBe(0);
  gate.release();
  await waitFor(() => budget.reserved === 0);
  expect(budget.releases).toBe(1);
  await expectAdmitted(other);

  await settleGc();
  expect(collected(firstStore), "stream 1 was collected").toBe(true);
  expect(collected(secondStore), "stream 2 was collected").toBe(true);
  expect((await settledArrayBuffers()) - baseline).toBeLessThanOrEqual(2 * MIB);
  expect([one.byteLength, two.byteLength]).toEqual([2 * MIB, 2 * MIB]);
}, 30_000);
