import { expect, test } from "vitest";
import { TtsFrameReader, pcmToWav, type TtsFrame } from "./ttsProtocol.ts";

function framed(header: object, pcm = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(json.length);
  return Buffer.concat([size, json, pcm]);
}

test("framing survives every split and coalesced frames without altering PCM", () => {
  const pcm = Buffer.from([0, 1, 255, 128]);
  const bytes = Buffer.concat([
    framed({ type: "ready" }),
    framed({ type: "audio", id: 1, sampleRate: 24000, bytes: pcm.length }, pcm),
    framed({ type: "cancelled", id: 2 }),
    framed({ type: "error", id: 3 }),
  ]);
  for (let split = 0; split <= bytes.length; split++) {
    const reader = new TtsFrameReader();
    const frames: TtsFrame[] = [];
    reader.feed(bytes.subarray(0, split), (frame) => frames.push(frame));
    reader.feed(bytes.subarray(split), (frame) => frames.push(frame));
    expect(frames).toEqual([
      { type: "ready" },
      { type: "audio", id: 1, pcm },
      { type: "cancelled", id: 2 },
      { type: "error", id: 3 },
    ]);
  }
});

test.each([
  { type: "audio", id: 1, bytes: 1440002, sampleRate: 24000 },
  { type: "audio", id: 1, bytes: 3, sampleRate: 24000 },
  { type: "audio", id: 1, bytes: -2, sampleRate: 24000 },
  { type: "audio", id: 1, bytes: 2, sampleRate: 22050 },
  { type: "error", id: 0 },
  { type: "unknown", id: 1 },
  [],
])("rejects invalid frame %j before buffering an audio body", (header) => {
  expect(() => new TtsFrameReader().feed(framed(header), () => {})).toThrow();
});

test("refuses oversized headers and pipe buffers", () => {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4097);
  expect(() => new TtsFrameReader().feed(size, () => {})).toThrow(/length/);
  expect(() =>
    new TtsFrameReader().feed(Buffer.alloc(1500000), () => {}),
  ).toThrow(/limits/);
});

test("WAV is 24 kHz mono signed PCM16 with exact RIFF/data sizes", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wav = pcmToWav(pcm);
  expect(wav.subarray(0, 4).toString()).toBe("RIFF");
  expect(wav.readUInt32LE(4)).toBe(40);
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(24000);
  expect(wav.readUInt16LE(34)).toBe(16);
  expect(wav.readUInt32LE(40)).toBe(4);
  expect(wav.subarray(44)).toEqual(pcm);
});
