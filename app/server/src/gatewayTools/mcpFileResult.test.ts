/**
 * The `/mcp` file result's pure parts (Task-1441 P7b): the applied limits
 * (AC7), the classification table (AC3, v02 Z1 and Z4 B) with injected
 * limits (v04 W5), the base64 pieces (Y4), and the writer's ordered stop and
 * the output hold (v03 Y1, v05 V3c) on a fake response with fake timers.
 * Expected values come from the rule table, never from the classifier.
 * Every value is fake.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, test, vi } from "vitest";
import {
  MCP_FILE_MAX_BYTES,
  MCP_FILE_OUTPUT_MS,
  MCP_IMAGE_INLINE_MAX,
  MCP_IMAGE_MAX_DIM,
  MCP_TEXT_INLINE_MAX,
  base64Length,
  classifyFile,
  createOutputHold,
  encodePiece,
  newPlaceholder,
  writeSplicedFile,
  type Classified,
  type InlineLimits,
  type WriterEvent,
} from "./mcpFileResult.ts";
import { pngHeader } from "../test/imageHeaders.ts";

afterEach(() => {
  vi.useRealTimers();
});

const MiB = 1024 * 1024;

test("the limits are the applied M8 values, the default is min(50 MiB, FILE), and each is within P7a's 100 MiB", () => {
  // P7b handoff "Applied values": run 1 T1, I4, D2; run 2c B7.
  assert.equal(MCP_TEXT_INLINE_MAX, 32_768);
  assert.equal(MCP_IMAGE_INLINE_MAX, 8_389_778);
  assert.equal(MCP_IMAGE_MAX_DIM, 7_900);
  assert.equal(MCP_FILE_MAX_BYTES, 11_534_336);
  assert.equal(Math.min(50 * MiB, MCP_FILE_MAX_BYTES), 11_534_336);
  for (const value of [
    MCP_TEXT_INLINE_MAX,
    MCP_IMAGE_INLINE_MAX,
    MCP_FILE_MAX_BYTES,
  ])
    assert.ok(value <= 100 * MiB);
  // Cap and threshold stay separate: the size-only image→blob branch is
  // reachable in production (v04 W5).
  assert.ok(MCP_FILE_MAX_BYTES > MCP_IMAGE_INLINE_MAX);
  assert.equal(MCP_FILE_OUTPUT_MS, 120_000);
});

// --- Headers, built by hand from each format's layout -----------------------

const le16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const le24 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
];
const asciiBytes = (text: string) => [...text].map((c) => c.charCodeAt(0));
const padded = (head: number[], size: number) => {
  const bytes = new Uint8Array(Math.max(size, head.length));
  bytes.set(head);
  return bytes;
};

/** SOI, an APP0 segment, then a baseline frame (SOF0). */
function jpegHeader(width: number, height: number, frame = 0xc0): number[] {
  return [
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...asciiBytes("JFIF"),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    frame,
    0x00,
    0x11,
    8,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    3,
  ];
}

function gifHeader(width: number, height: number): number[] {
  return [...asciiBytes("GIF89a"), ...le16(width), ...le16(height), 0, 0, 0];
}

function webpVp8(width: number, height: number): number[] {
  return [
    ...asciiBytes("RIFF"),
    0,
    0,
    0,
    0,
    ...asciiBytes("WEBPVP8 "),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...le16(width),
    ...le16(height),
  ];
}

function webpVp8l(width: number, height: number): number[] {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return [
    ...asciiBytes("RIFF"),
    0,
    0,
    0,
    0,
    ...asciiBytes("WEBPVP8L"),
    0,
    0,
    0,
    0,
    0x2f,
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 24) & 0xff,
  ];
}

function webpVp8x(width: number, height: number): number[] {
  return [
    ...asciiBytes("RIFF"),
    0,
    0,
    0,
    0,
    ...asciiBytes("WEBPVP8X"),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...le24(width - 1),
    ...le24(height - 1),
  ];
}

/** Small injected limits, so every branch is reachable in a few bytes. */
const LIMITS: InlineLimits = { textMax: 16, imageMax: 64, imageMaxDim: 100 };
const utf8 = (text: string) => new TextEncoder().encode(text);

