import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { ToolCallContext } from "./mcp/tool.ts";
import { commitValidatedKnowledgeChanges } from "./knowledgeBaseEntry.ts";
import {
  getKnowledgeIndex,
  searchKnowledgeIndex,
} from "./knowledgeBaseIndex.ts";
import { KnowledgeBaseStore, type KbFileChange } from "./knowledgeBaseStore.ts";
import { measureCpuMs, measureCpuMsAsync } from "./test/cpuBudget.ts";
import {
  kbDiffTool,
  kbGetEntryTool,
  kbSearchTool,
  kbTreeTool,
  setKnowledgeBaseToolStoreFactoryForTests,
} from "./tools/knowledge/knowledgeBaseTools.ts";

const ENTRY_COUNT = 120;
// CPU time rather than wall clock, so a loaded CI runner does not fail this
// (see ./test/cpuBudget.ts). Indexing and searching the fixture cost ~85ms of
// it, so the budget leaves an order of magnitude for machine-to-machine spread
// while still catching an index or search doing accidental per-entry work.
const PERF_BUDGET_CPU_MS = 1_000;
const LONG_BODY_MARKER = "LONG_CONFIDENTIAL_BODY_MARKER";

let root: string;
let store: KnowledgeBaseStore;

const ctx: ToolCallContext = {
  toolCallId: "kb-regression-test",
  session: {
    sessionId: "sess-kb-regression",
    harness: "pi",
    agentType: "workshop",
    title: "KB regression test",
  },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-regression-test-"));
  store = new KnowledgeBaseStore(root);
  setKnowledgeBaseToolStoreFactoryForTests(() => store);
});

afterEach(() => {
  setKnowledgeBaseToolStoreFactoryForTests(null);
  rmSync(root, { recursive: true, force: true });
});

function entryMarkdown(i: number, body: string): string {
  const padded = String(i).padStart(3, "0");
  return `---
kb:
  schema: 1
  id: kb-regression-${padded}
  type: note
  title: Regression Entry ${padded}
  status: active
  summary: Compact summary for regression entry ${padded} with shared needle.
  tags:
    - regression
    - shared-needle
  aliases:
    - Audit ${padded}
  createdAt: "2026-07-08T09:00:00.000Z"
  updatedAt: "2026-07-08T10:00:00.000Z"
---
# Regression Entry ${padded}

${body}
`;
}

async function seedLargeFixture(): Promise<void> {
  const repeatedBody = `${LONG_BODY_MARKER} shared needle body prose `.repeat(
    260,
  );
  const writes: KbFileChange[] = Array.from(
    { length: ENTRY_COUNT },
    (_, index) => {
      const padded = String(index).padStart(3, "0");
      return {
        op: "write",
        path: `regression/entry-${padded}/index.md`,
        content: entryMarkdown(index, repeatedBody),
      };
    },
  );
  await commitValidatedKnowledgeChanges(store, writes, {
    actor: {
      kind: "system",
      id: "kb-regression",
      name: "KB regression fixture",
    },
    reason: "Seed KB regression fixture",
    entryIds: writes.map(
      (_, index) => `kb-regression-${String(index).padStart(3, "0")}`,
    ),
  });
}

function jsonText(
  result: Awaited<ReturnType<typeof kbTreeTool.execute>>,
): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

