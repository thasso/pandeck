/**
 * Gateway client 1.3 (Task-1441 P8a): the upload fields and methods'
 * decoders with v02 AC2/AC6's bounds and v03 K7's closed envelopes, and the
 * client's answer decoders. Every value is fake.
 */
import { describe, expect, test } from "vitest";
import {
  FrameDecoder,
  MessageAssembler,
  encodeMessage,
  type Frame,
  type Payload,
} from "../workerProtocol/codec.ts";
import { WorkerMethodError } from "../workerProtocol/connection.ts";
import { UPLOAD_CHUNK_MAX_BYTES as STORE_CHUNK_MAX_BYTES } from "../gatewayTools/uploads.ts";
import { CLIENT_LIMITS } from "./clientListener.ts";
import {
  CLIENT_METHODS,
  UPLOAD_CHUNK_MAX_BYTES,
  decodeToolApply,
  decodeToolPrepare,
  decodeUploadOpen,
  decodeUploadOpenAnswer,
  decodeUploadPut,
  decodeUploadPutAnswer,
  decodeUploadRelease,
  decodeUploadReleaseAnswer,
} from "./clientMethods.ts";

const MIB = 1024 * 1024;
const SHA = "a".repeat(64);
const UPLOAD_ID = `upl-${"0f".repeat(16)}`;

function invalidParams(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(WorkerMethodError);
  expect((thrown as WorkerMethodError).code).toBe("invalid_params");
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  stagedAttachmentId: "p8a-0123456789abcdef",
  name: "report.pdf",
  mimeType: "application/pdf",
  size: 3,
  sha256: SHA,
  source: "/home/user/report.pdf",
  ...overrides,
});

test("names the three upload methods", () => {
  expect([
    CLIENT_METHODS.uploadsOpen,
    CLIENT_METHODS.uploadsPut,
    CLIENT_METHODS.uploadsRelease,
  ]).toEqual(["uploads.open", "uploads.put", "uploads.release"]);
});

describe("tools.prepare's uploads", () => {
  const prepare = (uploads: unknown) =>
    decodeToolPrepare({
      json: { name: "confluence_mutate_page", args: {}, uploads },
    });

  test("absent, the request is tools.call's", () => {
    expect(
      decodeToolPrepare({ json: { name: "confluence_mutate_page", args: {} } }),
    ).toEqual({ name: "confluence_mutate_page", args: {} });
  });

  test("decodes up to ten exact entries, prototype-named ids as plain strings", () => {
    const ids = ["__proto__", "constructor", "a b", "x".repeat(128)];
    const decoded = prepare(ids.map((id) => entry({ stagedAttachmentId: id })));
    expect(decoded.uploads?.map((each) => each.stagedAttachmentId)).toEqual(
      ids,
    );
    expect(decoded.args).toEqual({});
    expect(
      prepare(
        Array.from({ length: 10 }, (_, i) =>
          entry({ stagedAttachmentId: `s${i}`, size: 100 * MIB }),
        ),
      ).uploads,
    ).toHaveLength(10);
  });

  test.each<[string, unknown]>([
    ["not an array", entry()],
    ["empty", []],
    [
      "eleven entries",
      Array.from({ length: 11 }, (_, i) =>
        entry({ stagedAttachmentId: `${i}` }),
      ),
    ],
    ["a repeated id", [entry(), entry()]],
    ["an empty id", [entry({ stagedAttachmentId: "" })]],
    ["a 129-character id", [entry({ stagedAttachmentId: "x".repeat(129) })]],
    ["a control character", [entry({ stagedAttachmentId: "a\nb" })]],
    ["a non-ASCII id", [entry({ stagedAttachmentId: "café" })]],
    ["size 0", [entry({ size: 0 })]],
    ["size over 100 MiB", [entry({ size: 100 * MIB + 1 })]],
    ["a fractional size", [entry({ size: 1.5 })]],
    ["a string size", [entry({ size: "3" })]],
    ["an uppercase digest", [entry({ sha256: "A".repeat(64) })]],
    ["a short digest", [entry({ sha256: "a".repeat(63) })]],
    ["a 1,025-character name", [entry({ name: "n".repeat(1025) })]],
    ["a long MIME type", [entry({ mimeType: "m".repeat(1025) })]],
    ["a long source", [entry({ source: "s".repeat(1025) })]],
    ["an extra key", [{ ...entry(), sourcePath: "/etc/passwd" }]],
    ["a missing key", [{ ...entry(), source: undefined }]],
    ["a non-object entry", ["p8a-1"]],
  ])("refuses %s", (_what, uploads) => {
    invalidParams(() => prepare(uploads));
  });
});

