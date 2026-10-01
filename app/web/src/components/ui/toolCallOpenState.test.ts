import { expect, test } from "vitest";

/**
 * The open-state rule `ToolCallBlock`/`ThinkingBlock` implement, extracted so the
 * tricky part is pinned without a DOM: an uncontrolled block follows its
 * `defaultOpen` whenever that prop CHANGES (the transcript's expand/collapse-all)
 * and keeps its own toggles in between.
 */
function reduce(steps: Array<{ default?: boolean; toggle?: true }>): boolean {
  let lastDefault = false;
  let internalOpen = false;
  for (const step of steps) {
    if (step.default !== undefined && step.default !== lastDefault) {
      lastDefault = step.default;
      internalOpen = step.default;
    }
    if (step.toggle) internalOpen = !internalOpen;
  }
  return internalOpen;
}

test("expand-all opens a block the user had collapsed", () => {
  expect(reduce([{ default: false }, { default: true }])).toBe(true);
});

test("a manual toggle after expand-all sticks", () => {
  expect(reduce([{ default: true }, { toggle: true }])).toBe(false);
});

test("collapse-all closes a block the user had opened by hand", () => {
  // The subtle case: keying on the default's VALUE rather than on its change
  // would leave this block open, because the stored override was recorded
  // against `false` and the default returns to `false`.
  expect(
    reduce([
      { default: false },
      { toggle: true },
      { default: true },
      { default: false },
    ]),
  ).toBe(false);
});

test("re-rendering with an unchanged default preserves the manual state", () => {
  expect(
    reduce([
      { default: false },
      { toggle: true },
      { default: false },
      { default: false },
    ]),
  ).toBe(true);
});
