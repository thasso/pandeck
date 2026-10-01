/**
 * Integration test for the two-tier worktree watcher against a real temp git
 * repo: a commit inside the worktree (git-state tier) fires the git-state
 * listener and broadcasts a status; a working-tree edit (viewer tier) pushes
 * fresh changes. FSEvents delivery is asynchronous, so assertions poll.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import type { WorktreeRow } from "../db/worktreeStore.ts";

const tmp = mkdtempSync(join(tmpdir(), "worktree-watcher-test-"));
process.env.ASSISTANT_CWD = tmp;

const { createWorktree, removeWorktree } = await import("./worktrees.ts");
const { mainWorktreeId } = await import("./worktreeResolve.ts");
const {
  addWorktreeViewer,
  affectedWorktreeIdsForGitPaths,
  endTreeLingersForTests,
  fireTreeRetriesForTests,
  gitDirIgnoreForTests,
  refreshGitStatusesForTests,
  removeWorktreeViewer,
  rescanSessionWorktree,
  setTreeWatchLimitsForTests,
  treeActivityForTests,
  treeWatchLiveForTests,
  worktreeViewerRefs,
  onWorktreeGitStateChange,
  registerWorktree,
  treeIgnoreForTests,
  unregisterWorktree,
} = await import("./worktreeWatcher.ts");
const { default: parcelWatcher } = await import("../parcelWatcher.ts");
const { setWorktreeBroadcaster } = await import("./worktreeEvents.ts");
const { getWorktree, linkSessionToWorktree } =
  await import("../db/worktreeStore.ts");
const {
  cachedRepoBranchUpstreams,
  clearWorktreeStatusMemoryForTests,
  computeWorktreeStatus,
  readRepoBranchUpstreams,
  refreshWorktreeRemotePatch,
  resetWorktreeStatusComputeCountsForTests,
  worktreeStatusComputeCountsForTests,
} = await import("./worktreeStatus.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { clearRepoLockKeysForTests, countGitExecutionsForTests, repoLockKey } =
  await import("../gitExec.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

const repoPath = join(tmp, "watchrepo");
mkdirSync(repoPath, { recursive: true });
sh(repoPath, "init", "-b", "main");
writeFileSync(join(repoPath, "readme.md"), "hello\n");
sh(repoPath, "add", "-A");
sh(repoPath, "commit", "-m", "init");
const remotePath = join(tmp, "watchremote.git");
sh(tmp, "init", "--bare", remotePath);
sh(repoPath, "remote", "add", "origin", remotePath);
sh(repoPath, "push", "-u", "origin", "main");

projectStore.put({
  id: "watch-proj",
  name: "Watch Project",
  key: "WP",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot: join(tmp, "wt-root"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// An EXISTING project whose localPath exists but is NOT a git repo: it passes
// the sync watcher gate but resolves to no row.
const nonGitDir = join(tmp, "notarepo");
mkdirSync(nonGitDir, { recursive: true });
projectStore.put({
  id: "nogit-watch-proj",
  name: "No Git Watch Project",
  key: "NG",
  description: "",
  status: "active",
  localPaths: [{ path: nonGitDir, kind: "repo", match: "prefix" }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const broadcasts: ServerMessage[] = [];
setWorktreeBroadcaster({
  broadcast: (msg) => {
    broadcasts.push(msg);
  },
  broadcastWorktree: (_id, msg) => {
    broadcasts.push(msg);
  },
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error("Timed out waiting for watcher event.");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

test("git ref paths target one branch or the rows based on a moved base", () => {
  const row = (
    id: string,
    branch: string,
    baseBranch: string,
  ): WorktreeRow => ({
    id,
    projectId: "watch-proj",
    mainRepoRoot: repoPath,
    path: id === "main" ? repoPath : join(tmp, id),
    branch,
    baseBranch,
    baseCommit: "0".repeat(40),
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 0,
    updatedAt: 0,
    removedAt: null,
  });
  const rows = [
    row("main", "main", "main"),
    row("feature", "feature", "main"),
    row("stack-base", "stack-base", "main"),
    row("stack-child", "stack-child", "stack-base"),
  ];
  const gitDirNames = new Map<string, string | undefined>([
    ["main", undefined],
    ["feature", "feature"],
    ["stack-base", "stack-base"],
    ["stack-child", "stack-child"],
  ]);
  const affected = (path: string) =>
    affectedWorktreeIdsForGitPaths(
      rows,
      repoPath,
      [join(repoPath, ".git", path)],
      gitDirNames,
    ).sort();

  assert.deepEqual(affected("refs/heads/feature"), ["feature"]);
  assert.deepEqual(affected("worktrees/feature/HEAD"), ["feature"]);
  assert.deepEqual(affected("refs/remotes/origin/stack-child"), [
    "stack-child",
  ]);
  assert.deepEqual(affected("refs/remotes/origin/stack-base"), [
    "stack-base",
    "stack-child",
  ]);
  assert.deepEqual(affected("refs/heads/stack-base"), [
    "stack-base",
    "stack-child",
  ]);
  assert.deepEqual(affected("refs/heads/main"), [
    "feature",
    "main",
    "stack-base",
  ]);

  // An unknown linked HEAD fails safe to every row while its admin directory
  // exists; once it is gone, it was a removal and nobody else moved.
  const unknown = (exists: boolean) =>
    affectedWorktreeIdsForGitPaths(
      rows,
      repoPath,
      [join(repoPath, ".git", "worktrees", "removed-one", "HEAD")],
      gitDirNames,
      undefined,
      () => exists,
    ).sort();
  assert.deepEqual(unknown(true), [
    "feature",
    "main",
    "stack-base",
    "stack-child",
  ]);
  assert.deepEqual(unknown(false), []);
});

test("branch upstream map distinguishes every track shape, including gone", async () => {
  const formatRepo = join(tmp, "track-format-repo");
  const formatRemote = join(tmp, "track-format-remote.git");
  mkdirSync(formatRepo, { recursive: true });
  sh(formatRepo, "init", "-b", "main");
  sh(tmp, "init", "--bare", "-b", "main", formatRemote);
  sh(formatRepo, "commit", "--allow-empty", "-m", "root");
  sh(formatRepo, "remote", "add", "origin", formatRemote);
  const root = sh(formatRepo, "rev-parse", "HEAD").trim();
  const tree = sh(formatRepo, "rev-parse", "HEAD^{tree}").trim();
  const localChild = sh(
    formatRepo,
    "commit-tree",
    tree,
    "-p",
    root,
    "-m",
    "local",
  ).trim();
  const remoteChild = sh(
    formatRepo,
    "commit-tree",
    tree,
    "-p",
    root,
    "-m",
    "remote",
  ).trim();

  const cases: Array<[string, string, string]> = [
    ["sync", root, root],
    ["ahead", localChild, root],
    ["behind", root, remoteChild],
    ["both", localChild, remoteChild],
  ];
  for (const [branch, localTip, remoteTip] of cases) {
    sh(formatRepo, "branch", branch, localTip);
    sh(formatRepo, "update-ref", `refs/remotes/origin/${branch}`, remoteTip);
    sh(formatRepo, "config", `branch.${branch}.remote`, "origin");
    sh(formatRepo, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
  }
  sh(formatRepo, "branch", "no-upstream", root);
  sh(formatRepo, "remote", "add", "backup", formatRemote);
  sh(formatRepo, "branch", "adhoc", root);
  sh(formatRepo, "update-ref", "refs/remotes/backup/trunk", root);
  sh(formatRepo, "config", "branch.adhoc.remote", "backup");
  sh(formatRepo, "config", "branch.adhoc.merge", "refs/heads/trunk");
  // `%(refname:short)` calls this `heads/origin/sync` because it collides with
  // the remote's short name. The full-ref key must remain exactly origin/sync.
  sh(formatRepo, "branch", "origin/sync", root);
  sh(formatRepo, "config", "branch.origin/sync.remote", "origin");
  sh(formatRepo, "config", "branch.origin/sync.merge", "refs/heads/sync");
  sh(formatRepo, "branch", "gone", root);
  sh(formatRepo, "config", "branch.gone.remote", "origin");
  sh(formatRepo, "config", "branch.gone.merge", "refs/heads/gone");

  const upstreams = await readRepoBranchUpstreams(formatRepo, { force: true });
  assert.equal(upstreams.get("no-upstream")?.upstreamRef, undefined);
  assert.deepEqual(upstreams.get("sync"), {
    ahead: 0,
    behind: 0,
    upstreamRef: "refs/remotes/origin/sync",
    upstreamName: "remotes/origin/sync",
  });
  assert.deepEqual(upstreams.get("ahead"), {
    ahead: 1,
    behind: 0,
    upstreamRef: "refs/remotes/origin/ahead",
    upstreamName: "origin/ahead",
  });
  assert.deepEqual(upstreams.get("behind"), {
    ahead: 0,
    behind: 1,
    upstreamRef: "refs/remotes/origin/behind",
    upstreamName: "origin/behind",
  });
  assert.deepEqual(upstreams.get("both"), {
    ahead: 1,
    behind: 1,
    upstreamRef: "refs/remotes/origin/both",
    upstreamName: "origin/both",
  });
  assert.deepEqual(upstreams.get("origin/sync"), {
    ahead: 0,
    behind: 0,
    upstreamRef: "refs/remotes/origin/sync",
    upstreamName: "remotes/origin/sync",
  });
  assert.deepEqual(upstreams.get("adhoc"), {
    ahead: 0,
    behind: 0,
    upstreamRef: "refs/remotes/backup/trunk",
    upstreamName: "backup/trunk",
  });
  assert.deepEqual(upstreams.get("gone"), {
    ahead: 0,
    behind: 0,
    upstreamRef: "refs/remotes/origin/gone",
    upstreamName: "origin/gone",
    gone: true,
  });

  // Exact ambiguity repro: a local `origin/sync` branch makes Git disambiguate
  // the REMOTE upstream as `remotes/origin/sync`. Porcelain on a full scan and
  // the map-backed ref-only patch must preserve the same Git-owned label.
  const syncPath = join(tmp, "track-format-sync-worktree");
  const consumerPath = join(tmp, "track-format-consumer-worktree");
  sh(formatRepo, "worktree", "add", syncPath, "sync");
  sh(formatRepo, "worktree", "add", consumerPath, "ahead");
  const row = (
    id: string,
    path: string,
    branch: string,
    baseBranch: string,
  ): WorktreeRow => ({
    id,
    projectId: "track-format-project",
    mainRepoRoot: formatRepo,
    path,
    branch,
    baseBranch,
    baseCommit: root,
    status: "active",
    mergeStateJson: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  });
  clearWorktreeStatusMemoryForTests();
  const syncRow = row("track-format-sync", syncPath, "sync", "main");
  const syncFull = await computeWorktreeStatus(syncRow, {
    force: true,
    branchUpstreams: upstreams,
  });
  const syncContextPatch = await refreshWorktreeRemotePatch(syncRow, new Map());
  const consumerRow = row(
    "track-format-consumer",
    consumerPath,
    "ahead",
    "sync",
  );
  await computeWorktreeStatus(consumerRow, {
    force: true,
    branchUpstreams: upstreams,
  });
  const consumerPatch = await refreshWorktreeRemotePatch(
    consumerRow,
    upstreams,
  );
  assert.equal(syncFull.upstream?.name, "remotes/origin/sync");
  assert.equal(syncContextPatch?.upstream?.name, syncFull.upstream?.name);
  assert.equal(consumerPatch?.baseUpstream?.name, syncFull.upstream?.name);

  const failedRoot = join(tmp, "missing-track-format-repo");
  await readRepoBranchUpstreams(failedRoot, {
    force: true,
    repoKey: "missing-track-format-key",
  });
  assert.equal(
    cachedRepoBranchUpstreams(failedRoot),
    undefined,
    "a failed priming read must remain cold rather than cache an empty map",
  );
});

test("remote-only ref batches patch every tracked base with one map and no full scans", async () => {
  sh(repoPath, "branch", "release", "main");
  sh(repoPath, "config", "branch.release.remote", "origin");
  sh(repoPath, "config", "branch.release.merge", "refs/heads/main");
  const records = await Promise.all([
    ...["remote-one", "remote-two", "remote-three"].map((name) =>
      createWorktree({ projectId: "watch-proj", name }),
    ),
    createWorktree({
      projectId: "watch-proj",
      name: "remote-renamed-base",
      baseBranch: "release",
    }),
  ]);
  const rows = records.map((record) => getWorktree(record.id)!);
  // Creation registers live filesystem watchers. Stop them — and, by the
  // unregister contract, await scans they already launched — before resetting
  // process-global counters. Otherwise a delayed callback can land inside an
  // exact manual-measurement window below.
  for (const row of rows) await unregisterWorktree(row.id);

  // Production registration primes this relationship map once per repo. A cold
  // direct/manual event pays one repo-key read and one map before it can prove a
  // differently named remote path is unrelated.
  clearWorktreeStatusMemoryForTests();
  clearRepoLockKeysForTests();
  const coldUnaffected = await countGitExecutionsForTests(() =>
    refreshGitStatusesForTests(rows, repoPath, [
      join(repoPath, ".git", "refs", "remotes", "origin", "unrelated"),
    ]),
  );
  assert.equal(coldUnaffected.result.size, 0);
  assert.equal(coldUnaffected.executions, 2);
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 0,
    workingTree: 0,
    branchUpstreamMap: 1,
  });

  for (const row of rows) await computeWorktreeStatus(row, { force: true });

  resetWorktreeStatusComputeCountsForTests();
  clearRepoLockKeysForTests();
  const submoduleConfig = await countGitExecutionsForTests(() =>
    refreshGitStatusesForTests(rows, repoPath, [
      join(repoPath, ".git", "modules", "sub", "config"),
    ]),
  );
  assert.equal(submoduleConfig.result.size, 0);
  assert.equal(submoduleConfig.executions, 0);

  const newlyTracked = rows.find((row) => row.branch === "remote-one")!;
  sh(repoPath, "config", "branch.remote-one.remote", "origin");
  sh(repoPath, "config", "branch.remote-one.merge", "refs/heads/remote-one");
  resetWorktreeStatusComputeCountsForTests();
  clearRepoLockKeysForTests();
  const configRefresh = await countGitExecutionsForTests(() =>
    refreshGitStatusesForTests(rows, repoPath, [
      join(repoPath, ".git", "config"),
    ]),
  );
  assert.deepEqual([...configRefresh.result.keys()], [newlyTracked.id]);
  // One repo-key read (a second lookup of the same path is remembered), the
  // map, and the one full status scan.
  assert.equal(configRefresh.executions, 5);
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 1,
    workingTree: 0,
    branchUpstreamMap: 1,
  });

  sh(repoPath, "update-ref", "refs/remotes/origin/remote-one", "main");
  resetWorktreeStatusComputeCountsForTests();
  clearRepoLockKeysForTests();
  const ownUpstreamMove = await countGitExecutionsForTests(() =>
    refreshGitStatusesForTests(rows, repoPath, [
      join(repoPath, ".git", "refs", "remotes", "origin", "remote-one"),
    ]),
  );
  assert.deepEqual([...ownUpstreamMove.result.keys()], [newlyTracked.id]);
  // As above: the second repo-key lookup of the same path is remembered.
  assert.equal(ownUpstreamMove.executions, 5);
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 1,
    workingTree: 0,
    branchUpstreamMap: 1,
  });
  assert.deepEqual(ownUpstreamMove.result.get(newlyTracked.id)?.upstream, {
    ahead: 0,
    behind: 0,
    name: "origin/remote-one",
  });

  resetWorktreeStatusComputeCountsForTests();
  clearRepoLockKeysForTests();
  const unaffected = await countGitExecutionsForTests(() =>
    refreshGitStatusesForTests(rows, repoPath, [
      join(repoPath, ".git", "refs", "remotes", "origin", "unrelated"),
    ]),
  );
  assert.equal(unaffected.result.size, 0);
  assert.equal(
    unaffected.executions,
    0,
    "an empty target set costs no git reads",
  );
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 0,
    workingTree: 0,
    branchUpstreamMap: 0,
  });

  const tree = sh(repoPath, "rev-parse", "main^{tree}").trim();
  const parent = sh(repoPath, "rev-parse", "main").trim();
  const remoteTip = sh(
    repoPath,
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    "remote-only move",
  ).trim();
  sh(repoPath, "update-ref", "refs/remotes/origin/main", remoteTip);

  resetWorktreeStatusComputeCountsForTests();
  const remotePathEvent = join(
    repoPath,
    ".git",
    "refs",
    "remotes",
    "origin",
    "main",
  );
  const watchedRepoKey = await repoLockKey(repoPath);
  clearRepoLockKeysForTests();
  const patchedBatch = await countGitExecutionsForTests(() =>
    refreshGitStatusesForTests(
      rows,
      repoPath,
      [remotePathEvent],
      new Map(),
      watchedRepoKey,
    ),
  );
  assert.equal(patchedBatch.executions, 4);
  const patched = patchedBatch.result;
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 0,
    workingTree: 0,
    branchUpstreamMap: 1,
  });
  for (const row of rows)
    assert.deepEqual(patched.get(row.id)?.baseUpstream, {
      ahead: 0,
      behind: 1,
      name: "origin/main",
    });
  assert.equal(
    patched.get(rows.find((row) => row.branch === "remote-two")!.id)?.upstream,
    undefined,
    "a never-pushed row stays on the patch tier after context resolution",
  );

  // The patch preserves porcelain's own-upstream baseline while the full scan
  // recalculates it; both read baseUpstream from the same main-context map.
  const patchedStatus = patched.get(rows[0]!.id)!;
  const fullStatus = await computeWorktreeStatus(rows[0]!, { force: true });
  assert.deepEqual(
    {
      upstream: patchedStatus.upstream,
      baseUpstream: patchedStatus.baseUpstream,
    },
    {
      upstream: fullStatus.upstream,
      baseUpstream: fullStatus.baseUpstream,
    },
  );

  resetWorktreeStatusComputeCountsForTests();
  await refreshGitStatusesForTests(rows, repoPath, [
    join(repoPath, ".git", "refs", "heads", "main"),
  ]);
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: rows.length - 1,
    workingTree: 0,
    branchUpstreamMap: 1,
  });

  sh(repoPath, "update-ref", "refs/remotes/origin/main", parent);
  for (const record of records)
    await removeWorktree(record.id, { force: true, deleteBranch: true });
  sh(repoPath, "branch", "-D", "release");
});

test("symbolic branch refs force full-scan equivalence on remote-only moves", async () => {
  sh(
    repoPath,
    "symbolic-ref",
    "refs/heads/symbolic-base",
    "refs/remotes/origin/main",
  );
  const record = await createWorktree({
    projectId: "watch-proj",
    name: "symbolic-base-child",
    baseBranch: "symbolic-base",
  });
  const row = getWorktree(record.id)!;
  await unregisterWorktree(row.id);
  await computeWorktreeStatus(row, { force: true });

  const parent = sh(repoPath, "rev-parse", "refs/remotes/origin/main").trim();
  const tree = sh(repoPath, "rev-parse", `${parent}^{tree}`).trim();
  const remoteTip = sh(
    repoPath,
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    "move symbolic base",
  ).trim();
  sh(repoPath, "update-ref", "refs/remotes/origin/main", remoteTip);

  resetWorktreeStatusComputeCountsForTests();
  const refreshed = await refreshGitStatusesForTests([row], repoPath, [
    join(repoPath, ".git", "refs", "remotes", "origin", "main"),
  ]);
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 1,
    workingTree: 0,
    branchUpstreamMap: 1,
  });
  const eventStatus = refreshed.get(row.id)!;
  assert.equal(eventStatus.behind, 1);

  const fullStatus = await computeWorktreeStatus(row, { force: true });
  assert.deepEqual(
    {
      head: eventStatus.head,
      dirty: eventStatus.dirty,
      ahead: eventStatus.ahead,
      behind: eventStatus.behind,
      upstream: eventStatus.upstream,
      baseUpstream: eventStatus.baseUpstream,
    },
    {
      head: fullStatus.head,
      dirty: fullStatus.dirty,
      ahead: fullStatus.ahead,
      behind: fullStatus.behind,
      upstream: fullStatus.upstream,
      baseUpstream: fullStatus.baseUpstream,
    },
  );

  sh(repoPath, "update-ref", "refs/remotes/origin/main", parent);
  await removeWorktree(record.id, { force: true, deleteBranch: true });
  sh(repoPath, "symbolic-ref", "--delete", "refs/heads/symbolic-base");
});

test("a local symbolic branch/base is refreshed by any local ref move", async () => {
  sh(repoPath, "branch", "delegate", "main");
  sh(
    repoPath,
    "symbolic-ref",
    "refs/heads/local-symbolic-base",
    "refs/heads/delegate",
  );
  const record = await createWorktree({
    projectId: "watch-proj",
    name: "local-symbolic-child",
    baseBranch: "local-symbolic-base",
  });
  const row = getWorktree(record.id)!;
  await unregisterWorktree(row.id);
  await computeWorktreeStatus(row, { force: true });

  const parent = sh(repoPath, "rev-parse", "refs/heads/delegate").trim();
  const tree = sh(repoPath, "rev-parse", `${parent}^{tree}`).trim();
  const moved = sh(
    repoPath,
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    "move local delegate",
  ).trim();
  sh(repoPath, "update-ref", "refs/heads/delegate", moved);

  resetWorktreeStatusComputeCountsForTests();
  const refreshed = await refreshGitStatusesForTests([row], repoPath, [
    join(repoPath, ".git", "refs", "heads", "delegate"),
  ]);
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 1,
    workingTree: 0,
    branchUpstreamMap: 1,
  });
  assert.equal(refreshed.get(row.id)?.behind, 1);

  sh(repoPath, "update-ref", "refs/heads/delegate", parent);
  await removeWorktree(record.id, { force: true, deleteBranch: true });
  sh(repoPath, "symbolic-ref", "--delete", "refs/heads/local-symbolic-base");
  sh(repoPath, "branch", "-D", "delegate");
});

test("linked-context include tracking is resolved by porcelain", async () => {
  const contextRepo = join(tmp, "context-config-repo");
  const contextRemote = join(tmp, "context-config-remote.git");
  mkdirSync(contextRepo, { recursive: true });
  sh(contextRepo, "init", "-b", "main");
  sh(tmp, "init", "--bare", "-b", "main", contextRemote);
  sh(contextRepo, "commit", "--allow-empty", "-m", "root");
  sh(contextRepo, "remote", "add", "origin", contextRemote);
  sh(contextRepo, "push", "-u", "origin", "main");
  projectStore.put({
    id: "context-config-proj",
    name: "Context Config Project",
    key: "CC",
    description: "",
    status: "active",
    localPaths: [{ path: contextRepo, kind: "repo", match: "prefix" }],
    worktreeRoot: join(tmp, "context-wt-root"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const record = await createWorktree({
    projectId: "context-config-proj",
    name: "context-upstream",
  });
  const row = getWorktree(record.id)!;
  await unregisterWorktree(row.id);
  clearRepoLockKeysForTests();
  const registration = await countGitExecutionsForTests(() =>
    registerWorktree(row),
  );
  assert.equal(registration.executions, 3);
  await unregisterWorktree(row.id);
  const linkedGitDir = sh(
    record.path,
    "rev-parse",
    "--absolute-git-dir",
  ).trim();
  const includePath = join(contextRepo, ".git", "linked-context.conf");
  writeFileSync(
    includePath,
    `[branch "${row.branch}"]\n\tremote = origin\n\tmerge = refs/heads/${row.branch}\n`,
  );
  sh(
    contextRepo,
    "config",
    "--add",
    `includeIf.gitdir:${linkedGitDir}.path`,
    includePath,
  );

  const rootMap = await readRepoBranchUpstreams(contextRepo, { force: true });
  assert.equal(
    rootMap.get(row.branch)?.upstreamRef,
    undefined,
    "the main checkout's config context cannot see the linked includeIf",
  );
  assert.equal(
    sh(
      record.path,
      "for-each-ref",
      "--format=%(upstream)",
      `refs/heads/${row.branch}`,
    ).trim(),
    `refs/remotes/origin/${row.branch}`,
  );

  const base = sh(contextRepo, "rev-parse", "main").trim();
  const ownRemoteRef = `refs/remotes/origin/${row.branch}`;
  sh(contextRepo, "update-ref", ownRemoteRef, base);
  const baseline = await computeWorktreeStatus(row, { force: true });
  assert.deepEqual(baseline.upstream, {
    ahead: 0,
    behind: 0,
    name: "origin/context-upstream",
  });

  const tree = sh(contextRepo, "rev-parse", `${base}^{tree}`).trim();
  const remoteTip = sh(
    contextRepo,
    "commit-tree",
    tree,
    "-p",
    base,
    "-m",
    "behind one",
  ).trim();
  sh(contextRepo, "update-ref", ownRemoteRef, remoteTip);
  resetWorktreeStatusComputeCountsForTests();
  clearRepoLockKeysForTests();
  const refreshed = await countGitExecutionsForTests(() =>
    refreshGitStatusesForTests([row], contextRepo, [
      join(contextRepo, ".git", "refs", "remotes", "origin", row.branch),
    ]),
  );
  assert.deepEqual([...refreshed.result.keys()], [row.id]);
  assert.equal(refreshed.executions, 3);
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 0,
    workingTree: 0,
    branchUpstreamMap: 1,
  });
  assert.deepEqual(refreshed.result.get(row.id)?.upstream, {
    ahead: 0,
    behind: 1,
    name: "origin/context-upstream",
  });

  const remoteTipTwo = sh(
    contextRepo,
    "commit-tree",
    tree,
    "-p",
    remoteTip,
    "-m",
    "behind two",
  ).trim();
  sh(contextRepo, "update-ref", ownRemoteRef, remoteTipTwo);
  resetWorktreeStatusComputeCountsForTests();
  clearRepoLockKeysForTests();
  const refreshedAgain = await countGitExecutionsForTests(() =>
    refreshGitStatusesForTests([row], contextRepo, [
      join(contextRepo, ".git", "refs", "remotes", "origin", row.branch),
    ]),
  );
  assert.equal(refreshedAgain.executions, 3);
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 0,
    workingTree: 0,
    branchUpstreamMap: 1,
  });
  assert.deepEqual(refreshedAgain.result.get(row.id)?.upstream, {
    ahead: 0,
    behind: 2,
    name: "origin/context-upstream",
  });

  sh(record.path, "commit", "--allow-empty", "-m", "ahead one");
  sh(record.path, "commit", "--allow-empty", "-m", "ahead two");
  clearRepoLockKeysForTests();
  const forced = await countGitExecutionsForTests(() =>
    computeWorktreeStatus(row, { force: true }),
  );
  assert.deepEqual(forced.result.upstream, {
    ahead: 2,
    behind: 2,
    name: "origin/context-upstream",
  });
  assert.equal(forced.result.baseUpstream?.behind, 0);
  assert.equal(forced.executions, 9);

  sh(contextRepo, "update-ref", "-d", ownRemoteRef);
  const gone = await computeWorktreeStatus(row, { force: true });
  assert.equal(gone.upstream, undefined);

  sh(contextRepo, "update-ref", ownRemoteRef, base);

  // Cache the genuinely-untracked state, then add differently-named tracking
  // in a config context the root map cannot see. The next base ref event must
  // trigger a context-local one-process resolution, not preserve the baseline.
  writeFileSync(includePath, "");
  const privateBaseline = await computeWorktreeStatus(row, { force: true });
  assert.equal(privateBaseline.upstream, undefined);
  writeFileSync(
    includePath,
    `[branch "${row.branch}"]\n\tremote = origin\n\tmerge = refs/heads/main\n`,
  );
  sh(contextRepo, "update-ref", "refs/remotes/origin/main", remoteTip);
  resetWorktreeStatusComputeCountsForTests();
  clearRepoLockKeysForTests();
  const privateRefreshed = await countGitExecutionsForTests(() =>
    refreshGitStatusesForTests([row], contextRepo, [
      join(contextRepo, ".git", "refs", "remotes", "origin", "main"),
    ]),
  );
  assert.equal(privateRefreshed.executions, 3);
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: 0,
    workingTree: 0,
    branchUpstreamMap: 1,
  });
  assert.deepEqual(privateRefreshed.result.get(row.id)?.upstream, {
    ahead: 2,
    behind: 1,
    name: "origin/main",
  });
  assert.equal(privateRefreshed.result.get(row.id)?.baseUpstream?.behind, 1);
  sh(contextRepo, "update-ref", "refs/remotes/origin/main", base);

  clearWorktreeStatusMemoryForTests();
  const syntheticMain: WorktreeRow = {
    ...row,
    id: "synthetic-main-map-budget",
    path: contextRepo,
    branch: "main",
    baseBranch: "main",
  };
  clearRepoLockKeysForTests();
  const mainStatus = await countGitExecutionsForTests(() =>
    computeWorktreeStatus(syntheticMain, { force: true }),
  );
  assert.equal(mainStatus.executions, 4);
  assert.equal(worktreeStatusComputeCountsForTests().branchUpstreamMap, 0);

  clearWorktreeStatusMemoryForTests();
  const burstRows = Array.from({ length: 9 }, (_, index): WorktreeRow => ({
    ...row,
    id: `branch-map-burst-${index}`,
  }));
  await Promise.all(
    burstRows.map((burstRow) => computeWorktreeStatus(burstRow)),
  );
  assert.deepEqual(worktreeStatusComputeCountsForTests(), {
    full: burstRows.length,
    workingTree: 0,
    branchUpstreamMap: 1,
  });

  await removeWorktree(record.id, { force: true, deleteBranch: true });
});

test(
  "git-state tier detects commits; viewer tier pushes working-tree changes",
  { timeout: 30_000 },
  async () => {
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "watched",
    });
    const row = getWorktree(record.id)!;
    await registerWorktree(row);

    const headChanges: Array<{ worktreeId: string; head: string }> = [];
    onWorktreeGitStateChange((worktreeId, head) =>
      headChanges.push({ worktreeId, head }),
    );

    // Viewer tier on (also exercises the refcount path).
    await addWorktreeViewer(record.id);

    // Working-tree edit → viewer tier pushes changes + status.
    broadcasts.length = 0;
    writeFileSync(join(record.path, "edit.txt"), "wip\n");
    await waitFor(() =>
      broadcasts.some(
        (msg) =>
          msg.type === "worktreeChanges" &&
          msg.changes.worktreeId === record.id &&
          msg.changes.files.some((f) => f.path === "edit.txt"),
      ),
    );
    assert.ok(
      broadcasts.some(
        (msg) =>
          msg.type === "worktreeStatus" &&
          msg.status.worktreeId === record.id &&
          msg.status.dirty,
      ),
    );

    // Commit in the worktree → git-state tier fires the listener with the new head.
    broadcasts.length = 0;
    sh(record.path, "add", "-A");
    sh(record.path, "commit", "-m", "watched commit");
    const newHead = sh(record.path, "rev-parse", "HEAD").trim();
    await waitFor(() =>
      headChanges.some(
        (change) => change.worktreeId === record.id && change.head === newHead,
      ),
    );
    await waitFor(() =>
      broadcasts.some(
        (msg) =>
          msg.type === "worktreeStatus" &&
          msg.status.worktreeId === record.id &&
          msg.status.ahead === 1,
      ),
    );

    await unregisterWorktree(record.id);
    await removeWorktree(record.id, { force: true, deleteBranch: true });
  },
);

test(
  "aliased main viewer keys under the canonical id and delivers canonical-keyed changes",
  { timeout: 30_000 },
  async () => {
    const canonicalId = mainWorktreeId("watch-proj");
    // Watch via an ALIASED id — the reservation + subscription must key under the
    // canonical id so scans find it and broadcasts carry the canonical worktreeId.
    await addWorktreeViewer("main:WATCH-PROJ");
    assert.equal(worktreeViewerRefs("main:WATCH-PROJ"), 1);
    assert.equal(worktreeViewerRefs(canonicalId), 1); // same underlying watch

    broadcasts.length = 0;
    writeFileSync(join(repoPath, "main-edit.txt"), "wip\n");
    await waitFor(() =>
      broadcasts.some(
        (msg) =>
          msg.type === "worktreeChanges" &&
          msg.changes.worktreeId === canonicalId &&
          msg.changes.files.some((f) => f.path === "main-edit.txt"),
      ),
    );

    removeWorktreeViewer("main:WATCH-PROJ");
    assert.equal(worktreeViewerRefs(canonicalId), 0);
  },
);

test("watch/unwatch race keeps the refcount balanced (no leak)", async () => {
  const id = mainWorktreeId("watch-proj");
  // Unwatch arrives before the async add finishes resolving/subscribing.
  const adding = addWorktreeViewer(id);
  removeWorktreeViewer(id);
  await adding;
  assert.equal(worktreeViewerRefs(id), 0);
});

test("invalid watch ids never allocate watcher state", async () => {
  await addWorktreeViewer("main:no-such-project");
  assert.equal(worktreeViewerRefs("main:no-such-project"), 0);
});

test("an existing non-git project reserves then releases (no inert watcher entry)", async () => {
  const id = mainWorktreeId("nogit-watch-proj");
  await addWorktreeViewer(id); // passes the sync gate, resolves to no row → releases
  assert.equal(worktreeViewerRefs(id), 0);
});

test("a tree watch ignores what git ignores and submodules, by path, never by glob", async () => {
  const repo = join(tmp, "ignore-paths-repo");
  mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(
    join(repo, ".gitignore"),
    ["node_modules/", "build", "__pycache__/", "*.pyc", "cache*/", ""].join(
      "\n",
    ),
  );
  writeFileSync(
    join(repo, ".gitmodules"),
    '[submodule "lib"]\n\tpath = extern/lib\n\turl = ../lib.git\n',
  );
  const files = [
    "src/main.py",
    "app/web/package.json",
    "app/web/node_modules/pkg/index.js",
    // Collapsed into `build`: only the topmost ignored directory is listed.
    "build/sub/out.o",
    // A tracked source dir with ignored output beside it.
    "src/__pycache__/main.pyc",
    // Every file here is ignored, yet a new source file in it would show in
    // status: the directory itself matches no pattern and stays watched.
    "tools/only-output/__pycache__/x.pyc",
    // Parcel would read this directory's ignore entry as a glob: skipped.
    "cache[1]/x",
    "extern/lib/file.c",
  ];
  for (const file of files) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), "x\n");
  }
  sh(repo, "add", ".gitignore", ".gitmodules", "src/main.py", "app/web");

  const ignore = await treeIgnoreForTests(repo);
  // Parcel matches a glob as a regex against every crawled path; paths only.
  assert.ok(
    ignore.every((entry) => !/[*?[\]{}]/.test(entry)),
    ignore.join(),
  );
  assert.deepEqual(ignore.sort(), [
    ".DS_Store",
    ".git",
    "app/web/node_modules",
    "build",
    "dist",
    "extern/lib",
    "node_modules",
    "src/__pycache__",
  ]);
});

