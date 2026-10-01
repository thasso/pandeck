import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { backgroundFetchArgs } from "./worktreeFetch.ts";
import {
  baseBranchTarget,
  syncWorktree,
  WorktreeSyncConflictError,
} from "./worktreeSync.ts";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8" },
  );
}

function setup(name: string): {
  root: string;
  main: string;
  feature: string;
  remote: string;
  row: WorktreeRow;
} {
  const root = mkdtempSync(join(tmpdir(), `worktree-sync-${name}-`));
  const remote = join(root, "remote.git");
  const main = join(root, "main");
  const feature = join(root, "feature");
  mkdirSync(remote);
  sh(remote, "init", "--bare");
  mkdirSync(main);
  sh(main, "init", "-b", "main");
  writeFileSync(join(main, "file.txt"), "base\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-m", "base");
  sh(main, "remote", "add", "origin", remote);
  sh(main, "push", "-u", "origin", "main");
  sh(main, "worktree", "add", "-b", "feature", feature);
  sh(feature, "push", "-u", "origin", "feature");
  const base = sh(main, "rev-parse", "HEAD").trim();
  return {
    root,
    main,
    feature,
    remote,
    row: {
      id: `wt-${name}`,
      projectId: `project-${name}`,
      mainRepoRoot: main,
      path: feature,
      branch: "feature",
      baseBranch: "main",
      baseCommit: base,
      status: "active",
      mergeStateJson: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      removedAt: null,
    },
  };
}

function cloneRemote(root: string, remote: string, branch: string): string {
  const other = join(root, `other-${branch}`);
  sh(root, "clone", "--branch", branch, remote, other);
  return other;
}

test("pull with rebase updates cleanly and aborts conflicts back to the original HEAD", async () => {
  const repo = setup("pull");
  writeFileSync(join(repo.feature, "local.txt"), "local\n");
  sh(repo.feature, "add", "-A");
  sh(repo.feature, "commit", "-m", "local");

  const other = cloneRemote(repo.root, repo.remote, "feature");
  writeFileSync(join(other, "remote.txt"), "remote\n");
  sh(other, "add", "-A");
  sh(other, "commit", "-m", "remote");
  sh(other, "push");

  const pulled = await syncWorktree(repo.row, "pull-rebase");
  assert.equal(pulled.status, "updated");
  assert.equal(sh(repo.feature, "status", "--porcelain").trim(), "");
  assert.equal(
    sh(repo.feature, "merge-base", "--is-ancestor", "origin/feature", "HEAD"),
    "",
  );

  writeFileSync(join(repo.feature, "file.txt"), "local conflict\n");
  sh(repo.feature, "add", "-A");
  sh(repo.feature, "commit", "-m", "local conflict");
  sh(other, "pull", "--rebase");
  writeFileSync(join(other, "file.txt"), "remote conflict\n");
  sh(other, "add", "-A");
  sh(other, "commit", "-m", "remote conflict");
  sh(other, "push");
  const before = sh(repo.feature, "rev-parse", "HEAD").trim();

  await assert.rejects(
    () => syncWorktree(repo.row, "pull-rebase"),
    (err: unknown) => {
      assert.ok(err instanceof WorktreeSyncConflictError);
      assert.match(err.message, /conflict.*aborted.*restored/i);
      assert.deepEqual(err.conflictedFiles, ["file.txt"]);
      return true;
    },
  );
  assert.equal(sh(repo.feature, "rev-parse", "HEAD").trim(), before);
  assert.equal(sh(repo.feature, "status", "--porcelain").trim(), "");
});

/**
 * The base branch AS THE REMOTE HAS IT is the target: the local main checkout
 * is one clone among several and is not consulted, so every case here pushes
 * the base commit it expects to be rebased onto.
 */
