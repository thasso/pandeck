/**
 * Worktree creation on the Worker (W5): the root's mkdir, both naming
 * searches, the checkout folder's exclusive create, the submodule gate and
 * the discard of a failed create, each with a Worker failure injected where
 * it moved (`docs/workers.md`, W5).
 *
 * Worker failures are injected per method by a script on the in-process
 * Worker, which also records what it saw. Orderings between failures come from
 * gates opened by earlier requests, never from timing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, test, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const tmp = mkdtempSync(join(tmpdir(), "worktree-create-lifecycle-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";

const { createWorktree, removeWorktree } = await import("./worktrees.ts");
const { listWorktrees } = await import("../db/worktreeStore.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { presenceCountsForTests, presenceNow } =
  await import("./checkoutPresence.ts");
const { isWorkerFailure } = await import("../workers/fileClient.ts");
const { DEFAULT_WORKER_SIDE } = await import("../workers/placement.ts");
const { scriptWorkerAnswersForTests } =
  await import("../test/workerAnswers.ts");
const { FILE_METHODS } = await import("../workerProtocol/fileMethods.ts");
const { CHECKOUT_GIT_METHODS } =
  await import("../workerProtocol/checkoutMethods.ts");
const { LIFECYCLE_METHODS, encodeCreateDirResult } =
  await import("../workerProtocol/lifecycleMethods.ts");
const { inProcessWorkerQuiescentForTests, writeAsInProcessWorkerForTests } =
  await import("../workers/inProcessWorker.ts");
const { repoLockKey, withRepoLock } = await import("../gitExec.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

const repoPath = join(tmp, "mainrepo");
const worktreeRoot = join(tmp, "wt-root");
mkdirSync(repoPath, { recursive: true });
sh(repoPath, "init", "-b", "main");
writeFileSync(join(repoPath, "readme.md"), "hello\n");
sh(repoPath, "add", "-A");
sh(repoPath, "commit", "-m", "init");
const mainHead = sh(repoPath, "rev-parse", "HEAD").trim();

projectStore.put({
  id: "create-proj",
  name: "Create Project",
  key: "CRT",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

type Script = ReturnType<typeof scriptWorkerAnswersForTests>;
const scripts: Script[] = [];

/** A script armed for this test only. */
function script(...args: Parameters<typeof scriptWorkerAnswersForTests>) {
  const armed = scriptWorkerAnswersForTests(...args);
  scripts.push(armed);
  return armed;
}

function disarmAll(): void {
  while (scripts.length > 0) scripts.pop()!.disarm();
}

afterEach(disarmAll);

/** The folder naming candidate `n` (1-based) of `name` lands in. */
function candidate(name: string, n = 1): string {
  return join(worktreeRoot, `mainrepo-${n === 1 ? name : `${name}-${n}`}`);
}

function create(name: string, extra: Record<string, unknown> = {}) {
  return createWorktree({ projectId: "create-proj", name, ...extra });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("it resolved");
}

function branchExists(branch: string): boolean {
  return sh(repoPath, "branch", "--list", branch).trim() !== "";
}

function registered(path: string): boolean {
  return sh(repoPath, "worktree", "list", "--porcelain")
    .split("\n")
    .includes(`worktree ${path}`);
}

/** Records every checkout git run, passing it through unless a rule says. */
function recordGit(rules: Parameters<typeof script>[1] = []): Script {
  return script(CHECKOUT_GIT_METHODS.run, rules);
}

const isGit =
  (...prefix: string[]) =>
  (request: { args?: string[] }): boolean =>
    prefix.every((arg, at) => request.args?.[at] === arg);

/** Any git run that would delete a branch, by name or by ref. */
const deletesBranch = (request: { args?: string[] }): boolean =>
  isGit("branch", "-D")(request) || isGit("update-ref")(request);

/**
 * The discard deleted `name` as its own: one non-dereferencing
 * compare-and-delete at the start commit, then its config, never `branch -D`.
 */
function assertOwnedBranchDeleted(seen: Script["seen"], name: string): void {
  assert.deepEqual(
    seen
      .filter(
        (request) =>
          deletesBranch(request) ||
          isGit("config", "--remove-section")(request),
      )
      .map((request) => [request.args, request.action]),
    [
      [
        ["update-ref", "--no-deref", "-d", `refs/heads/${name}`, mainHead],
        "pass",
      ],
      [["config", "--remove-section", `branch.${name}`], "pass"],
    ],
  );
}

