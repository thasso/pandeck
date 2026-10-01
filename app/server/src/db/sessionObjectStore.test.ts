import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "session-object-store-test-"));
process.env.ASSISTANT_CWD = tmp;

const { linkSessionToObject, objectRefsForSession, sessionIdsForObject } =
  await import("./sessionObjectStore.ts");

test("persists generic session to object context edges", () => {
  linkSessionToObject("session-1", "knowledge", "kb-entry", "initial-context");
  linkSessionToObject("session-2", "knowledge", "kb-entry", "comment-handoff");

  assert.deepEqual(sessionIdsForObject("knowledge", "kb-entry").sort(), [
    "session-1",
    "session-2",
  ]);
  assert.deepEqual(
    objectRefsForSession("session-2").map(({ objectType, id, source }) => ({
      objectType,
      id,
      source,
    })),
    [{ objectType: "knowledge", id: "kb-entry", source: "comment-handoff" }],
  );
});
