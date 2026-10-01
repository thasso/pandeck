import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import type { GitResult } from "../gitExec.ts";
import {
  baseCheckoutRefreshOperationsForTests,
  refreshBaseCheckoutAfterMerge,
  type BaseCheckoutRefreshOperations,
} from "./baseCheckoutRefresh.ts";

const target = "a1b2c3d4e5f6789012345678901234567890abcd";
const oldHead = "0123456789012345678901234567890123456789";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8" },
  );
}

function realRepo(name: string): {
  root: string;
  remote: string;
  main: string;
  feature: string;
} {
  const root = mkdtempSync(join(tmpdir(), `base-checkout-refresh-${name}-`));
  const remote = join(root, "remote.git");
  const main = join(root, "main");
  const feature = join(root, "feature");
  mkdirSync(remote);
  sh(remote, "init", "--bare", "--initial-branch=main");
  mkdirSync(main);
  sh(main, "init", "--initial-branch=main");
  writeFileSync(join(main, "base.txt"), "base\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-m", "base");
  sh(main, "remote", "add", "origin", remote);
  sh(main, "push", "-u", "origin", "main");
  sh(main, "worktree", "add", "-b", "feature", feature);
  return { root, remote, main, feature };
}

function advanceRemote(repo: ReturnType<typeof realRepo>): string {
  const upstream = join(repo.root, "upstream");
  sh(repo.root, "clone", "--branch", "main", repo.remote, upstream);
  writeFileSync(join(upstream, "remote.txt"), "remote\n");
  sh(upstream, "add", "-A");
  sh(upstream, "commit", "-m", "remote");
  sh(upstream, "push", "origin", "main");
  return sh(upstream, "rev-parse", "HEAD").trim();
}

function row(
  id: string,
  path: string,
  branch: string,
  overrides: Partial<WorktreeRow> = {},
): WorktreeRow {
  return {
    id,
    projectId: "project-1",
    mainRepoRoot: "/repo/main",
    path,
    branch,
    baseBranch: "main",
    baseCommit: oldHead,
    status: "active",
    mergeStateJson: null,
    createdAt: 0,
    updatedAt: 0,
    removedAt: null,
    ...overrides,
  };
}

interface Recorder {
  calls: string[];
  invalidated: string[];
}

function operations(overrides: Partial<BaseCheckoutRefreshOperations> = {}): {
  operations: BaseCheckoutRefreshOperations;
  recorder: Recorder;
} {
  const recorder: Recorder = { calls: [], invalidated: [] };
  const source = row("feature", "/repo/feature", "feature");
  const main = row("main:project-1", "/repo/main", "main");
  const defaults: BaseCheckoutRefreshOperations = {
    resolveWorktree: async () => source,
    resolveMainWorktree: async () => main,
    listSpawnedWorktrees: () => [source],
    repoKey: async () => "repo-key",
    currentBranch: async (path) => (path === main.path ? "main" : "feature"),
    isDirty: async () => false,
    head: async () => oldHead,
    baseRemote: async () => "origin",
    fetchBaseTarget: async () => {
      recorder.calls.push("fetch-target");
      return target;
    },
    isAncestor: async () => true,
    localBranchOid: async () => oldHead,
    fastForwardCheckout: async () => {
      recorder.calls.push("merge-ff-only");
    },
    updateSubmodules: async () => {
      recorder.calls.push("submodules");
    },
    fastForwardLocalBranch: async (_path, remote, branch) => {
      recorder.calls.push(
        `fetch-refspec:${remote}:${branch}:refs/heads/${branch}`,
      );
      return { stdout: "", stderr: "", code: 0 };
    },
    withRepoLock: async (_key, run) => {
      recorder.calls.push("lock");
      return run();
    },
    invalidateStatus: (id) => recorder.invalidated.push(id),
  };
  return { operations: { ...defaults, ...overrides }, recorder };
}

const input = {
  worktreeId: "feature",
  repoPath: "/repo/feature",
  baseBranch: "main",
};

