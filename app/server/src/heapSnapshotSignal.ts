/**
 * A heap snapshot on SIGUSR1 when the server runs on Bun, as the production
 * package does, installed at import time: `index.ts` imports this right after
 * the boot lock, so a signal during boot is already answered.
 *
 * Bun has no Node inspector, and its default action for SIGUSR1 ENDS the
 * process, so without this a `kill -USR1` would take production down. This
 * handler writes a V8-format snapshot instead, which Chrome DevTools' Memory
 * tab loads. Development runs on Node, which keeps its own SIGUSR1 answer:
 * the inspector on 127.0.0.1:9229.
 *
 * The snapshot holds everything in memory, tokens included, so it goes to a
 * private directory under the temp dir and never into `DATA_DIR`, which is
 * backed up. Writing it blocks the event loop for seconds, and each file is
 * about the heap's size, so the handler is bounded: one write at a time, a
 * signal within {@link MIN_INTERVAL_MS} of the last write is logged and
 * ignored, and only the {@link KEPT_SNAPSHOTS} newest files are kept.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";

const MIN_INTERVAL_MS = 60_000;
const KEPT_SNAPSHOTS = 2;
const SNAPSHOT_NAME = /^heap-\d+-\d+\.heapsnapshot$/;

interface HeapSnapshotOptions {
  dir?: string;
  now?: () => number;
  write?: (path: string) => string;
  log?: (message: string) => void;
}

/** The SIGUSR1 handler; the options are seams for tests. */
export function heapSnapshotHandler({
  dir = join(tmpdir(), "personal-assistant-heap-snapshots"),
  now = Date.now,
  write = writeHeapSnapshot,
  log = (message) => console.info(message),
}: HeapSnapshotOptions = {}): () => void {
  let writing = false;
  let lastStarted: number | undefined;
  return () => {
    const started = now();
    if (writing) {
      log("[memory] heap snapshot skipped: one is being written");
      return;
    }
    if (lastStarted !== undefined && started - lastStarted < MIN_INTERVAL_MS) {
      log(
        `[memory] heap snapshot skipped: the last one started ${Math.round((started - lastStarted) / 1000)}s ago (minimum ${MIN_INTERVAL_MS / 1000}s)`,
      );
      return;
    }
    writing = true;
    lastStarted = started;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      // Make room first: the directory never holds more than the limit.
      const existing = readdirSync(dir)
        .filter((name) => SNAPSHOT_NAME.test(name))
        .map((name) => ({
          path: join(dir, name),
          mtime: statSync(join(dir, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of existing.slice(KEPT_SNAPSHOTS - 1))
        rmSync(old.path, { force: true });
      const file = write(
        join(dir, `heap-${process.pid}-${started}.heapsnapshot`),
      );
      chmodSync(file, 0o600);
      log(`[memory] heap snapshot written to ${file} in ${now() - started}ms`);
    } catch (err) {
      log(
        `[memory] heap snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      writing = false;
    }
  };
}

if (process.versions.bun) process.on("SIGUSR1", heapSnapshotHandler());
