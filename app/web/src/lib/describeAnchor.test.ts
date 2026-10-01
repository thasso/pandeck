import assert from "node:assert/strict";
import { test } from "vitest";
import { PREFIX_LEN, SUFFIX_LEN } from "@assistant/shared/comments";
import { bundleFromOffsets } from "./describeAnchor.ts";

const DOC =
  "# Notes\n\nThe scheduler  retries failed jobs with backoff.\n\nDone.\n";

test("slices the quote and its context out of the raw document text", () => {
  const start = DOC.indexOf("retries failed jobs");
  const end = start + "retries failed jobs".length;
  assert.deepEqual(bundleFromOffsets(DOC, start, end), {
    quote: {
      exact: "retries failed jobs",
      // Raw text, so the double space the author typed survives.
      prefix: "# Notes\n\nThe scheduler  ",
      suffix: " with backoff.\n\nDone.\n",
    },
    position: { start, end },
  });
});

test("clamps the context to the shared 32-character window", () => {
  const long = `${"a".repeat(100)}QUOTE${"b".repeat(100)}`;
  const bundle = bundleFromOffsets(long, 100, 105);
  assert.equal(bundle?.quote.exact, "QUOTE");
  assert.equal(bundle?.quote.prefix, "a".repeat(PREFIX_LEN));
  assert.equal(bundle?.quote.suffix, "b".repeat(SUFFIX_LEN));
});

test("rejects an empty, collapsed, inverted or out-of-range selection", () => {
  assert.equal(bundleFromOffsets(DOC, 7, 9), null); // whitespace only
  assert.equal(bundleFromOffsets(DOC, 5, 5), null);
  assert.equal(bundleFromOffsets(DOC, 9, 5), null);
  assert.equal(bundleFromOffsets(DOC, -1, 5), null);
  assert.equal(bundleFromOffsets(DOC, 0, DOC.length + 1), null);
  assert.equal(bundleFromOffsets(DOC, 0.5, 5), null);
});