test("rebase onto main succeeds cleanly and restores the branch on conflict", async () => {
  const clean = setup("rebase-clean");
  writeFileSync(join(clean.feature, "feature.txt"), "feature\n");
  sh(clean.feature, "add", "-A");
  sh(clean.feature, "commit", "-m", "feature");
  writeFileSync(join(clean.main, "main.txt"), "main\n");
  sh(clean.main, "add", "-A");
  sh(clean.main, "commit", "-m", "main");
  sh(clean.main, "push", "origin", "main");
  const result = await syncWorktree(clean.row, "rebase-main");
  assert.equal(result.status, "updated");
  assert.equal(
    sh(clean.feature, "merge-base", "--is-ancestor", "main", "feature"),
    "",
  );

  const conflict = setup("rebase-conflict");
  writeFileSync(join(conflict.feature, "file.txt"), "feature\n");
  sh(conflict.feature, "add", "-A");
  sh(conflict.feature, "commit", "-m", "feature conflict");
  writeFileSync(join(conflict.main, "file.txt"), "main\n");
  sh(conflict.main, "add", "-A");
  sh(conflict.main, "commit", "-m", "main conflict");
  sh(conflict.main, "push", "origin", "main");
  const before = sh(conflict.feature, "rev-parse", "HEAD").trim();

  await assert.rejects(
    () => syncWorktree(conflict.row, "rebase-main"),
    (err: unknown) => {
      assert.ok(err instanceof WorktreeSyncConflictError);
      assert.match(err.message, /conflict.*aborted.*restored/i);
      assert.deepEqual(err.conflictedFiles, ["file.txt"]);
      return true;
    },
  );
  assert.equal(sh(conflict.feature, "rev-parse", "HEAD").trim(), before);
  assert.equal(sh(conflict.feature, "status", "--porcelain").trim(), "");
});

test("conflict evidence reports when more than twenty files were truncated", async () => {
  const conflict = setup("rebase-many-conflicts");
  for (let index = 0; index < 21; index += 1) {
    writeFileSync(join(conflict.feature, `conflict-${index}.txt`), "feature\n");
    writeFileSync(join(conflict.main, `conflict-${index}.txt`), "main\n");
  }
  sh(conflict.feature, "add", "-A");
  sh(conflict.feature, "commit", "-m", "feature conflicts");
  sh(conflict.main, "add", "-A");
  sh(conflict.main, "commit", "-m", "main conflicts");
  sh(conflict.main, "push", "origin", "main");
  const before = sh(conflict.feature, "rev-parse", "HEAD").trim();

  await assert.rejects(
    () => syncWorktree(conflict.row, "rebase-main"),
    (err: unknown) => {
      assert.ok(err instanceof WorktreeSyncConflictError);
      assert.equal(err.conflictedFiles.length, 20);
      assert.equal(err.conflictedFilesTruncated, true);
      assert.equal(err.originalHead, before);
      return true;
    },
  );
  assert.equal(sh(conflict.feature, "rev-parse", "HEAD").trim(), before);
  assert.equal(sh(conflict.feature, "status", "--porcelain").trim(), "");
});

test("rebase onto main ignores commits the main checkout has not pushed", async () => {
  const repo = setup("rebase-local-only");
  writeFileSync(join(repo.feature, "feature.txt"), "feature\n");
  sh(repo.feature, "add", "-A");
  sh(repo.feature, "commit", "-m", "feature");
  const before = sh(repo.feature, "rev-parse", "HEAD").trim();
  // Local-only on this machine's main checkout: nobody else can see it, so it
  // is not what "up to date with main" means.
  writeFileSync(join(repo.main, "unpushed.txt"), "unpushed\n");
  sh(repo.main, "add", "-A");
  sh(repo.main, "commit", "-m", "unpushed");

  const result = await syncWorktree(repo.row, "rebase-main");
  assert.equal(result.status, "up-to-date");
  assert.equal(sh(repo.feature, "rev-parse", "HEAD").trim(), before);
  assert.equal(existsSync(join(repo.feature, "unpushed.txt")), false);
});

