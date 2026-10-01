import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";
import {
  buildKnowledgeIndex,
  getKnowledgeIndex,
  KB_INDEX_ARTIFACT,
  loadKnowledgeIndex,
  rebuildKnowledgeIndex,
  searchKnowledgeIndex,
  type KbTreeItem,
} from "./knowledgeBaseIndex.ts";

let root: string;
let store: KnowledgeBaseStore;
const AGENT = { kind: "agent", id: "workshop", name: "Workshop" } as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-index-test-"));
  store = new KnowledgeBaseStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const TS = '"2026-06-01T10:00:00.000Z"';

/** Build a minimal valid entry Markdown document. */
function entryDoc(opts: {
  id: string;
  title: string;
  type?: string;
  status?: string;
  summary?: string;
  tags?: string[];
  aliases?: string[];
  updatedAt?: string;
  body?: string;
}): string {
  const lines = [
    "---",
    "kb:",
    "  schema: 1",
    `  id: ${opts.id}`,
    `  type: ${opts.type ?? "note"}`,
    `  title: ${JSON.stringify(opts.title)}`,
    `  status: ${opts.status ?? "active"}`,
  ];
  if (opts.summary) lines.push(`  summary: ${JSON.stringify(opts.summary)}`);
  if (opts.tags) lines.push(`  tags: [${opts.tags.join(", ")}]`);
  if (opts.aliases)
    lines.push(
      `  aliases: [${opts.aliases.map((a) => JSON.stringify(a)).join(", ")}]`,
    );
  lines.push(
    `  createdAt: ${TS}`,
    `  updatedAt: ${opts.updatedAt ? JSON.stringify(opts.updatedAt) : TS}`,
    "---",
    opts.body ?? "",
  );
  return `${lines.join("\n")}\n`;
}

function flatten(
  items: KbTreeItem[],
  depth = 0,
): { path: string; type: string; depth: number }[] {
  return items.flatMap((item) => [
    { path: item.path, type: item.type, depth },
    ...flatten(item.children, depth + 1),
  ]);
}

describe("tree building", () => {
  test("represents folders, nested entries, and assets with container-first ordering", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "customers/index.md",
          content: entryDoc({
            id: "kb-customers",
            title: "Customers",
            type: "reference",
          }),
        },
        {
          op: "write",
          path: "customers/globex/index.md",
          content: entryDoc({ id: "kb-globex", title: "Globex" }),
        },
        {
          op: "write",
          path: "customers/globex/assets/deck.pdf",
          content: "%PDF",
        },
        {
          op: "write",
          path: "customers/globex/notes.md",
          content: "loose note",
        },
      ],
      { actor: AGENT, reason: "seed" },
    );

    const index = await buildKnowledgeIndex(store);
    const flat = flatten(index.tree);
    const byPath = new Map(flat.map((n) => [n.path, n]));

    assert.equal(byPath.get("customers")?.type, "entry");
    assert.equal(byPath.get("customers/globex")?.type, "entry");
    assert.equal(byPath.get("customers/globex/assets")?.type, "folder");
    assert.equal(byPath.get("customers/globex/assets/deck.pdf")?.type, "asset");
    assert.equal(byPath.get("customers/globex/notes.md")?.type, "file");
    // index.md is folded into the entry node, never a standalone leaf.
    assert.ok(!byPath.has("customers/index.md"));

    // Within customers/globex: container (assets folder) before leaf (notes.md).
    const globexChildren =
      index.tree[0]?.children.find((c) => c.path === "customers/globex")
        ?.children ?? [];
    assert.deepEqual(
      globexChildren.map((c) => c.path),
      ["customers/globex/assets", "customers/globex/notes.md"],
    );
  });

  test("captures broken entries as invalid without hiding valid siblings", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "ok/index.md",
          content: entryDoc({ id: "kb-ok", title: "Fine" }),
        },
        // Missing required kb.type / malformed frontmatter.
        {
          op: "write",
          path: "broken/index.md",
          content: "---\nkb:\n  schema: 1\n  id: kb-broken\n---\nbody\n",
        },
      ],
      { actor: AGENT, reason: "seed" },
    );

    const index = await buildKnowledgeIndex(store);
    assert.deepEqual(
      index.entries.map((e) => e.id),
      ["kb-ok"],
    );
    assert.equal(index.invalid.length, 1);
    assert.equal(index.invalid[0]?.path, "broken/index.md");
    assert.match(index.invalid[0]?.error ?? "", /kb\.type/);

    const broken = flatten(index.tree).find((n) => n.path === "broken");
    assert.equal(broken?.type, "invalid-entry");
  });

  test("reflects entry path moves while keeping the stable id", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "draft/note/index.md",
          content: entryDoc({ id: "kb-note", title: "My Note" }),
        },
      ],
      { actor: AGENT, reason: "create" },
    );
    let index = await buildKnowledgeIndex(store);
    assert.equal(index.entries[0]?.path, "draft/note/index.md");
    assert.equal(index.entries[0]?.folder, "draft/note");

    await store.commitChanges(
      [
        { op: "delete", path: "draft/note/index.md" },
        {
          op: "write",
          path: "published/my-note/index.md",
          content: entryDoc({ id: "kb-note", title: "My Note" }),
        },
      ],
      { actor: AGENT, reason: "move" },
    );
    index = await buildKnowledgeIndex(store);
    assert.equal(index.entries.length, 1);
    assert.equal(
      index.entries[0]?.id,
      "kb-note",
      "stable id survives the move",
    );
    assert.equal(index.entries[0]?.path, "published/my-note/index.md");
    assert.ok(
      !flatten(index.tree).some((n) => n.path.startsWith("draft/note")),
    );
  });
});