describe("tools.apply's uploadId", () => {
  const apply = (json: Record<string, unknown>) =>
    decodeToolApply({
      json: { name: "confluence_mutate_page", site: "s", items: [], ...json },
    });

  test("is optional, and never part of the request the tool sees", () => {
    expect(apply({})).toEqual({
      name: "confluence_mutate_page",
      request: { site: "s", items: [] },
    });
    const decoded = apply({ uploadId: UPLOAD_ID });
    expect(decoded.uploadId).toBe(UPLOAD_ID);
    expect(decoded.request).toEqual({ site: "s", items: [] });
  });

  test.each<unknown>([
    "",
    "upl-",
    UPLOAD_ID.toUpperCase(),
    `${UPLOAD_ID}0`,
    42,
    null,
  ])("refuses %j", (uploadId) => {
    invalidParams(() => apply({ uploadId }));
  });
});

describe("uploads.open", () => {
  const stream = (overrides: Record<string, unknown> = {}) => ({
    stagedAttachmentId: "p8a-1",
    size: MIB,
    sha256: SHA,
    ...overrides,
  });
  const open = (json: unknown, extra: Partial<Payload> = {}) =>
    decodeUploadOpen({ json, ...extra });

  test("decodes one to ten unique streams within W", () => {
    expect(open({ streams: [stream()], work: 2 * MIB })).toEqual({
      streams: [stream()],
      work: 2 * MIB,
    });
    expect(
      open({
        streams: Array.from({ length: 10 }, (_, i) =>
          stream({ stagedAttachmentId: `s${i}`, size: 10 * MIB }),
        ),
        work: 100 * MIB,
      })?.streams,
    ).toHaveLength(10);
  });

  test.each<[string, unknown, Partial<Payload>?]>([
    ["no JSON", undefined],
    ["no streams", { streams: [], work: 1 }],
    [
      "eleven streams",
      {
        streams: Array.from({ length: 11 }, (_, i) =>
          stream({ stagedAttachmentId: `s${i}`, size: 1 }),
        ),
        work: 11,
      },
    ],
    ["a repeated id", { streams: [stream(), stream()], work: 2 * MIB }],
    ["U over W", { streams: [stream()], work: MIB - 1 }],
    ["W over 100 MiB", { streams: [stream()], work: 100 * MIB + 1 }],
    [
      "two 60 MiB streams",
      {
        streams: [
          stream({ stagedAttachmentId: "a", size: 60 * MIB }),
          stream({ stagedAttachmentId: "b", size: 60 * MIB }),
        ],
        work: 100 * MIB,
      },
    ],
    [
      "a stream over 100 MiB",
      { streams: [stream({ size: 101 * MIB })], work: 101 * MIB },
    ],
    ["a bad digest", { streams: [stream({ sha256: "x" })], work: MIB }],
    ["an extra key", { streams: [stream()], work: MIB, userId: "u" }],
    [
      "an extra stream key",
      { streams: [{ ...stream(), name: "n" }], work: MIB },
    ],
    ["a fractional W", { streams: [stream()], work: MIB + 0.5 }],
    [
      "a text stream",
      { streams: [stream()], work: MIB },
      { text: { note: "x" } },
    ],
    [
      "a bytes stream",
      { streams: [stream()], work: MIB },
      { bytes: { chunk: new Uint8Array(1) } },
    ],
  ])("refuses %s", (_what, json, extra) => {
    expect(open(json, extra)).toBeUndefined();
  });
});

describe("uploads.put", () => {
  const chunk = new Uint8Array(16);
  const valid = { uploadId: UPLOAD_ID, stagedAttachmentId: "p8a-1", offset: 0 };

  test("decodes exactly one chunk of 1 B to 1 MiB at a non-negative offset", () => {
    expect(decodeUploadPut({ json: valid, bytes: { chunk } })).toEqual({
      uploadId: UPLOAD_ID,
      put: { ...valid, chunk },
    });
    const full = new Uint8Array(UPLOAD_CHUNK_MAX_BYTES);
    expect(
      decodeUploadPut({ json: { ...valid, offset: 5 }, bytes: { chunk: full } })
        .put?.chunk,
    ).toBe(full);
  });

  test.each<[string, Payload]>([
    ["a negative offset", { json: { ...valid, offset: -1 }, bytes: { chunk } }],
    [
      "a fractional offset",
      { json: { ...valid, offset: 0.5 }, bytes: { chunk } },
    ],
    ["no chunk", { json: valid }],
    ["an empty chunk", { json: valid, bytes: { chunk: new Uint8Array(0) } }],
    [
      "a chunk over 1 MiB",
      {
        json: valid,
        bytes: { chunk: new Uint8Array(UPLOAD_CHUNK_MAX_BYTES + 1) },
      },
    ],
    ["a second bytes stream", { json: valid, bytes: { chunk, more: chunk } }],
    ["a text stream", { json: valid, bytes: { chunk }, text: { chunk: "x" } }],
    ["an extra key", { json: { ...valid, size: 1 }, bytes: { chunk } }],
    [
      "a bad stream id",
      { json: { ...valid, stagedAttachmentId: "" }, bytes: { chunk } },
    ],
  ])(
    "refuses %s, naming the upload so the edge can discard it",
    (_what, payload) => {
      expect(decodeUploadPut(payload)).toEqual({ uploadId: UPLOAD_ID });
    },
  );

  test("an unreadable upload id names nothing", () => {
    expect(
      decodeUploadPut({ json: { ...valid, uploadId: "x" }, bytes: { chunk } }),
    ).toEqual({});
    expect(decodeUploadPut({ bytes: { chunk } })).toEqual({});
  });

  test("the client's chunk cap is the edge store's", () => {
    expect(UPLOAD_CHUNK_MAX_BYTES).toBe(STORE_CHUNK_MAX_BYTES);
    expect(UPLOAD_CHUNK_MAX_BYTES).toBe(1024 * 1024);
  });

  test("a maximal put fits the edge's client message limit", () => {
    // The largest legal JSON: a 128-character id and the largest offset.
    const payload: Payload = {
      json: {
        uploadId: UPLOAD_ID,
        stagedAttachmentId: "~".repeat(128),
        offset: Number.MAX_SAFE_INTEGER,
      },
      bytes: { chunk: new Uint8Array(UPLOAD_CHUNK_MAX_BYTES) },
    };
    const frames = encodeMessage(
      "request",
      2 ** 31 - 1,
      { method: CLIENT_METHODS.uploadsPut },
      payload,
    );
    const assembler = new MessageAssembler(CLIENT_LIMITS);
    const decoder = new FrameDecoder();
    let assembled: Payload | undefined;
    for (const frame of frames)
      decoder.push(frame, (decoded: Frame) => {
        if (decoded.type === "data") assembler.data(decoded);
        else if (decoded.type === "request")
          assembled = assembler.complete(decoded);
      });
    expect(assembled?.bytes?.chunk?.byteLength).toBe(UPLOAD_CHUNK_MAX_BYTES);
    const total = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
    expect(total).toBeLessThan(CLIENT_LIMITS.maxMessageBytes);
  });
});

