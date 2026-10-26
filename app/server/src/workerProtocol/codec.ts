/**
 * Worker protocol framing (`docs/workers.md`, "Protocol in phase 1").
 *
 * A connection is a byte stream of frames. Each frame is two big-endian
 * `u32`s — header length, payload length — then a UTF-8 JSON header, then the
 * payload bytes. A frame may arrive split at any byte and several may arrive
 * in one chunk. Each frame is capped ({@link MAX_FRAME_HEADER_BYTES},
 * {@link MAX_FRAME_PAYLOAD_BYTES}); a message is not: its parts travel as
 * ordered `data` frames before the `request` or `response` frame that
 * completes it, so only the executor's own parameters bound what one moves.
 *
 * A message carries a JSON body, named byte streams and named text streams.
 * Text travels as UTF-16LE, code unit for code unit: a string an executor
 * produced (stdout, a truncated patch, an error message) may hold a lone
 * surrogate, which UTF-8 cannot carry. The JSON body is safe for the small
 * strings it holds because `JSON.stringify` escapes lone surrogates.
 *
 * Anything malformed, out of sequence or over a cap is a
 * {@link WorkerProtocolError}, which ends the connection.
 */

/** The most payload one frame may carry; a message spans as many as it needs. */
export const MAX_FRAME_PAYLOAD_BYTES = 1024 * 1024;
/** The most a frame's JSON header may take. */
export const MAX_FRAME_HEADER_BYTES = 64 * 1024;
const PREFIX_BYTES = 8;

/** The peer broke the protocol; the connection cannot continue. */
export class WorkerProtocolError extends Error {}

/** What a request or response carries. */
export interface Payload {
  /** A JSON value; absent means `null`. */
  json?: unknown;
  /** Named strings, kept exact to the UTF-16 code unit. */
  text?: Readonly<Record<string, string>>;
  /** Named byte streams. */
  bytes?: Readonly<Record<string, Uint8Array>>;
}

type MessageKind = "request" | "response";

interface MessageHead {
  id: number;
  /** Names of the text streams this message carries, empty ones included. */
  text: string[];
  /** Names of the byte streams this message carries, empty ones included. */
  bytes: string[];
  /** How many `data` frames came before this one. */
  chunks: number;
  /** The last piece of the JSON body; earlier pieces were `body` data. */
  payload: Buffer;
}

export type Frame =
  | { type: "hello"; workerId: string; version: string }
  | { type: "welcome"; version: string }
  | { type: "refused"; version: string; reason: string }
  | ({ type: "request"; method: string } & MessageHead)
  /** `failure` is the error code of a failed request; absent on success. */
  | ({ type: "response"; failure?: string } & MessageHead)
  | {
      type: "data";
      of: MessageKind;
      id: number;
      stream: string;
      seq: number;
      payload: Buffer;
    }
  | { type: "cancel"; id: number };

type FrameHeader = Record<string, unknown> & { type: Frame["type"] };

const utf8 = new TextDecoder("utf-8", { fatal: true });

function encodeFrame(header: FrameHeader, payload?: Uint8Array): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const body = payload ?? new Uint8Array(0);
  if (head.length > MAX_FRAME_HEADER_BYTES)
    throw new Error(`A ${header.type} frame header is over the frame cap.`);
  const prefix = Buffer.alloc(PREFIX_BYTES);
  prefix.writeUInt32BE(head.length, 0);
  prefix.writeUInt32BE(body.length, 4);
  return Buffer.concat([prefix, head, body]);
}

/** One handshake or cancel frame. */
export function encodeControlFrame(
  frame: Extract<Frame, { type: "hello" | "welcome" | "refused" | "cancel" }>,
): Buffer {
  return encodeFrame(frame);
}