test("a git-state watch skips every object store by path", async () => {
  const gitDir = join(tmp, "ignore-git-dir");
  for (const dir of [
    "objects/ab",
    "refs/heads",
    "modules/extern/lib/objects/cd",
    "modules/extern/lib/modules/nested/objects",
    "worktrees/wt/modules/sub/objects",
  ])
    mkdirSync(join(gitDir, dir), { recursive: true });
  for (const head of [
    "HEAD",
    "modules/extern/lib/HEAD",
    "modules/extern/lib/modules/nested/HEAD",
    "worktrees/wt/HEAD",
    "worktrees/wt/modules/sub/HEAD",
  ])
    writeFileSync(join(gitDir, head), "ref: refs/heads/main\n");

  assert.deepEqual((await gitDirIgnoreForTests(gitDir)).sort(), [
    "lfs",
    "modules/extern/lib/modules/nested/objects",
    "modules/extern/lib/objects",
    "objects",
    "worktrees/wt/modules/sub/objects",
  ]);
});

/** Parcel subscriptions made for one checkout path since `spy` started. */
function subscribesOf(
  spy: { mock: { calls: unknown[][] } },
  path: string,
): Array<{ ignore?: string[] }> {
  return spy.mock.calls
    .filter((call) => call[0] === path)
    .map((call) => (call[2] ?? {}) as { ignore?: string[] });
}

