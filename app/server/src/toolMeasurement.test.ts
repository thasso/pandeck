import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { measureTools } from "./toolMeasurement.ts";

test("measure:tools reports activation overhead, unused bytes, and cache hits", () => {
  const root = mkdtempSync(join(tmpdir(), "measure-tools-"));
  const session = join(root, "sessions", "probe");
  const claude = join(root, "empty-credential-profiles");
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
    const report = measureTools({
      dataDir: root,
      credentialProfilesRoot: claude,
    });
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

test("measure:tools reads Claude transcripts from every account under the data dir, never from HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "measure-tools-accounts-"));
  const usageLine = `${JSON.stringify({
    type: "assistant",
    message: { usage: { input_tokens: 5, cache_read_input_tokens: 3 } },
  })}\n`;
  for (const account of ["claude-default", "claude-work"]) {
    const dir = join(
      root,
      "credential-profiles",
      account,
      "claude",
      "projects",
      "-work-repo",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${account}-session.jsonl`), usageLine);
  }
  // A pi account directory holds no Claude transcripts and is skipped.
  mkdirSync(join(root, "credential-profiles", "openai-x", "pi-agent"), {
    recursive: true,
  });
  // A throwaway HOME inside the fixture holds the decoy the old reader found.
  const home = join(root, "home");
  const homeProjects = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(homeProjects, { recursive: true });
  writeFileSync(join(homeProjects, "home-only.jsonl"), usageLine);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const report = measureTools({ dataDir: root });
    assert.equal(report.retrospective.files, 2);
    assert.equal(report.cache.providerCalls, 2);
    const off = measureTools({ dataDir: root, credentialProfilesRoot: "" });
    assert.equal(off.retrospective.files, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
