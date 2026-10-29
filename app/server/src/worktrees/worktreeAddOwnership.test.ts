/**
 * A failed `createWorktree` discards only what that attempt created: its own
 * folder, and its own branch through a non-dereferencing compare-and-delete at
 * the start commit. Every case drives the failure through a one-shot hook on an
 * exact git argv or on the Worker's folder naming probe for an exact path,
 * never through timing. Run:
 *   pnpm --filter @assistant/server test src/worktrees/worktreeAddOwnership.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, test, vi, type MockInstance } from "vitest";

// Real git repositories and checkouts, as in `worktrees.test.ts`.
vi.setConfig({ testTimeout: 120_000 });

type GitFn = "git" | "gitOptional" | "gitOptionalExit";
interface GitHook {
  fn: GitFn;
  argv: string[];
  run: (real: () => Promise<GitResultShape>) => Promise<GitResultShape>;
  fired: number;
}
interface GitResultShape {
  stdout: string;
  stderr: string;
  code: number;
}
// One-shot hooks: each acts on the FIRST call matching it exactly and passes
// every later call through, so `fired` proves it ran exactly once.
const hooks = vi.hoisted(() => ({
  git: [] as GitHook[],
  disarms: [] as Array<() => void>,
}));

vi.mock("../gitExec.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gitExec.ts")>();
  const wrap =
    (fn: GitFn) =>
    async (
      args: string[],
      cwd: string,
      signal?: AbortSignal,
      env?: NodeJS.ProcessEnv,
    ) => {
      const real = () => actual[fn](args, cwd, signal, env);
      const hook = hooks.git.find(
        (candidate) =>
          candidate.fired === 0 &&
          candidate.fn === fn &&
          JSON.stringify(candidate.argv) === JSON.stringify(args),
      );
      if (!hook) return real();
      hook.fired++;
      try {
        return await hook.run(real);
      } catch (err) {
        // An injected error keeps the wrapped function's own contract.
        if (fn === "git" || !(err instanceof actual.GitCommandError)) throw err;
        if (fn === "gitOptionalExit" && err.failureKind !== "exit") throw err;
        return err.result;
      }
    };
  return {
    ...actual,
    git: wrap("git"),
    gitOptional: wrap("gitOptional"),
    gitOptionalExit: wrap("gitOptionalExit"),
  };
});

// Canonical, so paths compare equal to the ones git prints.
const tmp = realpathSync(
  mkdtempSync(join(tmpdir(), "worktree-add-ownership-")),
);
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";

const { createWorktree } = await import("./worktrees.ts");
const { GitCommandError } = await import("../gitExec.ts");
const { listWorktrees } = await import("../db/worktreeStore.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { answerForPathForTests } = await import("../test/workerAnswers.ts");
const { FILE_METHODS, encodeExists } =
  await import("../workerProtocol/fileMethods.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Like {@link sh}, but an exit status 1 (nothing found) reads as "". */
function shOrEmpty(cwd: string, ...args: string[]): string {
  try {
    return sh(cwd, ...args);
  } catch (err) {
    if ((err as { status?: number }).status === 1) return "";
    throw err;
  }
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  sh(path, "init", "-b", "main");
  writeFileSync(join(path, "readme.md"), "hello\n");
  sh(path, "add", "-A");
  sh(path, "commit", "-m", "init");
}

