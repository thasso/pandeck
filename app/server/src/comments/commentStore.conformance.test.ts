import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { CommentStore } from "./commentStore.ts";
import { worktreeCommentStore } from "./worktreeCommentStore.ts";

const OPERATIONS = [
  "list",
  "add",
  "reply",
  "resolve",
  "edit",
  "delete",
  "attach",
] as const;

/** Shared structural/target-guard conformance, run unchanged for every adapter. */
function commentStoreConformance(name: string, store: CommentStore): void {
  describe(`${name} comment store conformance`, () => {
    test("implements the complete narrow store seam", () => {
      for (const operation of OPERATIONS)
        assert.equal(typeof store[operation], "function", operation);
      assert.deepEqual(Object.keys(store).sort(), [...OPERATIONS].sort());
    });

    test("rejects a target owned by another comment lifetime", async () => {
      await assert.rejects(
        store.list({
          kind: "session",
          sessionId: "browser-local",
          entryId: "entry",
          blockIndex: 0,
        }),
        /target|browser-local|session|comments/i,
      );
    });
  });
}

commentStoreConformance("worktree", worktreeCommentStore);