test("an explicit base remote overrides branch remote configuration and a narrow fetch mapping", async () => {
  const repo = setup("explicit-base-remote");
  const upstreamRemote = join(repo.root, "upstream.git");
  sh(repo.root, "clone", "--bare", repo.remote, upstreamRemote);
  sh(repo.feature, "remote", "add", "upstream", upstreamRemote);
  sh(repo.feature, "config", "branch.main.remote", "upstream");

  const originClone = join(repo.root, "origin-clone");
  sh(repo.root, "clone", "--branch", "main", repo.remote, originClone);
  writeFileSync(join(originClone, "origin.txt"), "origin\n");
  sh(originClone, "add", "-A");
  sh(originClone, "commit", "-m", "origin base");
  sh(originClone, "push");
  const originHead = sh(originClone, "rev-parse", "HEAD").trim();

  const upstreamClone = join(repo.root, "upstream-clone");
  sh(repo.root, "clone", "--branch", "main", upstreamRemote, upstreamClone);
  writeFileSync(join(upstreamClone, "upstream.txt"), "upstream\n");
  sh(upstreamClone, "add", "-A");
  sh(upstreamClone, "commit", "-m", "upstream base");
  sh(upstreamClone, "push");
  assert.notEqual(sh(upstreamClone, "rev-parse", "HEAD").trim(), originHead);
  assert.notEqual(
    sh(repo.feature, "rev-parse", "refs/remotes/origin/main").trim(),
    originHead,
  );
  // A command-line branch name only guarantees FETCH_HEAD. The explicit
  // destination in baseBranchTarget must update this tracking ref even when the
  // configured wildcard does not include main.
  sh(
    repo.feature,
    "config",
    "--replace-all",
    "remote.origin.fetch",
    "+refs/heads/feature:refs/remotes/origin/feature",
  );

  assert.equal(
    await baseBranchTarget(repo.row, { remote: "origin" }),
    originHead,
  );
  assert.equal(
    sh(repo.feature, "rev-parse", "refs/remotes/origin/main").trim(),
    originHead,
    "the targeted fetch must also refresh status counters' remote-tracking ref",
  );
});

test("a leading-plus base fetch targets the literal fully qualified branch", async () => {
  const repo = setup("leading-plus-base");
  const upstream = cloneRemote(repo.root, repo.remote, "main");

  sh(upstream, "switch", "-c", "+foo");
  writeFileSync(join(upstream, "plus.txt"), "plus\n");
  sh(upstream, "add", "-A");
  sh(upstream, "commit", "-m", "plus branch");
  const plusHead = sh(upstream, "rev-parse", "HEAD").trim();
  sh(upstream, "push", "origin", "refs/heads/+foo:refs/heads/+foo");

  sh(upstream, "switch", "main");
  sh(upstream, "switch", "-c", "foo");
  writeFileSync(join(upstream, "plain.txt"), "plain\n");
  sh(upstream, "add", "-A");
  sh(upstream, "commit", "-m", "plain branch");
  const plainHead = sh(upstream, "rev-parse", "HEAD").trim();
  sh(upstream, "push", "origin", "refs/heads/foo:refs/heads/foo");
  assert.notEqual(plusHead, plainHead);

  assert.equal(
    await baseBranchTarget(
      { ...repo.row, baseBranch: "+foo" },
      { remote: "origin" },
    ),
    plusHead,
  );
  assert.equal(
    sh(repo.feature, "rev-parse", "refs/remotes/origin/+foo").trim(),
    plusHead,
  );
  assert.equal(sh(repo.feature, "rev-parse", "FETCH_HEAD").trim(), plusHead);
});

// The other side of that read: `worktreeFetch.ts` sweeps the MAIN checkout
// without the repository lock, and FETCH_HEAD is per-working-tree — so its argv
// is the only thing standing between a background sweep and the target a locked
// `pull-rebase` is about to read here. This asserts what that argv does to a
// real repository; that the sweep issues it is asserted in worktreeFetch.test.ts.
test("the background sweep updates tracking refs without touching FETCH_HEAD", () => {
  const repo = setup("background-sweep");
  // A locked operation has just recorded the base it intends to rebase onto.
  const sentinel = sh(repo.main, "rev-parse", "HEAD").trim();
  writeFileSync(
    join(repo.main, ".git", "FETCH_HEAD"),
    `${sentinel}\t\tbranch 'main' of ${repo.remote}\n`,
  );

  // Meanwhile the remote moves, so the sweep really has a ref to update.
  const other = cloneRemote(repo.root, repo.remote, "main");
  writeFileSync(join(other, "moved.txt"), "moved\n");
  sh(other, "add", "-A");
  sh(other, "commit", "-m", "moved");
  sh(other, "push", "origin", "main");
  const moved = sh(other, "rev-parse", "HEAD").trim();

  sh(repo.main, ...backgroundFetchArgs());

  assert.equal(
    sh(repo.main, "rev-parse", "refs/remotes/origin/main").trim(),
    moved,
    "the sweep must still do its job",
  );
  assert.equal(
    readFileSync(join(repo.main, ".git", "FETCH_HEAD"), "utf8"),
    `${sentinel}\t\tbranch 'main' of ${repo.remote}\n`,
    "a locked rebase target must survive a background sweep",
  );
});