test(
  "tree watches linger past their last viewer under a hard cap",
  { timeout: 30_000 },
  async () => {
    const previous = setTreeWatchLimitsForTests({
      lingerMs: 60_000,
      maxWatches: 2,
    });
    const records = [];
    for (const name of ["cap-a", "cap-b", "cap-c"])
      records.push(await createWorktree({ projectId: "watch-proj", name }));
    const [a, b, c] = records.map((record) => record.id) as [
      string,
      string,
      string,
    ];
    const subscribe = vi.spyOn(parcelWatcher, "subscribe");
    try {
      await addWorktreeViewer(a);
      removeWorktreeViewer(a);
      assert.equal(await treeWatchLiveForTests(a), true, "a lingers");
      await addWorktreeViewer(a);
      assert.equal(
        subscribesOf(subscribe, records[0]!.path).length,
        1,
        "coming back within the linger costs no second crawl",
      );

      await addWorktreeViewer(b);
      await addWorktreeViewer(c);
      assert.equal(
        await treeWatchLiveForTests(a),
        false,
        "the least recently viewed tree yields its slot",
      );
      assert.equal(worktreeViewerRefs(a), 1, "and keeps its viewer");
      assert.equal(await treeWatchLiveForTests(b), true);
      assert.equal(await treeWatchLiveForTests(c), true);

      // An idle tree ranks below every viewed one: a takes its slot back and
      // c, with no slot to linger in, is dropped at once.
      removeWorktreeViewer(c);
      // c's slot frees once its release completes.
      await waitForAsync(() => treeWatchLiveForTests(a));
      assert.equal(await treeWatchLiveForTests(c), false);

      removeWorktreeViewer(b);
      assert.equal(await treeWatchLiveForTests(b), true, "b lingers");
      endTreeLingersForTests();
      assert.equal(
        await treeWatchLiveForTests(b),
        false,
        "the linger ends the watch",
      );
      removeWorktreeViewer(a);
    } finally {
      subscribe.mockRestore();
      setTreeWatchLimitsForTests(previous);
      for (const id of [a, b, c])
        await removeWorktree(id, { force: true, deleteBranch: true });
    }
  },
);

