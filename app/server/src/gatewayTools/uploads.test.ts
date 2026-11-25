/**
 * The edge's upload store (Task-1441 P8a, v02 AC6, v03 K1/K5/K7, v10 S2):
 * reservation, receiving and sealing, the unattached lifetime, synchronous
 * consumption and the two holds. Every value is fake.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFileBudget } from "./host.ts";
import { ITEMS_INVALID } from "./twoPhase.ts";
import {
  UPLOAD_BUSY,
  UPLOAD_EXPIRED,
  UPLOAD_IDLE_MS,
  UPLOAD_INVALID,
  UPLOAD_IN_USE,
  UPLOAD_MAX_UNATTACHED_MS,
  UPLOAD_MISMATCH,
  UploadMismatchError,
  createUploadStore,
  uploadApplyDeadlineMs,
  type UploadConsumed,
  type UploadScope,
} from "./uploads.ts";

const MIB = 1024 * 1024;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const bytesOf = (size: number, seed = 1) =>
  Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) & 0xff);

afterEach(() => {
  vi.useRealTimers();
});

function setup(capacity?: number) {
  const fileBudget = createFileBudget(capacity);
  const store = createUploadStore({ fileBudget });
  return { fileBudget, store, scope: store.scope("user-1") };
}

/** Open one upload of `sources` and put each whole, chunked at 1 MiB. */
function sealed(scope: UploadScope, sources: Record<string, Uint8Array>) {
  const streams = Object.entries(sources).map(([id, bytes]) => ({
    stagedAttachmentId: id,
    size: bytes.byteLength,
    sha256: sha(bytes),
  }));
  const work = streams.reduce((sum, stream) => sum + stream.size, 0);
  const opened = scope.open({ streams, work });
  if (!opened.ok) throw new Error(opened.message);
  const answers = [];
  for (const [id, bytes] of Object.entries(sources))
    for (let offset = 0; offset < bytes.byteLength; offset += MIB)
      answers.push(
        scope.put(
          { uploadId: opened.uploadId, stagedAttachmentId: id, offset },
          bytes.subarray(offset, offset + MIB),
        ),
      );
  return { uploadId: opened.uploadId, answers, streams, work };
}

const item = (id: string, bytes: Uint8Array, extra: object = {}) => ({
  operation: "uploadAttachment",
  pageId: "123",
  attachment: {
    fileName: "f.bin",
    stagedAttachmentId: id,
    size: bytes.byteLength,
    sha256: sha(bytes),
  },
  ...extra,
});

function attached(consumed: UploadConsumed) {
  if (!consumed.ok) throw new Error(consumed.message);
  return consumed;
}

describe("the apply deadline", () => {
  test.each([
    [1, 46_000],
    [MIB, 46_000],
    [MIB + 1, 47_000],
    [50 * MIB, 95_000],
    [100 * MIB, 145_000],
  ])("W = %d bytes runs to %d ms", (work, ms) => {
    expect(uploadApplyDeadlineMs(work)).toBe(ms);
  });

  test("never exceeds 145 s", () => {
    expect(uploadApplyDeadlineMs(100 * MIB, 60_000)).toBe(145_000);
  });
});