test("fast-forwards a clean managed base checkout and updates submodules", async () => {
  const fixture = operations();

  assert.equal(
    await refreshBaseCheckoutAfterMerge(input, fixture.operations),
    "Updated main to a1b2c3d.",
  );
  assert.deepEqual(fixture.recorder.calls, [
    "fetch-target",
    "lock",
    "merge-ff-only",
    "submodules",
  ]);
  assert.deepEqual(fixture.recorder.invalidated, ["main:project-1", "feature"]);
});

test("does not merge an already-current managed base checkout", async () => {
  const fixture = operations({ head: async () => target });

  assert.equal(
    await refreshBaseCheckoutAfterMerge(input, fixture.operations),
    "main was already up to date.",
  );
  assert.deepEqual(fixture.recorder.calls, ["fetch-target", "lock"]);
  assert.deepEqual(fixture.recorder.invalidated, ["main:project-1", "feature"]);
});

test("fast-forwards an existing base ref that no managed checkout holds", async () => {
  const fixture = operations({
    currentBranch: async (path) =>
      path === "/repo/main" ? "topic" : "feature",
  });

  assert.equal(
    await refreshBaseCheckoutAfterMerge(input, fixture.operations),
    "Fast-forwarded main (not checked out anywhere).",
  );
  assert.deepEqual(fixture.recorder.calls, [
    "fetch-target",
    "lock",
    "fetch-refspec:origin:main:refs/heads/main",
  ]);
  assert.deepEqual(fixture.recorder.invalidated, ["main:project-1", "feature"]);
});

test("does not fetch an already-current unmanaged base ref", async () => {
  const fixture = operations({
    currentBranch: async (path) =>
      path === "/repo/main" ? "topic" : "feature",
    localBranchOid: async () => target,
  });

  assert.equal(
    await refreshBaseCheckoutAfterMerge(input, fixture.operations),
    "main was already up to date.",
  );
  assert.deepEqual(fixture.recorder.calls, ["fetch-target", "lock"]);
  assert.deepEqual(fixture.recorder.invalidated, ["main:project-1", "feature"]);
});

test("an unclassified local branch fetch refusal stays an honest generic outcome", async () => {
  const fixture = operations({
    currentBranch: async (path) =>
      path === "/repo/main" ? "topic" : "feature",
    fastForwardLocalBranch: async () => ({
      stdout: "",
      stderr: "fatal: an unexpected refusal",
      code: 128,
    }),
  });

  assert.equal(
    await refreshBaseCheckoutAfterMerge(input, fixture.operations),
    "main was not updated: Git refused the fast-forward.",
  );
});

test("does not write a dirty managed base checkout", async () => {
  const fixture = operations({ isDirty: async () => true });

  assert.equal(
    await refreshBaseCheckoutAfterMerge(input, fixture.operations),
    "main was not updated: it has uncommitted changes.",
  );
  assert.deepEqual(fixture.recorder.calls, ["fetch-target", "lock"]);
});

test("does not write a managed base checkout with local commits", async () => {
  const fixture = operations({ isAncestor: async () => false });

  assert.equal(
    await refreshBaseCheckoutAfterMerge(input, fixture.operations),
    "main was not updated: it has local commits that are not in origin/main.",
  );
  assert.deepEqual(fixture.recorder.calls, ["fetch-target", "lock"]);
});

test("fetches the target but does not create an absent local base branch", async () => {
  const fixture = operations({
    currentBranch: async (path) =>
      path === "/repo/main" ? "topic" : "feature",
    localBranchOid: async () => undefined,
  });

  assert.equal(
    await refreshBaseCheckoutAfterMerge(input, fixture.operations),
    "main was not updated: it does not exist locally.",
  );
  assert.deepEqual(fixture.recorder.calls, ["fetch-target", "lock"]);
});

test("does not write when the managed base checkout detaches after discovery", async () => {
  let mainReads = 0;
  const fixture = operations({
    currentBranch: async (path) => {
      if (path !== "/repo/main") return "feature";
      mainReads += 1;
      return mainReads === 1 ? "main" : "";
    },
  });

  assert.equal(
    await refreshBaseCheckoutAfterMerge(input, fixture.operations),
    "main was not updated: its managed checkout is detached.",
  );
  assert.deepEqual(fixture.recorder.calls, ["fetch-target", "lock"]);
});