test(
  "a lingering watch scans nothing until a viewer returns",
  { timeout: 30_000 },
  async () => {
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "idle-linger",
    });
    await addWorktreeViewer(record.id);
    removeWorktreeViewer(record.id);
    assert.equal(await treeWatchLiveForTests(record.id), true);
    broadcasts.length = 0;
    const before = treeActivityForTests(record.id)!;
    writeFileSync(join(record.path, "idle-edit.txt"), "wip\n");
    // The event reaches the lingering watch, which schedules no scan for it.
    await waitFor(
      () => treeActivityForTests(record.id)!.eventBatches > before.eventBatches,
    );
    assert.equal(
      treeActivityForTests(record.id)!.scansScheduled,
      before.scansScheduled,
    );
    // The git-state tier may still report the new branch; a tree scan would
    // push the edited file.
    assert.ok(
      !broadcasts.some(
        (msg) =>
          msg.type === "worktreeChanges" &&
          msg.changes.files.some((file) => file.path === "idle-edit.txt"),
      ),
    );

    // The returning viewer's read is as fresh as the status cache allows, so
    // move the clock past that window rather than waiting it out.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 1_500);
      await addWorktreeViewer(record.id);
      const status = await computeWorktreeStatus(getWorktree(record.id)!);
      assert.equal(status.dirty, true, "the returning viewer reads fresh");
    } finally {
      vi.useRealTimers();
    }
    removeWorktreeViewer(record.id);
    await removeWorktree(record.id, { force: true, deleteBranch: true });
  },
);

