/**
 * Worktree removal on the Worker (W5): ownership refusal, process stop,
 * fail-closed on a Worker failure at every moved call, and quiescence before
 * the repo lock is released (`docs/workers.md`, W5).
 *
 * Worker failures are injected per method by a script on the in-process
 * Worker, which also records what it saw. Orderings come from the request
 * sequence and from conditions the test waits for, never from timing.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const tmp = mkdtempSync(join(tmpdir(), "worktree-lifecycle-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";

const {
  createWorktree,
  removeWorktree,
  WorktreeDirectoryResidueError,
  WorktreeUndeletableError,
} = await import("./worktrees.ts");
const { getWorktree } = await import("../db/worktreeStore.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { repoLockKey, withRepoLock } = await import("../gitExec.ts");
const { presenceNow } = await import("./checkoutPresence.ts");
const { setContainerExecForTests } = await import("../containerImages.ts");
const { isWorkerFailure } = await import("../workers/fileClient.ts");
const { DEFAULT_WORKER_SIDE } = await import("../workers/placement.ts");
const { inProcessWorkerQuiescentForTests, writeAsInProcessWorkerForTests } =
  await import("../workers/inProcessWorker.ts");
const { answeredFailure, answering, scriptWorkerAnswersForTests } =
  await import("../test/workerAnswers.ts");
const { FILE_METHODS } = await import("../workerProtocol/fileMethods.ts");
const { CHECKOUT_GIT_METHODS } =
  await import("../workerProtocol/checkoutMethods.ts");
const { LIFECYCLE_METHODS, decodeProcessStop, encodeResidueScan } =
  await import("../workerProtocol/lifecycleMethods.ts");

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

projectStore.put({
  id: "life-proj",
  name: "Lifecycle Project",
  key: "LIFE",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

type Script = ReturnType<typeof scriptWorkerAnswersForTests>;
const scripts: Script[] = [];
const processes: number[] = [];

/** A script armed for this test only. */
function script(...args: Parameters<typeof scriptWorkerAnswersForTests>) {
  const armed = scriptWorkerAnswersForTests(...args);
  scripts.push(armed);
  return armed;
}