test("a local-dot base remote fetches the same-named local branch", async () => {
  const repo = setup("local-dot-base");
  writeFileSync(join(repo.main, "local-base.txt"), "local base\n");
  sh(repo.main, "add", "-A");
  sh(repo.main, "commit", "-m", "local base");
  const localHead = sh(repo.main, "rev-parse", "refs/heads/main").trim();
  sh(repo.feature, "config", "branch.main.remote", ".");

  assert.equal(await baseBranchTarget(repo.row), localHead);
  assert.equal(sh(repo.feature, "rev-parse", "FETCH_HEAD").trim(), localHead);
});

test("an ad-hoc path base remote populates FETCH_HEAD without a tracking ref", async () => {
  const repo = setup("path-base");
  const pathRemote = join(repo.root, "path-remote.git");
  sh(repo.root, "clone", "--bare", repo.remote, pathRemote);
  const upstream = join(repo.root, "path-upstream");
  sh(repo.root, "clone", "--branch", "main", pathRemote, upstream);
  writeFileSync(join(upstream, "path-base.txt"), "path base\n");
  sh(upstream, "add", "-A");
  sh(upstream, "commit", "-m", "path base");
  sh(upstream, "push", "origin", "main");
  const pathHead = sh(upstream, "rev-parse", "HEAD").trim();
  const originTracking = sh(
    repo.feature,
    "rev-parse",
    "refs/remotes/origin/main",
  ).trim();
  assert.notEqual(originTracking, pathHead);
  sh(repo.feature, "config", "branch.main.remote", pathRemote);

  assert.equal(await baseBranchTarget(repo.row), pathHead);
  assert.equal(sh(repo.feature, "rev-parse", "FETCH_HEAD").trim(), pathHead);
  assert.equal(
    sh(repo.feature, "rev-parse", "refs/remotes/origin/main").trim(),
    originTracking,
  );
});

test("rebase onto main refuses when several remotes could be the base's", async () => {
  const repo = setup("rebase-ambiguous");
  // No `origin` and no `branch.main.remote`: two candidate histories, and
  // guessing one would rewrite the branch against a base nobody named.
  sh(repo.main, "remote", "rename", "origin", "upstream");
  sh(repo.main, "remote", "add", "fork", repo.remote);
  sh(repo.feature, "config", "--unset", "branch.main.remote");
  const before = sh(repo.feature, "rev-parse", "HEAD").trim();

  await assert.rejects(
    () => syncWorktree(repo.row, "rebase-main"),
    /no configured remote.*several/i,
  );
  assert.equal(sh(repo.feature, "rev-parse", "HEAD").trim(), before);
});

test("fast-forward main advances only when possible and otherwise leaves main unchanged", async () => {
  const clean = setup("ff-clean");
  writeFileSync(join(clean.feature, "feature.txt"), "feature\n");
  sh(clean.feature, "add", "-A");
  sh(clean.feature, "commit", "-m", "feature");
  const source = sh(clean.feature, "rev-parse", "HEAD").trim();
  const merged = await syncWorktree(clean.row, "fast-forward-main");
  assert.equal(merged.status, "updated");
  assert.equal(sh(clean.main, "rev-parse", "HEAD").trim(), source);

  const divergent = setup("ff-divergent");
  writeFileSync(join(divergent.feature, "feature.txt"), "feature\n");
  sh(divergent.feature, "add", "-A");
  sh(divergent.feature, "commit", "-m", "feature");
  writeFileSync(join(divergent.main, "main.txt"), "main\n");
  sh(divergent.main, "add", "-A");
  sh(divergent.main, "commit", "-m", "main");
  const before = sh(divergent.main, "rev-parse", "HEAD").trim();

  await assert.rejects(
    () => syncWorktree(divergent.row, "fast-forward-main"),
    /could not fast-forward.*left unchanged/i,
  );
  assert.equal(sh(divergent.main, "rev-parse", "HEAD").trim(), before);
  assert.equal(sh(divergent.main, "status", "--porcelain").trim(), "");
});

/**
 * Submodules on pull. Pulling is the app's ONE update path for a checkout (the
 * Project page no longer clones-and-pulls), so the submodule handling that used
 * to live in `projectProvision.pullProjectRepo` is verified here.
 *
 * Local file remotes need `protocol.file.allow=always`; the code under test
 * passes no such flag, so it is injected through `GIT_CONFIG_*` for the git
 * processes it spawns.
 */
