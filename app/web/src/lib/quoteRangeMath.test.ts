import assert from "node:assert/strict";
import { test } from "vitest";
import { findQuoteOffsets, normalizeWithMap } from "./quoteRangeMath.ts";

test("normalizes whitespace and maps each character to its raw offset", () => {
  assert.deepEqual(normalizeWithMap(" a\n\t b "), {
    text: " a b ",
    map: [0, 1, 2, 5, 6],
  });
  assert.deepEqual(normalizeWithMap(""), { text: "", map: [] });
});

test("finds a quote across differing whitespace and returns raw offsets", () => {
  const haystack = "Before three\n  emphasized\twords after";
  const offsets = findQuoteOffsets(haystack, "three emphasized words");

  assert.deepEqual(offsets, { start: 7, end: 31 });
  assert.equal(
    haystack.slice(offsets!.start, offsets!.end),
    "three\n  emphasized\twords",
  );
});

test("maps a trailing normalized space to its first raw character", () => {
  assert.deepEqual(findQuoteOffsets("alpha \n\tbeta", "alpha "), {
    start: 0,
    end: 6,
  });
});

test("rejects empty whitespace-only and absent quotes", () => {
  assert.equal(findQuoteOffsets("alpha beta", ""), null);
  assert.equal(findQuoteOffsets("alpha beta", " \n "), null);
  assert.equal(findQuoteOffsets("alpha beta", "gamma"), null);
});