describe("KB final regression audit", () => {
  test("indexes/searches/history-checks a large-ish fixture within the fast-suite budget", async () => {
    await seedLargeFixture();

    const { value: index, cpuMs: indexCpuMs } = await measureCpuMsAsync(() =>
      getKnowledgeIndex(store),
    );
    assert.equal(index.entries.length, ENTRY_COUNT);
    assert.equal(index.invalid.length, 0);
    assert.ok(
      index.entries.every((entry) => entry.body.length <= 4_000),
      "index stores bounded body text per entry",
    );

    const { value: search, cpuMs: searchCpuMs } = measureCpuMs(() =>
      searchKnowledgeIndex(index, "shared needle", { limit: 20 }),
    );
    assert.equal(search.length, 20);
    assert.ok(
      search.every((hit) => hit.snippet.length <= 162),
      "compact search snippets stay bounded",
    );
    assert.ok(
      search.every((hit) => !("headings" in hit) && !("aliases" in hit)),
      "compact search rows omit full-detail fields",
    );

    // History is left out of the budget on purpose: it spends its time in a
    // `git log` child process, which costs this process no CPU at all, so a
    // number measured here would say nothing about it either way.
    const history = await store.history({ limit: 5 });
    assert.ok(history.length >= 1);

    const totalCpuMs = indexCpuMs + searchCpuMs;
    assert.ok(
      totalCpuMs < PERF_BUDGET_CPU_MS,
      `large-ish fixture audit should stay fast (${Math.round(totalCpuMs)}ms CPU)`,
    );
  });

  test("agent-facing KB tool defaults stay compact and bounded", async () => {
    await seedLargeFixture();

    const tree = await kbTreeTool.execute({ maxItems: 12 }, ctx);
    const treePayload = tree.details as {
      items: unknown[];
      truncated: boolean;
      counts: { entries: number };
    };
    assert.equal(treePayload.items.length, 12);
    assert.equal(treePayload.truncated, true);
    assert.equal(treePayload.counts.entries, ENTRY_COUNT);
    assert.doesNotMatch(
      jsonText(tree),
      new RegExp(LONG_BODY_MARKER),
      "tree output excludes entry bodies",
    );
    assert.ok(
      jsonText(tree).length < 4_000,
      "small capped tree output remains token-sparse",
    );

    const search = await kbSearchTool.execute(
      { query: "shared needle", maxResults: 999 },
      ctx,
    );
    const searchPayload = search.details as {
      results: Array<Record<string, unknown>>;
    };
    assert.equal(
      searchPayload.results.length,
      100,
      "maxResults is capped for tool output",
    );
    assert.ok(
      searchPayload.results.every(
        (hit) => !("headings" in hit) && !("aliases" in hit),
      ),
      "compact search omits full-detail fields",
    );
    assert.doesNotMatch(
      jsonText(search),
      new RegExp(LONG_BODY_MARKER),
      "compact search does not dump entry bodies",
    );

    const compactEntry = await kbGetEntryTool.execute(
      { entryId: "kb-regression-000" },
      ctx,
    );
    assert.doesNotMatch(
      jsonText(compactEntry),
      /"content"/,
      "compact get omits source content",
    );
    assert.doesNotMatch(jsonText(compactEntry), new RegExp(LONG_BODY_MARKER));

    const fullEntry = await kbGetEntryTool.execute(
      { entryId: "kb-regression-000", detail: "full", maxChars: 512 },
      ctx,
    );
    const fullPayload = fullEntry.details as {
      content: string;
      truncated: boolean;
      totalChars: number;
    };
    assert.equal(fullPayload.content.length, 512);
    assert.equal(fullPayload.truncated, true);
    assert.ok(fullPayload.totalChars > 512);

    const firstCommit = (await store.history({ limit: 1 }))[0]!.commit;
    await commitValidatedKnowledgeChanges(
      store,
      [
        {
          op: "write",
          path: "regression/entry-000/index.md",
          content: entryMarkdown(
            0,
            `${"diff expansion ".repeat(500)}shared needle`,
          ),
        },
      ],
      {
        actor: {
          kind: "system",
          id: "kb-regression",
          name: "KB regression fixture",
        },
        reason: "Expand one regression entry",
        entryIds: ["kb-regression-000"],
      },
    );
    const diff = await kbDiffTool.execute(
      { from: firstCommit, entryId: "kb-regression-000", maxChars: 600 },
      ctx,
    );
    const diffPayload = diff.details as {
      patch: string;
      truncated: boolean;
      totalChars: number;
    };
    assert.equal(diffPayload.patch.length, 600);
    assert.equal(diffPayload.truncated, true);
    assert.ok(diffPayload.totalChars > 600);
  });
});
