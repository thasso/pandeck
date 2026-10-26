import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import { DATA_DIR } from "./config.ts";
import { handleDirectFileRequest } from "./directFileHttp.ts";
import { resetFileGrantsForTest } from "./directFileGrants.ts";
import { mintDocumentTargetGrant } from "./documentGrantTargets.ts";
import {
  failFileForTests,
  fileReadsCountsForTests,
  holdFileForTests,
  openFile,
} from "./fileReads.ts";
import {
  openServedFile,
  statServedFile,
  type ServedFileHandle,
} from "./servedFileAccess.ts";
import { updateSettings } from "./settings.ts";
import { showFilesTool } from "./tools/core/showFilesTool.ts";
import type { ToolCallContext } from "./mcp/tool.ts";
import { MAX_FRAME_PAYLOAD_BYTES } from "./workerProtocol/codec.ts";
import { FILE_METHODS } from "./workerProtocol/fileMethods.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerEpochForTests,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerServedForTests,
  inProcessWorkerServedMethodForTests,
  writeAsInProcessWorkerForTests,
} from "./workers/inProcessWorker.ts";

const CHUNK = MAX_FRAME_PAYLOAD_BYTES;
const INVALID_FRAME = new Uint8Array(8);

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "served-file-access-"));
});
afterAll(() => {
  resetFileGrantsForTest();
  rmSync(dir, { recursive: true, force: true });
});

/** Nothing is held: no handle in the table, no descriptor open anywhere. */
function assertNothingLeaked(): void {
  assert.equal(inProcessWorkerFileHandlesForTests(), 0, "handles held");
  assert.equal(
    fileReadsCountsForTests().liveDescriptors,
    0,
    "descriptors open",
  );
}

afterEach(assertNothingLeaked);

/** Bytes that are every value, in a fixed order, and not UTF-8. */
function binary(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let at = 0; at < size; at += 1) bytes[at] = (at * 151 + 7) & 0xff;
  return bytes;
}

function fixture(name: string, bytes: Buffer, root = dir): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Let in-process deliveries and filesystem callbacks run. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1)
    await new Promise<void>((done) => setImmediate(done));
}

describe("where a served file is read", () => {
  test("a path outside DATA_DIR and the Knowledge Base is read by the Worker", async () => {
    const path = fixture("outside.bin", binary(3000));
    const before = inProcessWorkerServedForTests();
    assert.equal((await statServedFile(path)).size, 3000);
    const file = await openServedFile(path, { stat: false });
    try {
      assert.ok(
        (await drain(file.createReadStream({ start: 0, end: 2999 }))).equals(
          binary(3000),
        ),
      );
    } finally {
      await file.close();
    }
    assert.ok(inProcessWorkerServedForTests() - before >= 4);

    const ctx = { session: { cwd: dir } } as unknown as ToolCallContext;
    const shown = inProcessWorkerServedForTests();
    await showFilesTool.execute({ paths: [path] }, ctx);
    assert.equal(inProcessWorkerServedForTests() - shown, 1, "show_files stat");
  });

  test("DATA_DIR, a custom Knowledge Base and every artifact are read on the server", async () => {
    const data = fixture("local.bin", binary(10), join(DATA_DIR, "served"));
    const kb = join(dir, "custom-kb");
    const note = fixture("note.md", Buffer.from("# note\n"), kb);
    updateSettings({
      knowledgeBase: { enabled: true, path: kb, effectivePath: "ignored" },
    });
    const ctx = { session: { cwd: dir } } as unknown as ToolCallContext;
    const artifacts = join(DATA_DIR, "session-artifacts", "s-local");
    fixture("shot.png", binary(12), artifacts);
    const injected = join(dir, "injected-data");
    fixture(
      "page.html",
      Buffer.from("<h1>x</h1>"),
      join(injected, "session-artifacts", "s-injected"),
    );

    const before = inProcessWorkerServedForTests();
    for (const path of [data, note]) {
      assert.equal((await statServedFile(path)).isFile, true);
      const file = await openServedFile(path, { stat: true });
      assert.equal((await file.stat()).isFile, true);
      await file.close();
    }
    await showFilesTool.execute(
      { paths: ["/api/session-artifacts/s-local/shot.png"] },
      ctx,
    );
    // An artifact is server data by kind, even where its root is not DATA_DIR.
    await mintDocumentTargetGrant(
      {
        target: {
          kind: "sessionArtifact",
          sessionId: "s-injected",
          path: "page.html",
        },
        scope: "file",
        delivery: "inline",
      },
      { dataDir: injected, resolveWorktree: async () => undefined },
    );
    assert.equal(inProcessWorkerServedForTests(), before);
  });
});