/* ----------------------- production Git behavior ------------------------- */

test("the production local-ref fetch treats a leading plus as literal and refuses divergence", async () => {
  const repo = realRepo("leading-plus-non-fast-forward");
  sh(repo.main, "switch", "-c", "+foo");
  writeFileSync(join(repo.main, "local.txt"), "local\n");
  sh(repo.main, "add", "-A");
  sh(repo.main, "commit", "-m", "local plus branch");
  const localPlus = sh(repo.main, "rev-parse", "refs/heads/+foo").trim();
  sh(repo.main, "switch", "-c", "topic");

  const upstream = join(repo.root, "upstream");
  sh(repo.root, "clone", "--branch", "main", repo.remote, upstream);
  sh(upstream, "switch", "-c", "+foo");
  writeFileSync(join(upstream, "remote-plus.txt"), "remote plus\n");
  sh(upstream, "add", "-A");
  sh(upstream, "commit", "-m", "remote plus branch");
  const remotePlus = sh(upstream, "rev-parse", "HEAD").trim();
  sh(upstream, "push", "origin", "refs/heads/+foo:refs/heads/+foo");

  sh(upstream, "switch", "main");
  sh(upstream, "switch", "-c", "foo");
  writeFileSync(join(upstream, "remote-plain.txt"), "remote plain\n");
  sh(upstream, "add", "-A");
  sh(upstream, "commit", "-m", "remote plain branch");
  const remotePlain = sh(upstream, "rev-parse", "HEAD").trim();
  sh(upstream, "push", "origin", "refs/heads/foo:refs/heads/foo");
  assert.notEqual(localPlus, remotePlus);
  assert.notEqual(localPlus, remotePlain);
  assert.notEqual(remotePlus, remotePlain);

  const result =
    await baseCheckoutRefreshOperationsForTests().fastForwardLocalBranch(
      repo.main,
      "origin",
      "+foo",
    );

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /non-fast-forward|rejected/i);
  assert.equal(sh(repo.main, "rev-parse", "refs/heads/+foo").trim(), localPlus);
});

test("the production local-ref fetch classifies Git's real checked-out refusal", async () => {
  const repo = realRepo("checked-out");
  sh(repo.main, "switch", "-c", "topic");
  const checkedOutMain = join(repo.root, "checked-out-main");
  sh(repo.main, "worktree", "add", checkedOutMain, "main");
  const localMain = sh(repo.main, "rev-parse", "main").trim();
  const remoteMain = advanceRemote(repo);
  assert.notEqual(localMain, remoteMain);

  const source = row("feature", repo.feature, "feature", {
    mainRepoRoot: repo.main,
  });
  const main = row("main:project-1", repo.main, "topic", {
    mainRepoRoot: repo.main,
  });
  const defaults = baseCheckoutRefreshOperationsForTests();
  let refusal: GitResult | undefined;
  const outcome = await refreshBaseCheckoutAfterMerge(
    {
      worktreeId: source.id,
      repoPath: source.path,
      baseBranch: "main",
    },
    {
      ...defaults,
      resolveWorktree: async () => source,
      resolveMainWorktree: async () => main,
      listSpawnedWorktrees: () => [source],
      fastForwardLocalBranch: async (...args) => {
        refusal = await defaults.fastForwardLocalBranch(...args);
        return refusal;
      },
      invalidateStatus: () => undefined,
    },
  );

  assert.ok(refusal);
  assert.notEqual(refusal.code, 0);
  assert.match(
    refusal.stderr,
    /refusing to fetch into branch 'refs\/heads\/main' checked out at/,
  );
  assert.equal(
    outcome,
    "main was not updated: it is checked out in another worktree.",
  );
  assert.equal(sh(repo.main, "rev-parse", "main").trim(), localMain);
});