interface Row {
  name: string;
  bytes: Uint8Array;
  type: string;
  expected: Classified;
}

const ROWS: Row[] = [
  // (i) image: type, signature, dimensions and size all hold.
  {
    name: "a PNG within every limit",
    bytes: padded(pngHeader(100, 100), 40),
    type: "image/png",
    expected: { as: "image", mimeType: "image/png" },
  },
  {
    name: "a PNG of exactly the image size limit",
    bytes: padded(pngHeader(1, 1), 64),
    type: "image/png",
    expected: { as: "image", mimeType: "image/png" },
  },
  {
    name: "a PNG one byte over the image size limit",
    bytes: padded(pngHeader(1, 1), 65),
    type: "image/png",
    expected: { as: "resource" },
  },
  {
    name: "a PNG one pixel over the dimension limit in width",
    bytes: padded(pngHeader(101, 1), 40),
    type: "image/png",
    expected: { as: "resource" },
  },
  {
    name: "a PNG one pixel over the dimension limit in height",
    bytes: padded(pngHeader(1, 101), 40),
    type: "image/png",
    expected: { as: "resource" },
  },
  {
    name: "a PNG type with JPEG bytes",
    bytes: padded(jpegHeader(10, 10), 40),
    type: "image/png",
    expected: { as: "resource" },
  },
  {
    name: "a PNG with its IHDR cut off",
    bytes: new Uint8Array(pngHeader(10, 10).slice(0, 20)),
    type: "image/png",
    expected: { as: "resource" },
  },
  {
    name: "a JPEG at the dimension limit, parameterized mixed-case type",
    bytes: padded(jpegHeader(100, 100), 40),
    type: "Image/JPEG; q=1",
    expected: { as: "image", mimeType: "image/jpeg" },
  },
  {
    name: "a progressive JPEG (SOF2) at the limit",
    bytes: padded(jpegHeader(100, 100, 0xc2), 40),
    type: "image/jpeg",
    expected: { as: "image", mimeType: "image/jpeg" },
  },
  {
    name: "a JPEG one over the dimension limit",
    bytes: padded(jpegHeader(101, 100), 40),
    type: "image/jpeg",
    expected: { as: "resource" },
  },
  {
    name: "a JPEG whose scan starts before any frame",
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0]),
    type: "image/jpeg",
    expected: { as: "resource" },
  },
  {
    name: "a GIF at the dimension limit",
    bytes: padded(gifHeader(100, 100), 20),
    type: "image/gif",
    expected: { as: "image", mimeType: "image/gif" },
  },
  {
    name: "a GIF one over the dimension limit",
    bytes: padded(gifHeader(100, 101), 20),
    type: "image/gif",
    expected: { as: "resource" },
  },
  {
    name: "a lossy WebP (VP8) at the dimension limit",
    bytes: padded(webpVp8(100, 100), 40),
    type: "image/webp",
    expected: { as: "image", mimeType: "image/webp" },
  },
  {
    name: "a lossy WebP (VP8) one over",
    bytes: padded(webpVp8(101, 100), 40),
    type: "image/webp",
    expected: { as: "resource" },
  },
  {
    name: "a lossless WebP (VP8L) at the dimension limit",
    bytes: padded(webpVp8l(100, 100), 40),
    type: "image/webp",
    expected: { as: "image", mimeType: "image/webp" },
  },
  {
    name: "a lossless WebP (VP8L) one over",
    bytes: padded(webpVp8l(100, 101), 40),
    type: "image/webp",
    expected: { as: "resource" },
  },
  {
    name: "an extended WebP (VP8X) at the dimension limit",
    bytes: padded(webpVp8x(100, 100), 40),
    type: "image/webp",
    expected: { as: "image", mimeType: "image/webp" },
  },
  {
    name: "an extended WebP (VP8X) one over",
    bytes: padded(webpVp8x(101, 100), 40),
    type: "image/webp",
    expected: { as: "resource" },
  },
  {
    name: "a WebP with an unknown chunk",
    bytes: padded(
      [...asciiBytes("RIFF"), 0, 0, 0, 0, ...asciiBytes("WEBPXXXX")],
      40,
    ),
    type: "image/webp",
    expected: { as: "resource" },
  },
  {
    name: "a BMP, which is never inline",
    bytes: padded(asciiBytes("BM"), 40),
    type: "image/bmp",
    expected: { as: "resource" },
  },
  // (ii) text: a text type, valid UTF-8, within the text limit.
  {
    name: "text/plain within the text limit",
    bytes: utf8("hello"),
    type: "text/plain",
    expected: { as: "text", mimeType: "text/plain", text: "hello" },
  },
  {
    name: "text of exactly the text limit",
    bytes: utf8("0123456789abcdef"),
    type: "text/csv; charset=utf-8",
    expected: { as: "text", mimeType: "text/csv", text: "0123456789abcdef" },
  },
  {
    name: "text one byte over the text limit",
    bytes: utf8("0123456789abcdefg"),
    type: "text/plain",
    expected: { as: "resource" },
  },
  {
    name: "text that is not UTF-8",
    bytes: new Uint8Array([0x68, 0xff, 0x69]),
    type: "text/plain",
    expected: { as: "resource" },
  },
  {
    name: "an SVG (+xml) image",
    bytes: utf8("<svg/>"),
    type: "image/svg+xml",
    expected: { as: "text", mimeType: "image/svg+xml", text: "<svg/>" },
  },
  ...[
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/javascript",
    "application/sql",
    "application/ld+json",
  ].map((type): Row => ({
    name: `${type} as text`,
    bytes: utf8("{}"),
    type,
    expected: { as: "text", mimeType: type, text: "{}" },
  })),
  // (iii) everything else.
  {
    name: "a PDF",
    bytes: utf8("%PDF-1.7"),
    type: "application/pdf",
    expected: { as: "resource" },
  },
  {
    name: "no type at all",
    bytes: utf8("hello"),
    type: "",
    expected: { as: "resource" },
  },
  {
    name: "an empty octet-stream",
    bytes: new Uint8Array(0),
    type: "application/octet-stream",
    expected: { as: "resource" },
  },
];

