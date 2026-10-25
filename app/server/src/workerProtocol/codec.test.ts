import assert from "node:assert/strict";
import { test } from "vitest";
import {
  decodeBoundedOutcome,
  decodeExecOutcome,
  encodeBoundedOutcome,
  encodeExecOutcome,
} from "./checkoutMethods.ts";
import {
  FrameDecoder,
  MAX_FRAME_HEADER_BYTES,
  MAX_FRAME_PAYLOAD_BYTES,
  MessageAssembler,
  WorkerProtocolError,
  encodeControlFrame,
  encodeMessage,
  type Frame,
  type Payload,
} from "./codec.ts";
import {
  WorkerConnection,
  WorkerMethodError,
  WorkerRequestError,
  type MethodHandlers,
} from "./connection.ts";
import { createInProcessTransport } from "./inProcessTransport.ts";
import { WORKER_PROTOCOL_VERSION } from "./version.ts";

/** Text that UTF-8 cannot carry, multi-byte text, and control characters. */
const AWKWARD = [
  "\uD83D", // lone high surrogate
  "\uDE00", // lone low surrogate
  "x\uDE00\uD83Dy", // both, reversed
  "😀ä€\u0000\u0001\u001f\u007f\r\n\t",
  "",
].join("|");

/** A deterministic generator, so a failing split can be replayed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

function frameBytes(): Buffer {
  return Buffer.concat([
    encodeControlFrame({ type: "hello", workerId: "w-ä", version: "1.0" }),
    ...encodeMessage(
      "request",
      1,
      { method: "checkout.git.run" },
      {
        json: { args: ["log", "😀", "\uD800"], n: 1 },
        text: { a: AWKWARD, empty: "" },
        bytes: { stdin: Buffer.from([0, 255, 0xc3, 0x28, 10]) },
      },
    ),
    encodeControlFrame({ type: "cancel", id: 1 }),
    ...encodeMessage(
      "response",
      1,
      { failure: "failed" },
      {
        text: { message: AWKWARD },
      },
    ),
    encodeControlFrame({ type: "welcome", version: "1.7" }),
  ]);
}

/** Every frame `chunks` decode to, payloads copied out for comparison. */
function decodeAll(chunks: Uint8Array[]): Frame[] {
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  for (const chunk of chunks)
    decoder.push(chunk, (frame) =>
      frames.push(
        "payload" in frame
          ? { ...frame, payload: Buffer.from(frame.payload) }
          : frame,
      ),
    );
  decoder.finish();
  return frames;
}

function splitAt(bytes: Buffer, cuts: number[]): Buffer[] {
  const parts: Buffer[] = [];
  let at = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    parts.push(bytes.subarray(at, cut));
    at = cut;
  }
  parts.push(bytes.subarray(at));
  return parts;
}

test("frames decode the same however the stream is split", () => {
  const bytes = frameBytes();
  const whole = decodeAll([bytes]);
  assert.deepEqual(
    whole.map((frame) => frame.type),
    [
      "hello",
      "data",
      "data",
      "request",
      "cancel",
      "data",
      "response",
      "welcome",
    ],
  );
  // One byte at a time cuts inside every multi-byte character and between
  // the two bytes of every UTF-16LE code unit.
  assert.deepEqual(
    decodeAll([...bytes].map((byte) => Uint8Array.of(byte))),
    whole,
  );
  const next = random(1168);
  for (let round = 0; round < 200; round++) {
    const cuts = Array.from({ length: 1 + Math.floor(next() * 12) }, () =>
      Math.floor(next() * bytes.length),
    );
    assert.deepEqual(
      decodeAll(splitAt(bytes, cuts)),
      whole,
      `cuts ${cuts.join(",")}`,
    );
  }
});

/** Encode a message, split it at random, and assemble it again. */
function roundTrip(payload: Payload, seed = 7): Payload {
  const bytes = Buffer.concat(encodeMessage("response", 9, {}, payload));
  const next = random(seed);
  const cuts = Array.from({ length: 64 }, () =>
    Math.floor(next() * bytes.length),
  );
  const assembler = new MessageAssembler();
  let message: Payload | undefined;
  for (const frame of decodeAll(splitAt(bytes, cuts)))
    if (frame.type === "data") assembler.data(frame);
    else if (frame.type === "response") message = assembler.complete(frame);
  assert.ok(message);
  return message;
}

