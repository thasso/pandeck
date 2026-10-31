import { deflateRawSync } from "node:zlib";
import { COMPRESSED_SERVER_FRAME_MIN_BYTES } from "@assistant/shared";

/**
 * Encode one serialized server message as its session-socket frame: the JSON
 * text itself, or its raw DEFLATE stream once it reaches
 * {@link COMPRESSED_SERVER_FRAME_MIN_BYTES} (sent as a binary frame).
 *
 * Synchronous on purpose: frames must leave in the order they were sent, and
 * level 3 deflates a 500 KB session list in a few milliseconds.
 */
export function encodeServerFrame(json: string): string | Buffer {
  if (Buffer.byteLength(json) < COMPRESSED_SERVER_FRAME_MIN_BYTES) return json;
  return deflateRawSync(json, { level: 3 });
}