for (const row of ROWS)
  test(`classification: ${row.name}`, () => {
    assert.deepEqual(classifyFile(row.bytes, row.type, LIMITS), row.expected);
  });

test("at the deployed limits: an image between IMAGE and FILE is a blob, a 12000² PNG is a blob, a 7900² PNG is an image", () => {
  assert.deepEqual(
    classifyFile(
      padded(pngHeader(10, 10), MCP_IMAGE_INLINE_MAX + 1),
      "image/png",
    ),
    { as: "resource" },
  );
  assert.deepEqual(
    classifyFile(padded(pngHeader(10, 10), MCP_IMAGE_INLINE_MAX), "image/png"),
    { as: "image", mimeType: "image/png" },
  );
  assert.deepEqual(
    classifyFile(padded(pngHeader(12_000, 12_000), 300_000), "image/png"),
    { as: "resource" },
  );
  assert.deepEqual(
    classifyFile(padded(pngHeader(7_900, 7_900), 1_000), "image/png"),
    { as: "image", mimeType: "image/png" },
  );
  assert.deepEqual(
    classifyFile(new Uint8Array(MCP_TEXT_INLINE_MAX).fill(0x61), "text/plain")
      .as,
    "text",
  );
  assert.deepEqual(
    classifyFile(
      new Uint8Array(MCP_TEXT_INLINE_MAX + 1).fill(0x61),
      "text/plain",
    ),
    { as: "resource" },
  );
});

test("the decoder keeps a BOM: each text re-encodes to its own bytes (Z4 B)", () => {
  const bom = [0xef, 0xbb, 0xbf];
  for (const bytes of [
    new Uint8Array(bom),
    new Uint8Array([...bom, ...utf8("grüße ✓")]),
    utf8("grüße ✓"),
  ]) {
    const classified = classifyFile(bytes, "text/plain", LIMITS);
    assert.equal(classified.as, "text");
    if (classified.as !== "text") return;
    assert.deepEqual(new TextEncoder().encode(classified.text), bytes);
  }
});

