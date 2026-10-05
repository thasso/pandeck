import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isHiddenKnowledgePath,
  normalizeKnowledgeRelativePath,
} from "./knowledgeBaseContract.ts";

test("normalizes relative paths and refuses absolute paths and traversal", () => {
  assert.equal(normalizeKnowledgeRelativePath(" a\\b//c.md "), "a/b/c.md");
  assert.equal(normalizeKnowledgeRelativePath(""), "");
  for (const bad of ["/etc/passwd", "C:\\x", "a/../b", "./a", "a\0b"])
    assert.throws(() => normalizeKnowledgeRelativePath(bad), /relative/);
});

test("hides every dot-segment path", () => {
  assert.equal(isHiddenKnowledgePath(".git/config"), true);
  assert.equal(isHiddenKnowledgePath("notes/.obsidian/app.json"), true);
  assert.equal(isHiddenKnowledgePath(".gitignore"), true);
  assert.equal(isHiddenKnowledgePath("notes/plan.md"), false);
});