/** Nothing of `name`'s candidates: no row, branch, folder or registration. */
function assertNothingFor(name: string): void {
  const prefix = `mainrepo-${name}`;
  assert.deepEqual(
    listWorktrees({ includeRemoved: true }).filter((row) =>
      row.path.startsWith(join(worktreeRoot, prefix)),
    ),
    [],
    "no row",
  );
  assert.equal(
    sh(repoPath, "branch", "--list", `${name}*`).trim(),
    "",
    "no branch",
  );
  assert.deepEqual(
    existsSync(worktreeRoot)
      ? readdirSync(worktreeRoot).filter((entry) => entry.startsWith(prefix))
      : [],
    [],
    "no folder",
  );
  assert.equal(
    sh(repoPath, "worktree", "list", "--porcelain").includes(
      join(worktreeRoot, prefix),
    ),
    false,
    "no registration",
  );
}

/** Resolves once `condition` holds; rejects after `ms`. */
async function until(
  condition: () => boolean,
  what: string,
  ms = 5_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Presence with nothing queued or running, so its counts are a snapshot. */
async function settledPresence() {
  await until(() => {
    const counts = presenceCountsForTests();
    return counts.queued === 0 && counts.backgroundInFlight === 0;
  }, "presence to settle");
  return presenceCountsForTests();
}

/** Every `console.error` line while `run` runs. */
async function errorsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run();
    // Copied before the restore, which clears them.
    return spy.mock.calls.map((call) => call.map(String).join(" "));
  } finally {
    spy.mockRestore();
  }
}

/* ------------------------------ (a) the root ------------------------------ */

test("(a) a Worker failure making the worktree root rejects before anything", async () => {
  const name = "root-down";
  const mkdir = script(LIFECYCLE_METHODS.mkdir, [
    { match: (request) => request.path === worktreeRoot, action: "fail" },
  ]);
  const git = recordGit();
  const error = await rejection(create(name));
  assert.ok(isWorkerFailure(error), String(error));
  assert.deepEqual(
    mkdir.seen.map((request) => request.action),
    ["fail"],
  );
  assert.equal(git.seen.some(isGit("worktree")), false);
  assertNothingFor(name);
});

/* ------------------------------ naming (RD-W5-8) -------------------------- */

test("(b) a candidate whose probe failed is not free: the next proven one is taken", async () => {
  const name = "probe-once";
  const taken = candidate(name);
  const bytes = Buffer.from([0, 1, 2, 255, 10]);
  mkdirSync(taken, { recursive: true });
  writeFileSync(join(taken, "keep.bin"), bytes);
  const exists = script(FILE_METHODS.exists, [
    { match: (request) => request.path === taken, times: 1, action: "fail" },
  ]);
  const discard = script(LIFECYCLE_METHODS.discardTree, []);
  const git = recordGit();

  const record = await create(name);
  assert.equal(record.branch, `${name}-2`);
  assert.equal(record.path, candidate(name, 2));
  assert.ok(
    exists.seen.some(
      (request) => request.path === taken && request.action === "fail",
    ),
  );
  assert.deepEqual(readdirSync(taken), ["keep.bin"]);
  assert.deepEqual(readFileSync(join(taken, "keep.bin")), bytes);
  assert.equal(branchExists(name), false, "candidate 1's branch never made");
  assert.equal(
    git.seen.some(
      (request) =>
        (isGit("worktree", "remove")(request) &&
          request.args?.includes(taken)) ||
        (deletesBranch(request) &&
          (request.args?.includes(name) === true ||
            request.args?.includes(`refs/heads/${name}`) === true)),
    ),
    false,
  );
  assert.deepEqual(discard.seen, []);

  disarmAll();
  await removeWorktree(record.id);
  rmSync(taken, { recursive: true, force: true });
});

test("(c) every naming probe failing rejects with that failure, never an add", async () => {
  const name = "probe-down";
  const before = await settledPresence();
  const exists = script(FILE_METHODS.exists, [
    {
      match: (request) => request.path?.startsWith(worktreeRoot + sep) === true,
      action: "fail",
    },
  ]);
  const git = recordGit();

  const error = await rejection(create(name));
  assert.ok(isWorkerFailure(error), String(error));
  assert.doesNotMatch(String(error), /Could not find a free worktree name/);
  assert.equal(
    exists.seen.filter((request) => request.action === "fail").length,
    20,
  );
  assert.equal(git.seen.some(isGit("worktree", "add")), false);
  assertNothingFor(name);
  assert.deepEqual(presenceCountsForTests(), before, "presence untouched");

  disarmAll();
  for (let n = 1; n <= 20; n++)
    assert.equal(
      presenceNow(DEFAULT_WORKER_SIDE, candidate(name, n)),
      "unverified",
    );
  await settledPresence();
});

