/**
 * A persist that fails part-way must leave the record readable and let the
 * NEXT persist finish the job: a thrown append that left half a line behind,
 * and a metadata rename that failed after its append succeeded. `node:fs` is
 * wrapped so each failure can be injected exactly once.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/claudeSdk/claudeSdkRecords.failures.test.ts`
 */
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, test, vi } from "vitest";

type Fs = typeof import("node:fs");

const inject = vi.hoisted(() => ({
  /** Replaces the next append once. */
  append: undefined as
    undefined | ((fs: Fs, path: string, data: string) => void),
  /** Replaces the next rename onto a path matching `renameTo` once. */
  renameTo: undefined as undefined | RegExp,
  /** Fails every stat/read of a matching path with `code` until cleared. */
  io: undefined as
    | undefined
    | { path: RegExp; code: "EACCES" | "EIO"; ops: Array<"stat" | "read"> },
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<Fs>();
  const appendFileSync = ((path: string, data: string, options?: unknown) => {
    const hook = inject.append;
    if (hook) {
      inject.append = undefined;
      return hook(fs, path, data);
    }
    return fs.appendFileSync(path, data, options as never);
  }) as Fs["appendFileSync"];
  const renameSync = ((from: string, to: string) => {
    if (inject.renameTo?.test(to)) {
      inject.renameTo = undefined;
      throw Object.assign(new Error("EIO: injected rename failure"), {
        code: "EIO",
      });
    }
    return fs.renameSync(from, to);
  }) as Fs["renameSync"];
  const failing = (op: "stat" | "read", path: unknown) => {
    const io = inject.io;
    if (io?.ops.includes(op) && io.path.test(String(path)))
      throw Object.assign(new Error(`${io.code}: injected ${op} failure`), {
        code: io.code,
      });
  };
  const statSync = ((path: string, options?: unknown) => {
    failing("stat", path);
    return fs.statSync(path, options as never);
  }) as Fs["statSync"];
  const readFileSync = ((path: string, options?: unknown) => {
    failing("read", path);
    return fs.readFileSync(path, options as never);
  }) as Fs["readFileSync"];
  const openSync = ((path: string, flags?: unknown, mode?: unknown) => {
    failing("read", path);
    return fs.openSync(path, flags as never, mode as never);
  }) as Fs["openSync"];
  const wrapped = {
    ...fs,
    appendFileSync,
    renameSync,
    statSync,
    readFileSync,
    openSync,
  };
  return { ...wrapped, default: wrapped };
});

const { DATA_DIR } = await import("../config.ts");
const { claudeSdkStore } = await import("./claudeSdkStore.ts");
const { ClaudeSdkRecordReadError, readClaudeSdkRecord } =
  await import("./claudeSdkRecords.ts");
const { claudeTurnSeam } = await import("../test/claudeTurnSeam.ts");

const dir = join(DATA_DIR, "claude-sdk");
const logFile = (id: string) => join(dir, `${id}.entries.jsonl`);
const metaFile = (id: string) => join(dir, `${id}.json`);
const error = vi.spyOn(console, "error");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Both files' exact bytes, to prove a refused operation changed nothing. */
function snapshot(id: string): [string, string, number] {
  return [
    readFileSync(metaFile(id), "utf8"),
    readFileSync(logFile(id), "utf8"),
    statSync(logFile(id)).ino,
  ];
}
const warn = vi.spyOn(console, "warn");

beforeAll(() => claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam)));

/**
 * The log parses line by line and holds exactly the session's timeline, and it
 * got there by cutting the failed tail and appending again — not through the
 * rewrite that repairs a log someone else changed.
 */
function assertDurable(id: string, entries: unknown[]): void {
  assert.ok(
    !warn.mock.calls.some((call) => String(call[0]).includes("rewriting")),
    "repaired in place, not rewritten",
  );
  const lines = readFileSync(logFile(id), "utf8").split("\n");
  assert.equal(lines.pop(), "", "the log ends on a complete line");
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    entries,
  );
  assert.deepEqual(readClaudeSdkRecord(dir, id)?.record.entries, entries);
}

test("an append that threw after writing half a line is repaired by the next persist", async () => {
  const id = `records-torn-append-${Date.now()}`;
  const session = claudeSdkStore.acquire(id);
  const adapter = session.createRuntimeAdapter();
  await adapter.prompt("first");
  assertDurable(id, session.timelineEntries());

  // The next persist (the second prompt's acceptance) writes half its bytes,
  // then fails the way a full disk would.
  inject.append = (fs, path, data) => {
    fs.appendFileSync(path, data.slice(0, Math.floor(data.length / 2)));
    throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
  };
  await adapter.prompt("second");
  assert.equal(inject.append, undefined, "the failure was injected");
  assertDurable(id, session.timelineEntries());
  claudeSdkStore.remove(id);
});

