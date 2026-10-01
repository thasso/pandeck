import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, test } from "vitest";
import {
  GitCommandError,
  git,
  gitBoundedStdout,
  gitOptional,
  gitOptionalExit,
  gitRawStdout,
  gitReadOnlyOptional,
  gitWithInputOptional,
  repoLockKey,
} from "./gitExec.ts";
import { setChildProcessEnvOverlay } from "./subprocessEnv.ts";

const missingCwd = join(tmpdir(), `git-exec-missing-${randomUUID()}`);

test("git reports execution failures as non-zero results", async () => {
  const successful = await git(["--version"], process.cwd());
  assert.equal(successful.code, 0);

  await assert.rejects(
    () => git(["rev-parse", "--show-toplevel"], missingCwd),
    (err: unknown) => {
      assert.ok(err instanceof GitCommandError);
      assert.equal(err.result.code, 1);
      assert.equal(err.failureKind, "execution");
      return true;
    },
  );

  const optional = await gitOptional(
    ["rev-parse", "--show-toplevel"],
    missingCwd,
  );
  assert.equal(optional.code, 1);
  assert.equal(optional.stdout, "");
});

test("every git executor hands git the child overlay the server does not hold", async () => {
  // The package proxy publishes its env bundle only for children; git must
  // keep getting it through the broker, whichever executor starts it.
  setChildProcessEnvOverlay({ PA_GIT_OVERLAY_PROBE: "overlay-value" });
  const printenv = ["-c", "alias.pa-env=!printenv PA_GIT_OVERLAY_PROBE"];
  try {
    assert.equal(process.env.PA_GIT_OVERLAY_PROBE, undefined);
    const plain = await git([...printenv, "pa-env"], process.cwd());
    assert.equal(plain.stdout.trim(), "overlay-value");
    const bounded = await gitBoundedStdout(
      [...printenv, "pa-env"],
      process.cwd(),
      1000,
    );
    assert.equal(bounded.patch.trim(), "overlay-value");
    const raw = await gitRawStdout([...printenv, "pa-env"], process.cwd());
    assert.equal(raw.content.toString("utf8").trim(), "overlay-value");
    const withInput = await gitWithInputOptional(
      [...printenv, "pa-env"],
      process.cwd(),
      "",
    );
    assert.equal(withInput.stdout.trim(), "overlay-value");
  } finally {
    setChildProcessEnvOverlay(null);
  }
});

