import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { findRelatedKnowledge } from "./relatedKnowledge.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function store(): KnowledgeBaseStore {
  const root = mkdtempSync(join(tmpdir(), "related-kb-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return new KnowledgeBaseStore(root);
}

function entry(
  id: string,
  type: string,
  title: string,
  body: string,
  tags: string[] = ["x"],
): string {
  const now = "2026-07-20T00:00:00.000Z";
  return [
    "---",
    "kb:",
    "  schema: 1",
    `  id: ${id}`,
    `  type: ${type}`,
    `  title: "${title}"`,
    "  status: active",
    `  createdAt: "${now}"`,
    `  updatedAt: "${now}"`,
    "  tags:",
    ...tags.map((t) => `    - "${t}"`),
    "---",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

test("surfaces related existing entries and excludes day-scan-owned artifacts", async () => {
  const kb = store();
  await kb.commitChanges(
    [
      {
        op: "write",
        path: "references/drm-session-binding/index.md",
        content: entry(
          "license-service-drm-session-binding-overview",
          "reference",
          "DRM session binding overview",
          "How DRM session tokens and CDN leaching protection work.",
          ["drm", "session-token"],
        ),
      },
      {
        op: "write",
        path: "references/widgets/index.md",
        content: entry(
          "widget-notes",
          "note",
          "Widget colour palette",
          "Unrelated notes about button colours.",
        ),
      },
      {
        op: "write",
        path: "daily-summaries/2026-07-22/index.md",
        content: entry(
          "daily-summary-2026-07-22",
          "daily-summary",
          "Daily summary about DRM session token work",
          "DRM session token mentions here too.",
          ["daily-summary"],
        ),
      },
      {
        op: "write",
        path: "meetings/2026-07-22-sales/index.md",
        content: entry(
          "meeting-abc123",
          "note",
          "DRM session token sales meeting",
          "Discussed DRM session token.",
          ["meeting-minutes"],
        ),
      },
    ],
    { actor: { kind: "system", name: "test" }, reason: "seed kb" },
  );

  const related = await findRelatedKnowledge(kb, {
    terms: ["DRM session token", "CDN leaching"],
  });
  const ids = related.map((r) => r.entryId);
  assert.ok(
    ids.includes("license-service-drm-session-binding-overview"),
    "finds the existing DRM overview",
  );
  assert.ok(
    !ids.includes("daily-summary-2026-07-22"),
    "never cross-references a daily summary",
  );
  assert.ok(
    !ids.includes("meeting-abc123"),
    "never cross-references a per-meeting entry",
  );
  assert.ok(
    !ids.includes("widget-notes"),
    "unrelated entry does not match the DRM terms",
  );
});

test("no usable terms yields no related entries", async () => {
  const kb = store();
  assert.deepEqual(
    await findRelatedKnowledge(kb, { terms: ["a", "the", "sync"] }),
    [],
  );
});
