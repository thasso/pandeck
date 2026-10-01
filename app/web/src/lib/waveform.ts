/**
 * Envelope extraction for the dictation waveform.
 *
 * The audio thread already does the only work that must happen there (format
 * conversion and framing); it posts each ~200 ms frame of Int16 PCM to the main
 * thread anyway, so the display envelope is derived HERE. That keeps the worklet
 * unchanged, adds no messages to keep in sync, and means the plot cannot drift
 * from the audio that was actually captured.
 *
 * One frame yields several bars, so a 200 ms frame at 8 buckets gives ~40 bars a
 * second — smooth enough to read as speech rather than a blocky meter.
 */

/** Bars per delivered frame. */
export const PEAKS_PER_FRAME = 8;

/**
 * Peak magnitude (0..1) per equal bucket of one PCM frame. Peak rather than RMS:
 * the question being answered is "is my voice arriving", and peaks track the
 * shape of speech more legibly at this size.
 */
export function framePeaks(
  frame: Int16Array,
  buckets: number = PEAKS_PER_FRAME,
): number[] {
  const count = Math.max(1, Math.trunc(buckets));
  if (frame.length === 0) return new Array<number>(count).fill(0);

  const out = new Array<number>(count).fill(0);
  const size = frame.length / count;
  for (let bucket = 0; bucket < count; bucket++) {
    const start = Math.floor(bucket * size);
    const end =
      bucket === count - 1 ? frame.length : Math.floor((bucket + 1) * size);
    let peak = 0;
    for (let i = start; i < end; i++) {
      // -32768 negates to itself in int16; Math.abs on the widened number is safe.
      const magnitude = Math.abs(frame[i]!);
      if (magnitude > peak) peak = magnitude;
    }
    out[bucket] = Math.min(1, peak / 32768);
  }
  return out;
}

/**
 * Fixed-capacity ring of recent peaks, oldest first when read.
 *
 * A plain array with `shift()` would be O(n) per bar at 40 bars/second; more
 * importantly this is deliberately NOT React state — re-rendering the composer
 * 40 times a second to move a canvas would be absurd. The waveform component
 * reads this from inside its own animation frame.
 */
export class PeakRing {
  private readonly buffer: Float32Array;
  private next = 0;
  private filled = 0;
  /** Bumped on every write so a consumer can skip redundant repaints. */
  version = 0;

  constructor(readonly capacity: number) {
    this.buffer = new Float32Array(Math.max(1, capacity));
  }

  push(values: readonly number[]): void {
    for (const value of values) {
      this.buffer[this.next] = value;
      this.next = (this.next + 1) % this.buffer.length;
      if (this.filled < this.buffer.length) this.filled++;
    }
    this.version++;
  }

  clear(): void {
    this.buffer.fill(0);
    this.next = 0;
    this.filled = 0;
    this.version++;
  }

  get length(): number {
    return this.filled;
  }

  /** Oldest → newest. */
  toArray(): number[] {
    const out: number[] = [];
    const start = this.filled < this.buffer.length ? 0 : this.next;
    for (let i = 0; i < this.filled; i++)
      out.push(this.buffer[(start + i) % this.buffer.length]!);
    return out;
  }
}
