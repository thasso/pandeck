import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";
import { buildKnowledgeIndex } from "./knowledgeBaseIndex.ts";
import { buildKnowledgeContextAttachment } from "./knowledgeBaseContext.ts";
import {
  resolveKnowledgeEntryResponse,
  resolveKnowledgeInspectorResponse,
} from "./knowledgeBaseHttp.ts";

let root: string;
let store: KnowledgeBaseStore;
const AGENT = { kind: "agent", id: "workshop", name: "Workshop" } as const;
const TS = '"2026-06-01T10:00:00.000Z"';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-http-test-"));
  store = new KnowledgeBaseStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entryDoc(opts: {
  id: string;
  title: string;
  summary?: string;
  tags?: string[];
  body?: string;
}): string {
  const lines = [
    "---",
    "kb:",
    "  schema: 1",
    `  id: ${opts.id}`,
    "  type: note",
    `  title: ${JSON.stringify(opts.title)}`,
    "  status: active",
  ];
  if (opts.summary) lines.push(`  summary: ${JSON.stringify(opts.summary)}`);
  if (opts.tags) lines.push(`  tags: [${opts.tags.join(", ")}]`);
  lines.push(
    `  createdAt: ${TS}`,
    `  updatedAt: ${TS}`,
    "---",
    opts.body ?? "",
  );
  return `${lines.join("\n")}\n`;
}

