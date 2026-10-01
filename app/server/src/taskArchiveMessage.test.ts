import assert from "node:assert/strict";
import { test } from "vitest";
import { validateClientMessage } from "./validateClientMessage.ts";

/**
 * `archiveTask` carries the direction, because the browser offers archiving
 * with an Undo instead of a confirmation prompt: the receipt's Undo is the same
 * message with `archived: false`, and a client that omits the flag still means
 * "archive" (`connection.ts` defaults it).
 */
test("archiveTask accepts the reversible form", () => {
  assert.equal(
    validateClientMessage({ type: "archiveTask", id: "8" }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({ type: "archiveTask", id: "8", archived: false }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({ type: "archiveTask", id: "8", archived: true }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({ type: "archiveTask", id: "8", archived: "no" }).ok,
    false,
  );
  assert.equal(validateClientMessage({ type: "archiveTask" }).ok, false);
});
