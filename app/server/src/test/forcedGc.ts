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
 */
export async function retentionControl(): Promise<{
  retainedVisible: boolean;
  retainedArrayBuffers: number;
  clearedAfterDrop: boolean;
  arrayBuffersAfterDrop: number;
}> {
  await settleGc();
  const baseline = arrayBuffersNow();
  let view: Uint8Array | undefined;
  const target = ((): WeakRef<ArrayBufferLike> => {
    const big = new Uint8Array(100 * MIB);
    big.fill(1);
    view = big.subarray(7, 8);
    return new WeakRef(big.buffer);
  })();
  await settleGc();
  const retainedVisible = target.deref() !== undefined;
  const retainedArrayBuffers = arrayBuffersNow() - baseline;
  // The view is read after the sample, so it is live through it.
  if (view?.byteLength !== 1) throw new Error("the control lost its view");
  view = undefined;
  await settleGc();
  return {
    retainedVisible,
    retainedArrayBuffers,
    clearedAfterDrop: target.deref() === undefined,
    arrayBuffersAfterDrop: arrayBuffersNow() - baseline,
  };
}
