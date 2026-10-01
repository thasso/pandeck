import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { heapSnapshotHandler } from "./heapSnapshotSignal.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-heap-snapshot-"));
  roots.push(root);
  const dir = join(root, "snapshots");
  const logs: string[] = [];
  let clock = 1_000_000;
  let reentered = false;
  let handler: () => void = () => undefined;
  handler = heapSnapshotHandler({
    dir,
    now: () => clock,
    write: (path) => {
      // A signal delivered while writing is refused, not nested.
      if (!reentered) {
        reentered = true;
        handler();
      }
      writeFileSync(path, "{}");
      // Distinct mtimes so retention orders by age, not by chance.
      utimesSync(path, clock / 1000, clock / 1000);
      return path;
    },
    log: (message) => logs.push(message),
  });
  return {
    dir,
    logs,
    signal: () => handler(),
    advance: (ms: number) => {
      clock += ms;
    },
    files: () => readdirSync(dir).sort(),
  };
}

test("one write at a time, and never within a minute of the last", () => {
  const f = fixture();
  f.signal();
  assert.equal(f.files().length, 1);
  assert.match(f.logs[0] ?? "", /skipped: one is being written/);
  assert.match(f.logs[1] ?? "", /heap snapshot written to /);

  f.advance(59_000);
  f.signal();
  assert.equal(f.files().length, 1);
  assert.match(f.logs[2] ?? "", /skipped: the last one started 59s ago/);

  f.advance(1_000);
  f.signal();
  assert.equal(f.files().length, 2);
});

test("only the two newest snapshots are kept, privately", () => {
  const f = fixture();
  for (let n = 0; n < 4; n += 1) {
    f.signal();
    f.advance(60_000);
  }
  const kept = f.files();
  assert.equal(kept.length, 2);
  assert.deepEqual(
    kept,
    [
      `heap-${process.pid}-1180000.heapsnapshot`,
      `heap-${process.pid}-1120000.heapsnapshot`,
    ].sort(),
  );
  assert.equal(statSync(f.dir).mode & 0o777, 0o700);
  for (const name of kept)
    assert.equal(statSync(join(f.dir, name)).mode & 0o777, 0o600);
});

test("a failed write is logged and does not wedge the handler", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-heap-snapshot-"));
  roots.push(root);
  const logs: string[] = [];
  let clock = 0;
  let fail = true;
  const handler = heapSnapshotHandler({
    dir: join(root, "snapshots"),
    now: () => clock,
    write: (path) => {
      if (fail) throw new Error("disk full");
      writeFileSync(path, "{}");
      return path;
    },
    log: (message) => logs.push(message),
  });
  handler();
  assert.match(logs[0] ?? "", /heap snapshot failed: disk full/);
  fail = false;
  clock += 60_000;
  handler();
  assert.match(logs[1] ?? "", /heap snapshot written to /);
});