function sameUnits(actual: string, expected: string, what: string): void {
  assert.equal(actual.length, expected.length, `${what} length`);
  for (let i = 0; i < expected.length; i++)
    assert.equal(
      actual.charCodeAt(i),
      expected.charCodeAt(i),
      `${what} code unit ${i}`,
    );
}

test("every text field keeps its exact code units, lone surrogates included", () => {
  const exec = decodeExecOutcome(
    roundTrip(
      encodeExecOutcome({
        error: { code: 128, message: `fatal: ${AWKWARD}` },
        stdout: AWKWARD,
        stderr: AWKWARD.repeat(3),
      }),
    ),
  );
  sameUnits(exec.stdout, AWKWARD, "stdout");
  sameUnits(exec.stderr, AWKWARD.repeat(3), "stderr");
  sameUnits(exec.error!.message, `fatal: ${AWKWARD}`, "message");
  assert.equal(exec.error!.code, 128);

  const bounded = decodeBoundedOutcome(
    roundTrip(
      encodeBoundedOutcome({
        code: null,
        aborted: false,
        patch: "\uD83D",
        totalChars: 5,
        stderr: AWKWARD,
        spawnError: AWKWARD,
      }),
    ),
  );
  sameUnits(bounded.patch, "\uD83D", "patch");
  assert.equal(bounded.patch.charCodeAt(0), 0xd83d);
  sameUnits(bounded.stderr, AWKWARD, "bounded stderr");
  sameUnits(bounded.spawnError!, AWKWARD, "spawnError");
});

test("a message larger than many frames arrives whole and in order", () => {
  const text = "\uD83D".repeat(MAX_FRAME_PAYLOAD_BYTES + 3);
  const bytes = Buffer.alloc(3 * MAX_FRAME_PAYLOAD_BYTES + 5, 7);
  const json = { args: ["x".repeat(MAX_FRAME_PAYLOAD_BYTES * 2)] };
  const frames = encodeMessage(
    "response",
    9,
    {},
    {
      json,
      text: { t: text },
      bytes: { b: bytes },
    },
  );
  for (const frame of frames)
    assert.ok(
      frame.length <= 8 + MAX_FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES,
    );
  const message = roundTrip({ json, text: { t: text }, bytes: { b: bytes } });
  assert.ok(message.text!.t === text);
  assert.ok(Buffer.from(message.bytes!.b!).equals(bytes));
  assert.deepEqual(message.json, json);
});

function prefix(headLength: number, payloadLength: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(headLength, 0);
  bytes.writeUInt32BE(payloadLength, 4);
  return bytes;
}

function rawFrame(header: unknown, payload = Buffer.alloc(0)): Buffer {
  const head = Buffer.from(
    typeof header === "string" ? header : JSON.stringify(header),
  );
  return Buffer.concat([prefix(head.length, payload.length), head, payload]);
}

const BAD_STREAMS: [string, Buffer][] = [
  ["over-cap payload", prefix(10, MAX_FRAME_PAYLOAD_BYTES + 1)],
  ["over-cap header", prefix(MAX_FRAME_HEADER_BYTES + 1, 0)],
  ["empty header", prefix(0, 0)],
  ["not JSON", rawFrame("{nope")],
  [
    "invalid UTF-8",
    Buffer.concat([prefix(3, 0), Buffer.from([0x22, 0xff, 0x22])]),
  ],
  ["unknown type", rawFrame({ type: "shout" })],
  ["control payload", rawFrame({ type: "cancel", id: 1 }, Buffer.from("x"))],
  [
    "data without seq",
    rawFrame({ type: "data", of: "request", id: 1, stream: "body" }),
  ],
];

