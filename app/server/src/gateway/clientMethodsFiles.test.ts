/**
 * Gateway client 1.2's file answers (Task-1441 P7a, G1, G4, H3), on the
 * client: `decodeFileAnswer`'s checks in their order, each refusal typed
 * `unexpected` or `corrupted` with its fixed text, and `decodeToolAnswer`
 * refusing any stream. Every value is fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  FileAnswerRefusal,
  decodeFileAnswer,
  decodeToolAnswer,
  type FileAnswer,
} from "./clientMethods.ts";

const BYTES = new TextEncoder().encode("hello");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const META = {
  name: "notes.txt",
  mimeType: "text/plain",
  size: 5,
  sha256: SHA,
};

const fileAnswer = (
  json: Record<string, unknown> = {},
  file: Record<string, unknown> = {},
  streams: Partial<Payload> = { bytes: { file: BYTES } },
): Payload => ({
  json: {
    ok: true,
    text: '{"status":"saved"}',
    file: { ...META, ...file },
    ...json,
  },
  ...streams,
});

function refused(
  payload: Payload,
  reason: "unexpected" | "corrupted",
  maxBytes = 5,
): void {
  assert.throws(
    () => decodeFileAnswer(payload, { maxBytes }),
    (err: unknown) =>
      err instanceof FileAnswerRefusal &&
      err.reason === reason &&
      err.message === `The gateway's file answer is ${reason}.`,
  );
}

test("a file answer decodes to its text, metadata and bytes", () => {
  const decoded: FileAnswer = decodeFileAnswer(fileAnswer(), { maxBytes: 5 });
  assert.deepEqual(decoded, {
    kind: "file",
    text: '{"status":"saved"}',
    file: META,
    bytes: BYTES,
  });
});

test("a zero-byte file and a 0-character MIME type decode", () => {
  const empty = new Uint8Array(0);
  const sha = createHash("sha256").update(empty).digest("hex");
  const decoded = decodeFileAnswer(
    fileAnswer(
      {},
      { size: 0, sha256: sha, mimeType: "" },
      { bytes: { file: empty } },
    ),
    { maxBytes: 1 },
  );
  assert.equal(decoded.kind, "file");
});

test("a plain success and a failure decode without streams", () => {
  assert.deepEqual(
    decodeFileAnswer({ json: { ok: true, text: "{}" } }, { maxBytes: 5 }),
    { kind: "plain", text: "{}" },
  );
  assert.deepEqual(
    decodeFileAnswer(
      { json: { ok: false, code: "tool_error", message: "busy" } },
      { maxBytes: 5 },
    ),
    { kind: "failure", code: "tool_error", message: "busy" },
  );
  assert.deepEqual(
    decodeFileAnswer(
      { json: { ok: false, code: "weird", message: "x".repeat(600) } },
      { maxBytes: 5 },
    ),
    { kind: "failure", code: "failed", message: "x".repeat(500) },
  );
});

test("1. keys: anything but the exact shapes is unexpected", () => {
  refused({ json: null }, "unexpected");
  refused({ json: [] }, "unexpected");
  refused({ json: { ok: "yes", text: "{}" } }, "unexpected");
  refused({ json: { ok: true, text: 7 } }, "unexpected");
  // A failure is exactly {ok: false, code, message} (O3).
  refused(
    { json: { ok: false, code: "failed", message: "", extra: 1 } },
    "unexpected",
  );
  refused({ json: { ok: false, code: "failed" } }, "unexpected");
  refused({ json: { ok: false, message: "" } }, "unexpected");
  refused(fileAnswer({ extra: 1 }), "unexpected");
  refused(fileAnswer({ file: null }), "unexpected");
  refused(fileAnswer({}, { extra: 1 }), "unexpected");
  const { sha256: _sha, ...noDigest } = META;
  refused(
    { json: { ok: true, text: "{}", file: noDigest }, bytes: { file: BYTES } },
    "unexpected",
  );
});

test("2. streams: exactly one byte stream named file; a plain or failed answer has none", () => {
  refused(fileAnswer({}, {}, {}), "unexpected");
  refused(fileAnswer({}, {}, { bytes: { other: BYTES } }), "unexpected");
  refused(
    fileAnswer({}, {}, { bytes: { file: BYTES, more: BYTES } }),
    "unexpected",
  );
  refused(
    fileAnswer({}, {}, { bytes: { file: BYTES }, text: { note: "x" } }),
    "unexpected",
  );
  refused(
    { json: { ok: true, text: "{}" }, bytes: { file: BYTES } },
    "unexpected",
  );
  refused({ json: { ok: true, text: "{}" }, text: { t: "x" } }, "unexpected");
  refused(
    {
      json: { ok: false, code: "failed", message: "" },
      bytes: { file: BYTES },
    },
    "unexpected",
  );
});

test("3. size: a safe integer equal to the stream and within the limit, even with a valid digest", () => {
  refused(fileAnswer({}, { size: 4 }), "unexpected");
  refused(fileAnswer({}, { size: "5" }), "unexpected");
  refused(fileAnswer({}, { size: 5.5 }), "unexpected");
  refused(fileAnswer(), "unexpected", 4);
  assert.equal(decodeFileAnswer(fileAnswer(), { maxBytes: 5 }).kind, "file");
  assert.equal(decodeFileAnswer(fileAnswer(), { maxBytes: 6 }).kind, "file");
});

test("4. digest: 64 lowercase hex equal to the bytes', else corrupted", () => {
  refused(fileAnswer({}, { sha256: SHA.toUpperCase() }), "corrupted");
  refused(fileAnswer({}, { sha256: SHA.slice(1) }), "corrupted");
  refused(fileAnswer({}, { sha256: "0".repeat(64) }), "corrupted");
  refused(fileAnswer({}, { sha256: 1 }), "corrupted");
  // Checked before the name: a bad digest with a bad name is corrupted.
  refused(fileAnswer({}, { sha256: "0".repeat(64), name: "" }), "corrupted");
});

test("5. name 1-1024 characters, MIME type 0-1024, text at most 60,000", () => {
  refused(fileAnswer({}, { name: "" }), "unexpected");
  refused(fileAnswer({}, { name: "n".repeat(1025) }), "unexpected");
  refused(fileAnswer({}, { name: 1 }), "unexpected");
  refused(fileAnswer({}, { mimeType: "m".repeat(1025) }), "unexpected");
  refused(fileAnswer({}, { mimeType: null }), "unexpected");
  refused(fileAnswer({ text: "t".repeat(60_001) }), "unexpected");
  refused({ json: { ok: true, text: "t".repeat(60_001) } }, "unexpected");
  assert.equal(
    decodeFileAnswer(
      fileAnswer(
        { text: "t".repeat(60_000) },
        { name: "n".repeat(1024), mimeType: "m".repeat(1024) },
      ),
      { maxBytes: 5 },
    ).kind,
    "file",
  );
});

test("decodeToolAnswer refuses any stream as an unexpected file, so a file answer never reads as text (G1)", () => {
  const unexpectedFile = (err: unknown): boolean =>
    err instanceof FileAnswerRefusal && err.reason === "unexpected";
  assert.throws(() => decodeToolAnswer(fileAnswer()), unexpectedFile);
  assert.throws(
    () =>
      decodeToolAnswer({
        json: { ok: true, text: "{}" },
        bytes: { file: BYTES },
      }),
    unexpectedFile,
  );
  assert.throws(
    () =>
      decodeToolAnswer({
        json: { ok: false, code: "failed", message: "" },
        text: { x: "y" },
      }),
    unexpectedFile,
  );
  assert.deepEqual(decodeToolAnswer({ json: { ok: true, text: "{}" } }), {
    ok: true,
    text: "{}",
  });
  assert.deepEqual(
    decodeToolAnswer({ json: { ok: true, text: "{}" }, bytes: {} }),
    {
      ok: true,
      text: "{}",
    },
  );
});