function putProject(id: string, repo: string, worktreeRoot: string): void {
  projectStore.put({
    id,
    name: id,
    key: id.toUpperCase(),
    description: "",
    status: "active",
    localPaths: [{ path: repo, kind: "repo", match: "prefix" }],
    worktreeRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

interface Fixture {
  projectId: string;
  repo: string;
  root: string;
  /** The checkout folder creation picks for `name`. */
  targetFor(name: string): string;
}

/** A project of its own: a repo with one commit on `main` and an absolute root. */
function fixture(id: string): Fixture {
  const repo = join(tmp, id, "repo");
  const root = join(tmp, id, "wt-root");
  initRepo(repo);
  putProject(id, repo, root);
  return {
    projectId: id,
    repo,
    root,
    targetFor: (name) => join(root, `${basename(repo)}-${name}`),
  };
}

/** A new commit on top of `main` that no ref points at. */
function looseCommit(repo: string, message: string): string {
  return sh(
    repo,
    "commit-tree",
    "main^{tree}",
    "-p",
    "main",
    "-m",
    message,
  ).trim();
}

function oidOf(repo: string, ref: string): string {
  return sh(repo, "rev-parse", "--verify", ref).trim();
}

function branchExists(repo: string, branch: string): boolean {
  return sh(repo, "branch", "--list", branch).trim() !== "";
}

function branchConfig(repo: string, branch: string): string {
  return shOrEmpty(
    repo,
    "config",
    "--get-regexp",
    `^branch\\.${branch.replace(/[.]/g, "\\.")}\\.`,
  );
}

function registered(repo: string, path: string): boolean {
  return sh(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .some((line) => line === `worktree ${path}`);
}

function hasRow(path: string): boolean {
  return listWorktrees({ includeRemoved: true }).some(
    (row) => row.path === path,
  );
}

/** Every file and directory under `dir`: relative path, mode and bytes. */
function snapshot(dir: string): Array<[string, number, string]> {
  const out: Array<[string, number, string]> = [];
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push([rel, st.mode, ""]);
      for (const entry of readdirSync(abs).sort()) walk(join(rel, entry));
    } else {
      out.push([rel, st.mode, readFileSync(abs).toString("base64")]);
    }
  };
  walk("");
  return out;
}

function onGit(
  fn: GitFn,
  argv: string[],
  run: GitHook["run"],
): { readonly fired: number } {
  const hook: GitHook = { fn, argv, run, fired: 0 };
  hooks.git.push(hook);
  return hook;
}

/**
 * The Worker's next existence probe of `path` answers absent: an answer, never
 * a Worker failure, which the naming searches would count as taken.
 */
function lieAbsent(path: string): { readonly fired: number } {
  const lie = { fired: 0 };
  hooks.disarms.push(
    answerForPathForTests(FILE_METHODS.exists, path, async () => {
      lie.fired++;
      return encodeExists(false);
    }),
  );
  return lie;
}

function exitFailure(message: string): InstanceType<typeof GitCommandError> {
  return new GitCommandError(
    message,
    { stdout: "", stderr: message, code: 128 },
    "exit",
  );
}

/** The shape a brokered or Worker failure takes: git never ran to an exit. */
function executionFailure(
  message: string,
): InstanceType<typeof GitCommandError> {
  return new GitCommandError(
    message,
    { stdout: "", stderr: "", code: 1 },
    "execution",
  );
}

/** A `worktree add` hook that lets git create the checkout, then fails. */
function failAddAfterGit(
  target: string,
  branch: string,
  error: Error,
  afterAdd?: () => void,
): { readonly fired: number } {
  return onGit("git", ["worktree", "add", target, branch], async (real) => {
    await real();
    afterAdd?.();
    throw error;
  });
}

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  hooks.git.length = 0;
  for (const disarm of hooks.disarms.splice(0)) disarm();
  vi.restoreAllMocks();
});

/** Whether a discard logged that it kept `branch`. */
function loggedKept(branch: string): boolean {
  return consoleError.mock.calls.some((args) =>
    args.some(
      (arg) =>
        typeof arg === "string" &&
        arg.includes(`kept branch ${branch}:`) &&
        arg.includes("[worktrees]"),
    ),
  );
}

/* ------------------------- pre-existing names survive ------------------------ */