describe("open", () => {
  test("reserves 2U + 2 MiB of the shared budget before any byte", () => {
    const { fileBudget, scope } = setup();
    const opened = scope.open({
      streams: [
        { stagedAttachmentId: "a", size: 3 * MIB, sha256: "a".repeat(64) },
        { stagedAttachmentId: "b", size: MIB, sha256: "b".repeat(64) },
      ],
      work: 7 * MIB,
    });
    expect(opened.ok).toBe(true);
    expect(fileBudget.reserved).toBe(2 * 4 * MIB + 2 * MIB);
  });

  test("a held budget answers busy and stores nothing", () => {
    const { fileBudget, scope } = setup();
    const release = fileBudget.reserve(MIB)!;
    expect(
      scope.open({
        streams: [{ stagedAttachmentId: "a", size: 1, sha256: "a".repeat(64) }],
        work: 1,
      }),
    ).toEqual({ ok: false, code: "tool_error", message: UPLOAD_BUSY });
    release();
    expect(fileBudget.reserved).toBe(0);
  });

  test.each([
    ["U = 101 MiB", [{ size: 101 * MIB }], 101 * MIB],
    ["two 60 MiB streams", [{ size: 60 * MIB }, { size: 60 * MIB }], 100 * MIB],
    ["U over W", [{ size: 2 }], 1],
    ["no stream", [], 0],
  ])("refuses %s and reserves nothing", (_what, sizes, work) => {
    const { fileBudget, scope } = setup();
    const answer = scope.open({
      streams: sizes.map(({ size }, i) => ({
        stagedAttachmentId: `s${i}`,
        size,
        sha256: "a".repeat(64),
      })),
      work,
    });
    expect(answer).toEqual({
      ok: false,
      code: "tool_error",
      message: UPLOAD_INVALID,
    });
    expect(fileBudget.reserved).toBe(0);
  });
});

describe("put", () => {
  test("reports each stream's completion, then the seal (K1)", () => {
    const { scope } = setup();
    const one = bytesOf(MIB + 5, 1);
    const two = bytesOf(10, 2);
    const { answers } = sealed(scope, { one, two });
    expect(answers).toEqual([
      { ok: true, received: MIB, streamComplete: false, sealed: false },
      { ok: true, received: MIB + 5, streamComplete: true, sealed: false },
      { ok: true, received: 10, streamComplete: true, sealed: true },
    ]);
  });

  test("copies the chunk: a later change to the caller's buffer is not stored", async () => {
    const { scope } = setup();
    const source = bytesOf(8);
    const opened = scope.open({
      streams: [{ stagedAttachmentId: "s", size: 8, sha256: sha(source) }],
      work: 8,
    });
    if (!opened.ok) throw new Error();
    const chunk = Uint8Array.from(source);
    scope.put(
      { uploadId: opened.uploadId, stagedAttachmentId: "s", offset: 0 },
      chunk,
    );
    chunk.fill(0);
    const consumed = attached(
      scope.consume(opened.uploadId, [item("s", source)]),
    );
    const bytes = await consumed.upload.stagedBytes(
      item("s", source).attachment,
    );
    expect(bytes).toEqual(source);
    expect(bytes.buffer).not.toBe(chunk.buffer);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(8);
  });

  test("a digest that does not match discards the upload and releases it", () => {
    const { fileBudget, scope } = setup();
    const opened = scope.open({
      streams: [{ stagedAttachmentId: "s", size: 4, sha256: "0".repeat(64) }],
      work: 4,
    });
    if (!opened.ok) throw new Error();
    expect(
      scope.put(
        { uploadId: opened.uploadId, stagedAttachmentId: "s", offset: 0 },
        bytesOf(4),
      ),
    ).toEqual({ ok: false, code: "tool_error", message: UPLOAD_MISMATCH });
    expect(fileBudget.reserved).toBe(0);
    expect(scope.release(opened.uploadId)).toEqual({ ok: true });
  });

  test.each([
    ["an unknown stream", { stagedAttachmentId: "x", offset: 0 }, 4],
    ["a gap", { stagedAttachmentId: "s", offset: 1 }, 2],
    ["an overrun", { stagedAttachmentId: "s", offset: 0 }, 9],
  ])("%s discards the upload and releases it", (_what, request, length) => {
    const { fileBudget, scope } = setup();
    const source = bytesOf(8);
    const opened = scope.open({
      streams: [{ stagedAttachmentId: "s", size: 8, sha256: sha(source) }],
      work: 8,
    });
    if (!opened.ok) throw new Error();
    expect(
      scope.put({ uploadId: opened.uploadId, ...request }, bytesOf(length)),
    ).toEqual({ ok: false, code: "tool_error", message: UPLOAD_INVALID });
    expect(fileBudget.reserved).toBe(0);
    // Gone: a further put finds nothing.
    expect(
      scope.put(
        { uploadId: opened.uploadId, stagedAttachmentId: "s", offset: 0 },
        source,
      ),
    ).toEqual({ ok: false, code: "tool_error", message: UPLOAD_EXPIRED });
  });

  test("a put after sealing discards the upload", () => {
    const { fileBudget, scope } = setup();
    const source = bytesOf(4);
    const { uploadId } = sealed(scope, { s: source });
    expect(
      scope.put({ uploadId, stagedAttachmentId: "s", offset: 4 }, bytesOf(1)),
    ).toMatchObject({ ok: false, message: UPLOAD_INVALID });
    expect(fileBudget.reserved).toBe(0);
  });

  test("another connection's id reads as unknown and is never touched", () => {
    const { fileBudget, store, scope } = setup();
    const source = bytesOf(4);
    const opened = scope.open({
      streams: [{ stagedAttachmentId: "s", size: 4, sha256: sha(source) }],
      work: 4,
    });
    if (!opened.ok) throw new Error();
    const other = store.scope("user-1");
    expect(
      other.put(
        { uploadId: opened.uploadId, stagedAttachmentId: "s", offset: 0 },
        source,
      ),
    ).toMatchObject({ ok: false, message: UPLOAD_EXPIRED });
    other.invalid(opened.uploadId);
    other.release(opened.uploadId);
    other.end();
    expect(other.consume(opened.uploadId, [item("s", source)])).toMatchObject({
      ok: false,
      message: ITEMS_INVALID,
    });
    expect(fileBudget.reserved).toBeGreaterThan(0);
    expect(
      scope.put(
        { uploadId: opened.uploadId, stagedAttachmentId: "s", offset: 0 },
        source,
      ),
    ).toMatchObject({ ok: true, sealed: true });
  });
});

