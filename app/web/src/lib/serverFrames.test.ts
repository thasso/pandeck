import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inflateServerFrame, ServerFrameReader } from "./serverFrames.ts";

function binaryFrame(json: string): ArrayBuffer {
  const bytes = deflateRawSync(json);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Let every queued inflate and delivery settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("inflateServerFrame", () => {
  it("restores the JSON a server deflated, multi-byte text included", async () => {
    const json = JSON.stringify({
      type: "ready",
      title: "Grüße ✓ ".repeat(500),
    });
    expect(await inflateServerFrame(binaryFrame(json))).toBe(json);
  });
});

describe("ServerFrameReader", () => {
  it("delivers a text frame synchronously while nothing is inflating", () => {
    const delivered: string[] = [];
    const reader = new ServerFrameReader(
      (json) => delivered.push(json),
      () => {},
    );
    reader.push('{"type":"a"}');
    expect(delivered).toEqual(['{"type":"a"}']);
  });

  it("holds later text frames behind an inflating binary frame", async () => {
    const delivered: string[] = [];
    const reader = new ServerFrameReader(
      (json) => delivered.push(json),
      () => {},
    );
    reader.push(binaryFrame('{"type":"big"}'));
    reader.push('{"type":"small"}');
    reader.push(binaryFrame('{"type":"big2"}'));
    reader.push('{"type":"small2"}');
    expect(delivered).toEqual([]);
    await settle();
    expect(delivered).toEqual([
      '{"type":"big"}',
      '{"type":"small"}',
      '{"type":"big2"}',
      '{"type":"small2"}',
    ]);
    reader.push('{"type":"after"}');
    expect(delivered.at(-1)).toBe('{"type":"after"}');
  });

  it("reports an unreadable frame once and delivers nothing after it", async () => {
    const delivered: string[] = [];
    const errors: unknown[] = [];
    const reader = new ServerFrameReader(
      (json) => delivered.push(json),
      (error) => errors.push(error),
    );
    reader.push('{"type":"before"}');
    reader.push(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    reader.push('{"type":"queued"}');
    await settle();
    reader.push('{"type":"later"}');
    reader.push(binaryFrame('{"type":"later2"}'));
    await settle();
    expect(delivered).toEqual(['{"type":"before"}']);
    expect(errors).toHaveLength(1);
  });
});