function bufferOf(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Every frame of one message, in order: its streams as `data` frames, then the
 * completing frame.
 */
export function encodeMessage(
  kind: MessageKind,
  id: number,
  head: { method: string } | { failure?: string },
  message: Payload,
): Buffer[] {
  const frames: Buffer[] = [];
  let seq = 0;
  const stream = (name: string, bytes: Buffer, keepLast = false): Buffer => {
    let at = 0;
    while (
      bytes.length - at > MAX_FRAME_PAYLOAD_BYTES ||
      (!keepLast && at < bytes.length)
    ) {
      const end = Math.min(at + MAX_FRAME_PAYLOAD_BYTES, bytes.length);
      frames.push(
        encodeFrame(
          { type: "data", of: kind, id, stream: name, seq: seq++ },
          bytes.subarray(at, end),
        ),
      );
      at = end;
    }
    return bytes.subarray(at);
  };
  const text = Object.entries(message.text ?? {});
  const bytes = Object.entries(message.bytes ?? {});
  // UTF-16LE chunks split at even offsets: the frame cap is even.
  for (const [name, value] of text)
    stream(`text:${name}`, Buffer.from(value, "utf16le"));
  for (const [name, value] of bytes) stream(`bytes:${name}`, bufferOf(value));
  const tail = stream(
    "body",
    Buffer.from(JSON.stringify(message.json ?? null), "utf8"),
    true,
  );
  frames.push(
    encodeFrame(
      {
        type: kind,
        id,
        ...head,
        text: text.map(([name]) => name),
        bytes: bytes.map(([name]) => name),
        chunks: seq,
      },
      tail,
    ),
  );
  return frames;
}

function fail(message: string): never {
  throw new WorkerProtocolError(message);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/** A decoded header checked against its frame type. */
function parseFrame(head: Buffer, payload: Buffer): Frame {
  let header: unknown;
  try {
    header = JSON.parse(utf8.decode(head));
  } catch {
    fail("A frame header is not UTF-8 JSON.");
  }
  if (typeof header !== "object" || header === null || Array.isArray(header))
    fail("A frame header is not an object.");
  const h = header as Record<string, unknown>;
  const control = (): void => {
    if (payload.length > 0)
      fail(`A ${String(h.type)} frame carries a payload.`);
  };
  switch (h.type) {
    case "hello":
      control();
      if (!isString(h.workerId) || !h.workerId || !isString(h.version))
        fail("A hello frame needs a Worker id and a version.");
      return { type: "hello", workerId: h.workerId, version: h.version };
    case "welcome":
      control();
      if (!isString(h.version)) fail("A welcome frame needs a version.");
      return { type: "welcome", version: h.version };
    case "refused":
      control();
      if (!isString(h.version) || !isString(h.reason))
        fail("A refused frame needs a version and a reason.");
      return { type: "refused", version: h.version, reason: h.reason };
    case "cancel":
      control();
      if (!isCount(h.id)) fail("A cancel frame needs a request id.");
      return { type: "cancel", id: h.id };
    case "data":
      if (
        (h.of !== "request" && h.of !== "response") ||
        !isCount(h.id) ||
        !isString(h.stream) ||
        !isCount(h.seq)
      )
        fail("A data frame needs a message, a stream and a sequence number.");
      return {
        type: "data",
        of: h.of,
        id: h.id,
        stream: h.stream,
        seq: h.seq,
        payload,
      };
    case "request":
    case "response": {
      if (
        !isCount(h.id) ||
        !isNames(h.text) ||
        !isNames(h.bytes) ||
        !isCount(h.chunks)
      )
        fail(`A ${h.type} frame needs an id, its stream names and a count.`);
      const head = {
        id: h.id,
        text: h.text,
        bytes: h.bytes,
        chunks: h.chunks,
        payload,
      };
      if (h.type === "request") {
        if (!isString(h.method)) fail("A request frame needs a method.");
        return { type: "request", method: h.method, ...head };
      }
      if (h.failure !== undefined && !isString(h.failure))
        fail("A response failure must be an error code.");
      return {
        type: "response",
        ...(h.failure !== undefined ? { failure: h.failure } : {}),
        ...head,
      };
    }
    default:
      return fail(`Unknown frame type ${JSON.stringify(h.type)}.`);
  }
}

/** Reassembles frames from a byte stream split anywhere. */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  /**
   * Feed received bytes; `onFrame` sees each complete frame in order. Throws
   * {@link WorkerProtocolError} at the first bad frame, after the good ones
   * before it were delivered. An over-cap frame fails on its length prefix,
   * before any of it is buffered.
   */
  push(bytes: Uint8Array, onFrame: (frame: Frame) => void): void {
    if (bytes.length > 0) {
      this.chunks.push(bufferOf(bytes));
      this.buffered += bytes.length;
    }
    while (this.buffered >= PREFIX_BYTES) {
      const prefix = this.peek(PREFIX_BYTES);
      const headLength = prefix.readUInt32BE(0);
      const payloadLength = prefix.readUInt32BE(4);
      if (headLength === 0 || headLength > MAX_FRAME_HEADER_BYTES)
        fail(`A frame header of ${headLength} bytes is outside the frame cap.`);
      if (payloadLength > MAX_FRAME_PAYLOAD_BYTES)
        fail(
          `A frame payload of ${payloadLength} bytes is over the frame cap.`,
        );
      const total = PREFIX_BYTES + headLength + payloadLength;
      if (this.buffered < total) return;
      const frame = this.take(total);
      onFrame(
        parseFrame(
          frame.subarray(PREFIX_BYTES, PREFIX_BYTES + headLength),
          frame.subarray(PREFIX_BYTES + headLength),
        ),
      );
    }
  }

  /** The stream ended; a frame cut short is a protocol error. */
  finish(): void {
    if (this.buffered > 0) fail("The connection ended inside a frame.");
  }

  private peek(length: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= length) return first.subarray(0, length);
    const parts: Buffer[] = [];
    for (let i = 0, have = 0; have < length; i++) {
      parts.push(this.chunks[i]!);
      have += this.chunks[i]!.length;
    }
    return Buffer.concat(parts).subarray(0, length);
  }

  private take(length: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= length) {
      const frame = first.subarray(0, length);
      if (first.length === length) this.chunks.shift();
      else this.chunks[0] = first.subarray(length);
      this.buffered -= length;
      return frame;
    }
    const parts: Buffer[] = [];
    let needed = length;
    while (needed > 0) {
      const chunk = this.chunks[0]!;
      if (chunk.length <= needed) {
        parts.push(chunk);
        this.chunks.shift();
        needed -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, needed));
        this.chunks[0] = chunk.subarray(needed);
        needed = 0;
      }
    }
    this.buffered -= length;
    return Buffer.concat(parts, length);
  }
}

