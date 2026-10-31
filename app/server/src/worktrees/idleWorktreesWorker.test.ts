/**
 * The idle view's existence check on the Worker (W5, RD-W5-2): a Worker
 * failure makes that row `unknown` with the existing warning, never
 * `missing`, and every other row keeps the kind it had.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "idle-worktrees-worker-"));
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";

const { computeIdleWorktrees } = await import("./idleWorktrees.ts");
const { createWorktree } = await import("./worktrees.ts");
const { insertWorktree } = await import("../db/worktreeStore.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { scriptWorkerAnswersForTests } =
  await import("../test/workerAnswers.ts");
const { FILE_METHODS } = await import("../workerProtocol/fileMethods.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

const repoPath = join(tmp, "mainrepo");
mkdirSync(repoPath, { recursive: true });
sh(repoPath, "init", "-b", "main");
writeFileSync(join(repoPath, "readme.md"), "hello\n");
sh(repoPath, "add", "-A");
sh(repoPath, "commit", "-m", "init");
projectStore.put({
  id: "idle-proj",
  name: "Idle Project",
  key: "IDLE",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot: join(tmp, "wt-root"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

let disarm = () => {};
afterEach(() => disarm());

function row(id: string, path: string): void {
  insertWorktree({
    id,
    projectId: "idle-proj",
    mainRepoRoot: repoPath,
    path,
    branch: id,
    baseBranch: "main",
    baseCommit: "0".repeat(40),
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    removedAt: null,
  });
}

test("a Worker failure at one row's existence check makes only that row unknown", async () => {
  const live = await createWorktree({ projectId: "idle-proj", name: "live" });
  const failing = await createWorktree({
    projectId: "idle-proj",
    name: "failing",
  });
  row("vanished", join(tmp, "wt-root", "never-there"));

  const kinds = async () =>
    Object.fromEntries(
      (await computeIdleWorktrees()).map((item) => [
        item.worktree.id,
        item.kind,
      ]),
    );
  const before = await kinds();
  assert.equal(before.vanished, "missing");
  assert.notEqual(before[failing.id], "unknown");
  assert.notEqual(before[live.id], "unknown");

  const script = scriptWorkerAnswersForTests(FILE_METHODS.exists, [
    { match: (request) => request.path === failing.path, action: "fail" },
  ]);
  disarm = script.disarm;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let after: Record<string, string>;
  let warnings: string[];
  try {
    after = await kinds();
    warnings = warn.mock.calls.map((call) => call.map(String).join(" "));
  } finally {
    warn.mockRestore();
  }

  assert.ok(script.seen.some((request) => request.action === "fail"));
  assert.deepEqual(after, { ...before, [failing.id]: "unknown" });
  assert.deepEqual(warnings, [
    `[worktrees] idle status for ${failing.id} failed: Scripted Worker failure for files.exists.`,
  ]);
});