test("a malformed or over-cap frame is a protocol error, found before buffering", () => {
  for (const [what, bytes] of BAD_STREAMS)
    assert.throws(
      () => new FrameDecoder().push(bytes, () => undefined),
      WorkerProtocolError,
      what,
    );
  // The cap is checked on the prefix alone: none of the payload has arrived.
  assert.throws(
    () =>
      new FrameDecoder().push(prefix(10, 2 ** 32 - 1), () =>
        assert.fail("no frame"),
      ),
    /over the frame cap/,
  );
  const truncated = new FrameDecoder();
  truncated.push(
    encodeControlFrame({ type: "cancel", id: 3 }).subarray(0, 11),
    () => assert.fail("no frame"),
  );
  assert.throws(() => truncated.finish(), WorkerProtocolError);
});

test("data out of sequence, or a count that does not match, is a protocol error", () => {
  const [first, second, last] = decodeAll(
    encodeMessage(
      "request",
      4,
      { method: "m" },
      {
        text: { a: "x".repeat(MAX_FRAME_PAYLOAD_BYTES) },
      },
    ),
  );
  assert.equal(first!.type, "data");
  assert.equal(second!.type, "data");
  const skipped = new MessageAssembler();
  assert.throws(
    () => skipped.data(second as Extract<Frame, { type: "data" }>),
    WorkerProtocolError,
  );
  const short = new MessageAssembler();
  short.data(first as Extract<Frame, { type: "data" }>);
  assert.throws(
    () => short.complete(last as Extract<Frame, { type: "request" }>),
    WorkerProtocolError,
  );
  const undeclared = new MessageAssembler();
  undeclared.data({
    ...(first as Extract<Frame, { type: "data" }>),
    stream: "text:b",
  });
  assert.throws(
    () =>
      undeclared.complete({
        ...(last as Extract<Frame, { type: "request" }>),
        chunks: 1,
      }),
    WorkerProtocolError,
  );
});

/** A connected server/Worker pair over the in-process transport. */
function pair(handlers: MethodHandlers = {}) {
  const [serverEnd, workerEnd] = createInProcessTransport();
  const server = new WorkerConnection(serverEnd, {
    handshake: { role: "server", admit: () => undefined },
  });
  const worker = new WorkerConnection(workerEnd, {
    handshake: { role: "worker", workerId: "w" },
    handlers,
  });
  return { server, worker, workerEnd };
}

test("a bad frame on a live connection ends it as a protocol error", async () => {
  const cases: [string, Buffer][] = [
    ...BAD_STREAMS,
    [
      "data out of sequence",
      rawFrame(
        { type: "data", of: "request", id: 1, stream: "body", seq: 1 },
        Buffer.from("{}"),
      ),
    ],
    [
      "a second hello",
      encodeControlFrame({
        type: "hello",
        workerId: "w",
        version: WORKER_PROTOCOL_VERSION,
      }),
    ],
    [
      "an unexpected response",
      Buffer.concat(encodeMessage("response", 77, {}, {})),
    ],
  ];
  for (const [what, bytes] of cases) {
    const { server, worker, workerEnd } = pair({
      echo: async (payload) => payload,
    });
    assert.deepEqual(
      (await server.request("echo", { json: 1 })).json,
      1,
      `${what}: live first`,
    );
    workerEnd.write(bytes);
    assert.match(await server.ended, /^protocol error: /, what);
    assert.match(await worker.ended, /closed/, what);
  }
  // A frame cut short when the stream ends.
  const { server, workerEnd } = pair();
  await server.request("missing", {}).catch(() => undefined);
  workerEnd.write(encodeControlFrame({ type: "cancel", id: 1 }).subarray(0, 9));
  workerEnd.close();
  assert.match(await server.ended, /^protocol error: .*inside a frame/);
});

test("an error message keeps its exact code units across a real connection", async () => {
  const { server } = pair({
    fail: async () => {
      throw new WorkerMethodError("custom", AWKWARD);
    },
  });
  await assert.rejects(server.request("fail", {}), (error: unknown) => {
    assert.ok(error instanceof WorkerRequestError);
    assert.equal(error.code, "custom");
    sameUnits(error.message, AWKWARD, "message");
    return true;
  });
});
