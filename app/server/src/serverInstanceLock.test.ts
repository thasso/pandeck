/**
 * One server per DATA_DIR: a live owner refuses a second server, a lock left
 * by a server that is gone (or whose pid was reused) is superseded by the next
 * generation, and neither a takeover nor a release removes a live lock.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";
import {
  acquireServerInstanceLock,
  ServerInstanceLockedError,
  type ServerInstanceOwner,
} from "./serverInstanceLock.ts";

const root = mkdtempSync(join(tmpdir(), "server-instance-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fresh = () => mkdtempSync(join(root, "data-"));
const generation = (dir: string, n: number) => join(dir, `server.lock.${n}`);
const owner = (
  dir: string,
  patch: Partial<Record<keyof ServerInstanceOwner, unknown>> = {},
): string =>
  JSON.stringify({
    pid: process.pid,
    hostname: "test-host",
    acquiredAt: "2026-09-29T00:00:00.000Z",
    dataDir: realpathSync(dir),
    ...patch,
  });
const exitedPid = (): number => {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(pid);
  return pid;
};

test("a live owner refuses a second server, and a release frees the directory", () => {
  const dir = fresh();
  const lock = acquireServerInstanceLock(dir);
  assert.equal(lock.path, generation(dir, 1));
  assert.equal(JSON.parse(readFileSync(lock.path, "utf8")).pid, process.pid);
  assert.throws(
    () => acquireServerInstanceLock(dir),
    (err: unknown) =>
      err instanceof ServerInstanceLockedError &&
      err.owner.pid === process.pid &&
      err.lockPath === lock.path &&
      err.message.includes(lock.path),
  );
  assert.deepEqual(
    readdirSync(dir),
    ["server.lock.1"],
    "a refused attempt leaves the live lock alone and no draft behind",
  );

  lock.release();
  assert.deepEqual(readdirSync(dir), []);
  acquireServerInstanceLock(dir).release();
});

test("a lock whose owner has exited is superseded by the next generation", () => {
  const dir = fresh();
  writeFileSync(generation(dir, 3), owner(dir, { pid: exitedPid() }));
  writeFileSync(generation(dir, 2), owner(dir, { pid: 1 }));
  const lock = acquireServerInstanceLock(dir);
  assert.equal(lock.path, generation(dir, 4));
  assert.deepEqual(
    readdirSync(dir),
    ["server.lock.4"],
    "every superseded generation is cleaned up",
  );
  lock.release();
});

test("only the HIGHEST generation owns the directory", () => {
  const dir = fresh();
  // A stale older generation next to a live newer one: the live one wins.
  writeFileSync(generation(dir, 1), owner(dir, { pid: exitedPid() }));
  const live = owner(dir);
  writeFileSync(generation(dir, 2), live);
  assert.throws(
    () => acquireServerInstanceLock(dir),
    ServerInstanceLockedError,
  );
  assert.equal(readFileSync(generation(dir, 2), "utf8"), live);
  assert.equal(existsSync(generation(dir, 1)), true, "nothing was taken over");
});

test("a live pid with a different start time is a reused pid, not the owner", () => {
  if (!existsSync(`/proc/${process.pid}/stat`)) return; // Linux only
  const dir = fresh();
  // Our pid, someone else's start time.
  writeFileSync(generation(dir, 1), owner(dir, { startTime: "1" }));
  const lock = acquireServerInstanceLock(dir);
  assert.equal(lock.path, generation(dir, 2));
  lock.release();
});

test("a malformed owner is stale: pid 0 or -1 would signal a whole group", () => {
  for (const patch of [
    { pid: 0 },
    { pid: -1 },
    { pid: 1.5 },
    { pid: "42" },
    { startTime: "not-a-tick-count" },
    { dataDir: "" },
    { hostname: 7 },
  ]) {
    const dir = fresh();
    writeFileSync(generation(dir, 1), owner(dir, patch));
    const lock = acquireServerInstanceLock(dir);
    assert.equal(lock.path, generation(dir, 2), JSON.stringify(patch));
    lock.release();
  }
});

test("a live lock copied into another directory holds only its own", () => {
  const original = fresh();
  const held = acquireServerInstanceLock(original);
  assert.equal(
    JSON.parse(readFileSync(held.path, "utf8")).dataDir,
    realpathSync(original),
  );
  // A backup of the running server, restored elsewhere on the same host.
  const restored = fresh();
  copyFileSync(held.path, generation(restored, 1));
  const copy = acquireServerInstanceLock(restored);
  assert.equal(copy.path, generation(restored, 2), "the copy is taken over");
  assert.throws(
    () => acquireServerInstanceLock(original),
    ServerInstanceLockedError,
    "while the original directory still refuses",
  );
  copy.release();
  held.release();
});

test("an unreadable lock is stale", () => {
  const dir = fresh();
  writeFileSync(generation(dir, 1), "");
  acquireServerInstanceLock(dir).release();
});

test("releasing a superseded lock never removes its successor's", () => {
  const dir = fresh();
  const lock = acquireServerInstanceLock(dir);
  // A successor judged us gone, removed our generation and took the next one.
  rmSync(lock.path);
  const successor = owner(dir, { pid: 1, startTime: "1" });
  writeFileSync(generation(dir, 2), successor);
  lock.release();
  assert.equal(readFileSync(generation(dir, 2), "utf8"), successor);
});

test("servers racing for one stale lock admit exactly one", async () => {
  const dir = fresh();
  writeFileSync(generation(dir, 1), owner(dir, { pid: exitedPid() }));
  const moduleUrl = new URL("./serverInstanceLock.ts", import.meta.url).href;
  // Each contender holds what it won long enough for every other to judge it.
  const contender = `
    const { acquireServerInstanceLock } = await import(${JSON.stringify(moduleUrl)});
    try {
      const lock = acquireServerInstanceLock(${JSON.stringify(dir)});
      console.log("won");
      setTimeout(() => lock.release(), 3000);
    } catch (err) {
      console.log(err.name === "ServerInstanceLockedError" ? "refused" : String(err));
    }
  `;
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const outcomes = await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", contender],
            { cwd, stdio: ["ignore", "pipe", "inherit"] },
          );
          let out = "";
          child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
          child.on("error", reject);
          child.on("exit", () => resolve(out.trim()));
        }),
    ),
  );
  assert.deepEqual([...outcomes].sort(), [
    "refused",
    "refused",
    "refused",
    "refused",
    "refused",
    "won",
  ]);
}, 60_000);