test(
  "a .gitignore edit rescans and re-subscribes with the new ignore set",
  { timeout: 30_000 },
  async () => {
    const previous = setTreeWatchLimitsForTests({ ignoreRefreshMs: 0 });
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "gitignore-edit",
    });
    const subscribe = vi.spyOn(parcelWatcher, "subscribe");
    try {
      mkdirSync(join(record.path, "generated"));
      writeFileSync(join(record.path, "generated", "out.txt"), "x\n");
      await addWorktreeViewer(record.id);
      assert.ok(
        !subscribesOf(subscribe, record.path)[0]?.ignore?.includes("generated"),
      );

      broadcasts.length = 0;
      writeFileSync(join(record.path, ".gitignore"), "generated/\n");
      // `.gitignore` shares a prefix with `.git`; it is a real change.
      await waitFor(() =>
        broadcasts.some(
          (msg) =>
            msg.type === "worktreeChanges" &&
            msg.changes.worktreeId === record.id &&
            msg.changes.files.some((file) => file.path === ".gitignore"),
        ),
      );
      await waitFor(() =>
        subscribesOf(subscribe, record.path).some((options) =>
          options.ignore?.includes("generated"),
        ),
      );
      removeWorktreeViewer(record.id);
    } finally {
      subscribe.mockRestore();
      setTreeWatchLimitsForTests(previous);
      await removeWorktree(record.id, { force: true, deleteBranch: true });
    }
  },
);

