import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
  knowledgeFile,
  knowledgeFiles,
  searchKnowledgeFiles,
} from "./knowledgeBaseIndex.ts";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";

let root: string;
let store: KnowledgeBaseStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kb-index-test-"));
  store = new KnowledgeBaseStore(root);
  await store.commitChanges(
    [
      {
        op: "write",
        path: "projects/acme/plan.md",
        content:
          "---\ntitle: Acme rollout\ntags: [project:acme, rollout]\nsummary: Ship it in Q3.\n---\n# Plan\n\nMigrate the billing service first.\n",
      },
      {
        op: "write",
        path: "legacy/index.md",
        content:
          "---\nkb:\n  schema: 1\n  id: kb-legacy\n  title: Legacy entry\n  tags: [old]\n---\nBody about invoices.\n",
      },
      {
        op: "write",
        path: "notes/no-meta.md",
        content: "# Standup notes\n\nBilling.\n",
      },
      {
        op: "write",
        path: "files/report.pdf",
        content: new Uint8Array([37, 80, 68, 70]),
      },
    ],
    { actor: { kind: "agent", name: "Test" }, reason: "seed" },
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("describes files from frontmatter, the retired kb: schema, headings, or the name", async () => {
  const byPath = new Map((await knowledgeFiles(store)).map((f) => [f.path, f]));
  assert.deepEqual(
    {
      title: byPath.get("projects/acme/plan.md")?.title,
      tags: byPath.get("projects/acme/plan.md")?.tags,
      summary: byPath.get("projects/acme/plan.md")?.summary,
    },
    {
      title: "Acme rollout",
      tags: ["project:acme", "rollout"],
      summary: "Ship it in Q3.",
    },
  );
  assert.equal(byPath.get("legacy/index.md")?.title, "Legacy entry");
  assert.equal(byPath.get("legacy/index.md")?.legacyId, "kb-legacy");
  assert.equal(byPath.get("notes/no-meta.md")?.title, "Standup notes");
  assert.equal(byPath.get("files/report.pdf")?.title, "report.pdf");
});

test("ranks title and path matches first and scopes to a folder", async () => {
  const files = await knowledgeFiles(store);
  const hits = searchKnowledgeFiles(files, "billing");
  assert.deepEqual(hits.map((hit) => hit.path).sort(), [
    "notes/no-meta.md",
    "projects/acme/plan.md",
  ]);
  assert.equal(
    searchKnowledgeFiles(files, "acme rollout")[0]?.path,
    "projects/acme/plan.md",
  );
  assert.deepEqual(
    searchKnowledgeFiles(files, "billing", { under: "notes" }).map(
      (hit) => hit.path,
    ),
    ["notes/no-meta.md"],
  );
  assert.equal(
    searchKnowledgeFiles(files, "report")[0]?.path,
    "files/report.pdf",
  );
});

test("sees the user's uncommitted edits without a commit", async () => {
  await writeFile(
    join(root, "notes/no-meta.md"),
    "# Retro notes\n\nChanged outside.\n",
  );
  // A new mtime is what tells the cache to re-read; force one for fast filesystems.
  await utimes(
    join(root, "notes/no-meta.md"),
    new Date(),
    new Date(Date.now() + 5000),
  );
  assert.equal(
    (await knowledgeFile(store, "notes/no-meta.md"))?.title,
    "Retro notes",
  );
});
