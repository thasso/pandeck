import { describe, expect, it } from "vitest";
import {
  beginLoad,
  dataOf,
  errorOf,
  failFrom,
  failed,
  fromNullable,
  hasData,
  idle,
  isEmpty,
  isInitialLoad,
  isPending,
  loadErrorMessage,
  loading,
  mapData,
  ready,
  refreshing,
  type LoadState,
} from "./loadState.ts";

describe("loadState", () => {
  it("exposes data for every state that has some", () => {
    expect(dataOf(idle<number[]>())).toBeUndefined();
    expect(dataOf(loading<number[]>())).toBeUndefined();
    expect(dataOf(ready([1]))).toEqual([1]);
    expect(dataOf(refreshing([1]))).toEqual([1]);
    expect(dataOf(failed("boom", [1]))).toEqual([1]);
    expect(dataOf(failed<number[]>("boom"))).toBeUndefined();
    expect(hasData(failed<number[]>("boom"))).toBe(false);
    expect(errorOf(failed("boom", [1]))).toBe("boom");
    expect(errorOf(ready([1]))).toBeUndefined();
  });

  it("reports a fetch in flight for loading and refreshing only", () => {
    expect(isPending(loading())).toBe(true);
    expect(isPending(refreshing(1))).toBe(true);
    expect(isPending(idle())).toBe(false);
    expect(isPending(ready(1))).toBe(false);
    expect(isPending(failed("boom"))).toBe(false);
    expect(isInitialLoad(loading())).toBe(true);
    expect(isInitialLoad(refreshing(1))).toBe(false);
  });

  it("calls a region empty only once the source has answered (R1)", () => {
    const empty = (rows: number[]) => rows.length === 0;
    expect(isEmpty(idle<number[]>(), empty)).toBe(false);
    expect(isEmpty(loading<number[]>(), empty)).toBe(false);
    expect(isEmpty(ready<number[]>([]), empty)).toBe(true);
    expect(isEmpty(ready([1]), empty)).toBe(false);
    // Stale-but-shown data is authoritative enough to say "nothing here".
    expect(isEmpty(refreshing<number[]>([]), empty)).toBe(true);
    expect(isEmpty(failed<number[]>("boom"), empty)).toBe(false);
  });

  it("keeps data across a refresh and across a failure (R2)", () => {
    expect(beginLoad(ready([1]))).toEqual(refreshing([1]));
    expect(beginLoad(failed("boom", [1]))).toEqual(refreshing([1]));
    expect(beginLoad(idle())).toEqual(loading());
    expect(beginLoad(failed("boom"))).toEqual(loading());

    expect(failFrom(refreshing([1]), "boom")).toEqual(failed("boom", [1]));
    expect(failFrom(loading<number[]>(), "boom")).toEqual(
      failed<number[]>("boom"),
    );
  });

  it("returns the same state when beginLoad moves nothing", () => {
    const stillLoading = loading<number[]>();
    expect(beginLoad(stillLoading)).toBe(stillLoading);
    const stillRefreshing = refreshing([1]);
    expect(beginLoad(stillRefreshing)).toBe(stillRefreshing);
  });

  it("treats a null subscription list as not loaded", () => {
    expect(fromNullable<number[]>(null)).toEqual(loading());
    expect(fromNullable<number[]>(undefined)).toEqual(loading());
    expect(fromNullable<number[]>([])).toEqual(ready([]));
  });

  it("projects data without losing the status or the error", () => {
    const size = (rows: number[]) => rows.length;
    expect(mapData(idle<number[]>(), size)).toEqual(idle());
    expect(mapData(loading<number[]>(), size)).toEqual(loading());
    expect(mapData(ready([1, 2]), size)).toEqual(ready(2));
    expect(mapData(refreshing([1, 2]), size)).toEqual(refreshing(2));
    expect(mapData(failed("boom", [1, 2]), size)).toEqual(failed("boom", 2));
    expect(mapData(failed<number[]>("boom"), size)).toEqual(
      failed<number>("boom"),
    );
  });

  it("normalizes thrown values into a renderable message", () => {
    expect(loadErrorMessage(new Error("nope"))).toBe("nope");
    expect(loadErrorMessage("nope")).toBe("nope");
    expect(loadErrorMessage(404)).toBe("404");
  });

  it("narrows on status", () => {
    const state: LoadState<number> = ready(7);
    if (state.status === "ready") expect(state.data).toBe(7);
    else expect.unreachable();
  });
});