test("a read-only status leaves the index untouched, even one a refresh would rewrite", async () => {
  // `git status` refreshes the index and rewrites it when a tracked file's
  // stat information moved — an `index.lock` and a new `index` in the git
  // dir. A READ must not do that: a watcher scan of a linked worktree racing
  // `git worktree remove` left the admin directory non-empty mid-delete.
  const repo = mkdtempSync(join(tmpdir(), "git-exec-read-only-"));
  try {
    await git(["init", "-q", "-b", "main"], repo);
    await git(["config", "user.email", "t@example.com"], repo);
    await git(["config", "user.name", "T"], repo);
    await writeFile(join(repo, "a.txt"), "a\n");
    await git(["add", "a.txt"], repo);
    await git(["commit", "-qm", "a"], repo);
    const indexPath = join(repo, ".git", "index");
    const before = await readFile(indexPath);
    // Move the file's stat data without changing its content: the next
    // refresh has something to write back.
    const stale = new Date(Date.now() - 60_000);
    await utimes(join(repo, "a.txt"), stale, stale);
    const read = await gitReadOnlyOptional(
      ["status", "--porcelain=v2", "--untracked-files=all"],
      repo,
    );
    assert.equal(read.code, 0);
    assert.equal(read.stdout, "", "a clean tree");
    assert.ok(
      before.equals(await readFile(indexPath)),
      "the read-only status wrote nothing back",
    );
    // The same command run as a mutation-side `git` does refresh — which is
    // exactly what a read must not do.
    await git(["status", "--porcelain=v2"], repo);
    assert.equal(
      before.equals(await readFile(indexPath)),
      false,
      "an ordinary status rewrote the index",
    );
    assert.ok((await stat(indexPath)).size > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gitOptionalExit still rejects execution failures", async () => {
  await assert.rejects(
    () => gitOptionalExit(["rev-parse", "--show-toplevel"], missingCwd),
    (err: unknown) => {
      assert.ok(err instanceof GitCommandError);
      assert.equal(err.failureKind, "execution");
      return true;
    },
  );
});

test("gitOptionalExit absorbs non-zero git exits", async () => {
  const args = [
    "rev-parse",
    "--verify",
    `refs/heads/definitely-missing-${randomUUID()}`,
  ];
  await assert.rejects(
    () => git(args, process.cwd()),
    (err: unknown) => {
      assert.ok(err instanceof GitCommandError);
      assert.equal(err.failureKind, "exit");
      assert.equal(err.result.code, 128);
      return true;
    },
  );

  const optional = await gitOptionalExit(args, process.cwd());
  assert.equal(optional.code, 128);
  assert.match(optional.stderr, /fatal:/i);
});

test("gitRawStdout uses the same non-zero execution-failure code", async () => {
  const result = await gitRawStdout(
    ["rev-parse", "--show-toplevel"],
    missingCwd,
  );
  assert.equal(result.code, 1);
  assert.equal(result.content.length, 0);
});

/**
 * The streaming read has to consume a whole diff to report exact totals, which
 * is precisely why it must be cancellable and bounded: an abandoned tool call
 * would otherwise keep a Git process reading to the end, and concurrent calls
 * would spawn without limit.
 */
/**
 * Built ONCE and shared. Each of the reads below only diffs it, so rebuilding
 * per test bought nothing and cost three more ~8 MB commits and working-tree
 * rewrites on a runner that is already running the lint and Nix jobs beside
 * this one.
 */
let sharedBigDiffRepository: Promise<string> | undefined;

async function bigDiffRepository(): Promise<string> {
  sharedBigDiffRepository ??= buildBigDiffRepository();
  return sharedBigDiffRepository;
}

afterAll(async () => {
  if (!sharedBigDiffRepository) return;
  rmSync(await sharedBigDiffRepository, { recursive: true, force: true });
});

async function buildBigDiffRepository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "git-bounded-test-"));
  await git(["init", "-q", "-b", "main", "."], root);
  const before = Array.from(
    { length: 200_000 },
    (_, index) => `line ${index} ${"a".repeat(30)}`,
  ).join("\n");
  await writeFile(join(root, "big.txt"), before, "utf8");
  await git(["add", "-A"], root);
  await git(
    [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-qm",
      "big",
    ],
    root,
  );
  await writeFile(join(root, "big.txt"), before.toUpperCase(), "utf8");
  return root;
}

test("gitBoundedStdout refuses an already-cancelled read without running git", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      gitBoundedStdout(["--version"], process.cwd(), 100, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof GitCommandError);
      assert.match(error.message, /cancelled/);
      return true;
    },
  );
});

test("gitBoundedStdout ends the git process when the caller cancels mid-stream", async () => {
  const root = await bigDiffRepository();
  const controller = new AbortController();
  // The yardstick is a second read of the same diff, started alongside and
  // never cancelled: it only settles once git has streamed the whole ~7 MB.
  // Comparing the two is what a wall-clock bound was reaching for, and it
  // survives a loaded runner, where both reads slow down together.
  const uncancelled = gitBoundedStdout(["diff"], root, 100);
  const pending = gitBoundedStdout(
    ["diff"],
    root,
    100,
    controller.signal,
  ).catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const first = await Promise.race([
    pending.then(() => "cancelled" as const),
    uncancelled.then(() => "whole diff" as const),
  ]);
  const settled = await pending;

  assert.ok(settled instanceof GitCommandError, `settled: ${String(settled)}`);
  assert.match(settled.message, /cancelled/);
  assert.equal(
    first,
    "cancelled",
    "cancelling mid-stream must end the git process, not read the diff out",
  );
  await uncancelled;
});

test("gitBoundedStdout bounds retained output while reporting the true total", async () => {
  const root = await bigDiffRepository();
  const result = await gitBoundedStdout(["diff"], root, 500);

  assert.equal(result.patch.length, 500);
  assert.equal(result.truncated, true);
  assert.ok(result.totalChars > 1_000_000);
});

test("concurrent streaming reads all complete under the shared fan-out bound", async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      gitBoundedStdout(["--version"], process.cwd(), 200),
    ),
  );

  for (const result of results) assert.match(result.patch, /^git version/);
});