test("T1: a branch naming wrongly judged free keeps its unmerged commits", async () => {
  const f = fixture("t1");
  const name = "t1";
  const unmerged = looseCommit(f.repo, "unmerged work");
  sh(f.repo, "branch", name, unmerged);
  const probe = onGit(
    "gitOptional",
    ["rev-parse", "--verify", `refs/heads/${name}`],
    async () => {
      throw executionFailure("injected naming probe failure");
    },
  );

  await assert.rejects(
    createWorktree({ projectId: f.projectId, name }),
    new RegExp(`a branch named '${name}' already exists`),
  );

  assert.equal(probe.fired, 1);
  assert.equal(oidOf(f.repo, `refs/heads/${name}`), unmerged);
  assert.notEqual(sh(f.repo, "log", "--oneline", `main..${name}`).trim(), "");
  assert.equal(existsSync(f.targetFor(name)), false);
  assert.equal(registered(f.repo, f.targetFor(name)), false);
  assert.equal(hasRow(f.targetFor(name)), false);
});

test("T1r: a branch someone else creates before the attempt's create survives", async () => {
  const f = fixture("t1r");
  const name = "t1r";
  const outsider = looseCommit(f.repo, "outsider");
  const create = onGit("git", ["branch", "--", name, "main"], async (real) => {
    sh(f.repo, "branch", name, outsider);
    return real();
  });

  await assert.rejects(
    createWorktree({ projectId: f.projectId, name }),
    new RegExp(`a branch named '${name}' already exists`),
  );

  assert.equal(create.fired, 1);
  assert.equal(oidOf(f.repo, `refs/heads/${name}`), outsider);
  assert.equal(existsSync(f.targetFor(name)), false);
  assert.equal(registered(f.repo, f.targetFor(name)), false);
  assert.equal(hasRow(f.targetFor(name)), false);
});

test("T2: a non-empty folder naming wrongly judged free survives byte-identical", async () => {
  const f = fixture("t2");
  const name = "t2";
  const target = f.targetFor(name);
  mkdirSync(join(target, "sub"), { recursive: true });
  writeFileSync(join(target, "a.txt"), "user data\n");
  writeFileSync(join(target, "sub", "b.bin"), Buffer.from([0, 1, 2, 254, 255]));
  writeFileSync(join(target, "secret"), "private\n");
  chmodSync(join(target, "secret"), 0o600);
  const before = snapshot(target);
  const lie = lieAbsent(target);

  await assert.rejects(
    createWorktree({ projectId: f.projectId, name }),
    new RegExp(`'${target}' already exists`),
  );

  assert.equal(lie.fired, 1);
  assert.deepEqual(snapshot(target), before);
  assert.equal(branchExists(f.repo, name), false);
  assert.equal(registered(f.repo, target), false);
  assert.equal(hasRow(target), false);
});

test("T2e: an empty folder naming wrongly judged free is refused, not adopted", async () => {
  const f = fixture("t2e");
  const name = "t2e";
  const target = f.targetFor(name);
  mkdirSync(target, { recursive: true });
  const lie = lieAbsent(target);

  await assert.rejects(
    createWorktree({ projectId: f.projectId, name }),
    /already exists/,
  );

  assert.equal(lie.fired, 1);
  assert.equal(statSync(target).isDirectory(), true);
  assert.deepEqual(readdirSync(target), []);
  assert.equal(branchExists(f.repo, name), false);
  assert.equal(registered(f.repo, target), false);
  assert.equal(hasRow(target), false);
});

/* ----------------------- what the attempt created goes ----------------------- */

test("T3: a failed add removes the folder and branch it created, and the name stays free", async () => {
  const f = fixture("t3");
  const name = "t3";
  const target = f.targetFor(name);
  const failure = exitFailure("injected add failure");
  const add = failAddAfterGit(target, name, failure);

  await assert.rejects(
    createWorktree({ projectId: f.projectId, name }),
    (err) => Object.is(err, failure),
  );

  assert.equal(add.fired, 1);
  assert.equal(existsSync(target), false);
  assert.equal(branchExists(f.repo, name), false);
  assert.equal(branchConfig(f.repo, name), "");
  assert.equal(registered(f.repo, target), false);
  assert.equal(hasRow(target), false);

  const retry = await createWorktree({ projectId: f.projectId, name });
  assert.equal(retry.branch, name);
  assert.equal(retry.path, target);
});

