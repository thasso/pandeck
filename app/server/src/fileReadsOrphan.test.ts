import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { open, type FileHandle } from "node:fs/promises";
import { afterEach, test, vi } from "vitest";
import {
  fileReadsCountsForTests,
  openFile,
  type FileOpenOutcome,
  type OpenedFile,
} from "./fileReads.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const native = vi.mocked(open);
const file = () => ({
  close: vi.fn(async () => {}),
  stat: vi.fn(),
  read: vi.fn(),
});
const outcomeOf = (outcome: FileOpenOutcome<OpenedFile>) => outcome;

afterEach(() => {
  assert.equal(fileReadsCountsForTests().liveDescriptors, 0);
  native.mockReset();
});

test("an orphaned native success closes once, without stat or a second outcome", async () => {
  const pending = deferred<FileHandle>();
  const end = new AbortController();
  const late = file();
  native.mockReturnValueOnce(pending.promise);
  const dispose = vi.fn(outcomeOf);
  const opening = openFile(
    "late",
    { stat: true, orphanOnEnd: end.signal },
    dispose,
  );
  await tick();
  end.abort();
  const outcome = await opening;
  assert.ok("error" in outcome);
  assert.equal(outcome.phase, "open");
  assert.equal(getEventListeners(end.signal, "abort").length, 0);
  pending.resolve(late as unknown as FileHandle);
  await tick();
  assert.equal(dispose.mock.calls.length, 1);
  assert.equal(late.close.mock.calls.length, 1);
  assert.equal(late.stat.mock.calls.length, 0);
  assert.deepEqual(native.mock.calls, [["late", "r"]]);
});

test("an orphaned native failure is consumed without a descriptor or second outcome", async () => {
  const pending = deferred<FileHandle>();
  native.mockReturnValueOnce(pending.promise);
  const end = new AbortController();
  const dispose = vi.fn(outcomeOf);
  const opening = openFile(
    "failed",
    { stat: false, orphanOnEnd: end.signal },
    dispose,
  );
  await tick();
  end.abort();
  assert.ok("error" in (await opening));
  pending.reject(Object.assign(new Error("late ENOENT"), { code: "ENOENT" }));
  await tick();
  assert.equal(dispose.mock.calls.length, 1);
  assert.equal(getEventListeners(end.signal, "abort").length, 0);
});

test("once a descriptor returned, connection end still waits for its stat and close", async () => {
  const stat = deferred<never>();
  const descriptor = file();
  descriptor.stat.mockReturnValueOnce(stat.promise);
  native.mockResolvedValueOnce(descriptor as unknown as FileHandle);
  const end = new AbortController();
  let settled = false;
  const opening = openFile(
    "statting",
    { stat: true, orphanOnEnd: end.signal },
    outcomeOf,
  ).then((outcome) => {
    settled = true;
    return outcome;
  });
  await tick();
  assert.equal(fileReadsCountsForTests().liveDescriptors, 1);
  assert.equal(descriptor.stat.mock.calls.length, 1);
  end.abort();
  await tick();
  assert.equal(settled, false);
  stat.reject(Object.assign(new Error("stat failed"), { code: "EIO" }));
  const outcome = await opening;
  assert.ok("error" in outcome);
  assert.equal(outcome.phase, "stat");
  assert.equal(descriptor.close.mock.calls.length, 1);
});

test("a returned descriptor still waits for in-flight reads before closing", async () => {
  const read = deferred<{ bytesRead: number }>();
  const descriptor = file();
  descriptor.read.mockReturnValueOnce(read.promise);
  native.mockResolvedValueOnce(descriptor as unknown as FileHandle);
  const end = new AbortController();
  const outcome = await openFile(
    "reading",
    { stat: false, orphanOnEnd: end.signal },
    outcomeOf,
  );
  assert.ok("file" in outcome);
  assert.equal(getEventListeners(end.signal, "abort").length, 0);
  const reading = outcome.file.read(0, 1);
  end.abort();
  const closing = outcome.file.close();
  await tick();
  assert.equal(descriptor.close.mock.calls.length, 0);
  read.resolve({ bytesRead: 0 });
  await reading;
  await closing;
  await outcome.file.close();
  assert.equal(descriptor.close.mock.calls.length, 1);
});

test("an already-ended connection starts no native open", async () => {
  const end = new AbortController();
  end.abort();
  const outcome = await openFile(
    "not-started",
    { stat: false, orphanOnEnd: end.signal },
    outcomeOf,
  );
  assert.ok("error" in outcome);
  assert.equal(outcome.phase, "open");
  assert.equal(native.mock.calls.length, 0);
});
