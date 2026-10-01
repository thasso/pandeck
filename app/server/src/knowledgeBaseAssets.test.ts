import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  addKnowledgeAsset,
  generatedExtractPathForAsset,
  listKnowledgeAssets,
  normalizeEntryLocalAssetPath,
  readKnowledgeAsset,
  readKnowledgeAssetText,
  readKnowledgeGeneratedExtract,
} from "./knowledgeBaseAssets.ts";
import { commitValidatedKnowledgeChanges } from "./knowledgeBaseEntry.ts";
import {
  KnowledgeBaseError,
  KnowledgeBaseStore,
} from "./knowledgeBaseStore.ts";

const AGENT = { kind: "agent", id: "workshop", name: "Workshop" } as const;
const ENTRY = `---
kb:
  schema: 1
  id: kb-assets-entry
  type: reference
  title: Asset entry
  status: active
  createdAt: "2026-07-07T10:00:00.000Z"
  updatedAt: "2026-07-07T10:00:00.000Z"
  assets: []
---
# Asset entry

Markdown remains primary.
`;

let root: string;
let store: KnowledgeBaseStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-assets-test-"));
  store = new KnowledgeBaseStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("KB asset path containment", () => {
  test("accepts only entry-local assets/ file paths", () => {
    assert.equal(
      normalizeEntryLocalAssetPath("assets/source.pdf"),
      "assets/source.pdf",
    );
    assert.throws(
      () => normalizeEntryLocalAssetPath("../assets/source.pdf"),
      /relative/,
    );
    assert.throws(
      () => normalizeEntryLocalAssetPath("source.pdf"),
      /under "assets\/"/,
    );
    assert.throws(
      () => normalizeEntryLocalAssetPath("assets/../index.md"),
      /relative/,
    );
  });

  test("rejects unsafe add-asset paths before writing", async () => {
    await seedEntry();
    await assert.rejects(
      () =>
        addKnowledgeAsset(
          store,
          {
            entryId: "kb-assets-entry",
            assetPath: "../assets/source.pdf",
            content: "x",
          },
          { actor: AGENT, reason: "Bad asset", taskId: "261" },
        ),
      KnowledgeBaseError,
    );
  });
});