test("T7: an abort during the branch create leaves nothing behind", async () => {
  const f = fixture("t7");
  const name = "t7";
  const target = f.targetFor(name);
  const controller = new AbortController();
  const create = onGit("git", ["branch", "--", name, "main"], async (real) => {
    controller.abort(new Error("cancelled"));
    return real();
  });

  await assert.rejects(
    createWorktree({
      projectId: f.projectId,
      name,
      signal: controller.signal,
    }),
    /cancelled/,
  );

  assert.equal(create.fired, 1);
  assert.equal(existsSync(target), false);
  assert.equal(branchExists(f.repo, name), false);
  assert.equal(registered(f.repo, target), false);
  assert.equal(hasRow(target), false);
});

test("T9: a failed upstream setup removes the tracking branch and its config", async () => {
  const remote = join(tmp, "t9", "remote");
  initRepo(remote);
  sh(remote, "checkout", "-q", "-b", "feature-9");
  writeFileSync(join(remote, "nine.txt"), "nine\n");
  sh(remote, "add", "-A");
  sh(remote, "commit", "-qm", "nine");
  sh(remote, "checkout", "-q", "main");
  const repo = join(tmp, "t9", "repo");
  execFileSync("git", ["clone", "--quiet", remote, repo], { cwd: tmp });
  const root = join(tmp, "t9", "wt-root");
  putProject("t9", repo, root);
  const headBranch = "feature-9";
  const headCommit = oidOf(repo, `refs/remotes/origin/${headBranch}`);
  const target = join(root, `${basename(repo)}-t9`);
  const upstream = onGit(
    "git",
    ["branch", `--set-upstream-to=origin/${headBranch}`, headBranch],
    async (real) => {
      await real();
      throw exitFailure("injected upstream failure");
    },
  );

  await assert.rejects(
    createWorktree({
      projectId: "t9",
      name: "t9",
      source: {
        kind: "track-remote",
        remote: "origin",
        headBranch,
        headCommit,
        preferredBaseBranch: "main",
      },
    }),
    /injected upstream failure/,
  );

  assert.equal(upstream.fired, 1);
  assert.equal(branchExists(repo, headBranch), false);
  assert.equal(branchConfig(repo, headBranch), "");
  assert.equal(existsSync(target), false);
  assert.equal(registered(repo, target), false);
  assert.equal(hasRow(target), false);
});

/* ------------------- an unprovable branch is kept and logged ------------------ */

test("T4: a branch whose creation cannot be proven is kept and logged", async () => {
  const f = fixture("t4");
  const name = "t4";
  const target = f.targetFor(name);
  const failure = executionFailure("injected worker failure");
  const create = onGit("git", ["branch", "--", name, "main"], async (real) => {
    await real();
    throw failure;
  });

  await assert.rejects(
    createWorktree({ projectId: f.projectId, name }),
    (err) => Object.is(err, failure),
  );

  assert.equal(create.fired, 1);
  assert.equal(existsSync(target), false);
  assert.equal(oidOf(f.repo, `refs/heads/${name}`), oidOf(f.repo, "main"));
  assert.equal(loggedKept(name), true);
  assert.equal(hasRow(target), false);
});

test("T5: an owned branch that moved before the delete is kept", async () => {
  const f = fixture("t5");
  const name = "t5";
  const target = f.targetFor(name);
  const startOid = oidOf(f.repo, "main");
  const moved = looseCommit(f.repo, "moved");
  const add = failAddAfterGit(
    target,
    name,
    exitFailure("injected add failure"),
  );
  const del = onGit(
    "gitOptional",
    ["update-ref", "--no-deref", "-d", `refs/heads/${name}`, startOid],
    async (real) => {
      sh(f.repo, "update-ref", `refs/heads/${name}`, moved);
      return real();
    },
  );

  await assert.rejects(
    createWorktree({ projectId: f.projectId, name }),
    /injected add failure/,
  );

  assert.equal(add.fired, 1);
  assert.equal(del.fired, 1);
  assert.equal(oidOf(f.repo, `refs/heads/${name}`), moved);
  assert.equal(existsSync(target), false);
  assert.equal(loggedKept(name), true);
  assert.equal(hasRow(target), false);
});

