import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { measureTools } from "./toolMeasurement.ts";

test("measure:tools reports activation overhead, unused bytes, and cache hits", () => {
  const root = mkdtempSync(join(tmpdir(), "measure-tools-"));
  const session = join(root, "sessions", "probe");
  const claude = join(root, "empty-claude");
  mkdirSync(session, { recursive: true });
  mkdirSync(claude);
  writeFileSync(
    join(session, "native.jsonl"),
    [
      {
        role: "toolResult",
        toolName: "find_tools",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              loaded: ["session_read", "session_search"],
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "session_read" }],
        usage: { inputTokens: 100, cacheReadTokens: 80 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 50, cacheReadTokens: 0 },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  try {
    const report = measureTools({ dataDir: root, claudeProjectsDir: claude });
    assert.equal(report.retrospective.activationEvents, 1);
    assert.equal(report.retrospective.loadedNames, 2);
    assert.equal(report.retrospective.calledAfterLoad, 1);
    assert.ok(report.retrospective.activationDefinitionChars > 0);
    assert.ok(report.retrospective.unusedDefinitionChars > 0);
    assert.deepEqual(
      {
        calls: report.cache.providerCalls,
        hits: report.cache.hits,
        misses: report.cache.misses,
      },
      { calls: 2, hits: 1, misses: 1 },
    );
    assert.equal(report.removedWorkflow.definitionChars, 3_363);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
