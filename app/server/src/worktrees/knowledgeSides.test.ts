/**
 * The Knowledge Base row's checkout side, end to end through the watcher and
 * the background fetch (AC3), and a project registered at the KB root beside
 * it (AC8, dual registration): the KB row never causes or joins a Worker
 * request, the project's run on the Worker, and both share one repo lock.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import { KNOWLEDGE_WORKTREE_ID, type ServerMessage } from "@assistant/shared";
import type { CheckoutSide } from "../workers/placement.ts";

const tmp = mkdtempSync(join(tmpdir(), "knowledge-sides-test-"));
process.env.ASSISTANT_CWD = tmp;
// The sweep and the status path's fetch are production-only.
process.env.ASSISTANT_BACKGROUND_FETCH = "1";

const { checkoutGitOn } = await import("../gitExec.ts");
const { DEFAULT_WORKER_SIDE } = await import("../workers/placement.ts");
const { answerNextInProcessWorkerCallForTests, inProcessWorkerServedForTests } =
  await import("../workers/inProcessWorker.ts");
const { CHECKOUT_GIT_METHODS } =
  await import("../workerProtocol/checkoutMethods.ts");
const { KnowledgeBaseStore } = await import("../knowledgeBaseStore.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { resolveReadableWorktreeRow } = await import("./knowledgeCheckout.ts");
const { mainWorktreeId, resolveWorktreeRow } =
  await import("./worktreeResolve.ts");
const { setWorktreeBroadcaster } = await import("./worktreeEvents.ts");
const { computeWorktreeStatus, readableWorktreeStatus } =
  await import("./worktreeStatus.ts");
const { getWorktreeChanges } = await import("./worktreeDiff.ts");
const { commitWorktree } = await import("./worktreeWrite.ts");
const {
  noteWorktreeInterest,
  onFetchCompleted,
  repoFetchedAt,
  sweepBackgroundFetchForTests,
} = await import("./worktreeFetch.ts");
const {
  addWorktreeViewer,
  onWorktreeGitStateChange,
  refreshGitStatusesForTests,
  rehydrateWorktreeWatchers,
  removeWorktreeViewer,
  treeIgnoreForTests,
  watchedRepoRoots,
} = await import("./worktreeWatcher.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error("Timed out waiting for watcher event.");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

const broadcasts: ServerMessage[] = [];
setWorktreeBroadcaster({
  broadcast: (msg) => {
    broadcasts.push(msg);
  },
  broadcastWorktree: (_id, msg) => {
    broadcasts.push(msg);
  },
});

/** Resolves with the fetch time of the next fetch completed on `side`. */
function nextFetch(side: CheckoutSide): Promise<number> {
  return new Promise((resolve) => {
    const stop = onFetchCompleted((fetchedOn, _repoPath, fetchedAt) => {
      if (fetchedOn !== side) return;
      stop();
      resolve(fetchedAt);
    });
  });
}

/**
 * Holds the in-process Worker's next checkout git request until released.
 * `entered` resolves once the held request has arrived.
 */
function holdNextWorkerGit(): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => (entered = resolve));
  answerNextInProcessWorkerCallForTests(
    CHECKOUT_GIT_METHODS.run,
    async (payload, signal, real) => {
      entered();
      await barrier;
      return real(payload, signal);
    },
  );
  return { entered: arrived, release };
}

const realNow = Date.now.bind(Date);
afterAll(() => {
  vi.restoreAllMocks();
});

const remote = join(tmp, "kb-remote.git");
const store = new KnowledgeBaseStore();

test("AC3: the KB row's watch, viewer, scans, fetch and a late sweep stay on the server", async () => {
  const row = await resolveReadableWorktreeRow(KNOWLEDGE_WORKTREE_ID);
  assert.ok(row, "the KB checkout row");
  sh(tmp, "init", "--bare", remote);
  sh(row.path, "remote", "add", "origin", remote);
  sh(row.path, "push", "-u", "origin", row.branch);
  await rehydrateWorktreeWatchers();
  const before = inProcessWorkerServedForTests();

  // The status path notes interest and fetches on the row's side.
  const firstFetch = nextFetch("server");
  assert.ok(await readableWorktreeStatus(KNOWLEDGE_WORKTREE_ID));
  await firstFetch;
  const repoKey = await checkoutGitOn("server").repoLockKey(row.path);
  assert.ok(repoFetchedAt("server", repoKey));
  assert.equal(repoFetchedAt(DEFAULT_WORKER_SIDE, repoKey), undefined);

  // The viewer's repo watch and tree watch, keyed on the server side.
  await addWorktreeViewer(KNOWLEDGE_WORKTREE_ID);
  assert.deepEqual(watchedRepoRoots(), [
    { side: "server", root: row.mainRepoRoot },
  ]);

  // A tree settle: a working-tree edit reaches the viewer as changes.
  broadcasts.length = 0;
  writeFileSync(join(row.path, "draft.md"), "# Draft\n");
  await waitFor(() =>
    broadcasts.some(
      (msg) =>
        msg.type === "worktreeChanges" &&
        msg.changes.worktreeId === KNOWLEDGE_WORKTREE_ID &&
        msg.changes.files.some((file) => file.path === "draft.md"),
    ),
  );

  // A repo scan: a commit moves the KB's HEAD.
  const heads: string[] = [];
  onWorktreeGitStateChange((worktreeId, head) => {
    if (worktreeId === KNOWLEDGE_WORKTREE_ID) heads.push(head);
  });
  await store.commitChanges(
    [{ op: "write", path: "watched.md", content: "watched\n" }],
    { actor: { kind: "user", name: "T" }, reason: "Add watched" },
  );
  const head = sh(row.path, "rev-parse", "HEAD").trim();
  await waitFor(() => heads.includes(head));

  // The git-status refresh and the ignore read a repo scan and settle use.
  const refreshed = await refreshGitStatusesForTests(
    "server",
    [row],
    row.mainRepoRoot,
    [join(row.mainRepoRoot, ".git", "HEAD")],
  );
  assert.ok(refreshed.get(KNOWLEDGE_WORKTREE_ID));
  assert.ok(Array.isArray(await treeIgnoreForTests("server", row.path)));

  // Long after the row was noted, past the interest TTL, the sweep still
  // fetches on the stored side, and its completion re-stamps the KB status.
  const offset = 40 * 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  broadcasts.length = 0;
  const lateFetch = nextFetch("server");
  sweepBackgroundFetchForTests();
  const fetchedAt = await lateFetch;
  await waitFor(() =>
    broadcasts.some(
      (msg) =>
        msg.type === "worktreeStatus" &&
        msg.status.worktreeId === KNOWLEDGE_WORKTREE_ID &&
        msg.status.fetchedAt === fetchedAt,
    ),
  );
  vi.restoreAllMocks();
  assert.equal(repoFetchedAt("server", repoKey), fetchedAt);
  assert.equal(repoFetchedAt(DEFAULT_WORKER_SIDE, repoKey), undefined);

  assert.equal(inProcessWorkerServedForTests() - before, 0);
  removeWorktreeViewer(KNOWLEDGE_WORKTREE_ID);
});

