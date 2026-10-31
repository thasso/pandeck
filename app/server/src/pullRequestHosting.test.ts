/**
 * Which checkout, and on which side, a live PR card speaks for: the recorded
 * one while it exists, else the main checkout its worktree row remembers. The
 * presence read runs on the recorded side's Worker, and a Worker failure there
 * rejects rather than choosing a root.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pull-request-hosting-"));
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";

const { pullRequestCardCheckout } = await import("./pullRequestHosting.ts");
const { insertWorktree } = await import("./db/worktreeStore.ts");
const { projectStore } = await import("./db/projectStore.ts");
const { DEFAULT_WORKER_SIDE } = await import("./workers/placement.ts");
const { checkoutSideOf } = await import("./worktrees/knowledgeCheckout.ts");
const { mainWorktreeId } = await import("./worktrees/worktreeResolve.ts");
const { isWorkerFailure } = await import("./workers/fileClient.ts");
const { scriptWorkerAnswersForTests } = await import("./test/workerAnswers.ts");
const { FILE_METHODS } = await import("./workerProtocol/fileMethods.ts");

const PROJECT = "hosting-proj";
const mainRepoRoot = join(tmp, "main");
const spawned = join(tmp, "spawned");
const removed = join(tmp, "removed");
mkdirSync(mainRepoRoot, { recursive: true });
mkdirSync(spawned, { recursive: true });

projectStore.put({
  id: PROJECT,
  name: "Hosting Project",
  key: "HOST",
  description: "",
  status: "active",
  localPaths: [{ path: mainRepoRoot, kind: "repo", match: "prefix" }],
  worktreeRoot: join(tmp, "wt-root"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

function row(id: string, path: string): void {
  insertWorktree({
    id,
    projectId: PROJECT,
    mainRepoRoot,
    path,
    branch: id,
    baseBranch: "main",
    baseCommit: "0".repeat(40),
    status: "removed",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    removedAt: 2_000,
  });
}

row("wt-present", spawned);
row("wt-removed", removed);

let disarm = () => {};
afterEach(() => disarm());

test("a recorded root that exists answers with its own side and root", async () => {
  assert.deepEqual(
    await pullRequestCardCheckout({
      repoRoot: spawned,
      worktreeId: "wt-present",
      sessionId: "session-1",
    }),
    { side: checkoutSideOf({ id: "wt-present" }), repoRoot: spawned },
  );
});

test("a removed root with a worktree answers with the main checkout and its side", async () => {
  assert.deepEqual(
    await pullRequestCardCheckout({
      repoRoot: removed,
      worktreeId: "wt-removed",
      sessionId: "session-1",
    }),
    {
      side: checkoutSideOf({ id: mainWorktreeId(PROJECT) }),
      repoRoot: mainRepoRoot,
    },
  );
});

test("a removed root without a worktree keeps the recorded root on the session's side", async () => {
  assert.deepEqual(
    await pullRequestCardCheckout({
      repoRoot: removed,
      sessionId: "session-1",
    }),
    { side: DEFAULT_WORKER_SIDE, repoRoot: removed },
  );
});

test("a Worker failure at the presence read rejects instead of choosing a root", async () => {
  const script = scriptWorkerAnswersForTests(FILE_METHODS.exists, [
    { match: (request) => request.path === spawned, action: "fail" },
  ]);
  disarm = script.disarm;
  await assert.rejects(
    pullRequestCardCheckout({
      repoRoot: spawned,
      worktreeId: "wt-present",
      sessionId: "session-1",
    }),
    (error: unknown) => isWorkerFailure(error),
  );
  assert.ok(
    script.seen.some((seen) => seen.path === spawned && seen.action === "fail"),
    "the read ran on the Worker",
  );
});
