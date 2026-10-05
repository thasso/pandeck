import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { ToolCallContext, ToolResult } from "./mcp/tool.ts";
import { knowledgeFiles, searchKnowledgeFiles } from "./knowledgeBaseIndex.ts";
import { KnowledgeBaseStore, type KbFileChange } from "./knowledgeBaseStore.ts";
import { measureCpuMs, measureCpuMsAsync } from "./test/cpuBudget.ts";
import {
  kbHistoryTool,
  kbListTool,
  kbReadTool,
  kbSearchTool,
  setKnowledgeBaseToolStoreFactoryForTests,
} from "./tools/knowledge/knowledgeBaseTools.ts";

/**
 * The `pnpm run test:kb` audit: over a large-ish folder, what the agent tools
 * return by default stays compact and bounded — no body in a search hit or a
 * listing, a read windowed, a patch capped — and describing and searching the
 * folder stays cheap.
 */

const FILE_COUNT = 120;
// CPU time rather than wall clock, so a loaded CI runner does not fail this
// (see ./test/cpuBudget.ts). The budget leaves an order of magnitude over the
// fixture's cost while still catching a describe or search doing accidental
// per-file work.
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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kb-regression-test-"));
  store = new KnowledgeBaseStore(root);
  setKnowledgeBaseToolStoreFactoryForTests(() => store);
  const changes: KbFileChange[] = Array.from({ length: FILE_COUNT }, (_, i) => {
    const n = String(i).padStart(3, "0");
    return {
      op: "write",
      path: `area-${i % 6}/note-${n}.md`,
      content: `---\ntitle: Regression note ${n}\ntags: [regression, shared-needle]\nsummary: Compact summary ${n} with shared needle.\n---\n# Note ${n}\n\n${`${LONG_BODY_MARKER} shared needle prose. `.repeat(200)}\n`,
    };
  });
  await store.commitChanges(changes, {
    actor: { kind: "agent", name: "Test" },
    reason: "seed fixture",
  });
});

afterEach(() => {
  setKnowledgeBaseToolStoreFactoryForTests(null);
  rmSync(root, { recursive: true, force: true });
});

function text(result: ToolResult): string {
  return JSON.stringify(result.details);
}

describe("KB regression audit", () => {
  test("describes and searches the fixture within the fast-suite budget", async () => {
    const described = await measureCpuMsAsync(() => knowledgeFiles(store));
    assert.equal(described.value.length, FILE_COUNT);
    const searched = measureCpuMs(() =>
      searchKnowledgeFiles(described.value, "shared needle"),
    );
    assert.equal(searched.value.length, 20);
    assert.ok(
      described.cpuMs + searched.cpuMs < PERF_BUDGET_CPU_MS,
      `describe+search took ${described.cpuMs + searched.cpuMs}ms CPU`,
    );
    // A second pass reuses every unchanged file.
    const again = await measureCpuMsAsync(() => knowledgeFiles(store));
    assert.ok(again.cpuMs < PERF_BUDGET_CPU_MS);
  });

  test("tool defaults stay compact and bounded", async () => {
    const search = await kbSearchTool.execute({ query: "shared needle" }, ctx);
    assert.ok(text(search).length < 12_000, "search rows carry snippets only");
    for (const hit of (search.details as { results: { snippet: string }[] })
      .results)
      assert.ok(
        hit.snippet.length <= 170,
        "a hit carries a snippet, not a body",
      );

    const listing = await kbListTool.execute({ maxItems: 12 }, ctx);
    const listed = listing.details as { items: unknown[]; truncated: boolean };
    assert.equal(listed.items.length, 12);
    assert.equal(listed.truncated, true);
    assert.doesNotMatch(text(listing), new RegExp(LONG_BODY_MARKER));

    const read = await kbReadTool.execute(
      { path: "area-0/note-000.md", maxChars: 512 },
      ctx,
    );
    const window = read.details as { content: string; nextStartLine?: number };
    assert.ok(window.content.length <= 512);
    assert.ok(window.nextStartLine !== undefined);

    const [head] = await store.history({ limit: 1 });
    const patch = await kbHistoryTool.execute(
      { commit: head!.shortCommit, maxChars: 600 },
      ctx,
    );
    const shown = patch.details as {
      patch: string;
      truncated: boolean;
      totalChars: number;
    };
    assert.equal(shown.patch.length, 600);
    assert.equal(shown.truncated, true);
    assert.ok(shown.totalChars > 600);
  });
});