describe("streaming pulls one chunk at a time", () => {
  test("an unread stream holds one chunk and one read at most", async () => {
    const path = fixture("sixteen.bin", binary(16 * CHUNK));
    const file = await openServedFile(path, { stat: false });
    try {
      const reads = () =>
        inProcessWorkerServedMethodForTests(FILE_METHODS.read);
      const before = reads();
      const stream = file.createReadStream({ start: 0, end: 16 * CHUNK - 1 });
      stream.pause();
      stream.read(0);
      await once(stream, "readable");
      // Time enough for any read beyond the first to be issued and answered.
      await settle();
      assert.equal(reads() - before, 1);
      assert.ok(stream.readableLength <= CHUNK);
      for (let taken = 1; taken <= 3; taken += 1) {
        assert.ok(stream.read() !== null, "a chunk was ready");
        await once(stream, "readable");
        await settle();
        assert.equal(reads() - before, taken + 1, "one read per chunk taken");
        assert.ok(stream.readableLength <= CHUNK);
      }
      stream.destroy();
    } finally {
      await file.close();
    }
  });

  test("a stream asks its caller before each read, and reads nothing once it is gone", async () => {
    const path = fixture("asked.bin", binary(4 * CHUNK));
    const file = await openServedFile(path, { stat: false });
    try {
      const reads = () =>
        inProcessWorkerServedMethodForTests(FILE_METHODS.read);
      const before = reads();
      let asked = 0;
      let gone = false;
      const stream = file.createReadStream(
        { start: 0, end: 4 * CHUNK - 1 },
        {
          get aborted() {
            asked += 1;
            return gone;
          },
        },
      );
      stream.pause();
      stream.read(0);
      await once(stream, "readable");
      await settle();
      assert.equal(reads() - before, 1);
      assert.equal(asked, 1, "asked before the first read");
      gone = true;
      // Taking the buffered chunk makes room for the next read.
      stream.read();
      await settle();
      assert.equal(asked, 2, "asked before the next read");
      assert.equal(stream.destroyed, true);
      assert.equal(reads() - before, 1, "no read once the caller is gone");
    } finally {
      await file.close();
    }
  });

  test("a paused, then draining client gets every byte with no extra reads", async () => {
    const size = 64 * CHUNK;
    const bytes = binary(size);
    const path = fixture("sixty-four.bin", bytes);
    const server: Server = createServer((req, res) => {
      void handleDirectFileRequest(
        req,
        res,
        new URL(req.url ?? "/", "http://127.0.0.1"),
        {},
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const before = inProcessWorkerServedMethodForTests(FILE_METHODS.read);
    try {
      const body = await new Promise<Buffer>((done, fail) => {
        const chunks: Buffer[] = [];
        let paused = false;
        const socket = connect(port, "127.0.0.1", () =>
          socket.write(
            `GET /api/files${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
          ),
        );
        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          if (paused) return;
          paused = true;
          socket.pause();
          // Paused long enough for every buffer between here and the file to
          // fill; then drain.
          void settle(50).then(() => socket.resume());
        });
        socket.on("error", fail);
        socket.on("close", () => {
          const all = Buffer.concat(chunks);
          done(all.subarray(all.indexOf("\r\n\r\n") + 4));
        });
      });
      assert.equal(sha256(body), sha256(bytes));
      const reads =
        inProcessWorkerServedMethodForTests(FILE_METHODS.read) - before;
      assert.ok(reads <= Math.ceil(size / CHUNK) + 1, `${reads} reads`);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("handles belong to the connection that opened them", () => {
  test("a handle from an ended connection never reaches its replacement", async () => {
    const a = fixture("a.bin", binary(3 * CHUNK));
    const bBytes = Buffer.from(binary(2 * CHUNK + 5).reverse());
    const b = fixture("b.bin", bBytes);
    const fileA = await openServedFile(a, { stat: false });
    const streamA = fileA.createReadStream({ start: 0, end: 3 * CHUNK - 1 });
    streamA.pause();
    streamA.read(0);
    await once(streamA, "readable");

    // An open held on the old connection settles only once that Worker is
    // quiescent: its handles swept, its descriptors closed.
    const probe = fixture("quiescence-probe.bin", binary(10));
    const connection = ensureInProcessWorker();
    const held = holdFileForTests(probe, "after-open");
    const swept = openServedFile(probe, { stat: false }).catch(
      (error: Error) => error,
    );
    await held.reached;
    const oldEpoch = inProcessWorkerEpochForTests();
    writeAsInProcessWorkerForTests(INVALID_FRAME);
    await connection.ended;
    held.release();
    assert.match(String(await swept), /The Worker connection ended/);
    assert.equal(fileReadsCountsForTests().liveDescriptors, 0);
    streamA.destroy();

    const fileB = await openServedFile(b, { stat: false });
    assert.notEqual(inProcessWorkerEpochForTests(), oldEpoch);
    const counts = () =>
      [FILE_METHODS.read, FILE_METHODS.close].map((method) =>
        inProcessWorkerServedMethodForTests(method),
      );
    const before = counts();
    await assert.rejects(
      fileA.createReadStream({ start: 0, end: 10 }).toArray(),
      /The Worker connection ended/,
    );
    await fileA.close();
    assert.deepEqual(counts(), before, "nothing reached the new connection");
    assert.equal(inProcessWorkerFileHandlesForTests(), 1);
    assert.equal(fileReadsCountsForTests().liveDescriptors, 1);
    try {
      const body = await drain(
        fileB.createReadStream({ start: 0, end: bBytes.byteLength - 1 }),
      );
      assert.ok(body.equals(bBytes));
    } finally {
      await fileB.close();
    }
  });
});

describe("an open abandoned mid-flight leaves nothing open", () => {
  test("an open whose caller gave up closes its late handle", async () => {
    const path = fixture("late.bin", binary(100));
    const connection = ensureInProcessWorker();
    const held = holdFileForTests(path, "after-open");
    const gone = new AbortController();
    const opening = openServedFile(path, {
      stat: false,
      signal: gone.signal,
    }).catch((error: Error) => error);
    await held.reached;
    gone.abort();
    held.release();
    await held.disposed;
    const settled = await opening;
    assert.equal((settled as Error).name, "AbortError");
    assertNothingLeaked();
    assert.equal(connection.isEnded, false);
    const file: ServedFileHandle = await openServedFile(path, { stat: false });
    assert.equal(
      (await drain(file.createReadStream({ start: 0, end: 99 }))).byteLength,
      100,
    );
    await file.close();
  });

  test("a server-side open whose caller gave up closes its descriptor", async () => {
    const path = fixture("late.bin", binary(10), join(DATA_DIR, "served"));
    const held = holdFileForTests(path, "after-open");
    const gone = new AbortController();
    const opening = openServedFile(path, {
      stat: true,
      signal: gone.signal,
    }).catch((error: Error) => error);
    await held.reached;
    gone.abort();
    held.release();
    await held.disposed;
    assert.equal(((await opening) as Error).name, "AbortError");
  });

  test("a failed descriptor stat has closed its descriptor before answering", async () => {
    const path = fixture("stat-fails.bin", binary(10));
    failFileForTests(path, { phase: "stat", code: "EIO" });
    const outcome = await openFile(path, { stat: true }, (result) => ({
      result,
      live: fileReadsCountsForTests().liveDescriptors,
    }));
    assert.ok("error" in outcome.result);
    assert.equal(outcome.result.phase, "stat");
    assert.equal(outcome.live, 0);
  });

  test("an open finishing after its connection ended is closed by the Worker", async () => {
    const path = fixture("ending.bin", binary(10));
    const connection = ensureInProcessWorker();
    const held = holdFileForTests(path, "after-open");
    const opening = openServedFile(path, { stat: false }).catch(
      (error: Error) => error,
    );
    await held.reached;
    writeAsInProcessWorkerForTests(INVALID_FRAME);
    await connection.ended;
    held.release();
    await held.disposed;
    assert.match(String(await opening), /The Worker connection ended/);
  });
});
