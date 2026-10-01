/**
 * `createWorktree`'s `track-remote` source against REAL repositories: a
 * checkout whose own branch is the remote's and tracks it, the merge-back base
 * it records, the preconditions it refuses instead of resolving, and the
 * update that brings it to a moved head (`worktreeSync.ts`'s `pull-rebase`,
 * which is the same seam the review checkout uses). Run:
 *   pnpm --filter @assistant/server test src/worktrees/worktreeTracking.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "worktree-tracking-"));
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";
// Cloning a submodule over the `file` transport is refused by default
// (CVE-2022-39253); the production git calls carry no `-c` overrides, so the
// allowance is injected through the environment the way a host would.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";

const { createWorktree, listWorktreeRecords, WorktreeCreateRefusalError } =
  await import("./worktrees.ts");
const { syncWorktree, WorktreeSyncPreconditionError } =
  await import("./worktreeSync.ts");
const { getWorktree } = await import("../db/worktreeStore.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { linkTaskToWorktree } = await import("../db/worktreeStore.ts");
const { createTask, archiveTask } = await import("../tasks.ts");
const { pullRequestCheckoutOperationsForTests } =
  await import("../pullRequestViewCheckout.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  sh(path, "init", "-b", "main");
  writeFileSync(join(path, "readme.md"), "hello\n");
  sh(path, "add", "-A");
  sh(path, "commit", "-m", "init");
}

/** A commit on `branch` of `repo`, created without leaving the current branch. */
function commitOn(repo: string, branch: string, text: string): string {
  const previous = sh(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
  sh(repo, "checkout", "-q", branch);
  writeFileSync(join(repo, `${text}.txt`), `${text}\n`);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", text);
  const oid = sh(repo, "rev-parse", "HEAD").trim();
  sh(repo, "checkout", "-q", previous);
  return oid;
}

const worktreeRoot = join(tmp, "wt-root");

/** A remote with `main`, `feature-7` and `feature/deep-fix`. */
const remotePath = join(tmp, "remote");
initRepo(remotePath);
sh(remotePath, "branch", "feature-7");
sh(remotePath, "branch", "feature/deep-fix");
commitOn(remotePath, "feature-7", "seven");
commitOn(remotePath, "feature/deep-fix", "deep");

function clone(name: string): string {
  const path = join(tmp, name);
  execFileSync("git", ["clone", "--quiet", remotePath, path], { cwd: tmp });
  return path;
}

function project(id: string, path: string): void {
  projectStore.put({
    id,
    name: id,
    key: id.toUpperCase(),
    description: "",
    status: "active",
    localPaths: [{ path, kind: "repo", match: "prefix" }],
    worktreeRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

const trackRepo = clone("track");
project("track-proj", trackRepo);

/** The commit a caller would have verified: what the clone's tracking ref says. */
function trackedOid(repo: string, headBranch: string): string {
  return sh(repo, "rev-parse", `refs/remotes/origin/${headBranch}`).trim();
}

function trackSource(
  repo: string,
  headBranch: string,
  preferredBaseBranch?: string,
  headCommit?: string,
) {
  return {
    kind: "track-remote" as const,
    remote: "origin",
    headBranch,
    headCommit: headCommit ?? trackedOid(repo, headBranch),
    ...(preferredBaseBranch !== undefined ? { preferredBaseBranch } : {}),
  };
}

/* --------------------------------- creating -------------------------------- */

test("checks out a worktree whose branch tracks the remote head branch", async () => {
  const record = await createWorktree({
    projectId: "track-proj",
    name: "feature-7",
    source: trackSource(trackRepo, "feature-7", "main"),
  });

  // The branch is the REMOTE's, not the requested name: every local join —
  // the inventory's, the merge cleanup's — looks for `branch === headBranch`.
  assert.equal(record.branch, "feature-7");
  assert.equal(
    sh(record.path, "rev-parse", "--abbrev-ref", "HEAD").trim(),
    "feature-7",
  );
  assert.equal(
    sh(record.path, "rev-parse", "HEAD").trim(),
    sh(trackRepo, "rev-parse", "refs/remotes/origin/feature-7").trim(),
  );
  // Tracking, so "bring it to the pull request's head" is an ordinary pull.
  assert.equal(
    sh(record.path, "rev-parse", "--abbrev-ref", "@{upstream}").trim(),
    "origin/feature-7",
  );
  // The pull request's base exists locally, so it is the recorded merge-back
  // target — the one thing `worktreeMerge.ts` insists on.
  assert.equal(record.baseBranch, "main");
  assert.equal(
    sh(trackRepo, "rev-parse", "refs/heads/main").trim(),
    getWorktree(record.id)?.baseCommit,
  );
});

test("the folder suffix collides, the branch name never does", async () => {
  const occupied = join(worktreeRoot, `${basename(trackRepo)}-deep`);
  mkdirSync(occupied, { recursive: true });

  const record = await createWorktree({
    projectId: "track-proj",
    name: "deep",
    source: trackSource(trackRepo, "feature/deep-fix", "main"),
  });

  assert.equal(record.branch, "feature/deep-fix");
  assert.equal(record.path, `${occupied}-2`);
});

test("records the main checkout's current branch when the base is not local", async () => {
  const path = clone("track-fallback");
  // The current branch is deliberately NOT `main`, so the fallback cannot be
  // mistaken for a hard-coded default.
  sh(path, "checkout", "-q", "-b", "trunk");
  project("fallback-proj", path);

  const record = await createWorktree({
    projectId: "fallback-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "release/9"),
  });

  assert.equal(record.branch, "feature-7");
  assert.equal(record.baseBranch, "trunk");
});

/* --------------------------------- refusals -------------------------------- */

test("refuses to adopt a local branch of the same name", async () => {
  const path = clone("track-existing");
  project("existing-proj", path);
  sh(path, "branch", "feature-7", "origin/feature-7");
  const before = (await listWorktreeRecords("existing-proj")).length;

  await assert.rejects(
    () =>
      createWorktree({
        projectId: "existing-proj",
        name: "seven",
        source: trackSource(path, "feature-7", "main"),
      }),
    (err: unknown) =>
      err instanceof WorktreeCreateRefusalError &&
      err.kind === "branch-exists" &&
      /already exists/.test(err.message),
  );

  assert.equal((await listWorktreeRecords("existing-proj")).length, before);
  assert.equal(
    existsSync(join(worktreeRoot, `${basename(path)}-seven`)),
    false,
  );
});

test("refuses a head branch the repository's remote does not have", async () => {
  const path = clone("track-ghost");
  project("ghost-proj", path);

  await assert.rejects(
    () =>
      createWorktree({
        projectId: "ghost-proj",
        name: "ghost",
        // A head the remote does not have: the pinned commit is irrelevant,
        // because the missing tracking ref is refused before it is read.
        source: trackSource(path, "ghost", "main", trackedOid(path, "main")),
      }),
    (err: unknown) =>
      err instanceof WorktreeCreateRefusalError &&
      err.kind === "head-unreachable",
  );
});

test("refuses when there is no local branch left to record as the base", async () => {
  const path = clone("track-detached");
  project("detached-proj", path);
  sh(path, "checkout", "-q", "--detach");

  await assert.rejects(
    () =>
      createWorktree({
        projectId: "detached-proj",
        name: "seven",
        source: trackSource(path, "feature-7", "release/9"),
      }),
    (err: unknown) =>
      err instanceof WorktreeCreateRefusalError &&
      err.kind === "base-unresolvable",
  );
});

/* -------------------------------- atomicity -------------------------------- */

test("discards the tracking checkout when a post-add step throws", async () => {
  // The submodule progress callback is the one thing that can throw between
  // `worktree add` and the row insert, so it is how the window is reached.
  const submodule = join(tmp, "sublib");
  initRepo(submodule);
  const superRemote = join(tmp, "super-remote");
  initRepo(superRemote);
  sh(superRemote, "checkout", "-q", "-b", "feature-7");
  sh(superRemote, "submodule", "add", "--quiet", submodule, "sub");
  sh(superRemote, "commit", "-qm", "add submodule");
  sh(superRemote, "checkout", "-q", "main");
  const superClone = join(tmp, "super-clone");
  execFileSync("git", ["clone", "--quiet", superRemote, superClone], {
    cwd: tmp,
  });
  project("super-proj", superClone);
  const before = (await listWorktreeRecords("super-proj")).length;

  await assert.rejects(
    () =>
      createWorktree({
        projectId: "super-proj",
        name: "seven",
        source: trackSource(superClone, "feature-7", "main"),
        onSubmodules: () => {
          throw new Error("boom");
        },
      }),
    /boom/,
  );

  // Nothing survives a rejected create: no row, no checkout, and — the part a
  // new-branch create also promises — no branch holding the name back.
  assert.equal((await listWorktreeRecords("super-proj")).length, before);
  assert.equal(
    existsSync(join(worktreeRoot, `${basename(superClone)}-seven`)),
    false,
  );
  assert.equal(sh(superClone, "branch", "--list", "feature-7").trim(), "");
});

/** The upstream a review checkout of `feature-7` verified before syncing. */
const UPSTREAM = {
  upstreamRemote: "origin",
  upstreamMerge: "refs/heads/feature-7",
};

/* --------------------------------- updating -------------------------------- */

test("pull-rebase brings the tracking checkout to a moved head", async () => {
  const path = clone("track-update");
  project("update-proj", path);
  const record = await createWorktree({
    projectId: "update-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const row = getWorktree(record.id);
  assert.ok(row);

  const moved = commitOn(remotePath, "feature-7", "moved");
  const first = await syncWorktree(row, "pull-rebase");

  assert.equal(first.status, "updated");
  assert.equal(first.head, moved);
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), moved);

  // Running it again finds nothing to do and says so, which is what the review
  // checkout reports as `already-current`.
  const second = await syncWorktree(row, "pull-rebase");
  assert.equal(second.status, "up-to-date");
  assert.equal(second.head, moved);
});

// The whole reason the caller's commit is carried in: `origin/<head>` moves
// with every fetch — including the background one `createWorktree` itself
// fires — so branching off the REF would check out a commit nobody verified,
// under a name saying it is the verified one.
test("checks out the verified commit even when the tracking ref has moved", async () => {
  const path = clone("track-pinned");
  project("pinned-proj", path);
  const verified = trackedOid(path, "feature-7");

  // Somebody else's fetch lands between the verification and the creation.
  const moved = commitOn(remotePath, "feature-7", "pinned-move");
  sh(path, "fetch", "--quiet", "origin");
  assert.equal(trackedOid(path, "feature-7"), moved);
  assert.notEqual(verified, moved);

  const record = await createWorktree({
    projectId: "pinned-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main", verified),
  });

  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), verified);
  // Still tracking, so the update path can bring it forward deliberately.
  assert.equal(
    sh(record.path, "rev-parse", "--abbrev-ref", "@{upstream}").trim(),
    "origin/feature-7",
  );
});

test("refuses a pinned commit the repository does not have", async () => {
  const path = clone("track-pruned");
  project("pruned-proj", path);
  const before = (await listWorktreeRecords("pruned-proj")).length;
  const absent = "0".repeat(39) + "1";

  await assert.rejects(
    () =>
      createWorktree({
        projectId: "pruned-proj",
        name: "seven",
        source: trackSource(path, "feature-7", "main", absent),
      }),
    (err: unknown) =>
      err instanceof WorktreeCreateRefusalError &&
      err.kind === "head-unreachable" &&
      /no longer in this repository/.test(err.message),
  );

  assert.equal((await listWorktreeRecords("pruned-proj")).length, before);
  assert.equal(
    existsSync(join(worktreeRoot, `${basename(path)}-seven`)),
    false,
  );
});

test("pull-rebase refuses an upstream that moved past the checked one", async () => {
  const path = clone("track-raced-upstream");
  project("raced-upstream-proj", path);
  const record = await createWorktree({
    projectId: "raced-upstream-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const row = getWorktree(record.id);
  assert.ok(row);
  const head = sh(record.path, "rev-parse", "HEAD").trim();
  // A real update: the caller verified an upstream AHEAD of the checkout, which
  // is the only case where a fetch happens at all.
  const checked = commitOn(remotePath, "feature-7", "raced-target");
  assert.notEqual(checked, head);

  // The upstream then moves again, after that verification. Without the
  // expectation the operation's OWN fetch would silently land on this newer
  // commit and report it as the update that was asked for.
  const moved = commitOn(remotePath, "feature-7", "raced-again");
  assert.notEqual(moved, checked);

  await assert.rejects(
    () =>
      syncWorktree(row, "pull-rebase", {
        expected: { head, upstream: checked, ...UPSTREAM },
      }),
    (err: unknown) =>
      err instanceof WorktreeSyncPreconditionError &&
      /was left as it is/.test(err.message),
  );
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), head);
});

test("pull-rebase refuses a checkout that moved since it was inspected", async () => {
  const path = clone("track-raced-head");
  project("raced-head-proj", path);
  const record = await createWorktree({
    projectId: "raced-head-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const row = getWorktree(record.id);
  assert.ok(row);
  const head = sh(record.path, "rev-parse", "HEAD").trim();

  await assert.rejects(
    () =>
      syncWorktree(row, "pull-rebase", {
        expected: { head: "0".repeat(39) + "1", upstream: head, ...UPSTREAM },
      }),
    (err: unknown) =>
      err instanceof WorktreeSyncPreconditionError &&
      /Nothing was changed/.test(err.message),
  );
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), head);
});

test("pull-rebase lands exactly on the upstream that was checked", async () => {
  const path = clone("track-expected-ok");
  project("expected-ok-proj", path);
  const record = await createWorktree({
    projectId: "expected-ok-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const row = getWorktree(record.id);
  assert.ok(row);
  const head = sh(record.path, "rev-parse", "HEAD").trim();
  const moved = commitOn(remotePath, "feature-7", "expected-ok");
  sh(path, "fetch", "--quiet", "origin");

  const result = await syncWorktree(row, "pull-rebase", {
    expected: { head, upstream: moved, ...UPSTREAM },
  });

  assert.equal(result.status, "updated");
  assert.equal(result.head, moved);
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), moved);
});

// The oid alone does not pin the upstream: the configured remote/merge pair is
// ordinary local config another action can repoint, and ANY two refs at the
// same commit satisfy an oid check. Without the identity guard this pulls from
// somewhere else, lands on the expected commit, and reports success — leaving a
// review session open on a checkout that no longer tracks the pull request.
test("pull-rebase refuses an upstream repointed to a same-oid branch", async () => {
  const path = clone("track-repointed");
  project("repointed-proj", path);
  const record = await createWorktree({
    projectId: "repointed-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const row = getWorktree(record.id);
  assert.ok(row);
  const head = sh(record.path, "rev-parse", "HEAD").trim();
  const checked = trackedOid(path, "feature-7");

  // A decoy branch at the SAME commit, and the branch repointed at it.
  sh(remotePath, "branch", "decoy", "feature-7");
  sh(path, "fetch", "--quiet", "origin");
  assert.equal(trackedOid(path, "decoy"), checked);
  sh(record.path, "branch", "--set-upstream-to=origin/decoy", "feature-7");

  await assert.rejects(
    () =>
      syncWorktree(row, "pull-rebase", {
        expected: { head, upstream: checked, ...UPSTREAM },
      }),
    (err: unknown) =>
      err instanceof WorktreeSyncPreconditionError &&
      /now tracks origin\/decoy/.test(err.message) &&
      /Nothing was fetched or changed/.test(err.message),
  );
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), head);
});

/* ------------------------------ linked Tasks ------------------------------- */

// What the checkout endpoint reports as the checkout's Tasks, and the reason it
// is filtered: the staged review session picks its Task from these ids the
// moment the answer lands, so they have to mean the same thing a browser's
// FRESH Tasks list means — which excludes archived Tasks entirely. An archived
// id left in would be attached, and would suppress the weaker links that should
// have their turn instead.
test("the checkout's reported Task ids are the LIVE ones", async () => {
  const path = clone("track-tasks");
  project("tasks-proj", path);
  const record = await createWorktree({
    projectId: "tasks-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const live = createTask({
    title: "Live work",
    source: { createdBy: "user" },
  });
  const archived = createTask({
    title: "Finished work",
    source: { createdBy: "user" },
  });
  linkTaskToWorktree(String(live.id), record.id);
  linkTaskToWorktree(String(archived.id), record.id);

  const taskIdsFor = pullRequestCheckoutOperationsForTests().taskIdsFor;
  assert.deepEqual(
    taskIdsFor(record.id).sort(),
    [String(archived.id), String(live.id)].sort(),
  );

  archiveTask(String(archived.id));
  assert.deepEqual(taskIdsFor(record.id), [String(live.id)]);

  archiveTask(String(live.id));
  // Both spent: an EMPTY answer, which is what lets the client move on to the
  // pull request's own links instead of attaching an archived Task.
  assert.deepEqual(taskIdsFor(record.id), []);
});

/* ------------------------- the no-op expectation --------------------------- */

// "Already at the upstream I mean to land on" is answered HERE, under the lock,
// and costs nothing: no fetch (the tracking ref must not move) and no mutation.
test("an expectation already at its upstream answers without fetching", async () => {
  const path = clone("track-noop");
  project("noop-proj", path);
  const record = await createWorktree({
    projectId: "noop-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const row = getWorktree(record.id);
  assert.ok(row);
  const head = sh(record.path, "rev-parse", "HEAD").trim();

  // The remote moves on. A fetch would advance the tracking ref; this must not.
  commitOn(remotePath, "feature-7", "noop-move");

  const result = await syncWorktree(row, "pull-rebase", {
    expected: { head, upstream: head, ...UPSTREAM },
  });

  assert.equal(result.status, "up-to-date");
  assert.equal(result.head, head);
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), head);
  assert.equal(trackedOid(path, "feature-7"), head, "nothing was fetched");
});

// Dirt is not consulted on that path, because nothing is being changed — the
// rule the endpoint keeps by asking the operation rather than deciding itself.
test("uncommitted work does not block the no-op answer", async () => {
  const path = clone("track-noop-dirty");
  project("noop-dirty-proj", path);
  const record = await createWorktree({
    projectId: "noop-dirty-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const row = getWorktree(record.id);
  assert.ok(row);
  const head = sh(record.path, "rev-parse", "HEAD").trim();
  writeFileSync(join(record.path, "scratch.txt"), "work in progress\n");

  const result = await syncWorktree(row, "pull-rebase", {
    expected: { head, upstream: head, ...UPSTREAM },
  });

  assert.equal(result.status, "up-to-date");
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), head);
});

// The guards run BEFORE that early return, which is the whole point of routing
// it here: a repointed upstream is caught even though there was nothing to do.
test("the no-op answer still refuses a repointed upstream", async () => {
  const path = clone("track-noop-repointed");
  project("noop-repointed-proj", path);
  const record = await createWorktree({
    projectId: "noop-repointed-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const row = getWorktree(record.id);
  assert.ok(row);
  const head = sh(record.path, "rev-parse", "HEAD").trim();
  sh(remotePath, "branch", "-f", "decoy2", "feature-7");
  sh(path, "fetch", "--quiet", "origin");
  sh(record.path, "branch", "--set-upstream-to=origin/decoy2", "feature-7");

  await assert.rejects(
    () =>
      syncWorktree(row, "pull-rebase", {
        expected: { head, upstream: head, ...UPSTREAM },
      }),
    (err: unknown) =>
      err instanceof WorktreeSyncPreconditionError &&
      /now tracks origin\/decoy2/.test(err.message),
  );
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), head);
});

// …and a DETACHED checkout, which tracks nothing however right its commit is.
test("the no-op answer still refuses a detached checkout", async () => {
  const path = clone("track-noop-detached");
  project("noop-detached-proj", path);
  const record = await createWorktree({
    projectId: "noop-detached-proj",
    name: "seven",
    source: trackSource(path, "feature-7", "main"),
  });
  const row = getWorktree(record.id);
  assert.ok(row);
  const head = sh(record.path, "rev-parse", "HEAD").trim();
  sh(record.path, "checkout", "-q", "--detach");

  await assert.rejects(
    () =>
      syncWorktree(row, "pull-rebase", {
        expected: { head, upstream: head, ...UPSTREAM },
      }),
    (err: unknown) =>
      err instanceof WorktreeSyncPreconditionError &&
      /a detached HEAD/.test(err.message),
  );
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), head);
});
