/**
 * Forced garbage collection for retention tests (Task-1441 P8a, v06 X1).
 *
 * "After settlement" means two forced collections, each followed by a
 * `setImmediate` turn, never a synchronous check at return. A retention check
 * watches a backing `ArrayBuffer` through a `WeakRef` plus Node's
 * `arrayBuffers` figure, and a file that asserts retention runs the control
 * (`retentionControl`) first: without a passing control its oracles prove
 * nothing.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

export const MIB = 1024 * 1024;

/** One forced collection, synchronously. */
export function forceGc(): void {
  gc();
}

/** Two forced collections, each followed by a `setImmediate` turn. */
export async function settleGc(): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Node's live `arrayBuffers` bytes. */
export const arrayBuffersNow = (): number => process.memoryUsage().arrayBuffers;

/**
 * The `arrayBuffers` figure once it stops falling: V8 frees a dead buffer's
 * backing store on a concurrent sweeper, so the figure can lag a collection
 * that a `WeakRef` already shows. Settles again until two readings agree (at
 * most 20 rounds); a buffer that is still held never falls, so the bound a
 * caller checks keeps its meaning.
 */
export async function settledArrayBuffers(): Promise<number> {
  await settleGc();
  let reading = arrayBuffersNow();
  for (let round = 0; round < 20; round += 1) {
    await settleGc();
    const next = arrayBuffersNow();
    if (next >= reading) return next;
    reading = next;
  }
  return reading;
}

/** Bytes a non-uniform pattern, so a shifted or clipped copy shows. */
export function patterned(length: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    bytes[index] = state >>> 23;
  }
  return bytes;
}

/**
 * X1's control: a 100 MiB allocation kept alive by one retained 1-byte view
 * must stay visible to both oracles, and dropping the view must clear both.
 * Both states are sampled with `settledArrayBuffers`, the cases' sampler.
 */
export async function retentionControl(): Promise<{
  retainedVisible: boolean;
  retainedArrayBuffers: number;
  clearedAfterDrop: boolean;
  arrayBuffersAfterDrop: number;
}> {
  const baseline = await settledArrayBuffers();
  let view: Uint8Array | undefined;
  const target = ((): WeakRef<ArrayBufferLike> => {
    const big = new Uint8Array(100 * MIB);
    big.fill(1);
    view = big.subarray(7, 8);
    return new WeakRef(big.buffer);
  })();
  // The same sampler the cases use, so the control shows it still sees a
  // retained buffer (v06 X1).
  const retained = await settledArrayBuffers();
  const retainedVisible = target.deref() !== undefined;
  const retainedArrayBuffers = retained - baseline;
  // The view is read after the sample, so it is live through it.
  if (view?.byteLength !== 1) throw new Error("the control lost its view");
  view = undefined;
  const afterDrop = await settledArrayBuffers();
  return {
    retainedVisible,
    retainedArrayBuffers,
    clearedAfterDrop: target.deref() === undefined,
    arrayBuffersAfterDrop: afterDrop - baseline,
  };
}
