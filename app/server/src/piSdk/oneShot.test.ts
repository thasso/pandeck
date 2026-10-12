import assert from "node:assert/strict";
import { test } from "vitest";
import { piIncompleteStop } from "./oneShot.ts";

test("a pi turn that did not end with a complete answer is reported", () => {
  // The output limit cuts the answer off: keeping the text as whole would
  // keep a truncated answer.
  assert.equal(piIncompleteStop("length"), "length");
  assert.equal(piIncompleteStop("error"), "error");
  assert.equal(piIncompleteStop("aborted"), "aborted");
  assert.equal(piIncompleteStop("stop"), undefined);
  assert.equal(piIncompleteStop("toolUse"), undefined);
  assert.equal(piIncompleteStop(undefined), undefined);
});