test("(c′) every folder probe failing for a tracking checkout rejects before the claim", async () => {
  const head = "review-down";
  sh(repoPath, "update-ref", `refs/remotes/origin/${head}`, mainHead);
  try {
    const before = await settledPresence();
    const exists = script(FILE_METHODS.exists, [
      {
        match: (request) =>
          request.path?.startsWith(join(worktreeRoot, "mainrepo-")) === true,
        action: "fail",
      },
    ]);
    const git = recordGit();

    const error = await rejection(
      create(head, {
        source: {
          kind: "track-remote",
          remote: "origin",
          headBranch: head,
          headCommit: mainHead,
        },
      }),
    );
    assert.ok(isWorkerFailure(error), String(error));
    // The 20 candidates and the timestamp one: none is added unchecked.
    assert.equal(
      exists.seen.filter((request) => request.action === "fail").length,
      21,
    );
    assert.equal(git.seen.some(isGit("worktree", "add")), false);
    assert.equal(git.seen.some(deletesBranch), false);
    assert.equal(branchExists(head), false, `refs/heads/${head} absent`);
    assertNothingFor(head);
    assert.deepEqual(presenceCountsForTests(), before, "presence untouched");
  } finally {
    sh(repoPath, "update-ref", "-d", `refs/remotes/origin/${head}`);
  }
});

/* ---------------------- the folder's exclusive create ---------------------- */

test("(g) an answered exists claims nothing: no branch, no discard", async () => {
  const name = "create-taken";
  const wt = candidate(name);
  const createDir = script(LIFECYCLE_METHODS.createDir, [
    {
      match: (request) => request.path === wt,
      times: 1,
      action: { answer: async () => encodeCreateDirResult("exists") },
    },
  ]);
  const discard = script(LIFECYCLE_METHODS.discardTree, []);
  const git = recordGit();

  const error = await rejection(create(name));
  assert.match(String(error), new RegExp(`'${wt}' already exists`));
  assert.equal(isWorkerFailure(error), false);
  assert.deepEqual(
    createDir.seen.map((request) => [request.path, request.action]),
    [[wt, "answer"]],
  );
  assert.equal(git.seen.some(isGit("branch")), false);
  assert.equal(git.seen.some(isGit("worktree", "add")), false);
  assert.equal(git.seen.some(isGit("worktree", "remove")), false);
  assert.deepEqual(discard.seen, []);
  assertNothingFor(name);
});

test("(h) a Worker lost after creating the folder claims nothing and settles first", async () => {
  const name = "create-lost";
  const wt = candidate(name);
  const lockKey = await repoLockKey(repoPath);
  const trace: string[] = [];
  let contender: Promise<void> | undefined;
  script(LIFECYCLE_METHODS.createDir, [
    {
      match: (request) => request.path === wt,
      times: 1,
      action: {
        answer: async (payload, signal, real) => {
          const answer = await real(payload, signal);
          trace.push("handler-settled");
          // Queued behind the creation, which holds the repo lock now.
          contender = withRepoLock(lockKey, async () => {
            trace.push("lock-acquired");
          });
          // The connection ends before this answer can reach the server.
          writeAsInProcessWorkerForTests(new Uint8Array(8));
          return answer;
        },
      },
    },
  ]);
  const discard = script(LIFECYCLE_METHODS.discardTree, []);
  const git = recordGit();

  const quiescent = inProcessWorkerQuiescentForTests();
  const error = await rejection(
    create(name).finally(() => trace.push("rejected")),
  );
  await contender;
  await quiescent;

  assert.ok(isWorkerFailure(error), String(error));
  // The rejection and the lock's release both follow the settled handler.
  assert.equal(trace[0], "handler-settled", trace.join());
  assert.deepEqual(trace.slice(1).sort(), ["lock-acquired", "rejected"]);
  assert.equal(git.seen.some(isGit("branch")), false);
  assert.equal(git.seen.some(isGit("worktree")), false);
  assert.deepEqual(discard.seen, []);
  // Made, but never proven the attempt's: left in place, not discarded.
  assert.deepEqual(readdirSync(wt), []);
  assert.equal(branchExists(name), false);
  assert.equal(registered(wt), false);
  assert.deepEqual(
    listWorktrees({ includeRemoved: true }).filter((row) => row.path === wt),
    [],
  );

  disarmAll();
  const next = await create(name);
  assert.equal(next.path, candidate(name, 2));
  await removeWorktree(next.id);
  rmSync(wt, { recursive: true, force: true });
});

/* ------------------------- the discard (RD-W5-4) -------------------------- */

const gitmodulesOf = (path: string) => join(path, ".gitmodules");

