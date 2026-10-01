import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifyKnowledgePath,
  isGeneratedKnowledgePath,
  isSourceKnowledgePath,
  KB_ENTRY_INDEX_FILE,
  KB_SCHEMA_VERSION,
  knowledgeEntryIndexPath,
  knowledgeEntrySlug,
  normalizeKnowledgeRelativePath,
  type KbEntryFrontmatterV1,
} from "./knowledgeBaseContract.ts";

test("normalizes human titles into stable entry folder slugs", () => {
  assert.equal(
    knowledgeEntrySlug("  NEBULAMark: Real-world use cases!  "),
    "nebulamark-real-world-use-cases",
  );
  assert.equal(knowledgeEntrySlug("Sam & Jordan sync"), "sam-and-jordan-sync");
  assert.equal(
    knowledgeEntrySlug("Änderungen Überprüfung"),
    "anderungen-uberprufung",
  );
  assert.equal(knowledgeEntrySlug("---"), "entry");
});

test("builds entry index paths from relative entry folders", () => {
  assert.equal(
    knowledgeEntryIndexPath("customers/globex"),
    `customers/globex/${KB_ENTRY_INDEX_FILE}`,
  );
  assert.equal(
    knowledgeEntryIndexPath("customers//globex/"),
    `customers/globex/${KB_ENTRY_INDEX_FILE}`,
  );
  assert.throws(() => knowledgeEntryIndexPath("/customers/globex"), /relative/);
  assert.throws(() => knowledgeEntryIndexPath("../globex"), /relative/);
  assert.throws(
    () => knowledgeEntryIndexPath("customers/globex/assets/source"),
    /assets/,
  );
});

test("classifies source, generated, and reserved KB paths", () => {
  assert.equal(
    classifyKnowledgePath("customers/globex/index.md"),
    "entry-index",
  );
  assert.equal(
    classifyKnowledgePath("customers/globex/assets/brief.pdf"),
    "asset",
  );
  assert.equal(
    classifyKnowledgePath(".kb/comments/kb-globex.jsonl"),
    "comment",
  );
  assert.equal(classifyKnowledgePath(".kb/generated/search.json"), "generated");
  assert.equal(classifyKnowledgePath(".git/config"), "reserved");
  assert.equal(classifyKnowledgePath("README.md"), "other");

  assert.equal(
    isGeneratedKnowledgePath(".kb/generated/extracts/kb-globex.txt"),
    true,
  );
  assert.equal(
    isSourceKnowledgePath(".kb/generated/extracts/kb-globex.txt"),
    false,
  );
  assert.equal(isSourceKnowledgePath(".kb/comments/kb-globex.jsonl"), true);
});

test("rejects absolute and traversal-like relative paths", () => {
  assert.equal(
    normalizeKnowledgeRelativePath("customers/globex"),
    "customers/globex",
  );
  assert.throws(
    () => normalizeKnowledgeRelativePath("/customers/globex"),
    /relative/,
  );
  assert.throws(
    () => normalizeKnowledgeRelativePath("C:\\knowledge\\globex"),
    /relative/,
  );
  assert.throws(
    () => normalizeKnowledgeRelativePath("customers/../globex"),
    /traversal/,
  );
  assert.throws(
    () => normalizeKnowledgeRelativePath("customers/./globex"),
    /traversal/,
  );
});

test("documents the v1 frontmatter shape as a compile-time contract", () => {
  const frontmatter: KbEntryFrontmatterV1 = {
    kb: {
      schema: KB_SCHEMA_VERSION,
      id: "kb-globex-brief",
      type: "plan",
      title: "Globex customer brief",
      status: "active",
      createdAt: "2026-07-07T10:00:00.000Z",
      updatedAt: "2026-07-07T10:00:00.000Z",
      tags: ["customer"],
      aliases: ["Globex"],
      links: ["pa://project/globex"],
      source: { kind: "manual", refs: ["pa://task/256"] },
      assets: [
        {
          path: "assets/source.pdf",
          mimeType: "application/pdf",
          kind: "source",
        },
      ],
    },
  };

  assert.equal(frontmatter.kb.schema, 1);
  assert.equal(frontmatter.kb.type, "plan");
});
