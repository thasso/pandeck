import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDirectFileRequest } from "../app/server/src/directFileHttp.ts";
import {
  handleFileGrantRequest,
  mintDocumentGrant,
} from "../app/server/src/directFileGrants.ts";
import {
  fileReadsCountsForTests,
  holdFileForTests,
} from "../app/server/src/fileReads.ts";
import { openServedFile } from "../app/server/src/servedFileAccess.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerServedMethodForTests,
  writeAsInProcessWorkerForTests,
} from "../app/server/src/workers/inProcessWorker.ts";

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${what}`);
    await delay(10);
  }
}

/** Real HTTP, real codec and a native FIFO open. Also bundled in the Nix Bun check. */
export async function checkWorkerFileOpenEnd(
  routes: readonly ("direct" | "grant")[] = ["direct", "grant"],
): Promise<void> {
  for (const route of routes) {
    const dir = mkdtempSync(join(tmpdir(), `worker-open-end-${route}-`));
    const path = join(dir, "swapped.bin");
    const other = join(dir, "other.bin");
    const unrelated = join(dir, "unrelated.bin");
    writeFileSync(path, "regular during lookup");
    writeFileSync(other, "replacement bytes");
    writeFileSync(unrelated, "unrelated");
    const url =
      route === "direct"
        ? `/api/files${path}`
        : (await mintDocumentGrant(path, "file", "inline")).url;
    const barrier = holdFileForTests(path, "before-open");
    const pending = holdFileForTests(unrelated, "after-open");
    const old = ensureInProcessWorker();
    const held = await openServedFile(other, { stat: false });
    let handled: Promise<unknown> | undefined;
    let closed: Promise<void> | undefined;
    const server = createServer((req, res) => {
      closed = new Promise((resolve) => res.once("close", resolve));
      const requestUrl = new URL(req.url!, "http://localhost");
      handled =
        route === "direct"
          ? handleDirectFileRequest(req, res, requestUrl, {})
          : handleFileGrantRequest(req, res, requestUrl);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new AbortController();
    const response = fetch(`http://127.0.0.1:${address.port}${url}`, {
      signal: client.signal,
    })
      .then((res) => res.arrayBuffer())
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let inflight: Promise<unknown> | undefined;
    let fresh: Awaited<ReturnType<typeof openServedFile>> | undefined;
    let fifo = false;
    let released = false;
    const releaseNative = async () => {
      if (!fifo || released) return;
      // NONBLOCK belongs only to the test's writer. Production still opens "r".
      await until(() => {
        try {
          const writer = openSync(
            path,
            constants.O_WRONLY | constants.O_NONBLOCK,
          );
          closeSync(writer);
          released = true;
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
          return false;
        }
      }, "FIFO reader to accept its cleanup writer");
    };
    try {
      await within(barrier.reached, "HTTP before-open barrier");
      unlinkSync(path);
      execFileSync("mkfifo", [path]);
      fifo = true;
      barrier.release();
      // The continuation submits the native open before this event-loop turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      inflight = openServedFile(unrelated, { stat: false }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await within(pending.reached, "unrelated open");
      assert.equal(fileReadsCountsForTests().liveDescriptors, 2);
      writeAsInProcessWorkerForTests(new Uint8Array(8));
      await within(old.ended, "connection end");
      pending.release();
      const error = await within(
        inflight,
        "unrelated request rejection before FIFO writer",
      );
      assert.match(String(error), /The Worker connection ended/);
      await within(pending.disposed, "unrelated late descriptor disposal");
      await within(handled!, "HTTP handler rejection before FIFO writer");
      assert.equal(inProcessWorkerFileHandlesForTests(), 0, "old table swept");
      assert.equal(
        fileReadsCountsForTests().liveDescriptors,
        0,
        "sweep closed every returned descriptor",
      );
      await held.close();
      fresh = await openServedFile(other, { stat: false });
      const count = () =>
        ["files.read", "files.close"].map(inProcessWorkerServedMethodForTests);
      const before = count();
      await held.close();
      assert.deepEqual(count(), before, "stale close reached replacement");
      await releaseNative();
      await within(barrier.disposed, "orphaned native open's late close");
      assert.equal(
        fileReadsCountsForTests().liveDescriptors,
        1,
        "only replacement descriptor remains",
      );
      assert.equal(
        inProcessWorkerFileHandlesForTests(),
        1,
        "late open never registered on replacement",
      );
      const chunks: Buffer[] = [];
      for await (const chunk of fresh.createReadStream({ start: 0, end: 16 }))
        chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), "replacement bytes");
      await fresh.close();
      assert.equal(fileReadsCountsForTests().liveDescriptors, 0);
      assert.equal(inProcessWorkerFileHandlesForTests(), 0);
      console.log(
        `Worker FIFO open-end (${route}): unrelated rejected and sweep completed before writer; late return closed, replacement intact.`,
      );
    } finally {
      barrier.release();
      pending.release();
      await releaseNative();
      if (fifo) await within(barrier.disposed, "cleanup native open");
      await inflight;
      client.abort();
      await response;
      await handled;
      // Bun does not emit res.close for every disconnected response.
      if (closed && process.versions.bun === undefined)
        await within(closed, "response close");
      await held.close();
      await fresh?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