test("(d) a Worker failure at the submodule gate discards the checkout", async () => {
  const name = "gate-once";
  const wt = candidate(name);
  const exists = script(FILE_METHODS.exists, [
    {
      match: (request) => request.path === gitmodulesOf(wt),
      times: 1,
      action: "fail",
    },
  ]);
  const git = recordGit();

  const error = await rejection(create(name));
  assert.ok(isWorkerFailure(error), String(error));
  assert.ok(
    exists.seen.some(
      (request) =>
        request.path === gitmodulesOf(wt) && request.action === "fail",
    ),
  );
  assert.equal(git.seen.filter(isGit("worktree", "prune")).length, 1);
  assertOwnedBranchDeleted(git.seen, name);
  assert.equal(registered(wt), false);
  assertNothingFor(name);
});

test("(e) a failed settle check is not proof; a later one is, and the name frees", async () => {
  const name = "settle-once";
  const wt = candidate(name);
  const added = { open: false };
  script(FILE_METHODS.exists, [
    {
      match: (request) => request.path === gitmodulesOf(wt),
      times: 1,
      action: "fail",
      opens: added,
    },
    // The pre-remove probe passes; the first settle probe fails.
    {
      match: (request) => request.path === wt,
      gate: added,
      skip: 1,
      times: 1,
      action: "fail",
    },
  ]);
  const git = recordGit();

  let error: unknown;
  const errors = await errorsDuring(async () => {
    error = await rejection(create(name));
  });
  assert.ok(isWorkerFailure(error), String(error));
  const subject = `[worktrees] discarding the incomplete worktree ${wt} (branch ${name})`;
  assert.ok(
    errors.some((line) => line.startsWith(`${subject}: settle check failed:`)),
    errors.join("\n"),
  );
  assert.equal(
    errors.some((line) => line.includes("directory remained")),
    false,
  );
  assert.equal(git.seen.filter(isGit("worktree", "prune")).length, 1);
  assertOwnedBranchDeleted(git.seen, name);
  assertNothingFor(name);

  disarmAll();
  const again = await create(name);
  assert.equal(again.branch, name);
  assert.equal(again.path, wt);
  await removeWorktree(again.id);
});

test("(f) when the discard cannot remove the checkout it logs the orphan and keeps its checked-out branch", async () => {
  const name = "orphan";
  const wt = candidate(name);
  const added = { open: false };
  const exists = script(FILE_METHODS.exists, [
    {
      match: (request) => request.path === gitmodulesOf(wt),
      times: 1,
      action: "fail",
      opens: added,
    },
    { match: (request) => request.path === wt, gate: added, action: "fail" },
  ]);
  script(LIFECYCLE_METHODS.discardTree, [
    { match: (request) => request.path === wt, gate: added, action: "fail" },
  ]);
  const git = recordGit([
    { match: isGit("worktree", "remove"), gate: added, action: "fail" },
  ]);

  let error: unknown;
  const errors = await errorsDuring(async () => {
    error = await rejection(create(name));
  });
  assert.ok(isWorkerFailure(error), String(error));
  assert.equal(
    exists.seen.find((request) => request.action === "fail")?.path,
    gitmodulesOf(wt),
    "the rejection is the submodule gate's",
  );
  const seenGit = [...git.seen];
  disarmAll();

  assert.deepEqual(
    listWorktrees({ includeRemoved: true }).filter((row) => row.path === wt),
    [],
  );
  assert.ok(registered(wt), "git still registers the orphan");
  assert.ok(existsSync(wt), "its folder remains");
  assert.ok(branchExists(name), "its branch remains");
  assert.equal(seenGit.filter(isGit("worktree", "prune")).length, 0);
  // The orphan still has the branch checked out, so no delete is attempted.
  assert.deepEqual(seenGit.filter(deletesBranch), []);
  const subject = `[worktrees] discarding the incomplete worktree ${wt} (branch ${name})`;
  for (const step of [
    "existence check failed:",
    "worktree remove failed:",
    "directory removal failed:",
    "settle check failed:",
    "directory remained after bounded cleanup.",
    `kept branch ${name}: checked out in a worktree`,
  ])
    assert.ok(
      errors.some((line) => line.startsWith(`${subject}: ${step}`)),
      `${step}\n${errors.join("\n")}`,
    );
  assert.equal(
    errors.some((line) => line.includes("branch delete failed:")),
    false,
  );

  const next = await create(name);
  assert.equal(next.path, candidate(name, 2));
  await removeWorktree(next.id);
  sh(repoPath, "worktree", "remove", "--force", wt);
  sh(repoPath, "branch", "-D", name);
});