test(
  "a linked session's tool call rescans a viewed worktree without a tree watch",
  { timeout: 30_000 },
  async () => {
    const previous = setTreeWatchLimitsForTests({ maxWatches: 0 });
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "tool-rescan",
    });
    try {
      linkSessionToWorktree("tool-rescan-session", record.id);
      await addWorktreeViewer(record.id);
      assert.equal(await treeWatchLiveForTests(record.id), false);

      broadcasts.length = 0;
      writeFileSync(join(record.path, "agent-edit.txt"), "wip\n");
      rescanSessionWorktree("unlinked-session");
      rescanSessionWorktree("tool-rescan-session");
      await waitFor(() =>
        broadcasts.some(
          (msg) =>
            msg.type === "worktreeChanges" &&
            msg.changes.worktreeId === record.id &&
            msg.changes.files.some((file) => file.path === "agent-edit.txt"),
        ),
      );
      removeWorktreeViewer(record.id);
    } finally {
      setTreeWatchLimitsForTests(previous);
      await removeWorktree(record.id, { force: true, deleteBranch: true });
    }
  },
);

/** Poll an async condition (the watcher settles on its own schedule). */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs)
      throw new Error("Timed out waiting for watcher state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

test(
  "an un-ignore inside the refresh cooldown still re-subscribes when it ends",
  { timeout: 30_000 },
  async () => {
    // Long enough that the edit below surely lands inside it.
    const previous = setTreeWatchLimitsForTests({ ignoreRefreshMs: 60_000 });
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "unignore-cooldown",
    });
    const subscribe = vi.spyOn(parcelWatcher, "subscribe");
    try {
      mkdirSync(join(record.path, "generated"));
      writeFileSync(join(record.path, "generated", "out.txt"), "x\n");
      writeFileSync(join(record.path, ".gitignore"), "generated/\n");
      await addWorktreeViewer(record.id);
      assert.ok(
        subscribesOf(subscribe, record.path)[0]?.ignore?.includes("generated"),
      );

      // Within the cooldown of that subscribe: nothing in `generated/` would
      // ever send the event that asks again, so the refresh arms its own retry.
      writeFileSync(join(record.path, ".gitignore"), "");
      await waitFor(() => treeActivityForTests(record.id)!.retryArmed);
      assert.equal(subscribesOf(subscribe, record.path).length, 1);
      // The cooldown ends: its timer fires and finds the window over.
      setTreeWatchLimitsForTests({ ignoreRefreshMs: 0 });
      fireTreeRetriesForTests();
      await waitFor(
        () =>
          subscribesOf(subscribe, record.path).length === 2 &&
          !subscribesOf(subscribe, record.path)[1]?.ignore?.includes(
            "generated",
          ),
      );
      await treeWatchLiveForTests(record.id);

      broadcasts.length = 0;
      writeFileSync(join(record.path, "generated", "new.txt"), "x\n");
      await waitFor(() =>
        broadcasts.some(
          (msg) =>
            msg.type === "worktreeChanges" &&
            msg.changes.worktreeId === record.id &&
            msg.changes.files.some((file) => file.path === "generated/new.txt"),
        ),
      );
      removeWorktreeViewer(record.id);
    } finally {
      subscribe.mockRestore();
      setTreeWatchLimitsForTests(previous);
      await removeWorktree(record.id, { force: true, deleteBranch: true });
    }
  },
);

