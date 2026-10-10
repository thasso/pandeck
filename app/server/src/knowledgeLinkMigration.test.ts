import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "kb-link-migration-test-"));
process.env.ASSISTANT_CWD = tmp;

const { rewriteLegacyKnowledgeLinks, migrateKnowledgeLinks } =
  await import("./knowledgeLinkMigration.ts");
const { knowledgeLegacyPath } = await import("./knowledgeLegacyLinks.ts");
const { KnowledgeBaseStore } = await import("./knowledgeBaseStore.ts");
const { createTask, readTask } = await import("./tasks.ts");
const { createMemory } = await import("./memory/memoryService.ts");
const { memoryStore } = await import("./db/memoryStore.ts");
const { resolvePaObjectLinks } = await import("./objectLinkResolver.ts");
const { DATA_DIR } = await import("./config.ts");
const { closeDb } = await import("./db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("rewrites known id links to path links and leaves everything else", () => {
  const paths = new Map([
    ["kb-plan", "projects/acme/plan doc.md"],
    ["kb-notes", "notes.md"],
  ]);
  const { text, count } = rewriteLegacyKnowledgeLinks(
    [
      "See [](pa://knowledge/kb-plan#Rollout), <pa://knowledge/kb-notes>.",
      "Ends with pa://knowledge/kb-notes.",
      "Already a path: pa://knowledge/projects/acme/plan.md",
      "Unknown: pa://knowledge/kb-gone",
    ].join("\n"),
    (id) => paths.get(id),
  );
  assert.equal(count, 3);
  assert.equal(
    text,
    [
      "See [](pa://knowledge/projects/acme/plan%20doc.md#Rollout), <pa://knowledge/notes.md>.",
      "Ends with pa://knowledge/notes.md.",
      "Already a path: pa://knowledge/projects/acme/plan.md",
      "Unknown: pa://knowledge/kb-gone",
    ].join("\n"),
  );
});

test("migrates the KB, Tasks and memory once, keeping history resolvable", async () => {
  // The default folder, so the link resolver reads the same KB.
  const root = join(DATA_DIR, "knowledge");
  const store = new KnowledgeBaseStore(root);
  const meta = {
    actor: { kind: "system" as const, name: "seed" },
    reason: "seed",
  };
  await store.commitChanges(
    [
      {
        op: "write",
        path: "projects/acme/index.md",
        content: "---\nkb:\n  id: kb-acme\n  title: Acme\n---\nThe plan.\n",
      },
      {
        op: "write",
        path: "notes.md",
        content: "# Notes\n\nSee pa://knowledge/kb-acme.\n",
      },
      {
        op: "write",
        path: "busy.md",
        content: "# Busy\n\nSee pa://knowledge/kb-acme.\n",
      },
    ],
    meta,
  );
  // The user is mid-edit on one file: the migration must leave it alone.
  await writeFile(
    join(root, "busy.md"),
    "# Busy\n\nmine pa://knowledge/kb-acme\n",
  );

  const task = createTask({
    title: "Ship Acme",
    description: "Background: pa://knowledge/kb-acme",
    source: { createdBy: "user" },
  });
  const memory = createMemory({
    text: "Acme plan lives at pa://knowledge/kb-acme",
    kind: "fact",
    provenance: { sourceKind: "manual" },
  });
  assert.ok(memory.ok);
  const updatedAt = readTask(task.id)!.updatedAt;

  const summary = await migrateKnowledgeLinks(store);
  assert.deepEqual(
    { ...summary, kbCommit: undefined, backup: undefined },
    {
      legacyIds: 1,
      kbFiles: 1,
      kbCommit: undefined,
      kbFilesSkipped: ["busy.md"],
      tasks: 1,
      memoryCards: 1,
      backup: undefined,
    },
  );
  assert.ok(summary?.backup && existsSync(summary.backup));
  assert.ok(summary.backup.startsWith(DATA_DIR));

  const link = "pa://knowledge/projects/acme/index.md";
  assert.equal(
    await readFile(join(root, "notes.md"), "utf8"),
    `# Notes\n\nSee ${link}.\n`,
  );
  assert.match(
    await readFile(join(root, "busy.md"), "utf8"),
    /mine pa:\/\/knowledge\/kb-acme/,
  );
  assert.equal(readTask(task.id)?.description, `Background: ${link}`);
  assert.equal(readTask(task.id)?.updatedAt, updatedAt, "not an edit");
  assert.equal(
    memoryStore.get(memory.card.id)?.text,
    `Acme plan lives at ${link}`,
  );

  // The frozen map outlives the frontmatter that carried the id.
  await store.commitChanges(
    [{ op: "write", path: "projects/acme/index.md", content: "# Acme\n" }],
    meta,
  );
  assert.equal(knowledgeLegacyPath("kb-acme"), "projects/acme/index.md");

  // Once only.
  assert.equal(await migrateKnowledgeLinks(store), null);
});

test("an old link in history still resolves to its file", async () => {
  const [resolved] = await resolvePaObjectLinks(["pa://knowledge/kb-acme"]);
  assert.equal(resolved?.existence, "exists");
  assert.equal(resolved?.title, "Acme");
  assert.equal(
    resolved?.href,
    "/knowledge/files?path=projects%2Facme%2Findex.md",
  );
});