function withFileTransport<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
  process.env.GIT_CONFIG_VALUE_0 = "always";
  const restore = () => {
    if (previous.count === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = previous.count;
    if (previous.key === undefined) delete process.env.GIT_CONFIG_KEY_0;
    else process.env.GIT_CONFIG_KEY_0 = previous.key;
    if (previous.value === undefined) delete process.env.GIT_CONFIG_VALUE_0;
    else process.env.GIT_CONFIG_VALUE_0 = previous.value;
  };
  return run().finally(restore);
}

/** `git` with a fixed identity plus file-transport allowance (for submodules). */
function shf(cwd: string, ...args: string[]): string {
  return sh(cwd, "-c", "protocol.file.allow=always", ...args);
}

/** A bare repo seeded with one commit on `main` through a throwaway clone. */
function seededBare(root: string, name: string, file: string): string {
  const bare = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  mkdirSync(bare, { recursive: true });
  sh(bare, "init", "--bare", "-b", "main");
  sh(root, "clone", bare, seed);
  writeFileSync(join(seed, file), "v1\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-m", "seed");
  sh(seed, "push", "origin", "main");
  return bare;
}

/**
 * A checkout of a super repo with `sub` embedded, plus a second clone that
 * stands in for "upstream". Shaped like `setup()` so `syncWorktree` can pull the
 * checkout itself (branch `main` with an upstream) rather than a spawned branch.
 */
function setupSuper(
  name: string,
  withSubmodule: boolean,
): { root: string; work: string; upstream: string; row: WorktreeRow } {
  const root = mkdtempSync(join(tmpdir(), `worktree-sync-${name}-`));
  const bare = seededBare(root, `${name}-super`, "top.txt");
  const upstream = join(root, `${name}-upstream`);
  sh(root, "clone", bare, upstream);
  if (withSubmodule) {
    const subBare = seededBare(root, `${name}-sub`, "subfile.txt");
    shf(upstream, "submodule", "add", subBare, "sub");
    sh(upstream, "commit", "-m", "add submodule");
    sh(upstream, "push", "origin", "main");
  }
  const work = join(root, `${name}-work`);
  shf(root, "clone", "--recurse-submodules", bare, work);
  return {
    root,
    work,
    upstream,
    row: {
      id: `wt-${name}`,
      projectId: `project-${name}`,
      mainRepoRoot: work,
      path: work,
      branch: "main",
      baseBranch: "main",
      baseCommit: sh(work, "rev-parse", "HEAD").trim(),
      status: "active",
      mergeStateJson: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      removedAt: null,
    },
  };
}

test("pull advances an existing submodule to the pulled gitlink", async () => {
  const repo = setupSuper("sub-advance", true);
  assert.ok(
    !existsSync(join(repo.work, "sub", "subfile2.txt")),
    "new submodule file absent before the pull",
  );

  const subInUpstream = join(repo.upstream, "sub");
  writeFileSync(join(subInUpstream, "subfile2.txt"), "v2\n");
  sh(subInUpstream, "add", "-A");
  sh(subInUpstream, "commit", "-m", "submodule v2");
  sh(subInUpstream, "push", "origin", "HEAD:main");
  sh(repo.upstream, "add", "sub");
  sh(repo.upstream, "commit", "-m", "bump submodule");
  sh(repo.upstream, "push", "origin", "main");

  await withFileTransport(() => syncWorktree(repo.row, "pull-rebase"));
  assert.ok(
    existsSync(join(repo.work, "sub", "subfile2.txt")),
    "submodule advanced to the pulled gitlink",
  );
});

test("pull initializes a submodule added upstream after the clone", async () => {
  const repo = setupSuper("sub-added", false);
  assert.ok(
    !existsSync(join(repo.work, "sub")),
    "no submodule before it is added upstream",
  );

  const subBare = seededBare(repo.root, "sub-added-late", "subfile.txt");
  shf(repo.upstream, "submodule", "add", subBare, "sub");
  sh(repo.upstream, "commit", "-m", "add submodule later");
  sh(repo.upstream, "push", "origin", "main");

  await withFileTransport(() => syncWorktree(repo.row, "pull-rebase"));
  assert.ok(
    existsSync(join(repo.work, "sub", "subfile.txt")),
    "newly added submodule initialized on pull",
  );
});