describe("the unattached lifetime", () => {
  test("release discards and is idempotent", () => {
    const { fileBudget, scope } = setup();
    const { uploadId } = sealed(scope, { s: bytesOf(4) });
    expect(scope.release(uploadId)).toEqual({ ok: true });
    expect(scope.release(uploadId)).toEqual({ ok: true });
    expect(fileBudget.reserved).toBe(0);
  });

  test("an invalid request naming the upload discards it", () => {
    const { fileBudget, scope } = setup();
    const { uploadId } = sealed(scope, { s: bytesOf(4) });
    expect(scope.invalid(uploadId)).toMatchObject({ message: UPLOAD_INVALID });
    expect(fileBudget.reserved).toBe(0);
  });

  test("idle for 60 s discards it, and an apply then reads it as expired", () => {
    vi.useFakeTimers();
    const { fileBudget, scope } = setup();
    const source = bytesOf(4);
    const { uploadId } = sealed(scope, { s: source });
    vi.advanceTimersByTime(UPLOAD_IDLE_MS - 1);
    expect(fileBudget.reserved).toBeGreaterThan(0);
    vi.advanceTimersByTime(1);
    expect(fileBudget.reserved).toBe(0);
    expect(scope.consume(uploadId, [item("s", source)])).toMatchObject({
      ok: false,
      message: UPLOAD_EXPIRED,
    });
  });

  test("a put resets the idle timer, but not the absolute bound", () => {
    vi.useFakeTimers();
    const { fileBudget, scope } = setup();
    const size = 20;
    const opened = scope.open({
      streams: [{ stagedAttachmentId: "s", size, sha256: "a".repeat(64) }],
      work: size,
    });
    if (!opened.ok) throw new Error();
    // Ten puts 59.999 s apart: never idle for 60 s, 599.99 s in all.
    for (let offset = 0; offset < 10; offset += 1) {
      vi.advanceTimersByTime(UPLOAD_IDLE_MS - 1);
      expect(
        scope.put(
          { uploadId: opened.uploadId, stagedAttachmentId: "s", offset },
          bytesOf(1),
        ),
      ).toMatchObject({ ok: true });
    }
    expect(fileBudget.reserved).toBeGreaterThan(0);
    vi.advanceTimersByTime(
      UPLOAD_MAX_UNATTACHED_MS - 10 * (UPLOAD_IDLE_MS - 1),
    );
    expect(fileBudget.reserved).toBe(0);
    expect(
      scope.put(
        { uploadId: opened.uploadId, stagedAttachmentId: "s", offset: 10 },
        bytesOf(1),
      ),
    ).toMatchObject({ ok: false, message: UPLOAD_EXPIRED });
    expect(UPLOAD_MAX_UNATTACHED_MS).toBe(600_000);
  });

  test("the connection's end discards a sealed upload but never an attached one", () => {
    const { fileBudget, store } = setup(500 * MIB);
    const scope = store.scope("user-1");
    const source = bytesOf(4);
    const first = sealed(scope, { s: source });
    const consumed = attached(
      scope.consume(first.uploadId, [item("s", source)]),
    );
    scope.end();
    expect(fileBudget.reserved).toBeGreaterThan(0);
    consumed.upload.executionSettled();
    consumed.outputSettled();
    expect(fileBudget.reserved).toBe(0);
    // After the end, the scope opens nothing more.
    expect(
      scope.open({
        streams: [{ stagedAttachmentId: "s", size: 1, sha256: "a".repeat(64) }],
        work: 1,
      }),
    ).toMatchObject({ ok: false, message: UPLOAD_INVALID });
  });
});

