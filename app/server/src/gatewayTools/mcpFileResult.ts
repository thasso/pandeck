/**
 * A file answer on `/mcp` (Task-1441 P7b): which part carries it, and how its
 * base64 reaches the response without the whole encoding in memory.
 *
 * - **Classification** (AC3, v02 Z1 and Z4 B): an image whose type, leading
 *   bytes and header dimensions all agree, within the image limits, is image
 *   content; a text type that decodes as UTF-8 within the text limit is an
 *   embedded text resource; everything else is an embedded blob resource
 *   labelled `application/octet-stream` (v04 W1). Nothing is refused here:
 *   the host's file limit already admitted the bytes (v04 W5).
 * - **The splice** (AC5, v03 Y2): an image or blob part carries a per-call
 *   placeholder through the SDK. The serialized body must hold it exactly
 *   once; the writer then sends the prefix, the file's base64 in pieces of at
 *   most 3 MiB input, waiting for `drain` whenever a write is refused, and
 *   the suffix, under an exact `content-length`.
 * - **Stopping** (v03 Y1): the output timer, a response `error`, a `close`
 *   before `finish` or the call's abort stop the writer: no further piece,
 *   `destroy()` at once, then the loop exits and drops the bytes. The
 *   output hold (`createOutputHold`) settles only once the loop has exited
 *   and the response has emitted `finish` or `close`.
 */
import { randomBytes } from "node:crypto";

/**
 * The applied M8 values (P7b handoff, "Applied values"): run 1 for text,
 * image and dimension, run 2c B7 for the file cap.
 */
export const MCP_TEXT_INLINE_MAX = 32_768;
export const MCP_IMAGE_INLINE_MAX = 8_389_778;
export const MCP_IMAGE_MAX_DIM = 7_900;
export const MCP_FILE_MAX_BYTES = 11_534_336;
/** How long a file answer's body may take once its head is written (Z3). */
export const MCP_FILE_OUTPUT_MS = 120_000;
/** Input bytes per encoded piece: 3-aligned, so the pieces join (Y4). */
const PIECE_INPUT_BYTES = 3 * 1024 * 1024;

export interface InlineLimits {
  textMax: number;
  imageMax: number;
  imageMaxDim: number;
}

const DEPLOYED_LIMITS: InlineLimits = {
  textMax: MCP_TEXT_INLINE_MAX,
  imageMax: MCP_IMAGE_INLINE_MAX,
  imageMaxDim: MCP_IMAGE_MAX_DIM,
};

/** How a file reaches the model; `as` is `meta.file.deliveredAs`. */
export type Classified =
  | { as: "text"; mimeType: string; text: string }
  | { as: "image"; mimeType: string }
  | { as: "resource" };

/** The media type without parameters, lowercased. */
function mediaTypeOf(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/sql",
]);

function isTextType(type: string): boolean {
  return (
    type.startsWith("text/") ||
    TEXT_TYPES.has(type) ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  bytes.length >= prefix.length &&
  prefix.every((byte, index) => bytes[index] === byte);
const ascii = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length &&
  [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));
const u16be = (bytes: Uint8Array, at: number) =>
  (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number) =>
  bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number) =>
  bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const u32be = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) >>> 0) + u24be(bytes, at + 1);
const u24be = (bytes: Uint8Array, at: number) =>
  (bytes[at]! << 16) | (bytes[at + 1]! << 8) | bytes[at + 2]!;

interface Dimensions {
  width: number;
  height: number;
}