afterEach(() => {
  while (scripts.length > 0) scripts.pop()!.disarm();
  setContainerExecForTests(null);
  for (const pid of processes.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
});

let created = 0;
async function worktree() {
  return createWorktree({ projectId: "life-proj", name: `life-${++created}` });
}

function registered(path: string): boolean {
  return sh(repoPath, "worktree", "list", "--porcelain")
    .split("\n")
    .includes(`worktree ${path}`);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("it resolved");
}

/** Nothing durable happened: the row is active, Git registers it, it is on disk. */
function assertUntouched(record: { id: string; path: string }): void {
  assert.equal(getWorktree(record.id)?.status, "active");
  assert.ok(registered(record.path), "git still registers the checkout");
  assert.ok(existsSync(join(record.path, "readme.md")), "the folder is intact");
}

/** Records every checkout git run, passing it through. */
function recordGit(): Script {
  return script(CHECKOUT_GIT_METHODS.run, []);
}

const gitRan = (git: Script, ...prefix: string[]): boolean =>
  git.seen.some((request) =>
    prefix.every((arg, at) => request.args?.[at] === arg),
  );

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A shell (our child) whose background `sleep` is our grandchild, in `cwd`. */
async function grandchildIn(cwd: string): Promise<number> {
  const shell = spawn("sh", ["-c", "sleep 600 & echo $!; wait"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  processes.push(shell.pid!);
  const pid = await new Promise<number>((resolve) =>
    shell.stdout!.once("data", (data: Buffer) =>
      resolve(Number(String(data).trim())),
    ),
  );
  processes.push(pid);
  return pid;
}

/* ----------------------------- V4 ownership ------------------------------ */

for (const force of [false, true])
  test(`a foreign-owned directory refuses removal before any git mutation${force ? ", forced too" : ""}`, async () => {
    const record = await worktree();
    const foreign = join(record.path, "store");
    script(LIFECYCLE_METHODS.scanResidue, [
      {
        match: (request) => request.path === record.path,
        action: {
          answer: answering(
            encodeResidueScan({
              complete: true,
              directoriesVisited: 2,
              foreign: { path: foreign, reason: "foreign-owner", uid: 4242 },
            }),
          ),
        },
      },
    ]);
    // No container runtime: the real reclaim is unavailable.
    setContainerExecForTests(async () => ({
      code: 1,
      stdout: "",
      stderr: "docker: not here",
    }));
    const git = recordGit();

    const error = await rejection(
      removeWorktree(record.id, { force, deleteBranch: true }),
    );
    assert.ok(error instanceof WorktreeUndeletableError, String(error));
    assert.equal(
      error.message,
      `${foreign} belongs to uid 4242, so this server cannot delete it and it could not be reclaimed: no usable container runtime: docker: not here. Nothing was removed — hand it back with sudo chown -R $(id -u):$(id -g) ${record.path}, or delete it with sudo rm -rf ${record.path}, then remove the worktree again.`,
    );
    assertUntouched(record);
    assert.notEqual(
      sh(repoPath, "branch", "--list", record.branch).trim(),
      "",
      "the branch is still there",
    );
    assert.equal(gitRan(git, "worktree"), false);
    assert.equal(gitRan(git, "branch"), false);
  });

/* ---------------------------- V5 process stop ---------------------------- */

test("removal stops a grandchild in the checkout and leaves one beside it", async () => {
  const record = await worktree();
  const sibling = `${record.path}-sibling`;
  mkdirSync(sibling);
  const inside = await grandchildIn(join(record.path));
  const beside = await grandchildIn(sibling);
  const info = vi.spyOn(console, "info");
  let logged: unknown[][];
  try {
    await removeWorktree(record.id);
  } finally {
    logged = [...info.mock.calls];
    info.mockRestore();
  }
  assert.ok(
    logged.some(([line]) =>
      String(line).startsWith(
        `[worktrees] stopped 1 process(es) still running in ${record.path}.`,
      ),
    ),
    "the stop is logged",
  );
  await until(() => !alive(inside), "the grandchild to exit");
  assert.ok(alive(beside), "the grandchild beside the checkout survives");
  assert.equal(getWorktree(record.id)?.status, "removed");
  rmSync(sibling, { recursive: true, force: true });
});

/* ----------------------- V6 removal fails closed ------------------------- */

/** A Worker failure at one call rejects, leaves everything, and a retry heals. */
async function failsClosed(
  record: { id: string; path: string },
  arm: () => Script,
  options: { deleteBranch?: boolean; force?: boolean } = {},
): Promise<Script> {
  const git = recordGit();
  const armed = arm();
  const error = await rejection(removeWorktree(record.id, options));
  assert.ok(isWorkerFailure(error), String(error));
  assert.ok(
    armed.seen.some((request) => request.action === "fail"),
    "the injected call was reached",
  );
  assertUntouched(record);
  assert.equal(gitRan(git, "worktree", "remove"), false);
  assert.equal(gitRan(git, "worktree", "prune"), false);
  armed.disarm();
  git.disarm();
  await removeWorktree(record.id, options);
  assert.equal(getWorktree(record.id)?.status, "removed");
  assert.equal(existsSync(record.path), false);
  return armed;
}

test("(a) the checkout's existence check", async () => {
  const record = await worktree();
  await failsClosed(record, () =>
    script(FILE_METHODS.exists, [
      { match: (request) => request.path === record.path, action: "fail" },
    ]),
  );
});

test("(b) the residue scan", async () => {
  const record = await worktree();
  await failsClosed(record, () =>
    script(LIFECYCLE_METHODS.scanResidue, [
      { match: () => true, action: "fail" },
    ]),
  );
});

test("(c) the process stop", async () => {
  const record = await worktree();
  await failsClosed(record, () =>
    script(LIFECYCLE_METHODS.stopProcesses, [
      { match: () => true, action: "fail" },
    ]),
  );
});

test("(d) the removal of a checkout git no longer registers", async () => {
  const record = await worktree();
  rmSync(join(repoPath, ".git", "worktrees", basename(record.path)), {
    recursive: true,
    force: true,
  });
  assert.equal(registered(record.path), false);
  assert.equal(presenceNow(DEFAULT_WORKER_SIDE, record.path), "present");
  const armed = script(LIFECYCLE_METHODS.removeTree, [
    { match: () => true, action: "fail" },
  ]);
  const error = await rejection(removeWorktree(record.id));
  assert.ok(isWorkerFailure(error), String(error));
  assert.equal(error instanceof WorktreeDirectoryResidueError, false);
  assert.deepEqual(
    armed.seen.map((request) => [request.json.stage, request.action]),
    [["initial", "fail"]],
  );
  assert.equal(getWorktree(record.id)?.status, "active");
  assert.ok(existsSync(join(record.path, "readme.md")));
  assert.equal(
    presenceNow(DEFAULT_WORKER_SIDE, record.path),
    "present",
    "presence is not forgotten",
  );
  armed.disarm();
  await removeWorktree(record.id);
  assert.equal(getWorktree(record.id)?.status, "removed");
  assert.equal(existsSync(record.path), false);
});

test("(f) the registration probe's realpath", async () => {
  const record = await worktree();
  // Git lists the main checkout first, so its realpath is the first asked.
  await failsClosed(record, () =>
    script(FILE_METHODS.realpath, [
      { match: (request) => request.path !== record.path, action: "fail" },
    ]),
  );
});

test("(f) an answered realpath failure reads as not the same path, as base", async () => {
  const record = await worktree();
  const armed = script(FILE_METHODS.realpath, [
    {
      match: (request) => request.path !== record.path,
      action: {
        answer: answering(answeredFailure("ENOENT", "ENOENT: no such file")),
      },
    },
  ]);
  // The checkout's own listed path still matches, so removal goes ahead.
  await removeWorktree(record.id);
  assert.ok(armed.seen.some((request) => request.action === "answer"));
  assert.equal(getWorktree(record.id)?.status, "removed");
});

test("(h) the repository's existence check", async () => {
  const record = await worktree();
  await failsClosed(record, () =>
    script(FILE_METHODS.exists, [
      { match: (request) => request.path === repoPath, action: "fail" },
    ]),
  );
});

test("(i) the submodule gitdir inspection", async () => {
  const record = await worktree();
  const modules = (path: string | undefined) =>
    path?.endsWith(join(".git", "worktrees", basename(record.path), "modules"));
  await failsClosed(record, () =>
    script(FILE_METHODS.inspect, [
      { match: (request) => modules(request.path) === true, action: "fail" },
    ]),
  );
});

test("(i) an answered failure other than ENOENT refuses too", async () => {
  const record = await worktree();
  const git = recordGit();
  script(FILE_METHODS.inspect, [
    {
      match: (request) => request.path?.endsWith("modules") === true,
      action: {
        answer: answering(
          answeredFailure("EACCES", "EACCES: permission denied"),
        ),
      },
    },
  ]);
  const error = await rejection(removeWorktree(record.id));
  assert.equal(isWorkerFailure(error), false);
  assert.match(String(error), /EACCES: permission denied/);
  assertUntouched(record);
  assert.equal(gitRan(git, "worktree", "remove"), false);
});

/* ---------------------- V2 quiescence before the lock --------------------- */

test("a connection end during the stop rejects only after its last signal, and so does the lock", async () => {
  const record = await worktree();
  const lockKey = await repoLockKey(repoPath);
  const trace: string[] = [];
  let answer: ReturnType<typeof decodeProcessStop> | undefined;
  script(LIFECYCLE_METHODS.stopProcesses, [
    {
      match: () => true,
      times: 1,
      action: {
        answer: async (payload, signal, real) => {
          const answered = await real(payload, signal);
          answer = decodeProcessStop(answered);
          trace.push("handler-settled");
          return answered;
        },
      },
    },
  ]);
  const trapPid = join(record.path, "trap.pid");
  const termSeen = join(record.path, "term-seen");
  const direct = spawn(
    "sh",
    [
      "-c",
      `sh -c 'trap "touch term-seen" TERM; echo $$ > trap.pid; while :; do sleep 0.1; done' & wait`,
    ],
    { cwd: record.path, stdio: "ignore" },
  );
  processes.push(direct.pid!);
  await until(() => existsSync(trapPid), "the trap shell");
  const trap = Number(readFileSync(trapPid, "utf8").trim());
  processes.push(trap);

  const quiescent = inProcessWorkerQuiescentForTests();
  const removal = removeWorktree(record.id, { force: true }).then(
    () => trace.push("resolved"),
    (error: unknown) => {
      trace.push("rejected");
      return error;
    },
  );
  await until(() => existsSync(termSeen), "the SIGTERM");
  writeAsInProcessWorkerForTests(new Uint8Array(8));
  const contender = withRepoLock(lockKey, async () => {
    trace.push("lock-acquired");
  });
  const error = await removal;
  await contender;
  await quiescent;

  assert.ok(isWorkerFailure(error), String(error));
  assert.ok(trace.indexOf("handler-settled") >= 0, trace.join());
  assert.ok(
    trace.indexOf("handler-settled") < trace.indexOf("rejected"),
    trace.join(),
  );
  assert.ok(
    trace.indexOf("handler-settled") < trace.indexOf("lock-acquired"),
    trace.join(),
  );
  assert.ok(answer?.terminated.includes(trap), "the trap shell got SIGTERM");
  assert.ok(answer?.killed.includes(trap), "and then SIGKILL");

  await until(() => !alive(trap), "the trap shell to exit");
  assert.equal(getWorktree(record.id)?.status, "active");
  assert.ok(registered(record.path));
  await removeWorktree(record.id, { force: true });
  assert.equal(getWorktree(record.id)?.status, "removed");
});
