import { describe, expect, it } from "vitest";
import { framePeaks, PEAKS_PER_FRAME, PeakRing } from "./waveform.ts";

/** A frame whose second half is loud and first half silent. */
function halfLoudFrame(length = 1600): Int16Array {
  const frame = new Int16Array(length);
  for (let i = length / 2; i < length; i++) frame[i] = 20000;
  return frame;
}

describe("framePeaks", () => {
  it("returns one bar per bucket, normalised to 0..1", () => {
    const peaks = framePeaks(halfLoudFrame(), 8);
    expect(peaks).toHaveLength(8);
    for (const peak of peaks) {
      expect(peak).toBeGreaterThanOrEqual(0);
      expect(peak).toBeLessThanOrEqual(1);
    }
  });

  it("locates energy in the buckets that actually contain it", () => {
    const peaks = framePeaks(halfLoudFrame(), 8);
    expect(peaks.slice(0, 4)).toEqual([0, 0, 0, 0]);
    for (const peak of peaks.slice(4))
      expect(peak).toBeCloseTo(20000 / 32768, 5);
  });

  it("reports silence as zero, so a flat trace really means no audio", () => {
    expect(framePeaks(new Int16Array(800), 4)).toEqual([0, 0, 0, 0]);
  });

  it("handles the extreme negative sample without overflowing past 1", () => {
    const frame = new Int16Array([-32768, 0, 0, 0]);
    expect(framePeaks(frame, 1)[0]).toBe(1);
  });

  it("still returns a full bar set for an empty frame", () => {
    expect(framePeaks(new Int16Array(0), 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it("covers the whole frame — the last bucket takes any remainder", () => {
    // 10 samples over 3 buckets does not divide evenly; the loud final sample
    // must not fall outside every bucket.
    const frame = new Int16Array(10);
    frame[9] = 32767;
    expect(framePeaks(frame, 3)[2]).toBeGreaterThan(0.9);
  });

  it("defaults to the frame budget used by the capture path", () => {
    expect(framePeaks(new Int16Array(1600))).toHaveLength(PEAKS_PER_FRAME);
  });
});

describe("PeakRing", () => {
  it("reads oldest to newest", () => {
    const ring = new PeakRing(8);
    ring.push([0.1, 0.2, 0.3]);
    // Float32 storage: half the memory and ample precision for a display
    // magnitude, so compare approximately rather than bit-exactly.
    const values = ring.toArray();
    expect(values).toHaveLength(3);
    expect(values[0]).toBeCloseTo(0.1, 6);
    expect(values[1]).toBeCloseTo(0.2, 6);
    expect(values[2]).toBeCloseTo(0.3, 6);
    expect(ring.length).toBe(3);
  });

  it("keeps only the most recent peaks once full", () => {
    const ring = new PeakRing(4);
    ring.push([1, 2, 3, 4, 5, 6]);
    expect(ring.toArray()).toEqual([3, 4, 5, 6]);
    expect(ring.length).toBe(4);
  });

  it("wraps correctly across several pushes", () => {
    const ring = new PeakRing(3);
    ring.push([1, 2]);
    ring.push([3, 4]);
    expect(ring.toArray()).toEqual([2, 3, 4]);
  });

  it("bumps a version so the canvas can skip redundant repaints", () => {
    const ring = new PeakRing(4);
    const before = ring.version;
    ring.push([0.5]);
    expect(ring.version).toBeGreaterThan(before);
  });

  it("clears back to empty between utterances", () => {
    const ring = new PeakRing(4);
    ring.push([1, 2, 3]);
    ring.clear();
    expect(ring.toArray()).toEqual([]);
    expect(ring.length).toBe(0);
  });
});