describe("uploads.release", () => {
  test("decodes the id alone", () => {
    expect(decodeUploadRelease({ json: { uploadId: UPLOAD_ID } })).toBe(
      UPLOAD_ID,
    );
  });

  test.each<[string, Payload]>([
    ["no id", { json: {} }],
    ["a bad id", { json: { uploadId: "upl-1" } }],
    ["an extra key", { json: { uploadId: UPLOAD_ID, force: true } }],
    [
      "a bytes stream",
      { json: { uploadId: UPLOAD_ID }, bytes: { chunk: new Uint8Array(1) } },
    ],
  ])("refuses %s", (_what, payload) => {
    expect(decodeUploadRelease(payload)).toBeUndefined();
  });
});

describe("the client's upload answer decoders", () => {
  const refusal = { ok: false, code: "tool_error", message: "busy" };

  test("each reads its closed success or the tool_error refusal", () => {
    expect(
      decodeUploadOpenAnswer({ json: { ok: true, uploadId: UPLOAD_ID } }),
    ).toEqual({ ok: true, uploadId: UPLOAD_ID });
    expect(
      decodeUploadPutAnswer({
        json: { ok: true, received: 5, streamComplete: true, sealed: false },
      }),
    ).toEqual({ ok: true, received: 5, streamComplete: true, sealed: false });
    expect(decodeUploadReleaseAnswer({ json: { ok: true } })).toEqual({
      ok: true,
    });
    for (const decode of [
      decodeUploadOpenAnswer,
      decodeUploadPutAnswer,
      decodeUploadReleaseAnswer,
    ])
      expect(decode({ json: refusal })).toEqual(refusal);
  });

  test("a refusal's text is capped", () => {
    const answer = decodeUploadOpenAnswer({
      json: { ...refusal, message: "m".repeat(900) },
    });
    expect(answer.ok === false && answer.message.length).toBe(500);
  });

  test.each<[string, (payload: Payload) => unknown, Payload]>([
    ["an open without an id", decodeUploadOpenAnswer, { json: { ok: true } }],
    [
      "an open with a foreign id shape",
      decodeUploadOpenAnswer,
      { json: { ok: true, uploadId: "x" } },
    ],
    [
      "an open with an extra key",
      decodeUploadOpenAnswer,
      { json: { ok: true, uploadId: UPLOAD_ID, more: 1 } },
    ],
    [
      "a sealed put that completed no stream",
      decodeUploadPutAnswer,
      { json: { ok: true, received: 5, streamComplete: false, sealed: true } },
    ],
    [
      "a put with received 0",
      decodeUploadPutAnswer,
      { json: { ok: true, received: 0, streamComplete: false, sealed: false } },
    ],
    [
      "a refusal with another code",
      decodeUploadPutAnswer,
      { json: { ok: false, code: "failed", message: "x" } },
    ],
    [
      "a release with a stream",
      decodeUploadReleaseAnswer,
      { json: { ok: true }, bytes: { file: new Uint8Array(1) } },
    ],
  ])("refuses %s as malformed", (_what, decode, payload) => {
    expect(() => decode(payload)).toThrow(/malformed/);
  });
});