describe("KB asset add/list/read", () => {
  test("adds an asset, records compact metadata, and reads bounded bytes", async () => {
    await seedEntry();

    const result = await addKnowledgeAsset(
      store,
      {
        entryId: "kb-assets-entry",
        assetPath: "assets/source.txt",
        title: "Source text",
        mimeType: "text/plain",
        content: "0123456789",
        updatedAt: "2026-07-07T10:01:00.000Z",
      },
      { actor: AGENT, reason: "Add source asset", taskId: "261" },
    );

    assert.equal(result.asset.path, "assets/source.txt");
    assert.equal(result.asset.sizeBytes, 10);
    assert.equal(result.asset.metadataDeclared, true);
    assert.equal(
      "content" in result.asset,
      false,
      "compact asset listing does not dump file content",
    );
    assert.deepEqual(result.commit.changedPaths.sort(), [
      "entry/assets/source.txt",
      "entry/index.md",
    ]);

    const listed = await listKnowledgeAssets(store, {
      entryId: "kb-assets-entry",
    });
    assert.equal(listed.assets.length, 1);
    assert.equal(listed.assets[0]?.title, "Source text");

    const bytes = await readKnowledgeAsset(store, {
      entryId: "kb-assets-entry",
      assetPath: "assets/source.txt",
      maxBytes: 4,
    });
    assert.equal(bytes.content.toString("utf8"), "0123");
    assert.equal(bytes.sizeBytes, 10);
    assert.equal(bytes.truncated, true);

    const text = await readKnowledgeAssetText(store, {
      entryId: "kb-assets-entry",
      assetPath: "assets/source.txt",
    });
    assert.equal(text.text, "0123456789");
    assert.equal(text.truncated, false);
  });

  test("preserves Markdown and JSON asset content exactly", async () => {
    await seedEntry();
    const markdown =
      "# Asset note\n\nThis deliberately long line must not be wrapped even though ordinary KB entry Markdown bodies are formatted near the preferred column.\n";
    const json = "{  not valid json but still an arbitrary source asset  }\n";

    await addKnowledgeAsset(
      store,
      {
        entryId: "kb-assets-entry",
        assetPath: "assets/raw-note.md",
        mimeType: "text/markdown",
        content: markdown,
        updatedAt: "2026-07-07T10:01:00.000Z",
      },
      { actor: AGENT, reason: "Add raw Markdown asset", taskId: "261" },
    );
    await addKnowledgeAsset(
      store,
      {
        entryId: "kb-assets-entry",
        assetPath: "assets/raw-data.json",
        mimeType: "application/json",
        content: json,
        updatedAt: "2026-07-07T10:02:00.000Z",
      },
      { actor: AGENT, reason: "Add raw JSON asset", taskId: "261" },
    );

    assert.equal(
      await readFile(join(root, "entry/assets/raw-note.md"), "utf8"),
      markdown,
    );
    assert.equal(
      await readFile(join(root, "entry/assets/raw-data.json"), "utf8"),
      json,
    );
  });

  test("lists non-extractable binary assets even when metadata is missing", async () => {
    await seedEntry();
    await commitValidatedKnowledgeChanges(
      store,
      [
        {
          op: "write",
          path: "entry/assets/photo.bin",
          content: Uint8Array.from([0, 1, 2, 3]),
        },
      ],
      { actor: AGENT, reason: "Add unlisted binary", taskId: "261" },
    );

    const listed = await listKnowledgeAssets(store, {
      entryId: "kb-assets-entry",
    });
    assert.equal(listed.assets.length, 1);
    assert.equal(listed.assets[0]?.path, "assets/photo.bin");
    assert.equal(listed.assets[0]?.exists, true);
    assert.equal(listed.assets[0]?.metadataDeclared, false);
    assert.equal(listed.assets[0]?.mimeType, undefined);
  });

  test("rejects text previews for non-text assets without reading unbounded content", async () => {
    await seedEntry();
    await addKnowledgeAsset(
      store,
      {
        entryId: "kb-assets-entry",
        assetPath: "assets/photo.bin",
        mimeType: "application/octet-stream",
        content: Uint8Array.from([0, 1, 2, 3]),
        updatedAt: "2026-07-07T10:01:00.000Z",
      },
      { actor: AGENT, reason: "Add binary", taskId: "261" },
    );

    await assert.rejects(
      () =>
        readKnowledgeAssetText(store, {
          entryId: "kb-assets-entry",
          assetPath: "assets/photo.bin",
        }),
      /not text-like/,
    );
  });
});

describe("KB generated asset extracts", () => {
  test("stores extract text under .kb/generated and excludes it from the source tree", async () => {
    await seedEntry();
    const expectedExtract = generatedExtractPathForAsset(
      "kb-assets-entry",
      "assets/source.pdf",
    );

    const result = await addKnowledgeAsset(
      store,
      {
        entryId: "kb-assets-entry",
        assetPath: "assets/source.pdf",
        title: "Source PDF",
        mimeType: "application/pdf",
        content: "%PDF",
        extractText: "Extracted PDF text for agent search and preview.",
        updatedAt: "2026-07-07T10:01:00.000Z",
      },
      { actor: AGENT, reason: "Add source PDF", taskId: "261" },
    );

    assert.equal(result.extractPath, expectedExtract);
    assert.equal(result.asset.extract?.path, expectedExtract);
    assert.equal(result.asset.extract?.exists, true);

    const extract = await readKnowledgeGeneratedExtract(
      store,
      expectedExtract,
      12,
    );
    assert.equal(extract?.text, "Extracted PD");
    assert.equal(extract?.truncated, true);
    await assert.rejects(
      () =>
        readKnowledgeGeneratedExtract(
          store,
          ".kb/generated/index/kb-index.json",
        ),
      /\.kb\/generated\/extracts\//,
    );

    const tree = await store.listTree();
    assert.ok(
      !tree.some((node) => node.path.startsWith(".kb/generated")),
      "generated extracts are not source tree nodes",
    );
    assert.ok(
      tree.some((node) => node.path === "entry/assets/source.pdf"),
      "source asset remains visible",
    );
  });
});

async function seedEntry(): Promise<void> {
  await commitValidatedKnowledgeChanges(
    store,
    [{ op: "write", path: "entry/index.md", content: ENTRY }],
    {
      actor: AGENT,
      reason: "Seed entry",
      taskId: "261",
      entryIds: ["kb-assets-entry"],
    },
  );
}