/** PNG: the signature, then IHDR's width and height. */
function pngDimensions(bytes: Uint8Array): Dimensions | undefined {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return undefined;
  if (bytes.length < 24 || !ascii(bytes, 12, "IHDR")) return undefined;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** JPEG: the SOI, then the first SOFn segment's frame size. */
function jpegDimensions(bytes: Uint8Array): Dimensions | undefined {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return undefined;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    let marker = bytes[at + 1]!;
    // Fill bytes before a marker.
    while (marker === 0xff && at + 2 < bytes.length) {
      at += 1;
      marker = bytes[at + 1]!;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      at += 2;
      continue;
    }
    // End of image or start of scan before any frame: no size.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (at + 4 > bytes.length) return undefined;
    const length = u16be(bytes, at + 2);
    if (length < 2) return undefined;
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) return undefined;
      return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

/** GIF: the signature, then the logical screen descriptor. */
function gifDimensions(bytes: Uint8Array): Dimensions | undefined {
  if (!ascii(bytes, 0, "GIF87a") && !ascii(bytes, 0, "GIF89a"))
    return undefined;
  if (bytes.length < 10) return undefined;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/** WebP: RIFF/WEBP, then a VP8, VP8L or VP8X chunk's size. */
function webpDimensions(bytes: Uint8Array): Dimensions | undefined {
  if (!ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) return undefined;
  if (ascii(bytes, 12, "VP8 ")) {
    if (bytes.length < 30) return undefined;
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a))
      return undefined;
    return {
      width: u16le(bytes, 26) & 0x3fff,
      height: u16le(bytes, 28) & 0x3fff,
    };
  }
  if (ascii(bytes, 12, "VP8L")) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return undefined;
    const bits =
      (bytes[21]! |
        (bytes[22]! << 8) |
        (bytes[23]! << 16) |
        (bytes[24]! << 24)) >>>
      0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(bytes, 12, "VP8X")) {
    if (bytes.length < 30) return undefined;
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  return undefined;
}

const IMAGE_DIMENSIONS: Record<
  string,
  (bytes: Uint8Array) => Dimensions | undefined
> = {
  "image/png": pngDimensions,
  "image/jpeg": jpegDimensions,
  "image/gif": gifDimensions,
  "image/webp": webpDimensions,
};

/**
 * The part a file goes as: a pure function of its bytes, its type and the
 * limits (v04 W5: the endpoint uses the deployed ones, tests inject others).
 */
export function classifyFile(
  bytes: Uint8Array,
  mimeType: string,
  limits: InlineLimits = DEPLOYED_LIMITS,
): Classified {
  const type = mediaTypeOf(mimeType);
  const dimensions = IMAGE_DIMENSIONS[type];
  if (dimensions && bytes.byteLength <= limits.imageMax) {
    const size = dimensions(bytes);
    if (
      size &&
      size.width >= 1 &&
      size.height >= 1 &&
      size.width <= limits.imageMaxDim &&
      size.height <= limits.imageMaxDim
    )
      return { as: "image", mimeType: type };
  }
  if (isTextType(type) && bytes.byteLength <= limits.textMax) {
    try {
      // A BOM is kept as text, so the resource re-encodes to the same bytes.
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      return { as: "text", mimeType: type, text };
    } catch {
      // Not UTF-8: a blob.
    }
  }
  return { as: "resource" };
}

/**
 * A fresh placeholder for one call's file slot: 48 random bytes as base64,
 * 64 characters, valid base64 so the SDK's result check passes.
 */
export function newPlaceholder(): string {
  return randomBytes(48).toString("base64");
}

/** The base64 length of `size` bytes. */
export const base64Length = (size: number): number => 4 * Math.ceil(size / 3);

/**
 * One piece's base64, read through a view of the source: never more than
 * 3 MiB of input, and never a copy of the whole file.
 */
export function encodePiece(
  source: Uint8Array,
  offset: number,
  length: number,
): string {
  if (length > PIECE_INPUT_BYTES || offset % 3 !== 0)
    throw new Error("a piece is at most 3 MiB from a 3-aligned offset");
  return Buffer.from(
    source.buffer,
    source.byteOffset + offset,
    length,
  ).toString("base64");
}