describe("consumption (K5)", () => {
  test("attaches once: a second apply with the same id is refused and changes nothing", () => {
    const { fileBudget, scope } = setup();
    const source = bytesOf(4);
    const { uploadId } = sealed(scope, { s: source });
    const first = attached(scope.consume(uploadId, [item("s", source)]));
    const second = scope.consume(uploadId, [item("s", source)]);
    expect(second).toMatchObject({ ok: false, message: ITEMS_INVALID });
    second.outputSettled();
    expect(
      scope.put({ uploadId, stagedAttachmentId: "s", offset: 0 }, source),
    ).toMatchObject({ message: UPLOAD_IN_USE });
    expect(scope.release(uploadId)).toMatchObject({ message: UPLOAD_IN_USE });
    expect(scope.invalid(uploadId)).toMatchObject({ message: UPLOAD_INVALID });
    expect(fileBudget.reserved).toBeGreaterThan(0);
    first.upload.executionSettled();
    first.outputSettled();
    expect(fileBudget.reserved).toBe(0);
  });

  test.each([
    ["execution first", ["execution", "output"]],
    ["output first", ["output", "execution"]],
  ])("releases exactly once, only after both holds: %s", (_what, order) => {
    let releases = 0;
    const budget = createFileBudget();
    const store = createUploadStore({
      fileBudget: {
        reserve(bytes) {
          const release = budget.reserve(bytes);
          return (
            release &&
            (() => {
              releases += 1;
              release();
            })
          );
        },
        get reserved() {
          return budget.reserved;
        },
      },
    });
    const scope = store.scope("user-1");
    const source = bytesOf(4);
    const { uploadId } = sealed(scope, { s: source });
    const consumed = attached(scope.consume(uploadId, [item("s", source)]));
    const hold = {
      execution: () => consumed.upload.executionSettled(),
      output: () => consumed.outputSettled(),
    };
    hold[order[0] as "execution"]();
    expect(releases).toBe(0);
    hold[order[1] as "output"]();
    hold.execution();
    hold.output();
    expect(releases).toBe(1);
  });

  test("a validation refusal discards at once and releases after the refusal's output", () => {
    const { fileBudget, scope } = setup();
    const source = bytesOf(4);
    const { uploadId } = sealed(scope, { s: source });
    const refused = scope.consume(uploadId, [
      item("s", source, {}),
      item("s", bytesOf(5)),
    ]);
    expect(refused).toMatchObject({ ok: false, message: ITEMS_INVALID });
    expect(fileBudget.reserved).toBeGreaterThan(0);
    refused.outputSettled();
    expect(fileBudget.reserved).toBe(0);
    // A new open is admitted afterwards.
    expect(sealed(scope, { t: bytesOf(2) }).answers.at(-1)).toMatchObject({
      sealed: true,
    });
  });

  test("an unsealed upload is discarded on consumption", () => {
    const { fileBudget, scope } = setup();
    const opened = scope.open({
      streams: [{ stagedAttachmentId: "s", size: 4, sha256: "a".repeat(64) }],
      work: 4,
    });
    if (!opened.ok) throw new Error();
    const refused = scope.consume(opened.uploadId, [item("s", bytesOf(4))]);
    expect(refused.ok).toBe(false);
    refused.outputSettled();
    expect(fileBudget.reserved).toBe(0);
  });

  const one = bytesOf(6, 1);
  const two = bytesOf(9, 2);
  test.each<[string, Record<string, Uint8Array>, unknown[]]>([
    ["no upload item", { s: one }, [{ operation: "edit", pageId: "1" }]],
    ["a missing stream (unreferenced)", { s: one, t: two }, [item("s", one)]],
    ["an unknown stream", { s: one }, [item("t", one)]],
    [
      "a size that differs",
      { s: one },
      [
        {
          ...item("s", one),
          attachment: { ...item("s", one).attachment, size: 7 },
        },
      ],
    ],
    [
      "a digest that differs",
      { s: one },
      [
        {
          ...item("s", one),
          attachment: { ...item("s", one).attachment, sha256: sha(two) },
        },
      ],
    ],
    [
      "W that differs from the open's",
      { s: one },
      [item("s", one), item("s", one)],
    ],
    [
      "an item with no attachment",
      { s: one },
      [item("s", one), { operation: "uploadAttachment", pageId: "1" }],
    ],
  ])("refuses %s, whole-call", (_what, sources, items) => {
    const { scope } = setup();
    const { uploadId } = sealed(scope, sources);
    expect(scope.consume(uploadId, items)).toMatchObject({
      ok: false,
      message: ITEMS_INVALID,
    });
  });

  test("repeated-source items attach when W counts every item", () => {
    const { scope } = setup();
    const opened = scope.open({
      streams: [{ stagedAttachmentId: "s", size: 6, sha256: sha(one) }],
      work: 12,
    });
    if (!opened.ok) throw new Error();
    scope.put(
      { uploadId: opened.uploadId, stagedAttachmentId: "s", offset: 0 },
      one,
    );
    const consumed = attached(
      scope.consume(opened.uploadId, [
        item("s", one),
        { operation: "edit", pageId: "9" },
        item("s", one, { pageId: "124" }),
      ]),
    );
    expect(consumed.upload.work).toBe(12);
  });

  test("prototype-named stream ids are ordinary keys", async () => {
    const { scope } = setup();
    const proto = bytesOf(3, 7);
    const ctor = bytesOf(4, 8);
    // Own keys: an object literal's `__proto__` would set the prototype.
    const { uploadId } = sealed(
      scope,
      Object.fromEntries([
        ["__proto__", proto],
        ["constructor", ctor],
      ]),
    );
    const consumed = attached(
      scope.consume(uploadId, [
        item("__proto__", proto),
        item("constructor", ctor),
      ]),
    );
    expect(
      await consumed.upload.stagedBytes(item("__proto__", proto).attachment),
    ).toEqual(proto);
  });

  test("stagedBytes rechecks each item and refuses a mismatch as a typed defect", async () => {
    const { scope } = setup();
    const { uploadId } = sealed(scope, { s: one });
    const consumed = attached(scope.consume(uploadId, [item("s", one)]));
    await expect(
      consumed.upload.stagedBytes({
        ...item("s", one).attachment,
        sha256: sha(two),
      }),
    ).rejects.toBeInstanceOf(UploadMismatchError);
    await expect(
      consumed.upload.stagedBytes({ ...item("s", one).attachment, size: 5 }),
    ).rejects.toThrow(UPLOAD_MISMATCH);
    await expect(
      consumed.upload.stagedBytes({ stagedAttachmentId: "t" }),
    ).rejects.toBeInstanceOf(UploadMismatchError);
  });
});

test("no refusal text carries an id, a name or a size", () => {
  for (const text of [
    UPLOAD_BUSY,
    UPLOAD_EXPIRED,
    UPLOAD_INVALID,
    UPLOAD_IN_USE,
    UPLOAD_MISMATCH,
  ])
    expect(text).not.toMatch(/upl-|\d/);
});
