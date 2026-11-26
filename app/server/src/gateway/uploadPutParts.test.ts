/**
 * F004a (Task-1441 P8a, V3): an `uploads.put` reaches the edge's upload store
 * as the received slices, which the store copies into place, so a put costs
 * one copy rather than three. Every other message still decodes into buffers
 * of its own. The wire is the real codec's; the store is the real one.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import { createFileBudget } from "../gatewayTools/host.ts";
import {
  createUploadStore,
  probeUploadAllocations,
} from "../gatewayTools/uploads.ts";
import { MIB, patterned, settleGc } from "../test/forcedGc.ts";
import {
  FrameDecoder,
  MessageAssembler,
  encodeMessage,
  type AssemblyLimits,
  type Payload,
} from "../workerProtocol/codec.ts";
import { CLIENT_LIMITS } from "./clientListener.ts";
import { CLIENT_METHODS, decodeUploadPut } from "./clientMethods.ts";

const STAGED = "p8a-0123456789abcdef";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  vi.restoreAllMocks();
});

function putWire(uploadId: string, offset: number, chunk: Uint8Array): Buffer {
  return Buffer.concat(
    encodeMessage(
      "request",
      7,
      { method: CLIENT_METHODS.uploadsPut },
      {
        json: { uploadId, stagedAttachmentId: STAGED, offset },
        bytes: { chunk },
      },
    ),
  );
}

/** Each request the chunks complete, as the connection would serve it. */
function receive(
  chunks: readonly Uint8Array[],
  byteParts: boolean,
  limits: AssemblyLimits | null = CLIENT_LIMITS,
): Payload[] {
  const decoder = new FrameDecoder();
  const assembler = new MessageAssembler(limits ?? undefined);
  const payloads: Payload[] = [];
  for (const chunk of chunks)
    decoder.push(chunk, (frame) => {
      if (frame.type === "data") assembler.data(frame);
      else if (frame.type === "request")
        payloads.push(assembler.complete(frame, byteParts));
    });
  decoder.finish();
  return payloads;
}

function splitAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const sorted = [...new Set(cuts)]
    .filter((cut) => cut > 0 && cut < bytes.length)
    .sort((a, b) => a - b);
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (const cut of [...sorted, bytes.length]) {
    // A fresh buffer per piece, as a socket hands them over.
    pieces.push(Uint8Array.from(bytes.subarray(at, cut)));
    at = cut;
  }
  return pieces;
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

function storeWithUpload(source: Uint8Array) {
  const store = createUploadStore({ fileBudget: createFileBudget() });
  const scope = store.scope("user-1");
  const opened = scope.open({
    streams: [
      {
        stagedAttachmentId: STAGED,
        size: source.byteLength,
        sha256: sha(source),
      },
    ],
    work: source.byteLength,
  });
  assert.ok(opened.ok);
  return { scope, uploadId: opened.uploadId };
}

/** The listener's put handler: decode, then the store copies the slices. */
function serve(
  scope: ReturnType<typeof storeWithUpload>["scope"],
  payload: Payload,
) {
  const { put } = decodeUploadPut(payload);
  assert.ok(put);
  const { chunk, ...request } = put;
  return scope.put(request, chunk);
}

test("a 1 MiB put split anywhere, the prefix, header and payload edges included, is stored byte for byte with its digest", () => {
  const source = patterned(MIB, 11);
  const sample = putWire(`upl-${"0f".repeat(16)}`, 0, source);
  const head = sample.readUInt32BE(0);
  // Every cut at the data frame's prefix, header and payload boundaries.
  const edges = [1, 4, 7, 8, 9, 8 + head - 1, 8 + head, 8 + head + 1];
  const next = random(1441);
  const rounds: number[][] = [edges];
  for (let round = 0; round < 40; round++)
    rounds.push(
      Array.from({ length: 1 + Math.floor(next() * 64) }, () =>
        Math.floor(next() * sample.length),
      ),
    );
  for (const cuts of rounds) {
    const { scope, uploadId } = storeWithUpload(source);
    const probe = probeUploadAllocations();
    try {
      const [payload] = receive(
        splitAt(putWire(uploadId, 0, source), cuts),
        true,
      );
      assert.ok(payload?.byteParts?.chunk, `cuts ${cuts.join(",")}`);
      assert.equal(payload.bytes, undefined);
      assert.deepEqual(serve(scope, payload), {
        ok: true,
        received: MIB,
        streamComplete: true,
        sealed: true,
      });
      const stored = probe.takeBuffer();
      assert.ok(stored);
      assert.equal(
        sha(new Uint8Array(stored)),
        sha(source),
        `cuts ${cuts.join(",")}`,
      );
    } finally {
      probe.disarm();
      scope.end();
    }
  }
});