/** What the writer needs of an `http.ServerResponse`; a fake in tests. */
export interface SplicedResponse {
  readonly destroyed: boolean;
  writeHead(status: number, headers: Record<string, string | number>): unknown;
  write(chunk: string): boolean;
  end(chunk: string): unknown;
  destroy(): unknown;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/** The writer's steps, reported to a test seam (v04 W6 2). */
export type WriterEvent =
  "head" | "write-refused" | "waiting" | "drained" | "stopped" | "exited";

export interface SplicedBody {
  status: number;
  prefix: string;
  suffix: string;
  bytes: Uint8Array;
}

export interface WriterOptions {
  /** The call's abort: the response closing early or the exchange ending. */
  signal: AbortSignal;
  outputMs?: number;
  probe?: (event: WriterEvent) => void;
}

/**
 * Writes `prefix`, the file's base64 and `suffix` (Y1). Settles when the
 * writer has stopped: after `finish`, or after an abort, once its pending
 * wait has ended. It never rejects.
 */
export async function writeSplicedFile(
  res: SplicedResponse,
  body: SplicedBody,
  options: WriterOptions,
): Promise<void> {
  const probe = options.probe ?? (() => {});
  let source: Uint8Array | undefined = body.bytes;
  const size = source.byteLength;
  let stopped = false;
  let finished = false;
  let stop: () => void = () => {};
  const stopping = new Promise<void>((resolve) => (stop = resolve));
  let onFinished: () => void = () => {};
  const finishing = new Promise<void>((resolve) => (onFinished = resolve));
  const abort = (): void => {
    if (stopped) return;
    // 1-3: no further piece, the response destroyed at once, the wait ended.
    stopped = true;
    probe("stopped");
    if (!res.destroyed) res.destroy();
    stop();
  };
  const onFinish = (): void => {
    finished = true;
    onFinished();
  };
  const onClose = (): void => {
    if (!finished) abort();
  };
  res.on("finish", onFinish);
  res.on("close", onClose);
  res.on("error", abort);
  options.signal.addEventListener("abort", abort);
  const timer = setTimeout(abort, options.outputMs ?? MCP_FILE_OUTPUT_MS);
  const drained = async (): Promise<void> => {
    probe("waiting");
    let onDrain: () => void = () => {};
    const draining = new Promise<void>((resolve) => (onDrain = resolve));
    res.on("drain", onDrain);
    try {
      await Promise.race([draining, stopping]);
    } finally {
      res.off("drain", onDrain);
    }
    if (!stopped) probe("drained");
  };
  try {
    if (options.signal.aborted || res.destroyed) abort();
    if (stopped) return;
    res.writeHead(body.status, {
      "content-type": "application/json",
      "content-length":
        Buffer.byteLength(body.prefix) +
        base64Length(size) +
        Buffer.byteLength(body.suffix),
    });
    probe("head");
    if (!res.write(body.prefix)) await drained();
    for (let offset = 0; offset < size && !stopped;) {
      const length = Math.min(PIECE_INPUT_BYTES, size - offset);
      const piece = encodePiece(source, offset, length);
      offset += length;
      if (stopped) break;
      if (!res.write(piece)) {
        probe("write-refused");
        await drained();
      }
    }
    if (stopped) return;
    res.end(body.suffix);
    await Promise.race([finishing, stopping]);
  } finally {
    // 4: whatever ended it, the same cleanup.
    clearTimeout(timer);
    res.off("finish", onFinish);
    res.off("close", onClose);
    res.off("error", abort);
    options.signal.removeEventListener("abort", abort);
    source = undefined;
    probe("exited");
  }
}

/**
 * One `/mcp` exchange's output hold (Y1 step 5, v08 T3, v09 U6): what the
 * host's `onSettled` registers runs once, when the response has emitted
 * `finish` or `close` and no writer is still running, whether a writer ran
 * or not.
 */
export interface OutputHold {
  onSettled(fn: () => void): void;
  /** A writer starts; the answer is its exit. */
  writerStarted(): () => void;
}

export function createOutputHold(res: {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}): OutputHold {
  let ended = false;
  let writers = 0;
  let settled = false;
  const pending: (() => void)[] = [];
  const check = (): void => {
    if (settled || !ended || writers > 0) return;
    settled = true;
    for (const fn of pending.splice(0)) fn();
  };
  const onEnd = (): void => {
    res.off("finish", onEnd);
    res.off("close", onEnd);
    ended = true;
    check();
  };
  res.once("finish", onEnd);
  res.once("close", onEnd);
  return {
    onSettled(fn) {
      if (settled) fn();
      else pending.push(fn);
    },
    writerStarted() {
      writers += 1;
      let exited = false;
      return () => {
        if (exited) return;
        exited = true;
        writers -= 1;
        check();
      };
    },
  };
}