describe("persistence and rebuild determinism", () => {
  test("excludes the generated index artifact from the source tree", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "a/index.md",
          content: entryDoc({ id: "kb-a", title: "A" }),
        },
      ],
      { actor: AGENT, reason: "seed" },
    );
    await rebuildKnowledgeIndex(store);

    // The persisted artifact lives under .kb/generated and must never surface.
    assert.ok(await store.readGeneratedFile(KB_INDEX_ARTIFACT));
    const index = await buildKnowledgeIndex(store);
    assert.ok(
      !flatten(index.tree).some((n) => n.path.includes(".kb/generated")),
    );
    assert.ok(
      !flatten(index.tree).some((n) => n.path.includes(KB_INDEX_ARTIFACT)),
    );
  });

  test("rebuild is deterministic and does not rewrite unchanged content", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "a/index.md",
          content: entryDoc({ id: "kb-a", title: "A" }),
        },
      ],
      { actor: AGENT, reason: "seed" },
    );
    const first = await rebuildKnowledgeIndex(store);
    assert.equal(first.written, true);
    const second = await rebuildKnowledgeIndex(store);
    assert.equal(second.written, false, "no rewrite when nothing changed");
    assert.deepEqual(second.index.entries, first.index.entries);
  });

  test("getKnowledgeIndex reuses the persisted artifact until HEAD changes", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "a/index.md",
          content: entryDoc({ id: "kb-a", title: "A" }),
        },
      ],
      { actor: AGENT, reason: "seed" },
    );
    const built = await getKnowledgeIndex(store);
    const persisted = await loadKnowledgeIndex(store);
    assert.ok(persisted);
    assert.equal(persisted?.head, built.head);

    await store.commitChanges(
      [
        {
          op: "write",
          path: "b/index.md",
          content: entryDoc({ id: "kb-b", title: "B" }),
        },
      ],
      { actor: AGENT, reason: "add b" },
    );
    const refreshed = await getKnowledgeIndex(store);
    assert.notEqual(
      refreshed.head,
      built.head,
      "HEAD change triggers a rebuild",
    );
    assert.deepEqual(refreshed.entries.map((e) => e.id).sort(), [
      "kb-a",
      "kb-b",
    ]);
  });
});

describe("search", () => {
  async function seedSearchCorpus() {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "titlematch/index.md",
          content: entryDoc({
            id: "kb-title",
            title: "Watermarking overview",
            type: "brief",
            updatedAt: "2026-07-01T00:00:00.000Z",
          }),
        },
        {
          op: "write",
          path: "tagmatch/index.md",
          content: entryDoc({
            id: "kb-tag",
            title: "Customer brief",
            tags: ["watermarking", "customer"],
            updatedAt: "2026-07-02T00:00:00.000Z",
          }),
        },
        {
          op: "write",
          path: "bodymatch/index.md",
          content: entryDoc({
            id: "kb-body",
            title: "Random notes",
            updatedAt: "2026-07-03T00:00:00.000Z",
            body: "# Background\nThis discusses watermarking pipelines at length.",
          }),
        },
        {
          op: "write",
          path: "aliasmatch/index.md",
          content: entryDoc({
            id: "kb-alias",
            title: "NEBULAMark",
            aliases: ["Watermarking product"],
            updatedAt: "2026-07-04T00:00:00.000Z",
          }),
        },
      ],
      { actor: AGENT, reason: "seed corpus" },
    );
    return buildKnowledgeIndex(store);
  }

  test("ranks title matches above alias, tag, then body matches", async () => {
    const index = await seedSearchCorpus();
    const hits = searchKnowledgeIndex(index, "watermarking");
    assert.deepEqual(
      hits.map((h) => h.id),
      ["kb-title", "kb-alias", "kb-tag", "kb-body"],
    );
    // Compact rows carry a snippet but no verbose fields.
    assert.ok(hits[0]?.snippet !== undefined);
    assert.equal(hits[0]?.tags, undefined);
    assert.equal(hits[0]?.matchedFields, undefined);
  });

  test("respects limit, type filter, and detail levels", async () => {
    const index = await seedSearchCorpus();

    const limited = searchKnowledgeIndex(index, "watermarking", { limit: 2 });
    assert.equal(limited.length, 2);

    const briefs = searchKnowledgeIndex(index, "watermarking", {
      types: ["brief"],
    });
    assert.deepEqual(
      briefs.map((h) => h.id),
      ["kb-title"],
    );

    const standard = searchKnowledgeIndex(index, "watermarking", {
      detail: "standard",
      limit: 1,
    });
    assert.ok(standard[0]?.matchedFields?.includes("title"));
    assert.ok("tags" in (standard[0] ?? {}));
    assert.equal(
      standard[0]?.headings,
      undefined,
      "headings are full-detail only",
    );

    const full = searchKnowledgeIndex(index, "watermarking pipelines", {
      detail: "full",
    });
    const bodyHit = full.find((h) => h.id === "kb-body");
    assert.ok(bodyHit?.headings?.includes("Background"));
    assert.equal(bodyHit?.folder, "bodymatch");
  });

  test("returns nothing for an empty query and misses", async () => {
    const index = await seedSearchCorpus();
    assert.equal(searchKnowledgeIndex(index, "   ").length, 0);
    assert.equal(searchKnowledgeIndex(index, "nonexistentterm").length, 0);
  });
});