type CompletingFrame = Extract<Frame, { type: MessageKind }>;

/**
 * Collects each message's `data` frames until the frame that completes it.
 * Sequence numbers count every data frame of a message from zero, across its
 * streams, so frames of interleaved messages are told apart by id and checked
 * in order.
 */
export class MessageAssembler {
  private partial = new Map<
    string,
    { seq: number; streams: Map<string, Buffer[]> }
  >();

  data(frame: Extract<Frame, { type: "data" }>): void {
    const key = `${frame.of}:${frame.id}`;
    let message = this.partial.get(key);
    if (!message) {
      message = { seq: 0, streams: new Map() };
      this.partial.set(key, message);
    }
    if (frame.seq !== message.seq)
      fail(
        `Data frame ${frame.seq} of ${key} arrived where ${message.seq} was due.`,
      );
    message.seq += 1;
    let parts = message.streams.get(frame.stream);
    if (!parts) {
      parts = [];
      message.streams.set(frame.stream, parts);
    }
    parts.push(frame.payload);
  }

  complete(frame: CompletingFrame): Payload {
    const key = `${frame.type}:${frame.id}`;
    const message = this.partial.get(key);
    this.partial.delete(key);
    const streams = message?.streams ?? new Map<string, Buffer[]>();
    if (frame.chunks !== (message?.seq ?? 0))
      fail(
        `${key} declared ${frame.chunks} data frames but ${message?.seq ?? 0} arrived.`,
      );
    const declared = new Set([
      "body",
      ...frame.text.map((name) => `text:${name}`),
      ...frame.bytes.map((name) => `bytes:${name}`),
    ]);
    for (const name of streams.keys())
      if (!declared.has(name)) fail(`${key} sent undeclared stream ${name}.`);
    const joined = (name: string): Buffer =>
      Buffer.concat(streams.get(name) ?? []);
    let json: unknown;
    try {
      json = JSON.parse(
        utf8.decode(Buffer.concat([joined("body"), frame.payload])),
      );
    } catch {
      fail(`The body of ${key} is not UTF-8 JSON.`);
    }
    const text: Record<string, string> = {};
    for (const name of frame.text) {
      const bytes = joined(`text:${name}`);
      if (bytes.length % 2 !== 0)
        fail(`Text stream ${name} of ${key} ends inside a code unit.`);
      text[name] = bytes.toString("utf16le");
    }
    const bytes: Record<string, Buffer> = {};
    for (const name of frame.bytes) bytes[name] = joined(`bytes:${name}`);
    return { json, text, bytes };
  }
}