test(
  "a failed subscribe of a viewed tree retries until events flow",
  { timeout: 30_000 },
  async () => {
    const previous = setTreeWatchLimitsForTests({ retryBaseMs: 60_000 });
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "subscribe-retry",
    });
    const original = parcelWatcher.subscribe.bind(parcelWatcher);
    let failed = false;
    const subscribe = vi
      .spyOn(parcelWatcher, "subscribe")
      .mockImplementation((dir, callback, options) => {
        if (dir === record.path && !failed) {
          failed = true;
          return Promise.reject(new Error("inotify watch limit reached"));
        }
        return original(dir, callback, options);
      });
    try {
      await addWorktreeViewer(record.id);
      assert.ok(failed);
      assert.equal(await treeWatchLiveForTests(record.id), false);
      assert.equal(treeActivityForTests(record.id)!.retryArmed, true);
      fireTreeRetriesForTests();
      await waitForAsync(() => treeWatchLiveForTests(record.id));

      broadcasts.length = 0;
      writeFileSync(join(record.path, "after-retry.txt"), "x\n");
      await waitFor(() =>
        broadcasts.some(
          (msg) =>
            msg.type === "worktreeChanges" &&
            msg.changes.worktreeId === record.id &&
            msg.changes.files.some((file) => file.path === "after-retry.txt"),
        ),
      );
      removeWorktreeViewer(record.id);
    } finally {
      subscribe.mockRestore();
      setTreeWatchLimitsForTests(previous);
      await removeWorktree(record.id, { force: true, deleteBranch: true });
    }
  },
);

/**
 * Spy on parcel subscribes of `paths`, whose subscriptions reject their next
 * `unsubscribe` while `failUnsubscribes` is above zero, and wait for `hold`
 * before releasing. `live`/`maxLive` count native subscriptions of them all.
 */
function flakyUnsubscribes(...paths: string[]) {
  const original = parcelWatcher.subscribe.bind(parcelWatcher);
  const state = {
    failUnsubscribes: 0,
    unsubscribeCalls: 0,
    hold: undefined as Promise<void> | undefined,
    live: 0,
    maxLive: 0,
  };
  const spy = vi
    .spyOn(parcelWatcher, "subscribe")
    .mockImplementation(async (dir, callback, options) => {
      const subscription = await original(dir, callback, options);
      if (!paths.includes(dir)) return subscription;
      state.live += 1;
      state.maxLive = Math.max(state.maxLive, state.live);
      return {
        unsubscribe: async () => {
          state.unsubscribeCalls += 1;
          await state.hold;
          if (state.failUnsubscribes > 0) {
            state.failUnsubscribes -= 1;
            throw new Error("unsubscribe failed");
          }
          await subscription.unsubscribe();
          state.live -= 1;
        },
      };
    });
  return { spy, state };
}

test(
  "a failed release keeps the old subscription and retries before re-subscribing",
  { timeout: 30_000 },
  async () => {
    const previous = setTreeWatchLimitsForTests({
      ignoreRefreshMs: 0,
      retryBaseMs: 60_000,
    });
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "release-failure",
    });
    const { spy, state } = flakyUnsubscribes(record.path);
    try {
      mkdirSync(join(record.path, "generated"));
      writeFileSync(join(record.path, "generated", "out.txt"), "x\n");
      writeFileSync(join(record.path, ".gitignore"), "generated/\n");
      await addWorktreeViewer(record.id);

      state.failUnsubscribes = 1;
      writeFileSync(join(record.path, ".gitignore"), "");
      await waitFor(() => state.unsubscribeCalls >= 1);
      assert.equal(
        subscribesOf(spy, record.path).length,
        1,
        "nothing subscribes while the old subscription may still be live",
      );
      assert.equal(await treeWatchLiveForTests(record.id), true);

      // The failed release armed its own retry; it releases, then subscribes.
      assert.equal(treeActivityForTests(record.id)!.retryArmed, true);
      fireTreeRetriesForTests();
      await waitFor(
        () =>
          subscribesOf(spy, record.path).length === 2 &&
          !subscribesOf(spy, record.path)[1]?.ignore?.includes("generated"),
      );
      assert.equal(state.unsubscribeCalls, 2);
      await treeWatchLiveForTests(record.id);
      broadcasts.length = 0;
      writeFileSync(join(record.path, "generated", "new.txt"), "x\n");
      await waitFor(() =>
        broadcasts.some(
          (msg) =>
            msg.type === "worktreeChanges" &&
            msg.changes.worktreeId === record.id &&
            msg.changes.files.some((file) => file.path === "generated/new.txt"),
        ),
      );
      removeWorktreeViewer(record.id);
    } finally {
      spy.mockRestore();
      setTreeWatchLimitsForTests(previous);
      await removeWorktree(record.id, { force: true, deleteBranch: true });
    }
  },
);

test(
  "a failed release when a linger ends is retried, never orphaned",
  { timeout: 30_000 },
  async () => {
    const previous = setTreeWatchLimitsForTests({ retryBaseMs: 200 });
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "linger-release",
    });
    const { spy, state } = flakyUnsubscribes(record.path);
    try {
      await addWorktreeViewer(record.id);
      removeWorktreeViewer(record.id);
      state.failUnsubscribes = 1;
      endTreeLingersForTests();
      await waitFor(() => state.unsubscribeCalls >= 1);
      // Forgotten by the registry, but the retry still owns the release.
      await waitFor(() => state.unsubscribeCalls === 2);
      assert.equal(await treeWatchLiveForTests(record.id), false);
    } finally {
      spy.mockRestore();
      setTreeWatchLimitsForTests(previous);
      await removeWorktree(record.id, { force: true, deleteBranch: true });
    }
  },
);

