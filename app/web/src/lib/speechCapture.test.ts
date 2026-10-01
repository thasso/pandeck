import { describe, expect, it } from "vitest";
import { concatFrames, effectiveCaptureRate } from "./speechCapture.ts";

describe("effectiveCaptureRate", () => {
  /**
   * This must agree with the worklet's own rule. If the two drift, the server is
   * told the wrong rate for the audio it receives — the transcript comes back
   * garbled rather than failing outright, which is much harder to diagnose.
   */
  it("reports the decimated rate whenever the context rate is an exact multiple", () => {
    expect(effectiveCaptureRate(48000)).toBe(16000);
    expect(effectiveCaptureRate(32000)).toBe(16000);
    expect(effectiveCaptureRate(16000)).toBe(16000);
  });

  it("passes a non-multiple rate through for the server to resample", () => {
    expect(effectiveCaptureRate(44100)).toBe(44100);
    expect(effectiveCaptureRate(22050)).toBe(22050);
  });
});

describe("concatFrames", () => {
  it("joins frames in order without losing samples", () => {
    const buffer = concatFrames([
      new Int16Array([1, 2]),
      new Int16Array([3]),
      new Int16Array([4, 5]),
    ]);
    expect(Array.from(new Int16Array(buffer))).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles the no-audio case", () => {
    expect(concatFrames([]).byteLength).toBe(0);
  });
});
