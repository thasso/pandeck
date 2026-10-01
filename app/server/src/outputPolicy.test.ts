import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, symlinkSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "vitest";
import {
  OUTPUT_BUDGETS,
  addArtifactNotice,
  boundNativeOutput,
  captureTaskOutputArtifact,
  fullOutputPathFromUnknownToolOutput,
  isQualityGateCommand,
  persistOutputArtifact,
  prepareReadWindow,
  readResultMetadataFromUnknownToolOutput,
  replaceUnknownToolOutputText,
  textFromUnknownToolOutput,
} from "./outputPolicy.ts";
import { deleteToolGroupSessionData } from "./mcp/toolGroups/registry.ts";
import { listSessionArtifacts } from "./mcp/toolGroups/packRuntime.ts";
import { DATA_DIR } from "./config.ts";

describe("bounded native output policy", () => {
  test("adds a smaller default window and log-specific guidance metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pa-output-"));
    try {
      const path = join(dir, "events.jsonl");
      await writeFile(path, `${'{"event":true}\n'.repeat(10_000)}`);
      const decision = await prepareReadWindow({ path }, dir);
      assert.equal(decision.input.limit, OUTPUT_BUDGETS.logReadDefaultLines);
      assert.equal(decision.logLike, true);
      const result = boundNativeOutput({
        toolName: "read",
        toolInput: decision.input,
        raw: `${"first event\n".repeat(120)}`.trimEnd(),
        readDecision: decision,
        readResult: { numLines: 120, startLine: 1, totalLines: 10_000 },
      });
      assert.match(result.text, /Bounded default window/);
      assert.match(result.text, /previous offset=1, next offset=121/);
      assert.match(result.text, /prefer rg '<pattern>' <path>, jq -c/);
      assert.equal(result.elided, false);
      assert.ok(result.retainedChars > result.rawChars);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("explicit read ranges get a larger but still finite safety budget", () => {
    const raw = `${"source line\n".repeat(5_000)}`;
    const result = boundNativeOutput({
      toolName: "read",
      toolInput: { path: "large.ts", offset: 1, limit: 5_000 },
      raw,
    });
    assert.equal(result.elided, true);
    assert.ok(result.text.length <= OUTPUT_BUDGETS.explicitReadChars);
  });

  test("successful quality gates become concise command-aware summaries", () => {
    const raw = `${"vite routine output\n".repeat(8_000)}built in 2.3s\n`;
    const result = boundNativeOutput({
      toolName: "bash",
      toolInput: { command: "pnpm run build" },
      raw,
      exitCode: 0,
    });
    assert.equal(result.mode, "quality-success");
    assert.equal(result.elided, true);
    assert.match(result.text, /Quality gate passed; exit 0/);
    assert.match(result.text, /Command: pnpm run build/);
    assert.match(result.text, /built in 2.3s/);
    assert.ok(result.text.length < 3_000);
  });

  test("failed gates keep a bounded tail, command, exit code, and conflict hint", () => {
    const raw = `${"noise\n".repeat(10_000)}FAIL src/example.test.ts\nExpected 2, received 1\n`;
    const result = boundNativeOutput({
      toolName: "bash",
      toolInput: { command: "git rebase main && pnpm test" },
      raw,
      isError: true,
      exitCode: 1,
    });
    assert.equal(result.mode, "failure");
    assert.match(result.text, /Command failed; exit 1/);
    assert.match(result.text, /git rebase main && pnpm test/);
    assert.match(result.text, /Expected 2, received 1/);
    assert.match(result.text, /git diff --name-only --diff-filter=U/);
    assert.ok(result.text.length < OUTPUT_BUDGETS.failureChars + 1_000);
  });

  test("large diffs keep selected leading hunks and recommend targeted follow-up", () => {
    const raw = `${"@@ hunk @@\n+line\n-line\n".repeat(2_000)}`;
    const result = boundNativeOutput({
      toolName: "bash",
      toolInput: { command: "git diff" },
      raw,
      exitCode: 0,
    });
    assert.equal(result.mode, "diff");
    assert.match(result.text, /git diff --stat/);
    assert.match(result.text, /git diff -- <path>/);
  });

  test("Claude response replacement preserves native object shape", () => {
    const response = {
      stdout: "many lines",
      stderr: "warning",
      rawOutputPath: "/tmp/vendor.log",
    };
    assert.equal(textFromUnknownToolOutput(response), "many lines\nwarning");
    assert.equal(
      fullOutputPathFromUnknownToolOutput({
        details: { fullOutputPath: "/tmp/vendor.log" },
      }),
      "/tmp/vendor.log",
    );
    assert.deepEqual(replaceUnknownToolOutputText(response, "bounded"), {
      stdout: "bounded",
      stderr: "",
      rawOutputPath: "/tmp/vendor.log",
    });
    const fileReadOutput = {
      type: "text",
      file: {
        filePath: "/tmp/file.ts",
        content: "one\ntwo",
        numLines: 2,
        startLine: 401,
        totalLines: 900,
        truncatedByTokenCap: true,
      },
    };
    assert.equal(textFromUnknownToolOutput(fileReadOutput), "one\ntwo");
    assert.deepEqual(readResultMetadataFromUnknownToolOutput(fileReadOutput), {
      numLines: 2,
      startLine: 401,
      totalLines: 900,
      truncatedByTokenCap: true,
    });
    assert.deepEqual(
      replaceUnknownToolOutputText(
        fileReadOutput,
        "one\ntwo\n\n[Use offset=403 to continue.]",
      ),
      {
        ...fileReadOutput,
        file: {
          ...fileReadOutput.file,
          content: "one\ntwo\n\n[Use offset=403 to continue.]",
          numLines: 2,
        },
      },
    );
  });

  test("merges artifact navigation into one renderer-compatible notice", () => {
    const result = addArtifactNotice(
      {
        text: "1\tone\n2\ttwo\n\n[Use offset=3 to continue.]",
        elided: true,
        mode: "read",
        rawChars: 100,
        retainedChars: 50,
      },
      { path: "/tmp/full.log", url: "/api/session-artifacts/s/full.log" },
    );
    assert.equal((result.text.match(/\n\n\[/g) ?? []).length, 1);
    assert.match(result.text, /Use offset=3 to continue\. Full raw output:/);
  });

  test("persists elided raw output in the session artifact store", async () => {
    const sessionId = `output-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const artifact = await persistOutputArtifact({
        sessionId,
        toolName: "bash",
        raw: "complete raw output\n",
      });
      assert.equal(
        await readFile(artifact.path, "utf8"),
        "complete raw output\n",
      );
      assert.match(artifact.url, /\/api\/session-artifacts\//);
      const [stored] = listSessionArtifacts(sessionId);
      assert.equal(stored?.sourceTool, "bash");
      assert.equal(stored?.mimeType, "text/plain; charset=utf-8");
    } finally {
      deleteToolGroupSessionData(sessionId);
    }
  });

  test("captures bounded task output without a truncation marker in the body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pa-task-output-"));
    const sessionId = `task-output-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const output = join(dir, "task.out");
      await writeFile(output, "before\u001b[31mred\u001b[0m\n\tlast\u0001\n");
      const evidence = captureTaskOutputArtifact({
        sessionId,
        outputFile: output,
        trustedRoot: dir,
      });
      assert.equal(evidence.text, true);
      assert.equal(evidence.truncated, false);
      assert.equal(evidence.capturedBytes, "beforered\n\tlast\n".length);
      const artifacts = listSessionArtifacts(sessionId);
      assert.equal(artifacts.length, 1);
      const artifactRelativePath = artifacts[0]!.url.split(
        `/api/session-artifacts/${encodeURIComponent(sessionId)}/`,
      )[1]!;
      assert.equal(
        await readFile(
          join(DATA_DIR, "session-artifacts", sessionId, artifactRelativePath),
          "utf8",
        ),
        "beforered\n\tlast\n",
      );
    } finally {
      deleteToolGroupSessionData(sessionId);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("caps task output at first and last 32 KiB without splitting UTF-8", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pa-task-output-"));
    const sessionId = `task-cap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const output = join(dir, "task.out");
      const text = `${"a".repeat(32_765)}€${"b".repeat(32_768)}€${"c".repeat(32_765)}€`;
      await writeFile(output, text);
      const evidence = captureTaskOutputArtifact({
        sessionId,
        outputFile: output,
        trustedRoot: dir,
      });
      assert.ok(evidence.originalBytes, JSON.stringify(evidence));
      assert.equal(evidence.capturedBytes, 65_536);
      assert.equal(evidence.truncated, true);
      const artifacts = listSessionArtifacts(sessionId);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0]!.size, 65_536);
    } finally {
      deleteToolGroupSessionData(sessionId);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not drop the middle range at or below the capture cap", async () => {
    for (const size of [40_000, 65_536]) {
      const dir = await mkdtemp(join(tmpdir(), "pa-task-output-"));
      const sessionId = `task-range-${size}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        const output = join(dir, "task.out");
        await writeFile(output, "x".repeat(size));
        const evidence = captureTaskOutputArtifact({
          sessionId,
          outputFile: output,
          trustedRoot: dir,
        });
        assert.equal(evidence.originalBytes, size);
        assert.equal(evidence.capturedBytes, size);
        assert.equal(evidence.truncated, false);
      } finally {
        deleteToolGroupSessionData(sessionId);
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("refuses oversized task output before scanning it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pa-task-output-"));
    const sessionId = `task-too-large-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const output = join(dir, "task.out");
      await writeFile(output, "");
      truncateSync(output, 64 * 1024 * 1024 + 1);
      const evidence = captureTaskOutputArtifact({
        sessionId,
        outputFile: output,
        trustedRoot: dir,
      });
      assert.equal(evidence.artifactId, undefined);
      assert.equal(evidence.originalBytes, 64 * 1024 * 1024 + 1);
      assert.equal(evidence.capturedBytes, 0);
      assert.match(evidence.refusalReason ?? "", /too-large/);
      assert.equal(listSessionArtifacts(sessionId).length, 0);
    } finally {
      deleteToolGroupSessionData(sessionId);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses untrusted task output without creating an artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pa-task-output-"));
    const sessionId = `task-refusal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const output = join(dir, "task.out");
      await writeFile(output, "secret output");
      const link = join(dir, "link.out");
      symlinkSync(output, link);
      const evidence = captureTaskOutputArtifact({
        sessionId,
        outputFile: link,
        trustedRoot: dir,
      });
      assert.equal(evidence.artifactId, undefined);
      assert.equal(evidence.capturedBytes, 0);
      assert.match(evidence.refusalReason ?? "", /symlink/);
      assert.equal(listSessionArtifacts(sessionId).length, 0);
      chmodSync(output, 0o000);
      const unreadable = captureTaskOutputArtifact({
        sessionId,
        outputFile: output,
        trustedRoot: dir,
      });
      assert.equal(unreadable.artifactId, undefined);
      assert.equal(listSessionArtifacts(sessionId).length, 0);
    } finally {
      chmodSync(join(dir, "task.out"), 0o600);
      deleteToolGroupSessionData(sessionId);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes representative quality gate forms", () => {
    for (const command of [
      "pnpm --filter @assistant/server test",
      "pnpm run typecheck",
      "npm run build",
      "cargo test",
      "go test ./...",
      "pytest -q",
    ])
      assert.equal(isQualityGateCommand(command), true, command);
    assert.equal(isQualityGateCommand("pnpm install"), false);
  });
});