test("a queued streaming read cancels without waiting for a slot", async () => {
  const root = await bigDiffRepository();
  // Fill every read slot with work that takes hundreds of milliseconds.
  const busy = Array.from({ length: 6 }, () =>
    gitBoundedStdout(["diff"], root, 100),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  const controller = new AbortController();
  const queued = gitBoundedStdout(["diff"], root, 100, controller.signal).catch(
    (error: unknown) => error,
  );
  controller.abort();
  // Cancelling while queued must not mean "wait for a slot, then cancel", so
  // the rejection has to arrive while all six slot holders are still running —
  // an ordering a busy machine cannot invert, unlike an elapsed-time bound.
  const slots = Promise.all(busy);
  const first = await Promise.race([
    queued.then(() => "queued" as const),
    slots.then(() => "slot holders" as const),
  ]);
  const settled = await queued;

  assert.ok(settled instanceof GitCommandError, `settled: ${String(settled)}`);
  assert.match(settled.message, /cancelled/);
  assert.equal(first, "queued", "the queued read waited for a slot to cancel");

  // The abandoned waiter must not have consumed or leaked a slot.
  for (const result of await slots) assert.equal(result.patch.length, 100);
  const after = await gitBoundedStdout(["--version"], process.cwd(), 200);
  assert.match(after.patch, /^git version/);
});

test("a remembered repo key follows a checkout path reused by another repository", async () => {
  const base = mkdtempSync(join(tmpdir(), "repo-key-reuse-"));
  try {
    const checkout = join(base, "checkout");
    const init = async (dir: string) => {
      mkdirSync(dir, { recursive: true });
      await git(["init", "-q"], dir);
    };
    await init(checkout);
    assert.equal(
      await repoLockKey(checkout),
      realpathSync(join(checkout, ".git")),
    );

    // The checkout is removed and a different repository's worktree takes
    // its path: the new directory must not inherit the old lock key.
    rmSync(checkout, { recursive: true, force: true });
    const other = join(base, "other");
    await init(other);
    await git(["commit", "-q", "--allow-empty", "-m", "x"], other, undefined, {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    });
    await git(["worktree", "add", "-q", checkout], other);
    assert.equal(
      await repoLockKey(checkout),
      realpathSync(join(other, ".git")),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a remembered repo key follows a worktree repointed at another repository", async () => {
  const base = mkdtempSync(join(tmpdir(), "repo-key-repoint-"));
  const identity = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  try {
    const repos: string[] = [];
    for (const name of ["a", "b"]) {
      const repo = join(base, name);
      mkdirSync(repo, { recursive: true });
      await git(["init", "-q"], repo);
      await git(
        ["commit", "-q", "--allow-empty", "-m", "x"],
        repo,
        undefined,
        identity,
      );
      await git(["worktree", "add", "-q", join(base, `wt-${name}`)], repo);
      repos.push(repo);
    }
    const checkout = join(base, "wt-a");
    assert.equal(
      await repoLockKey(checkout),
      realpathSync(join(repos[0]!, ".git")),
    );

    // Same directory, `.git` pointer rewritten in place to the other repository.
    writeFileSync(
      join(checkout, ".git"),
      readFileSync(join(base, "wt-b", ".git"), "utf8"),
    );
    assert.equal(
      await repoLockKey(checkout),
      realpathSync(join(repos[1]!, ".git")),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a path below a checkout root is not memoized, so it follows its repository", async () => {
  const base = mkdtempSync(join(tmpdir(), "repo-key-nested-"));
  const identity = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  try {
    const checkout = join(base, "checkout");
    const nested = join(checkout, "app", "web");
    mkdirSync(nested, { recursive: true });
    await git(["init", "-q"], checkout);
    assert.equal(
      await repoLockKey(nested),
      realpathSync(join(checkout, ".git")),
    );

    // The containing checkout becomes a linked worktree of another repository;
    // the nested directory itself is untouched.
    const other = join(base, "other");
    mkdirSync(other, { recursive: true });
    await git(["init", "-q"], other);
    await git(
      ["commit", "-q", "--allow-empty", "-m", "x"],
      other,
      undefined,
      identity,
    );
    const linked = join(base, "linked");
    await git(["worktree", "add", "-q", linked], other);
    rmSync(join(checkout, ".git"), { recursive: true, force: true });
    writeFileSync(
      join(checkout, ".git"),
      readFileSync(join(linked, ".git"), "utf8"),
    );
    assert.equal(await repoLockKey(nested), realpathSync(join(other, ".git")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
