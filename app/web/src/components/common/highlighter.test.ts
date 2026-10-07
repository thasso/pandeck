import { beforeEach, expect, test } from "vitest";
import { clearHighlightCache, highlightToHast } from "./highlighter.ts";

beforeEach(() => clearHighlightCache());

test("highlightToHast memoizes by (code, language)", () => {
  const code = "const a = 1;\nconst b = 2;\n";
  const first = highlightToHast(code, "json");
  const second = highlightToHast(code, "json");
  // Identity, not deep equality: the point is that re-renders reuse the tree
  // instead of re-tokenizing (the transcript's dominant cost).
  expect(second).toBe(first);
});

test("aliases resolve to the same cache entry", () => {
  const code = '{"a":1}';
  expect(highlightToHast(code, "json")).toBe(highlightToHast(code, "json"));
});

test("different code or language are separate entries", () => {
  const a = highlightToHast('{"a":1}', "json");
  const b = highlightToHast('{"a":2}', "json");
  expect(b).not.toBe(a);
  expect(highlightToHast('{"a":1}', "markdown")).not.toBe(a);
});

test("clearing the cache drops memoized results", () => {
  const code = '{"a":1}';
  const first = highlightToHast(code, "json");
  clearHighlightCache();
  expect(highlightToHast(code, "json")).not.toBe(first);
});
