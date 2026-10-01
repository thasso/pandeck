// @vitest-environment jsdom
// The store arms its auto-dismiss only where there is a `window` (it is a
// browser-API wrapper, not one of this package's pure transforms), so its
// timers cannot be exercised in the DOM-free default environment.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  dismissToast,
  getToasts,
  showToast,
  TOAST_BRIEF_MS,
  TOAST_DWELL_MS,
} from "./toast.ts";

/**
 * The toast store's timers. The bug this guards is invisible in a snapshot and
 * only appears under load: a KEYED toast reuses its predecessor's id, so a
 * replacement inherited the old auto-dismiss and could vanish almost at once.
 * That is worst exactly when it matters most — a failure repeating.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const toast of [...getToasts()]) dismissToast(toast.id);
  vi.useRealTimers();
});

it("gives a replacement its full dwell rather than its predecessor's remainder", () => {
  showToast("first failure", { key: "k", durationMs: TOAST_DWELL_MS });
  // Almost all of the first toast's time is gone.
  vi.advanceTimersByTime(TOAST_DWELL_MS - 50);
  expect(getToasts()).toHaveLength(1);

  showToast("second failure", { key: "k", durationMs: TOAST_DWELL_MS });
  // The moment the old timer would have fired, the replacement is still up.
  vi.advanceTimersByTime(100);
  expect(getToasts()).toHaveLength(1);
  expect(getToasts()[0]!.message).toBe("second failure");

  vi.advanceTimersByTime(TOAST_DWELL_MS);
  expect(getToasts()).toHaveLength(0);
});

it("replaces rather than stacks under one key, and stacks without one", () => {
  showToast("a", { key: "k" });
  showToast("b", { key: "k" });
  expect(getToasts()).toHaveLength(1);

  showToast("c");
  showToast("d");
  expect(getToasts()).toHaveLength(3);
});

it("leaves nothing armed once a toast is dismissed by hand", () => {
  const id = showToast("a", { durationMs: TOAST_BRIEF_MS });
  dismissToast(id);
  expect(getToasts()).toHaveLength(0);
  // A second toast that happens to reuse the id must not be cut short.
  const next = showToast("b", { key: "k", durationMs: TOAST_DWELL_MS });
  vi.advanceTimersByTime(TOAST_BRIEF_MS + 50);
  expect(getToasts().map((toast) => toast.id)).toEqual([next]);
});