test(
  "a re-view after a failed release reuses the retiring watch",
  { timeout: 30_000 },
  async () => {
    const previous = setTreeWatchLimitsForTests({ retryBaseMs: 60_000 });
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "reuse-after-failure",
    });
    const { spy, state } = flakyUnsubscribes(record.path);
    try {
      await addWorktreeViewer(record.id);
      removeWorktreeViewer(record.id);
      // Every release fails until the re-view has settled: the leave and the
      // linger end each queue an attempt.
      state.failUnsubscribes = 100;
      endTreeLingersForTests();
      await waitFor(() => state.unsubscribeCalls >= 1);

      await addWorktreeViewer(record.id);
      state.failUnsubscribes = 0;
      // The release retry fires and now finds the watch wanted again.
      assert.equal(treeActivityForTests(record.id)!.retryArmed, true);
      fireTreeRetriesForTests();
      await treeWatchLiveForTests(record.id);
      assert.equal(state.maxLive, 1, "never two subscriptions of the path");
      assert.equal(
        subscribesOf(spy, record.path).length,
        1,
        "the retiring watch and its subscription are reused",
      );
      assert.equal(await treeWatchLiveForTests(record.id), true);

      broadcasts.length = 0;
      writeFileSync(join(record.path, "reused.txt"), "x\n");
      await waitFor(() =>
        broadcasts.some(
          (msg) =>
            msg.type === "worktreeChanges" &&
            msg.changes.worktreeId === record.id &&
            msg.changes.files.some((file) => file.path === "reused.txt"),
        ),
      );
      removeWorktreeViewer(record.id);
    } finally {
      spy.mockRestore();
      setTreeWatchLimitsForTests(previous);
      await removeWorktree(record.id, { force: true, deleteBranch: true });
    }
  },
);

test(
  "a re-view during an in-flight release subscribes only after it",
  { timeout: 30_000 },
  async () => {
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "reuse-in-flight",
    });
    const { spy, state } = flakyUnsubscribes(record.path);
    try {
      await addWorktreeViewer(record.id);
      removeWorktreeViewer(record.id);
      let release!: () => void;
      state.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      endTreeLingersForTests();
      await waitFor(() => state.unsubscribeCalls >= 1);

      const viewing = addWorktreeViewer(record.id);
      // The view's step queues behind the release still in flight.
      await waitFor(() => treeActivityForTests(record.id)!.settlesPending >= 2);
      assert.equal(
        subscribesOf(spy, record.path).length,
        1,
        "no subscribe while the old release is pending",
      );
      state.hold = undefined;
      release();
      await viewing;
      assert.equal(state.maxLive, 1, "never two subscriptions of the path");
      assert.equal(subscribesOf(spy, record.path).length, 2);
      assert.equal(await treeWatchLiveForTests(record.id), true);

      broadcasts.length = 0;
      writeFileSync(join(record.path, "after-release.txt"), "x\n");
      await waitFor(() =>
        broadcasts.some(
          (msg) =>
            msg.type === "worktreeChanges" &&
            msg.changes.worktreeId === record.id &&
            msg.changes.files.some((file) => file.path === "after-release.txt"),
        ),
      );
      removeWorktreeViewer(record.id);
    } finally {
      spy.mockRestore();
      await removeWorktree(record.id, { force: true, deleteBranch: true });
    }
  },
);

test(
  "a displaced subscription keeps its slot until its release completes",
  { timeout: 30_000 },
  async () => {
    const previous = setTreeWatchLimitsForTests({ maxWatches: 1 });
    const first = await createWorktree({
      projectId: "watch-proj",
      name: "cap-evict-first",
    });
    const second = await createWorktree({
      projectId: "watch-proj",
      name: "cap-evict-second",
    });
    const { spy, state } = flakyUnsubscribes(first.path, second.path);
    try {
      await addWorktreeViewer(first.id);
      assert.equal(await treeWatchLiveForTests(first.id), true);
      let release!: () => void;
      state.hold = new Promise<void>((resolve) => {
        release = resolve;
      });

      // The newer view displaces `first`, whose release starts at once but
      // stays in flight: `second` must wait for the slot, not crawl beside it.
      await addWorktreeViewer(second.id);
      await waitFor(() => state.unsubscribeCalls >= 1);
      // Every step `second` has queued has run, and none subscribed.
      assert.equal(await treeWatchLiveForTests(second.id), false);
      assert.equal(subscribesOf(spy, second.path).length, 0);
      assert.equal(state.maxLive, 1, "never above the cap");

      state.hold = undefined;
      release();
      await waitForAsync(() => treeWatchLiveForTests(second.id));
      assert.equal(state.maxLive, 1, "never above the cap");
      assert.equal(await treeWatchLiveForTests(first.id), false);
      assert.equal(worktreeViewerRefs(first.id), 1, "first keeps its viewer");
      removeWorktreeViewer(first.id);
      removeWorktreeViewer(second.id);
    } finally {
      spy.mockRestore();
      setTreeWatchLimitsForTests(previous);
      await removeWorktree(first.id, { force: true, deleteBranch: true });
      await removeWorktree(second.id, { force: true, deleteBranch: true });
    }
  },
);

test(
  "re-ranks never retry a failed release ahead of its backoff",
  { timeout: 30_000 },
  async () => {
    const previous = setTreeWatchLimitsForTests({ retryBaseMs: 1_000 });
    const record = await createWorktree({
      projectId: "watch-proj",
      name: "release-backoff",
    });
    const other = await createWorktree({
      projectId: "watch-proj",
      name: "release-backoff-other",
    });
    const { spy, state } = flakyUnsubscribes(record.path);
    /** Yield to I/O (git, parcel) without a timer, which is faked here. */
    const until = async (predicate: () => boolean) => {
      for (let turn = 0; !predicate(); turn += 1) {
        if (turn > 20_000) throw new Error("Timed out waiting for watcher.");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    try {
      await addWorktreeViewer(record.id);
      removeWorktreeViewer(record.id);
      // Only the retry timer is faked: it fires when the test says so, however
      // slow the churn below runs.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      state.failUnsubscribes = 1_000;
      endTreeLingersForTests();
      await until(() => state.unsubscribeCalls >= 1);

      // Unrelated viewers arriving and leaving re-rank every watch.
      for (let round = 0; round < 3; round += 1) {
        await addWorktreeViewer(other.id);
        removeWorktreeViewer(other.id);
      }
      for (let turn = 0; turn < 50; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(state.unsubscribeCalls, 1, "only the timer retries");

      vi.advanceTimersByTime(1_000);
      await until(() => state.unsubscribeCalls === 2);
      state.failUnsubscribes = 0;
      // The next backoff (2 s) finally releases it.
      vi.advanceTimersByTime(2_000);
      await until(() => state.unsubscribeCalls === 3);
      await until(() => state.live === 0);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
      setTreeWatchLimitsForTests(previous);
      await removeWorktree(record.id, { force: true, deleteBranch: true });
      await removeWorktree(other.id, { force: true, deleteBranch: true });
    }
  },
);