test("a metadata rename that failed after a successful append is repaired by the next persist", async () => {
  const id = `records-failed-rename-${Date.now()}`;
  const session = claudeSdkStore.acquire(id);
  const adapter = session.createRuntimeAdapter();
  await adapter.prompt("first");

  // The second prompt's acceptance appends its entry, then cannot publish
  // the metadata that vouches for it.
  inject.renameTo = new RegExp(`${id}\\.json$`);
  await adapter.prompt("second");
  assert.equal(inject.renameTo, undefined, "the failure was injected");
  assertDurable(id, session.timelineEntries());
  claudeSdkStore.remove(id);
});

test("a log that exists but cannot be read fails the acquire and is never replaced", async () => {
  // A persisted session, then a "restart": the same files under a new id.
  const source = `records-unreadable-src-${Date.now()}`;
  const live = claudeSdkStore.acquire(source);
  await live.createRuntimeAdapter().prompt("remember this");
  const timeline = live.timelineEntries();
  const id = `records-unreadable-${Date.now()}`;
  copyFileSync(metaFile(source), metaFile(id));
  copyFileSync(logFile(source), logFile(id));
  claudeSdkStore.remove(source);
  const before = snapshot(id);

  for (const failure of [
    { code: "EACCES", ops: ["read"] },
    { code: "EIO", ops: ["stat", "read"] },
  ] as const) {
    inject.io = {
      path: new RegExp(`${escape(id)}\\.entries\\.jsonl$`),
      code: failure.code,
      ops: [...failure.ops],
    };
    assert.throws(
      () => claudeSdkStore.acquire(id),
      (err: unknown) =>
        err instanceof ClaudeSdkRecordReadError &&
        err.message.includes(failure.code),
      "the load fails; it never passes for an empty transcript",
    );
    assert.equal(claudeSdkStore.get(id), undefined, "no session was created");
    assert.equal(
      claudeSdkStore.exists(id),
      true,
      "still present, so routing never treats it as a fresh id",
    );
    inject.io = undefined;
    assert.deepEqual(snapshot(id), before, "nothing on disk changed");
  }

  // Readable again: everything is there, and the next persist only appends.
  const restored = claudeSdkStore.acquire(id);
  assert.deepEqual(restored.timelineEntries(), timeline);
  restored.setTitle("Still here");
  assert.equal(readFileSync(logFile(id), "utf8"), before[1]);
  assert.equal(statSync(logFile(id)).ino, before[2]);
  claudeSdkStore.remove(id);
});

test("a live session refuses to persist while its log cannot be checked, then resumes", async () => {
  const id = `records-unstattable-${Date.now()}`;
  const session = claudeSdkStore.acquire(id);
  const adapter = session.createRuntimeAdapter();
  await adapter.prompt("first");
  const before = snapshot(id);

  error.mockClear();
  inject.io = {
    path: new RegExp(`${escape(id)}\\.entries\\.jsonl$`),
    code: "EIO",
    ops: ["stat"],
  };
  session.setTitle("Renamed while unreadable");
  inject.io = undefined;
  assert.deepEqual(snapshot(id), before, "the refused persist wrote nothing");
  assert.ok(
    error.mock.calls.some((call) => String(call[0]).includes("EIO")),
    "the refusal is surfaced",
  );

  await adapter.prompt("second");
  assertDurable(id, session.timelineEntries());
  assert.equal(readClaudeSdkRecord(dir, id)?.record.title, session.title);
  claudeSdkStore.remove(id);
});

test("the foreign-writer check never overwrites a log it could not read", async () => {
  const id = `records-unverifiable-${Date.now()}`;
  const session = claudeSdkStore.acquire(id);
  await session.createRuntimeAdapter().prompt("first");
  // Someone else appended, so the next persist must verify the log first.
  const foreign = `${JSON.stringify({ id: "foreign", seq: 999 })}\n`;
  const { appendFileSync } =
    await vi.importActual<typeof import("node:fs")>("node:fs");
  appendFileSync(logFile(id), foreign);
  const before = snapshot(id);

  inject.io = {
    path: new RegExp(`${escape(id)}\\.entries\\.jsonl$`),
    code: "EACCES",
    ops: ["read"],
  };
  session.setTitle("Cannot verify");
  inject.io = undefined;
  assert.deepEqual(snapshot(id), before, "unverifiable means untouched");

  // Readable again, the log still holds an entry the session does not.
  session.setTitle("Still conflicting");
  assert.deepEqual(snapshot(id), before, "and a real conflict is refused too");
  claudeSdkStore.remove(id);
});
