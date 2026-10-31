import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { test } from "vitest";
import { COMPRESSED_SERVER_FRAME_MIN_BYTES } from "@assistant/shared";
import { encodeServerFrame } from "./serverFrames.ts";

test("a message under the threshold stays a JSON text frame", () => {
  const json = JSON.stringify({ type: "ok", text: "x".repeat(100) });
  assert.equal(encodeServerFrame(json), json);
});

test("a message at the threshold becomes a raw-DEFLATE binary frame of its JSON", () => {
  const json = JSON.stringify({ type: "ready", sessions: "s".repeat(40_000) });
  const frame = encodeServerFrame(json);
  assert.ok(Buffer.isBuffer(frame));
  assert.ok(frame.byteLength < json.length / 10);
  assert.equal(inflateRawSync(frame).toString("utf8"), json);
});

test("the threshold counts UTF-8 bytes, not UTF-16 code units", () => {
  // Three bytes per character: under the threshold in characters, over it in bytes.
  const text = "✓".repeat(Math.ceil(COMPRESSED_SERVER_FRAME_MIN_BYTES / 3));
  const frame = encodeServerFrame(text);
  assert.ok(Buffer.isBuffer(frame));
  assert.equal(inflateRawSync(frame).toString("utf8"), text);
});