test("a placeholder is 64 characters of base64, fresh per call", () => {
  const one = newPlaceholder();
  const two = newPlaceholder();
  assert.match(one, /^[A-Za-z0-9+/]{64}$/);
  assert.notEqual(one, two);
  assert.equal(Buffer.from(one, "base64").length, 48);
});

test("pieces are views of at most 3 MiB from 3-aligned offsets, and join to the whole base64", () => {
  const source = new Uint8Array(3 * MiB + 5).map((_v, i) => (i * 7) % 256);
  // A view at an offset in a larger buffer: the offsets are the view's.
  const backing = new Uint8Array(source.length + 11);
  backing.set(source, 11);
  const view = backing.subarray(11);
  const pieces = [encodePiece(view, 0, 3 * MiB), encodePiece(view, 3 * MiB, 5)];
  assert.equal(pieces.join(""), Buffer.from(source).toString("base64"));
  assert.throws(() => encodePiece(view, 0, 3 * MiB + 3));
  assert.throws(() => encodePiece(view, 1, 3));
  for (const size of [0, 1, 2, 3, 4, 3 * MiB - 1, 3 * MiB, 3 * MiB + 1])
    assert.equal(
      base64Length(size),
      Buffer.from(new Uint8Array(size)).toString("base64").length,
    );
});

// --- The writer and the output hold, on a fake response ---------------------

/**
 * A response whose `write` refuses when `blocked`, and whose `destroy` only
 * records: the test decides when `close` follows.
 */