test("AC8: a project at the KB root runs on the Worker without the KB row causing or joining it", async () => {
  const kb = await resolveReadableWorktreeRow(KNOWLEDGE_WORKTREE_ID);
  assert.ok(kb);
  const root = realpathSync(kb.path);
  const now = new Date().toISOString();
  projectStore.put({
    id: "kb-project",
    name: "KB Project",
    key: "KBPROJECT",
    description: "",
    status: "active",
    localPaths: [{ path: root, kind: "repo", match: "prefix" }],
    worktreeRoot: join(tmp, "kb-project-worktrees"),
    createdAt: now,
    updatedAt: now,
  });
  const projectId = mainWorktreeId("kb-project");
  const project = await resolveWorktreeRow(projectId);
  assert.ok(project, "the project's main checkout");
  assert.equal(realpathSync(project.path), root);

  // 1. Overlap: with the project's Worker git held, the KB row's status,
  //    changes and fetch note all complete, and the Worker serves nothing new.
  writeFileSync(join(root, "overlap.md"), "overlap\n");
  const held = holdNextWorkerGit();
  let projectDone = false;
  const projectStatus = computeWorktreeStatus(project, { force: true }).then(
    (status) => {
      projectDone = true;
      return status;
    },
  );
  await held.entered;
  const whileHeld = inProcessWorkerServedForTests();
  const kbStatus = await computeWorktreeStatus(kb, { force: true });
  assert.ok(kbStatus.dirty);
  const changes = await getWorktreeChanges(kb, { kind: "workingTree" });
  assert.ok(changes.files.some((file) => file.path === "overlap.md"));
  assert.ok(await noteWorktreeInterest("server", root));
  assert.equal(projectDone, false, "the project's request is still held");
  assert.equal(inProcessWorkerServedForTests(), whileHeld);
  held.release();
  assert.ok((await projectStatus).dirty);

  // 2. Registry: one fetch entry and one repo watch per side for the root.
  const workerFetch = nextFetch(DEFAULT_WORKER_SIDE);
  await computeWorktreeStatus(project, { force: true });
  await workerFetch;
  const repoKey = await checkoutGitOn("server").repoLockKey(root);
  assert.ok(repoFetchedAt("server", repoKey));
  assert.ok(repoFetchedAt(DEFAULT_WORKER_SIDE, repoKey));
  await addWorktreeViewer(KNOWLEDGE_WORKTREE_ID);
  await addWorktreeViewer(projectId);
  assert.deepEqual(
    watchedRepoRoots()
      .filter((watched) => watched.root === root)
      .map((watched) => watched.side),
    ["server", DEFAULT_WORKER_SIDE],
  );
  removeWorktreeViewer(KNOWLEDGE_WORKTREE_ID);
  removeWorktreeViewer(projectId);

  // 3. Locks: both sides share the repo's one lock key, so a KB commit and a
  //    project commit serialize instead of racing the shared index.
  assert.equal(
    await checkoutGitOn(DEFAULT_WORKER_SIDE).repoLockKey(root),
    repoKey,
  );
  writeFileSync(join(root, "project.md"), "project\n");
  writeFileSync(join(root, "kb.md"), "kb\n");
  const order: string[] = [];
  const projectHeld = holdNextWorkerGit();
  const projectCommit = commitWorktree(project, {
    message: "Project commit",
    paths: ["project.md"],
  }).then((result) => {
    order.push("project");
    return result;
  });
  await projectHeld.entered;
  const kbCommit = commitWorktree(kb, {
    message: "KB commit",
    paths: ["kb.md"],
  }).then((result) => {
    order.push("kb");
    return result;
  });
  // The KB commit waits on the lock the held project commit holds.
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(order, []);
  projectHeld.release();
  assert.equal((await projectCommit).status, "committed");
  assert.equal((await kbCommit).status, "committed");
  assert.deepEqual(order, ["project", "kb"]);
  assert.match(
    sh(root, "log", "-2", "--format=%s"),
    /KB commit\nProject commit/,
  );
});
