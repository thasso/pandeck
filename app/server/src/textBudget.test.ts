/**
 * `clipText` is the app's one truncation primitive, so its edges are tested
 * HERE rather than inferred from the two callers that spend budgets with it.
 *   pnpm --filter @assistant/server test src/textBudget.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { clipText, TRUNCATION_MARKER } from "./textBudget.ts";

test("text at or under the limit comes back untouched and unmarked", () => {
  assert.deepEqual(clipText("abc", 3), { text: "abc", truncated: false });
  assert.deepEqual(clipText("", 10), { text: "", truncated: false });
});

test("longer text is clipped to a head and marked", () => {
  const clipped = clipText("abcdef", 3);
  assert.equal(clipped.text, `abc${TRUNCATION_MARKER}`);
  assert.equal(clipped.truncated, true);
});

test("a clip never splits a surrogate pair into a lone surrogate", () => {
  // "ab" + one astral character (two UTF-16 code units), clipped at 3 — the cut
  // falls between the pair's lead and trail units.
  const clipped = clipText("ab\u{1F600}", 3);
  assert.equal(clipped.text, `ab${TRUNCATION_MARKER}`);
  assert.ok(
    !/[\uD800-\uDBFF]/.test(clipped.text),
    "no orphaned lead surrogate survives the clip",
  );
});