test("copy count: a put split into 64 KiB socket chunks joins no payload bytes; a joined stream is copied once", () => {
  const source = patterned(MIB, 12);
  const { scope, uploadId } = storeWithUpload(source);
  const wire = putWire(uploadId, 0, source);
  const chunks = splitAt(
    wire,
    Array.from(
      { length: Math.ceil(wire.length / 65_536) },
      (_, i) => i * 65_536,
    ),
  );
  const concat = vi.spyOn(Buffer, "concat");
  const joinedBytes = () =>
    concat.mock.results.reduce(
      (sum, result) => sum + (result.value as Buffer).byteLength,
      0,
    );
  const [parts] = receive(chunks, true);
  assert.ok(parts);
  // Only the small headers and JSON body are ever joined.
  assert.ok(joinedBytes() < 4 * 1024, `joined ${joinedBytes()} B`);
  assert.equal(serve(scope, parts).ok, true);
  // Every slice is a view of a received chunk: nothing was copied for it.
  const received = new Set(chunks.map((chunk) => chunk.buffer));
  for (const part of parts.byteParts!.chunk!)
    assert.ok(received.has(part.buffer));
  concat.mockClear();
  // Any other message: its stream is joined once into its own buffer (the
  // decoder no longer joins a frame split across chunks first).
  const [joined] = receive(chunks, false);
  assert.equal(joined?.bytes?.chunk?.byteLength, MIB);
  assert.ok(
    joinedBytes() >= MIB && joinedBytes() < MIB + 4 * 1024,
    `joined ${joinedBytes()} B`,
  );
  assert.ok(!received.has(joined.bytes.chunk.buffer));
  scope.end();
});

test("several frames in one chunk, a stream over several data frames, and __proto__ names decode the same with or without slices", () => {
  const bytes = patterned(2 * MIB + 5, 13);
  const wire = Buffer.concat([
    ...encodeMessage(
      "request",
      1,
      { method: "m" },
      {
        json: { a: 1 },
        text: { t: "ä\ud800" },
        // An own `__proto__` entry, never a prototype (AC7).
        bytes: Object.fromEntries([
          ["__proto__", bytes],
          ["b", Uint8Array.of(1, 2)],
        ]),
      },
    ),
    ...encodeMessage("request", 2, { method: "n" }, { json: null }),
  ]);
  const next = random(7);
  for (const chunks of [
    [wire],
    splitAt(
      wire,
      Array.from({ length: 30 }, () => Math.floor(next() * wire.length)),
    ),
  ]) {
    const [joined, empty] = receive(chunks, false, null);
    const [sliced] = receive(chunks, true, null);
    assert.ok(joined && sliced && empty);
    assert.deepEqual(empty.json, null);
    assert.deepEqual(sliced.json, joined.json);
    assert.deepEqual(sliced.text, joined.text);
    assert.equal(Object.getPrototypeOf(sliced.byteParts), null);
    assert.deepEqual(Object.keys(sliced.byteParts!), ["__proto__", "b"]);
    assert.ok(Object.hasOwn(joined.bytes!, "__proto__"));
    for (const name of ["__proto__", "b"])
      assert.ok(
        Buffer.concat(sliced.byteParts![name]!).equals(
          Buffer.from(joined.bytes![name]!),
        ),
        name,
      );
    assert.ok(Buffer.from(joined.bytes!.__proto__!).equals(Buffer.from(bytes)));
  }
});

test("bounds are charged the same however the frames are split", () => {
  const wire = putWire(`upl-${"0f".repeat(16)}`, 0, patterned(MIB, 14));
  const fits = (limit: number, chunks: Uint8Array[]) => {
    try {
      receive(chunks, true, {
        maxMessageBytes: limit,
        maxBufferedBytes: limit,
        maxPartialMessages: 1,
      });
      return true;
    } catch {
      return false;
    }
  };
  let low = 1;
  let high = 2 * MIB;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid, [wire])) high = mid;
    else low = mid + 1;
  }
  const split = splitAt(
    wire,
    Array.from({ length: 200 }, (_, i) => i * 5_003 + 1),
  );
  assert.equal(fits(low, split), true);
  assert.equal(fits(low - 1, split), false);
});

test("retention: once the put answers, no received chunk is kept; a slice kept by the caller would pin its chunk (control)", async () => {
  const source = patterned(MIB, 15);
  const run = (keep: boolean) => {
    const { scope, uploadId } = storeWithUpload(source);
    const wire = putWire(uploadId, 0, source);
    const chunks = splitAt(
      wire,
      Array.from({ length: 20 }, (_, i) => i * 60_000 + 3),
    );
    const refs = chunks.map((chunk) => new WeakRef(chunk.buffer));
    const [payload] = receive(chunks, true);
    assert.equal(serve(scope, payload!).ok, true);
    const kept = keep ? payload!.byteParts!.chunk!.at(-2) : undefined;
    return { refs, kept, scope };
  };
  const held = run(true);
  const clean = run(false);
  await settleGc();
  // Control: the kept slice holds its chunk, so the oracle can see one.
  assert.ok(held.kept);
  assert.ok(held.refs.some((ref) => ref.deref() !== undefined));
  assert.deepEqual(
    clean.refs.filter((ref) => ref.deref() !== undefined).length,
    0,
  );
  // The stores still hold their uploads: only the chunks went.
  held.scope.end();
  clean.scope.end();
});