class FakeResponse extends EventEmitter {
  destroyed = false;
  blocked = false;
  destroys = 0;
  chunks: string[] = [];
  head:
    { status: number; headers: Record<string, string | number> } | undefined;
  ended = false;
  writeHead(status: number, headers: Record<string, string | number>) {
    this.head = { status, headers };
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.blocked;
  }
  end(chunk: string) {
    this.chunks.push(chunk);
    this.ended = true;
  }
  destroy() {
    this.destroys += 1;
    this.destroyed = true;
  }
  /** The writer's own listeners, `once` ones included. */
  listening(): number {
    return ["finish", "close", "error", "drain"].reduce(
      (sum, event) => sum + this.listenerCount(event),
      0,
    );
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function startWriter(
  res: FakeResponse,
  bytes: Uint8Array,
  signal = new AbortController().signal,
) {
  const events: WriterEvent[] = [];
  const hold = createOutputHold(res);
  let released = 0;
  hold.onSettled(() => (released += 1));
  const exited = hold.writerStarted();
  let done = false;
  const writing = writeSplicedFile(
    res,
    { status: 200, prefix: '{"a":"', suffix: '"}', bytes },
    { signal, probe: (event) => events.push(event) },
  ).finally(() => {
    exited();
    done = true;
  });
  return {
    events,
    writing,
    released: () => released,
    done: () => done,
    baseline: res.listenerCount("finish") + res.listenerCount("close"),
  };
}

test("the normal path: prefix, pieces, suffix, exact content-length; the hold settles after finish and writer exit", async () => {
  const res = new FakeResponse();
  const bytes = new Uint8Array(3 * MiB + 2).map((_v, i) => i % 251);
  const run = startWriter(res, bytes);
  await tick();
  assert.ok(res.ended);
  const body = res.chunks.join("");
  assert.equal(body, `{"a":"${Buffer.from(bytes).toString("base64")}"}`);
  assert.equal(res.head?.headers["content-length"], Buffer.byteLength(body));
  assert.equal(run.released(), 0, "no release before finish");
  res.emit("finish");
  await run.writing;
  res.emit("close");
  assert.equal(run.released(), 1);
  assert.equal(res.destroys, 0);
  assert.deepEqual(run.events, ["head", "exited"]);
  // Only the hold's two `once` listeners were ever left, and they fired.
  assert.equal(res.listening(), 0);
});

test("the output timer fires while blocked on drain: destroy at exactly 120 s, the writer exits, and the release waits for the delayed close", async () => {
  vi.useFakeTimers();
  const res = new FakeResponse();
  res.blocked = true;
  const run = startWriter(res, new Uint8Array(7 * MiB));
  await vi.advanceTimersByTimeAsync(0);
  assert.ok(run.events.includes("waiting"));
  const piecesBefore = res.chunks.length;
  await vi.advanceTimersByTimeAsync(MCP_FILE_OUTPUT_MS - 1);
  assert.equal(res.destroys, 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(res.destroys, 1, "destroyed at 120 s");
  await run.writing;
  assert.ok(run.done());
  assert.equal(res.chunks.length, piecesBefore, "no piece after the stop");
  assert.equal(run.released(), 0, "no release at destroy()");
  assert.equal(vi.getTimerCount(), 0, "the output timer is cleared");
  await vi.advanceTimersByTimeAsync(5_000);
  assert.equal(run.released(), 0);
  res.emit("close");
  assert.equal(run.released(), 1);
  assert.equal(res.listening(), 0);
  assert.deepEqual(run.events.slice(-2), ["stopped", "exited"]);
});

test("an error before close: no release at the error, one after close", async () => {
  const res = new FakeResponse();
  res.blocked = true;
  const run = startWriter(res, new Uint8Array(7 * MiB));
  await tick();
  res.emit("error", new Error("socket"));
  await run.writing;
  assert.equal(res.destroys, 1);
  assert.equal(run.released(), 0);
  res.emit("close");
  res.emit("close");
  assert.equal(run.released(), 1);
});

test("a peer close while waiting: the response is already destroyed, so no second destroy(), and one release", async () => {
  const res = new FakeResponse();
  res.blocked = true;
  const run = startWriter(res, new Uint8Array(7 * MiB));
  await tick();
  res.destroyed = true;
  res.emit("close");
  await run.writing;
  assert.equal(res.destroys, 0);
  assert.equal(run.released(), 1);
  assert.equal(res.listening(), 0);
});

test("the call's abort stops the writer: destroy, exit, then the release on close", async () => {
  const res = new FakeResponse();
  res.blocked = true;
  const controller = new AbortController();
  const run = startWriter(res, new Uint8Array(7 * MiB), controller.signal);
  await tick();
  controller.abort();
  await run.writing;
  assert.equal(res.destroys, 1);
  assert.equal(run.released(), 0);
  res.emit("close");
  assert.equal(run.released(), 1);
});

test("drain resumes the writer piece by piece", async () => {
  const res = new FakeResponse();
  res.blocked = true;
  const bytes = new Uint8Array(7 * MiB).map((_v, i) => i % 13);
  const run = startWriter(res, bytes);
  for (let round = 0; round < 4 && !res.ended; round += 1) {
    await tick();
    res.emit("drain");
  }
  await tick();
  assert.ok(res.ended);
  assert.equal(
    res.chunks.join(""),
    `{"a":"${Buffer.from(bytes).toString("base64")}"}`,
  );
  assert.ok(
    run.events.filter((event) => event === "write-refused").length >= 3,
  );
  res.emit("finish");
  res.emit("close");
  await run.writing;
  assert.equal(run.released(), 1);
});

test("a response already destroyed writes nothing and the hold waits for close", async () => {
  const res = new FakeResponse();
  res.destroyed = true;
  const run = startWriter(res, new Uint8Array(10));
  await run.writing;
  assert.equal(res.head, undefined);
  assert.equal(res.chunks.length, 0);
  assert.equal(run.released(), 0);
  res.emit("close");
  assert.equal(run.released(), 1);
});

test("the output hold without a writer settles at finish or close, at most once, and late registrations run at once", () => {
  for (const event of ["finish", "close"]) {
    const res = new FakeResponse();
    const hold = createOutputHold(res);
    let count = 0;
    hold.onSettled(() => (count += 1));
    assert.equal(count, 0);
    res.emit(event);
    res.emit("finish");
    res.emit("close");
    assert.equal(count, 1);
    hold.onSettled(() => (count += 1));
    assert.equal(count, 2);
  }
});
