import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { commitValidatedKnowledgeChanges } from "../knowledgeBaseEntry.ts";
import { DATA_REGION_END, DATA_REGION_START } from "./appendix.ts";
import { DAY_SCAN_ACTOR_NAME } from "./types.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function store(): KnowledgeBaseStore {
  const root = mkdtempSync(join(tmpdir(), "day-guard-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return new KnowledgeBaseStore(root);
}

const DATE = "2026-07-13";
const ENTRY = `daily-summaries/${DATE}/index.md`;

function dayEntry(regionBody: string, note: string): string {
  return [
    "---",
    "kb:",
    "  schema: 1",
    `  id: daily-summary-${DATE}`,
    "  type: daily-summary",
    `  title: "Daily summary ${DATE}"`,
    "  status: active",
    '  createdAt: "2026-07-13T00:00:00.000Z"',
    '  updatedAt: "2026-07-13T00:00:00.000Z"',
    "  tags:",
    "    - daily-summary",
    "---",
    `# Daily summary ${DATE}`,
    "",
    DATA_REGION_START,
    regionBody,
    DATA_REGION_END,
    "",
    "## Notes",
    "",
    note,
    "",
  ].join("\n");
}

const agent = {
  actor: { kind: "agent" as const, name: "assistant", sessionId: "s1" },
  reason: "edit",
};
const dayScan = {
  actor: { kind: "system" as const, name: DAY_SCAN_ACTOR_NAME },
  reason: "day-scan",
};

async function seed(kb: KnowledgeBaseStore): Promise<void> {
  // The collection run commits the day entry as the day-scan actor (bypassing the tool wrapper).
  await kb.commitChanges(
    [
      {
        op: "write",
        path: ENTRY,
        content: dayEntry("machine data v1", "my note"),
      },
    ],
    dayScan,
  );
}

test("an ordinary agent cannot alter the generated region but can edit Notes outside it", async () => {
  const kb = store();
  await seed(kb);

  // Rewriting inside the markers is rejected.
  await assert.rejects(
    () =>
      commitValidatedKnowledgeChanges(
        kb,
        [
          {
            op: "write",
            path: ENTRY,
            content: dayEntry("HACKED data", "my note"),
          },
        ],
        agent,
      ),
    /generated region/,
  );

  // Editing only the Notes region (markers untouched) is allowed.
  const ok = await commitValidatedKnowledgeChanges(
    kb,
    [
      {
        op: "write",
        path: ENTRY,
        content: dayEntry("machine data v1", "updated note"),
      },
    ],
    agent,
  );
  assert.ok(ok.commit);
});

test("an ordinary agent cannot write day-scan-owned assets; the day-scan actor can", async () => {
  const kb = store();
  await seed(kb);
  const manifest = `daily-summaries/${DATE}/assets/manifest.json`;
  await assert.rejects(
    () =>
      commitValidatedKnowledgeChanges(
        kb,
        [{ op: "write", path: manifest, content: "{}" }],
        agent,
      ),
    /day-scan-owned artifact/,
  );
  // The synthesis/collection actor is allowed through the same wrapper.
  const ok = await commitValidatedKnowledgeChanges(
    kb,
    [{ op: "write", path: manifest, content: '{"ok":true}' }],
    dayScan,
  );
  assert.ok(ok.commit);
});