describe("resolveKnowledgeEntryResponse", () => {
  test("returns a rendered document with body, outline levels, and image assets", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "notes/deep/index.md",
          content: entryDoc({
            id: "kb-deep",
            title: "Deep Note",
            summary: "A deep note.",
            tags: ["alpha", "beta"],
            body: "## Overview\n\nSome prose.\n\n## Details\n\nMore text.\n",
          }),
        },
        {
          op: "write",
          path: "notes/deep/assets/diagram.png",
          content: "PNGDATA",
        },
      ],
      { actor: AGENT, reason: "seed" },
    );

    const index = await buildKnowledgeIndex(store);
    const res = await resolveKnowledgeEntryResponse(store, index, {
      id: "kb-deep",
    });
    assert.ok(res);
    assert.equal(res.kind, "entry");
    if (res.kind !== "entry") return;
    assert.equal(res.title, "Deep Note");
    assert.equal(res.slug, "deep");
    assert.equal(res.uri, "pa://knowledge/kb-deep");
    assert.deepEqual(res.outline, [
      { text: "Overview", level: 2 },
      { text: "Details", level: 2 },
    ]);
    assert.ok(res.markdown.includes("Some prose."));
    // Frontmatter is stripped from the rendered body.
    assert.ok(!res.markdown.includes("schema:"));
    const image = res.assets.find((a) => a.path === "assets/diagram.png");
    assert.ok(image);
    assert.equal(image?.isImage, true);
  });

  test("resolves by folder path as well as id", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "topic/index.md",
          content: entryDoc({ id: "kb-topic", title: "Topic" }),
        },
      ],
      { actor: AGENT, reason: "seed" },
    );
    const index = await buildKnowledgeIndex(store);
    const byPath = await resolveKnowledgeEntryResponse(store, index, {
      path: "topic",
    });
    assert.equal(byPath?.kind, "entry");
    assert.equal(byPath?.kind === "entry" ? byPath.id : null, "kb-topic");
  });

  test("degrades to an invalid-entry state for unparseable frontmatter", async () => {
    // Bypass validation to write an entry with broken frontmatter on disk.
    await store.commitChanges(
      [
        {
          op: "write",
          path: "broken/index.md",
          content: "no frontmatter here\n",
        },
      ],
      { actor: AGENT, reason: "seed" },
    );
    const index = await buildKnowledgeIndex(store);
    assert.equal(index.entries.length, 0);
    assert.equal(index.invalid.length, 1);
    const res = await resolveKnowledgeEntryResponse(store, index, {
      path: "broken",
    });
    assert.ok(res);
    assert.equal(res.kind, "invalid");
    if (res.kind !== "invalid") return;
    assert.equal(res.folder, "broken");
    assert.ok(res.error);
    assert.ok(res.markdown?.includes("no frontmatter"));
  });

  test("returns compact inspector metadata, related objects, history, and bounded diff", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "alpha/index.md",
          content: entryDoc({
            id: "kb-alpha",
            title: "Alpha",
            body: "Related: pa://task/266\n",
          }),
        },
      ],
      { actor: AGENT, reason: "seed alpha", entryIds: ["kb-alpha"] },
    );
    await store.commitChanges(
      [{ op: "write", path: "alpha/assets/source.txt", content: "source" }],
      { actor: AGENT, reason: "add source", entryIds: ["kb-alpha"] },
    );

    const index = await buildKnowledgeIndex(store);
    const res = await resolveKnowledgeInspectorResponse(store, index, {
      id: "kb-alpha",
    });
    assert.ok(res);
    assert.equal(res.kind, "entry");
    if (res.kind !== "entry") return;
    assert.equal(res.frontmatter.id, "kb-alpha");
    assert.equal(
      res.assets.some((asset) => asset.path === "assets/source.txt"),
      true,
    );
    assert.equal(
      res.paObjectReferences.some((link) => link.uri === "pa://task/266"),
      true,
    );
    assert.equal(res.history.length, 2);
    assert.ok(res.latestDiff?.patch.includes("source.txt"));
    assert.ok(!res.latestDiff?.patch.includes("Related: pa://task/266"));
  });

  test("hides retired comment-log-only commits from history", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "alpha/index.md",
          content: entryDoc({
            id: "kb-alpha",
            title: "Alpha",
            body: "original line\n",
          }),
        },
      ],
      { actor: AGENT, reason: "seed alpha", entryIds: ["kb-alpha"] },
    );
    // The retired comment workflow committed ONLY its log, under the entry's
    // own trailer. Those commits stay in Git but never in document history.
    await store.commitChanges(
      [
        {
          op: "write",
          path: ".kb/comments/kb-alpha.jsonl",
          content: '{"type":"comment"}\n',
        },
      ],
      { actor: AGENT, reason: "add comment", entryIds: ["kb-alpha"] },
    );
    await store.commitChanges(
      [
        {
          op: "write",
          path: "alpha/index.md",
          content: entryDoc({
            id: "kb-alpha",
            title: "Alpha",
            body: "reworded line\n",
          }),
        },
      ],
      { actor: AGENT, reason: "reword the line", entryIds: ["kb-alpha"] },
    );

    const index = await buildKnowledgeIndex(store);
    const res = await resolveKnowledgeInspectorResponse(store, index, {
      id: "kb-alpha",
    });
    assert.equal(res?.kind, "entry");
    if (res?.kind !== "entry") return;
    const subjects = res.history.map((row) => row.subject);
    assert.deepEqual(subjects, ["reword the line", "seed alpha"]);
    // The default diff is the latest content change, never the log commit.
    assert.equal(res.latestDiff?.commit, res.history[0]?.fullCommit);
    assert.ok(res.latestDiff?.patch.includes("reworded line"));
  });

  test("includes path-scoped history even when the entry is absent from recent whole-KB history", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "alpha/index.md",
          content: entryDoc({ id: "kb-alpha", title: "Alpha" }),
        },
      ],
      { actor: AGENT, reason: "seed alpha", entryIds: ["kb-alpha"] },
    );
    // Push Alpha beyond the whole-KB 100-commit lookup window by repeatedly
    // updating one unrelated entry. Reusing one path keeps this history test
    // focused on commit depth instead of also stress-testing a growing Git index.
    for (let i = 0; i < 105; i += 1) {
      await store.commitChanges(
        [
          {
            op: "write",
            path: "other/index.md",
            content: entryDoc({ id: "kb-other", title: `Other ${i}` }),
          },
        ],
        { actor: AGENT, reason: `update other ${i}`, entryIds: ["kb-other"] },
      );
    }

    const index = await buildKnowledgeIndex(store);
    const res = await resolveKnowledgeInspectorResponse(store, index, {
      id: "kb-alpha",
    });
    assert.equal(res?.kind, "entry");
    if (res?.kind !== "entry") return;
    assert.equal(res.history.length, 1);
    assert.equal(res.history[0]?.subject, "seed alpha");
    assert.ok(res.latestDiff?.patch.includes("alpha/index.md"));
  });

  test("includes structured per-file old/new text for rich diff rendering", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "beta/index.md",
          content: entryDoc({ id: "kb-beta", title: "Beta", body: "one\n" }),
        },
      ],
      { actor: AGENT, reason: "seed beta", entryIds: ["kb-beta"] },
    );
    await store.commitChanges(
      [
        {
          op: "write",
          path: "beta/index.md",
          content: entryDoc({ id: "kb-beta", title: "Beta", body: "two\n" }),
        },
      ],
      { actor: AGENT, reason: "update beta", entryIds: ["kb-beta"] },
    );

    const index = await buildKnowledgeIndex(store);
    const latest = await resolveKnowledgeInspectorResponse(store, index, {
      id: "kb-beta",
    });
    assert.equal(latest?.kind, "entry");
    if (latest?.kind !== "entry") return;
    const modified = latest.latestDiff?.files.find(
      (file) => file.path === "beta/index.md",
    );
    assert.ok(modified, "expected a file entry for beta/index.md");
    assert.equal(modified?.status, "modified");
    assert.equal(modified?.binary, false);
    assert.ok(modified?.oldText?.includes("one"));
    assert.ok(modified?.newText?.includes("two"));

    // The very first commit reports the file as added with no old side.
    const seedCommit = latest.history[latest.history.length - 1]?.fullCommit;
    assert.ok(seedCommit);
    const seeded = await resolveKnowledgeInspectorResponse(store, index, {
      id: "kb-beta",
      diffCommit: seedCommit,
    });
    assert.equal(seeded?.kind, "entry");
    if (seeded?.kind !== "entry") return;
    const added = seeded.latestDiff?.files.find(
      (file) => file.path === "beta/index.md",
    );
    assert.equal(added?.status, "added");
    assert.equal(added?.oldText, null);
    assert.ok(added?.newText?.includes("one"));
  });

  test("builds Knowledge context attachment without raw body content", async () => {
    await store.commitChanges(
      [
        {
          op: "write",
          path: "alpha/index.md",
          content: entryDoc({
            id: "kb-alpha",
            title: "Alpha",
            summary: "Compact summary.",
            body: "SECRET BODY SHOULD NOT RIDE ALONG",
          }),
        },
      ],
      { actor: AGENT, reason: "seed alpha", entryIds: ["kb-alpha"] },
    );
    const attachment = await buildKnowledgeContextAttachment("kb-alpha", store);
    assert.ok(attachment);
    assert.equal(attachment.role, "knowledge-context");
    const body = Buffer.from(attachment.data, "base64").toString("utf8");
    assert.ok(body.includes("Entry id: kb-alpha"));
    assert.ok(body.includes("Compact summary."));
    assert.ok(!body.includes("SECRET BODY"));
  });

  test("returns null for a missing entry", async () => {
    const index = await buildKnowledgeIndex(store);
    assert.equal(
      await resolveKnowledgeEntryResponse(store, index, { id: "nope" }),
      null,
    );
  });
});