test("T6: an owned branch checked out elsewhere at cleanup is kept", async () => {
  const f = fixture("t6");
  const name = "t6";
  const target = f.targetFor(name);
  const other = join(tmp, "t6", "other-checkout");
  let list: { readonly fired: number } | undefined;
  // Armed only once the add ran, so it is the discard's guard that it meets.
  const add = failAddAfterGit(
    target,
    name,
    exitFailure("injected add failure"),
    () => {
      list = onGit(
        "gitOptional",
        ["worktree", "list", "--porcelain"],
        async (real) => {
          sh(f.repo, "worktree", "add", other, name);
          return real();
        },
      );
    },
  );

  await assert.rejects(
    createWorktree({ projectId: f.projectId, name }),
    /injected add failure/,
  );

  assert.equal(add.fired, 1);
  assert.equal(list?.fired, 1);
  assert.equal(branchExists(f.repo, name), true);
  assert.equal(registered(f.repo, other), true);
  assert.equal(readFileSync(join(other, "readme.md"), "utf8"), "hello\n");
  assert.equal(existsSync(target), false);
  assert.equal(loggedKept(name), true);
  assert.equal(hasRow(target), false);
});

test("T10: a symref swapped in at the owned name is deleted by name; its target survives", async () => {
  const f = fixture("t10");
  const name = "t10";
  const target = f.targetFor(name);
  const startOid = oidOf(f.repo, "main");
  sh(f.repo, "branch", "victim", "main");
  const refs = (): string =>
    sh(f.repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/");
  const before = refs();
  const add = failAddAfterGit(
    target,
    name,
    exitFailure("injected add failure"),
  );
  const del = onGit(
    "gitOptional",
    ["update-ref", "--no-deref", "-d", `refs/heads/${name}`, startOid],
    async (real) => {
      sh(f.repo, "symbolic-ref", `refs/heads/${name}`, "refs/heads/victim");
      return real();
    },
  );

  await assert.rejects(
    createWorktree({ projectId: f.projectId, name }),
    /injected add failure/,
  );

  assert.equal(add.fired, 1);
  assert.equal(del.fired, 1);
  assert.equal(oidOf(f.repo, "refs/heads/victim"), startOid);
  const unrelated = (listing: string): string[] =>
    listing
      .split("\n")
      .filter((line) => line && !line.startsWith(`refs/heads/${name} `));
  assert.deepEqual(unrelated(refs()), unrelated(before));
  assert.equal(existsSync(target), false);
  assert.equal(hasRow(target), false);
});

/* --------------------------- a relative root is refused --------------------------- */

test("T8: a relative worktree root is refused before anything is created", async () => {
  const relativeRoot = "rel-wt-1228";
  const repo = join(tmp, "t8", "repo");
  initRepo(repo);
  putProject("t8", repo, relativeRoot);
  const name = "t8";
  // Git, running in the main checkout, would resolve the target here.
  const gitTarget = join(repo, relativeRoot, `${basename(repo)}-${name}`);
  sh(repo, "worktree", "add", "-q", "-b", "pre-t8", gitTarget, "main");
  writeFileSync(join(gitTarget, "work.txt"), "in progress\n");
  const gitTargetBefore = snapshot(gitTarget);
  const preOid = oidOf(repo, "refs/heads/pre-t8");
  const serverSide = resolve(process.cwd(), relativeRoot);
  assert.notEqual(process.cwd(), repo);
  assert.equal(existsSync(serverSide), false);

  await assert.rejects(
    createWorktree({ projectId: "t8", name }),
    /Worktree root "rel-wt-1228" must be an absolute path/,
  );

  assert.equal(existsSync(serverSide), false);
  assert.equal(registered(repo, gitTarget), true);
  assert.equal(oidOf(repo, "refs/heads/pre-t8"), preOid);
  assert.deepEqual(snapshot(gitTarget), gitTargetBefore);
  assert.equal(branchExists(repo, name), false);
});
