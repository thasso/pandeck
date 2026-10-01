import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "vitest";
import {
  removeBackgroundDeliveryOutput,
  writeBackgroundDeliveryOutput,
} from "./deliveryOutput.ts";

test("activity output lives in a private turn-scoped file until discard", () => {
  const output = writeBackgroundDeliveryOutput(["ready", "changed"], 3);
  assert.ok(output);
  assert.equal(statSync(output.path).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(output.path, "utf8"),
    "ready\nchanged\n[3 event(s) dropped by the bounded monitor buffer]\n",
  );

  removeBackgroundDeliveryOutput(output.cleanupPath);
  assert.equal(existsSync(output.path), false);
});
