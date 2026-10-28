/**
 * The main checkout on the Worker (candidate scan, resolved root, stamp) and
 * the session-cwd primitives over the presence cache. Expected paths come from
 * base's candidate rule computed on the host; interleavings use held calls and
 * an explicit clock, never timing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "main-presence-"));
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";

const { checkoutFailureOf } = await import("../checkoutFileAccess.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { insertWorktree, linkSessionToWorktree, markWorktreeRemovedForTests } =
  await import("../db/worktreeStore.ts");
const { failFileForTests, holdFileForTests } = await import("../fileReads.ts");
const { countGitExecutionsForTests } = await import("../gitExec.ts");
const {
  MALFORMED_ANSWERS,
  answerForPathForTests,
  answeredFailure,
  answering,
  recordServedForTests,
} = await import("../test/workerAnswers.ts");
const { WorkerMethodError } = await import("../workerProtocol/connection.ts");
const { FILE_METHODS } = await import("../workerProtocol/fileMethods.ts");
const { isWorkerFailure } = await import("../workers/fileClient.ts");
const { inProcessWorkerServedMethodForTests, writeAsInProcessWorkerForTests } =
  await import("../workers/inProcessWorker.ts");
const { DEFAULT_WORKER_SIDE } = await import("../workers/placement.ts");
const {
  flushPresenceForTests,
  onPresenceChange,
  presenceCountsForTests,
  presenceKey,
  presenceNow,
  resetPresenceForTests,
} = await import("./checkoutPresence.ts");
const {
  CheckoutEdgeChangedError,
  UnverifiedCheckoutError,
  checkWorktreeCheckout,
  checkoutCwd,
  checkoutEdgeTarget,
  onCheckoutCheckSettledForTests,
  sessionCheckoutRefusal,
  sessionWorktreeEdge,
  sessionWorktreeMissing,
  sessionWorktreeRetired,
  worktreeCwdForSession,
  worktreeMissingProbe,
} = await import("./sessionCwd.ts");
const {
  checkMainCheckout,
  clearMainRepoCache,
  invalidateMainRepo,
  mainCheckoutEdgeNow,
  mainCheckoutPathForProject,
  mainRepoResolveCount,
  mainWorktreeId,
  resolveMainWorktreeRow,
  worktreeExistsSync,
} = await import("./worktreeResolve.ts");

const INVALID_FRAME = new Uint8Array(8);
let serial = 0;

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

/** Ages what the stamp covers, so a resolve trusts its stamp. */
function ageStampFiles(repo: string): void {
  const hourAgo = new Date(Date.now() - 3_600_000);
  for (const file of ["HEAD", "refs/heads/main"])
    utimesSync(join(repo, ".git", file), hourAgo, hourAgo);
}

type LocalPath = { path: string; kind: "repo" | "workspace" };

/** A registered project with `localPaths`; answers its id. */
function project(localPaths: LocalPath[]): string {
  const id = `mp-${++serial}`;
  putProject(id, localPaths);
  return id;
}

/** Writes project `id` with `localPaths`, as a registry edit does. */
function putProject(id: string, localPaths: LocalPath[]): void {
  projectStore.put({
    id,
    name: id,
    key: id.toUpperCase(),
    description: "",
    status: "active",
    localPaths: localPaths.map((p) => ({ ...p, match: "prefix" as const })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Edits project `id` to `localPaths` and invalidates it, as the registry writers do. */
function editProject(id: string, localPaths: LocalPath[]): void {
  putProject(id, localPaths);
  invalidateMainRepo(id);
}

function fresh(name: string): string {
  return join(tmp, `${name}-${++serial}`);
}

/** A coding session linked to `worktreeId`; answers its id. */
function session(worktreeId?: string, agentType = "developer"): string {
  const id = `s-${++serial}`;
  sessionStore.upsert({ id, harness: "pi", agentType } as Parameters<
    typeof sessionStore.upsert
  >[0]);
  if (worktreeId) linkSessionToWorktree(id, worktreeId);
  return id;
}

/** An active spawned row at `path`; answers its id. */
function spawnedRow(path: string): string {
  const id = `wt-${++serial}`;
  insertWorktree({
    id,
    projectId: "none",
    mainRepoRoot: tmp,
    path,
    branch: id,
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  });
  return id;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

/** Collects the `main:<projectId>` keys notified. */
function mainNotifications(): { keys: string[]; off: () => void } {
  const keys: string[] = [];
  const off = onPresenceChange((changes) => {
    for (const change of changes)
      if (change.key.startsWith("main:")) keys.push(change.key);
  });
  return { keys, off };
}

beforeEach(() => {
  clearMainRepoCache();
  resetPresenceForTests();
});
afterEach(async () => {
  vi.restoreAllMocks();
  onCheckoutCheckSettledForTests(undefined);
  await flushPresenceForTests();
});

describe("main checkout path (AC8, D15)", () => {
  test("cold: the candidate's subdirectory after one scan; warm: the root, stable across a commit and both TTLs", async () => {
    const repo = fresh("nested-repo");
    initRepo(repo);
    const sub = join(repo, "sub", "dir");
    mkdirSync(sub, { recursive: true });
    const id = project([{ path: sub, kind: "repo" }]);
    const root = realpathSync(repo);

    assert.equal(mainCheckoutPathForProject(id), undefined, "unknown");
    await flushPresenceForTests();
    assert.equal(mainCheckoutPathForProject(id), realpathSync(sub));

    // Unstamped: the resolve ran while its files were new.
    await resolveMainWorktreeRow(id);
    assert.equal(mainCheckoutPathForProject(id), root);
    sh(repo, "commit", "--allow-empty", "-m", "moves the stamp");
    assert.equal(mainCheckoutPathForProject(id), root, "across a commit");

    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now + 4_000);
    assert.equal(mainCheckoutPathForProject(id), root, "past the 3 s TTL");
    clock.mockRestore();

    // Stamped: aged files, then past the 10 min TTL.
    ageStampFiles(repo);
    invalidateMainRepo(id);
    await resolveMainWorktreeRow(id);
    const resolves = mainRepoResolveCount();
    await resolveMainWorktreeRow(id);
    assert.equal(mainRepoResolveCount() - resolves, 0, "stamp trusted");
    sh(repo, "commit", "--allow-empty", "-m", "moves it again");
    assert.equal(mainCheckoutPathForProject(id), root, "across a commit");
    const later = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try {
      assert.equal(mainCheckoutPathForProject(id), root, "past the 10 min TTL");
      await resolveMainWorktreeRow(id);
      assert.equal(mainRepoResolveCount() - resolves, 1, "re-validated");
      assert.equal(mainCheckoutPathForProject(id), root, "after the resolve");
    } finally {
      later.mockRestore();
    }
  });

  test("candidate transitions: A deleted then B, none then created, unknown → none, each notified", async () => {
    const { keys, off } = mainNotifications();
    try {
      const a = fresh("cand-a");
      initRepo(a);
      const b = fresh("cand-b");
      mkdirSync(b);
      const id = project([
        { path: a, kind: "repo" },
        { path: b, kind: "workspace" },
      ]);
      const key = mainWorktreeId(id);
      const pathA = realpathSync(a);
      mainCheckoutPathForProject(id);
      await flushPresenceForTests();
      assert.equal(mainCheckoutPathForProject(id), pathA);
      assert.deepEqual(keys, [key], "unknown → path");
      await flushPresenceForTests();
      assert.equal(keys.length, 1, "an unchanged scan is silent");

      rmSync(a, { recursive: true });
      assert.equal(mainCheckoutPathForProject(id), pathA, "old state, rescans");
      await flushPresenceForTests();
      assert.equal(mainCheckoutPathForProject(id), realpathSync(b));
      assert.deepEqual(keys, [key, key], "path A → path B");

      const c = fresh("cand-c");
      const none = project([{ path: c, kind: "repo" }]);
      const noneKey = mainWorktreeId(none);
      mainCheckoutPathForProject(none);
      await flushPresenceForTests();
      assert.equal(mainCheckoutPathForProject(none), undefined);
      assert.deepEqual(mainCheckoutEdgeNow(none), {
        kind: "missing",
        retired: false,
      });
      assert.deepEqual(keys.slice(2), [noneKey], "unknown → none");
      await flushPresenceForTests();

      mkdirSync(c);
      assert.equal(mainCheckoutPathForProject(none), undefined);
      await flushPresenceForTests();
      assert.equal(mainCheckoutPathForProject(none), realpathSync(c));
      assert.deepEqual(keys.slice(2), [noneKey, noneKey], "none → path");
    } finally {
      off();
    }
  });

  test("a resolved root its side answers absent falls to the candidate and its key is forgotten", async () => {
    const repo = fresh("dropped-root");
    initRepo(repo);
    const id = project([{ path: repo, kind: "repo" }]);
    const root = realpathSync(repo);
    await resolveMainWorktreeRow(id);
    assert.deepEqual(mainCheckoutEdgeNow(id), { kind: "unverified" });
    await flushPresenceForTests();
    assert.deepEqual(mainCheckoutEdgeNow(id), { kind: "live", path: root });

    rmSync(repo, { recursive: true });
    const entries = presenceCountsForTests().entries;
    mainCheckoutEdgeNow(id);
    await flushPresenceForTests();
    assert.equal(
      presenceCountsForTests().entries,
      entries - 1,
      "root key gone",
    );
    assert.equal(mainCheckoutPathForProject(id), undefined, "the candidate");
    await flushPresenceForTests();
    assert.deepEqual(mainCheckoutEdgeNow(id), {
      kind: "missing",
      retired: false,
    });
  });

  test("invalidateMainRepo during a held scan: the check keeps its own result, the cache records nothing", async () => {
    const repo = fresh("invalidated");
    initRepo(repo);
    const id = project([{ path: repo, kind: "repo" }]);
    const held = holdFileForTests(join(repo, ".git"), "exists");
    const pending = checkMainCheckout(id);
    await held.reached;
    invalidateMainRepo(id);
    held.release();
    assert.deepEqual(await pending, {
      verdict: "live",
      path: realpathSync(repo),
    });
    assert.equal(mainCheckoutPathForProject(id), undefined, "still unknown");

    // The same for a background scan.
    await flushPresenceForTests();
    invalidateMainRepo(id);
    const again = holdFileForTests(join(repo, ".git"), "exists");
    mainCheckoutPathForProject(id);
    await again.reached;
    invalidateMainRepo(id);
    again.release();
    await flushPresenceForTests();
    assert.equal(
      mainCheckoutPathForProject(id),
      undefined,
      "late scan dropped",
    );
  });

  test("an edit during a held scan: the check answers its own record, publishes nothing, and the next check reads the edit (F003)", async () => {
    const repo = fresh("own-record");
    const edited = fresh("own-record-edited");
    initRepo(repo);
    initRepo(edited);
    const id = project([{ path: repo, kind: "repo" }]);
    const held = holdFileForTests(join(repo, ".git"), "exists");
    const pending = checkMainCheckout(id);
    await held.reached;
    editProject(id, [{ path: edited, kind: "repo" }]);
    held.release();
    assert.deepEqual(await pending, {
      verdict: "live",
      path: realpathSync(repo),
    });
    assert.deepEqual(mainCheckoutEdgeNow(id), { kind: "unverified" });
    assert.deepEqual(await checkMainCheckout(id), {
      verdict: "live",
      path: realpathSync(edited),
    });
  });

  test("a background scan whose read an edit overtook before it started never starts", async () => {
    const repo = fresh("deferred-old");
    const edited = fresh("deferred-new");
    initRepo(repo);
    initRepo(edited);
    const id = project([{ path: repo, kind: "repo" }]);
    const trace = recordServedForTests([FILE_METHODS.exists]);
    try {
      // The read schedules its scan; the edit lands before the scan starts.
      assert.equal(mainCheckoutPathForProject(id), undefined);
      editProject(id, [{ path: edited, kind: "repo" }]);
      mainCheckoutPathForProject(id);
      await flushPresenceForTests();
      assert.equal(mainCheckoutPathForProject(id), realpathSync(edited));
      assert.deepEqual(
        trace.pathsOf(FILE_METHODS.exists).filter((p) => p.startsWith(repo)),
        [],
        "no Worker call for the pre-edit record",
      );
    } finally {
      trace.stop();
    }
  });

  test.each([
    { name: "falsely missing", workspace: false },
    { name: "the old workspace", workspace: true },
  ])(
    "an edit during a resolved root's own check: its own record answers it, and nothing is published ($name, F002)",
    async ({ workspace }) => {
      const repo = fresh("root-old");
      const edited = fresh("root-new");
      const oldWorkspace = fresh("workspace-old");
      initRepo(repo);
      initRepo(edited);
      mkdirSync(oldWorkspace);
      const id = project([
        { path: repo, kind: "repo" },
        ...(workspace
          ? [{ path: oldWorkspace, kind: "workspace" as const }]
          : []),
      ]);
      assert.equal(
        (await resolveMainWorktreeRow(id))?.path,
        realpathSync(repo),
      );
      const root = realpathSync(repo);
      const held = holdFileForTests(root, "exists");
      const pending = checkMainCheckout(id);
      await held.reached;
      rmSync(repo, { recursive: true });
      editProject(id, [{ path: edited, kind: "repo" }]);
      held.release();
      const oldCheck = await pending;
      assert.deepEqual(
        mainCheckoutEdgeNow(id),
        { kind: "unverified" },
        "not missing, not the old workspace",
      );
      // The old check's own scan of its own record answers it alone.
      assert.deepEqual(
        oldCheck,
        workspace
          ? { verdict: "live", path: realpathSync(oldWorkspace) }
          : { verdict: "missing-absent" },
      );
      assert.deepEqual(await checkMainCheckout(id), {
        verdict: "live",
        path: realpathSync(edited),
      });
    },
  );

  test.each(["EACCES", "ENOENT"])(
    "a realpath %s on a present folder keeps the path as chosen, and the final check answers true",
    async (code) => {
      const target = fresh("real-target");
      mkdirSync(target);
      const link = fresh("chosen-link");
      symlinkSync(target, link);
      const id = project([{ path: link, kind: "workspace" }]);
      failFileForTests(link, { phase: "realpath", code });
      assert.deepEqual(await checkMainCheckout(id), {
        verdict: "live",
        path: link,
      });
      assert.deepEqual(await checkMainCheckout(id), {
        verdict: "live",
        path: realpathSync(link),
      });
    },
  );

  test("a candidate deleted during its realpath is missing, never live (RV-W3d-09)", async () => {
    const repo = fresh("deleted-during-realpath");
    initRepo(repo);
    const id = project([{ path: repo, kind: "repo" }]);
    const mainId = mainWorktreeId(id);
    const held = holdFileForTests(repo, "realpath");
    const pending = checkWorktreeCheckout(mainId);
    await held.reached;
    rmSync(repo, { recursive: true });
    held.release();
    assert.deepEqual(await pending, {
      worktreeId: mainId,
      verdict: "missing-absent",
    });
  });

  test("a cold scan and its final existence call add no presence key", async () => {
    const repo = fresh("no-key");
    initRepo(repo);
    const id = project([{ path: repo, kind: "repo" }]);
    const entries = presenceCountsForTests().entries;
    assert.equal((await checkMainCheckout(id)).verdict, "live");
    assert.equal(presenceCountsForTests().entries, entries);
  });

  test("cached 'no repository' answers within its TTL with no Worker call", async () => {
    const plain = fresh("no-git");
    mkdirSync(plain);
    const id = project([{ path: plain, kind: "repo" }]);
    assert.equal(await resolveMainWorktreeRow(id), undefined);
    const served = inProcessWorkerServedMethodForTests(FILE_METHODS.exists);
    assert.deepEqual(await checkMainCheckout(id), {
      verdict: "missing-no-repository",
    });
    assert.deepEqual(mainCheckoutEdgeNow(id), {
      kind: "missing",
      retired: true,
    });
    assert.equal(mainCheckoutPathForProject(id), undefined);
    assert.equal(
      inProcessWorkerServedMethodForTests(FILE_METHODS.exists) - served,
      0,
    );
  });

  test("worktreeExistsSync: unverified is plausible, all verified absent is not", async () => {
    const gone = fresh("plausible");
    const id = project([{ path: gone, kind: "repo" }]);
    assert.equal(worktreeExistsSync(mainWorktreeId(id)), true, "unverified");
    await flushPresenceForTests();
    assert.equal(worktreeExistsSync(mainWorktreeId(id)), false);
    mkdirSync(gone);
    worktreeExistsSync(mainWorktreeId(id));
    await flushPresenceForTests();
    assert.equal(worktreeExistsSync(mainWorktreeId(id)), true);
    assert.equal(worktreeExistsSync("main:no-such-project"), false);
  });

  test("invalidateMainRepo forgets the project's local-path and root keys", async () => {
    const repo = fresh("forgotten");
    initRepo(repo);
    const id = project([{ path: repo, kind: "repo" }]);
    const before = presenceCountsForTests().entries;
    worktreeExistsSync(mainWorktreeId(id));
    await resolveMainWorktreeRow(id);
    mainCheckoutEdgeNow(id);
    await flushPresenceForTests();
    assert.ok(presenceCountsForTests().entries > before);
    invalidateMainRepo(id);
    assert.equal(presenceCountsForTests().entries, before);
  });
});

describe("main stamp through the Worker (AC9)", () => {
  function stampedProject(): { id: string; repo: string; head: string } {
    const repo = fresh("stamped");
    initRepo(repo);
    ageStampFiles(repo);
    return {
      id: project([{ path: repo, kind: "repo" }]),
      repo,
      head: join(realpathSync(repo), ".git", "HEAD"),
    };
  }

  test.each(["invalidate", "clear"] as const)(
    "a held stamp: a second caller joins, and a %s during the hold publishes nothing",
    async (drop) => {
      const { id, head } = stampedProject();
      const base = mainRepoResolveCount();
      const held = holdFileForTests(head, "inspect");
      const first = resolveMainWorktreeRow(id);
      await held.reached;
      const second = resolveMainWorktreeRow(id);
      assert.equal(mainRepoResolveCount() - base, 1, "joined");
      if (drop === "invalidate") invalidateMainRepo(id);
      else clearMainRepoCache();
      held.release();
      await Promise.all([first, second]);
      await resolveMainWorktreeRow(id);
      assert.equal(mainRepoResolveCount() - base, 2, "nothing was published");
    },
  );

  test("a held freshness check is shared, and an invalidation during it is not answered from the dropped entry", async () => {
    const { id, head } = stampedProject();
    await resolveMainWorktreeRow(id);
    const base = mainRepoResolveCount();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    try {
      const held = holdFileForTests(head, "inspect");
      const first = resolveMainWorktreeRow(id);
      await held.reached;
      const second = resolveMainWorktreeRow(id);
      held.release();
      await Promise.all([first, second]);
      assert.equal(mainRepoResolveCount() - base, 0, "fresh, shared");

      const again = holdFileForTests(head, "inspect");
      const third = resolveMainWorktreeRow(id);
      await again.reached;
      invalidateMainRepo(id);
      again.release();
      await third;
      assert.equal(mainRepoResolveCount() - base, 1, "re-resolved");
      await resolveMainWorktreeRow(id);
      assert.equal(mainRepoResolveCount() - base, 2, "nothing was published");
    } finally {
      clock.mockRestore();
    }
  });

  test.each(["invalidate", "clear"] as const)(
    "an edit and a %s during a held freshness check: the old call resolves its own record, publishes nothing, and new calls read the edit (F001)",
    async (drop) => {
      const { id, repo, head } = stampedProject();
      const edited = fresh("edited-stamped");
      initRepo(edited);
      ageStampFiles(edited);
      await resolveMainWorktreeRow(id);
      const base = mainRepoResolveCount();
      const held = holdFileForTests(head, "inspect");
      const old = resolveMainWorktreeRow(id);
      await held.reached;
      putProject(id, [{ path: edited, kind: "repo" }]);
      if (drop === "invalidate") invalidateMainRepo(id);
      else clearMainRepoCache();
      held.release();
      const oldRow = await old;
      assert.equal(mainCheckoutPathForProject(id), undefined, "nothing cached");
      assert.equal(
        (await resolveMainWorktreeRow(id))?.path,
        realpathSync(edited),
      );
      assert.equal(mainCheckoutPathForProject(id), realpathSync(edited));
      assert.equal(mainRepoResolveCount() - base, 2, "its own, then the next");
      assert.equal(oldRow?.path, realpathSync(repo), "its own");
    },
  );

  test("a missing packed-refs stamps '-'; ENOTDIR propagates", async () => {
    const { id, repo } = stampedProject();
    const common = join(realpathSync(repo), ".git");
    await resolveMainWorktreeRow(id);
    const base = mainRepoResolveCount();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      // No packed-refs in a fresh repo: still trusted, no git process.
      await resolveMainWorktreeRow(id);
      assert.equal(mainRepoResolveCount() - base, 0);

      answerForPathForTests(
        FILE_METHODS.inspect,
        join(common, "reftable", "tables.list"),
        answering(answeredFailure("ENOTDIR", "ENOTDIR: not a directory")),
      );
      const error = await rejection(resolveMainWorktreeRow(id));
      assert.equal(checkoutFailureOf(error), "filesystem");
      assert.equal((error as { code?: unknown }).code, "ENOTDIR");
    } finally {
      clock.mockRestore();
    }
  });

  test("a rebuild of N stamped mains runs no git", async () => {
    const ids = [stampedProject(), stampedProject(), stampedProject()].map(
      ({ id }) => id,
    );
    for (const id of ids) await resolveMainWorktreeRow(id);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      const { executions } = await countGitExecutionsForTests(async () => {
        for (const id of ids) await resolveMainWorktreeRow(id);
      });
      assert.equal(executions, 0);
    } finally {
      clock.mockRestore();
    }
  });
});

/**
 * Each consumer of the main family, by the request it fails: a scan stage,
 * the final existence call, and the stamp in both its uses.
 */
interface Site {
  name: string;
  method: string;
  phase: "exists" | "realpath" | "inspect";
  /** Sets the stage up; answers the path its request names and the call. */
  prepare(): Promise<{ path: string; run: () => Promise<unknown> }>;
}

function linkedCandidate(): { id: string; link: string; target: string } {
  const target = fresh("site-target");
  mkdirSync(target);
  const link = fresh("site-link");
  symlinkSync(target, link);
  return {
    id: project([{ path: link, kind: "workspace" }]),
    link,
    target: realpathSync(target),
  };
}

const SITES: Site[] = [
  {
    name: "scan: the .git stage",
    method: FILE_METHODS.exists,
    phase: "exists",
    prepare: async () => {
      const { id, link } = linkedCandidate();
      return { path: join(link, ".git"), run: () => checkMainCheckout(id) };
    },
  },
  {
    name: "scan: the existence stage",
    method: FILE_METHODS.exists,
    phase: "exists",
    prepare: async () => {
      const { id, link } = linkedCandidate();
      return { path: link, run: () => checkMainCheckout(id) };
    },
  },
  {
    name: "scan: the realpath stage",
    method: FILE_METHODS.realpath,
    phase: "realpath",
    prepare: async () => {
      const { id, link } = linkedCandidate();
      return { path: link, run: () => checkMainCheckout(id) };
    },
  },
  {
    name: "scan: the final existence call",
    method: FILE_METHODS.exists,
    phase: "exists",
    prepare: async () => {
      const { id, target } = linkedCandidate();
      return { path: target, run: () => checkMainCheckout(id) };
    },
  },
  {
    name: "stamp: a resolve's trusted stamp",
    method: FILE_METHODS.inspect,
    phase: "inspect",
    prepare: async () => {
      const repo = fresh("site-stamp");
      initRepo(repo);
      const id = project([{ path: repo, kind: "repo" }]);
      return {
        path: join(realpathSync(repo), ".git", "HEAD"),
        run: () => resolveMainWorktreeRow(id),
      };
    },
  },
  {
    name: "stamp: a freshness check",
    method: FILE_METHODS.inspect,
    phase: "inspect",
    prepare: async () => {
      const repo = fresh("site-fresh");
      initRepo(repo);
      ageStampFiles(repo);
      const id = project([{ path: repo, kind: "repo" }]);
      await resolveMainWorktreeRow(id);
      const at = Date.now() + 60_000;
      vi.spyOn(Date, "now").mockReturnValue(at);
      return {
        path: join(realpathSync(repo), ".git", "HEAD"),
        run: () => resolveMainWorktreeRow(id),
      };
    },
  },
];

describe("Worker failures at each main consumer (AC7)", () => {
  test.each(SITES)("$name: a coded refusal rejects", async (site) => {
    const { path, run } = await site.prepare();
    answerForPathForTests(site.method, path, async () => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    });
    const error = await rejection(run());
    assert.ok(isWorkerFailure(error), String(error));
  });

  test.each(SITES)("$name: a malformed answer rejects", async (site) => {
    const { path, run } = await site.prepare();
    answerForPathForTests(
      site.method,
      path,
      answering(MALFORMED_ANSWERS[site.method]!),
    );
    const error = await rejection(run());
    assert.ok(isWorkerFailure(error), String(error));
  });

  test.each(SITES)(
    "$name: a connection end while held rejects",
    async (site) => {
      const { path, run } = await site.prepare();
      const held = holdFileForTests(path, site.phase);
      const pending = rejection(run());
      await held.reached;
      writeAsInProcessWorkerForTests(INVALID_FRAME);
      held.release();
      const error = await pending;
      assert.match(String(error), /The Worker connection ended/);
      assert.ok(isWorkerFailure(error));
    },
  );

  test("a failed background scan keeps the last candidate", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { id, link, target } = linkedCandidate();
    assert.equal((await checkMainCheckout(id)).verdict, "live");
    answerForPathForTests(FILE_METHODS.exists, join(link, ".git"), async () => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    });
    rmSync(target, { recursive: true });
    mainCheckoutPathForProject(id);
    await flushPresenceForTests();
    assert.equal(mainCheckoutPathForProject(id), target, "frozen");
  });
});

describe("session cwd primitives (Component 3)", () => {
  test("cold start never claims missing; one probe later it does (AC4)", async () => {
    const gone = fresh("gone");
    const row = spawnedRow(gone);
    const id = session(row);
    assert.equal(sessionWorktreeMissing(id), false);
    assert.deepEqual(sessionWorktreeEdge(id), {
      kind: "unverified",
      worktreeId: row,
    });
    assert.throws(() => worktreeCwdForSession(id), UnverifiedCheckoutError);
    await flushPresenceForTests();
    assert.equal(sessionWorktreeMissing(id), true);
    assert.equal(worktreeCwdForSession(id), undefined);
    assert.equal(worktreeMissingProbe()(row), true);
  });

  test("a check answers each verdict from its own request", async () => {
    const live = fresh("live");
    mkdirSync(live);
    const liveRow = spawnedRow(live);
    const absentRow = spawnedRow(fresh("absent"));
    const removedRow = spawnedRow(fresh("removed"));
    markWorktreeRemovedForTests(removedRow);

    assert.deepEqual(await checkWorktreeCheckout(undefined), {
      worktreeId: undefined,
      verdict: "none",
    });
    assert.deepEqual(await checkWorktreeCheckout(liveRow), {
      worktreeId: liveRow,
      verdict: "live",
      path: live,
    });
    assert.deepEqual(await checkWorktreeCheckout(absentRow), {
      worktreeId: absentRow,
      verdict: "missing-absent",
    });
    const served = inProcessWorkerServedMethodForTests(FILE_METHODS.exists);
    assert.deepEqual(await checkWorktreeCheckout(removedRow), {
      worktreeId: removedRow,
      verdict: "missing-db",
    });
    assert.deepEqual(await checkWorktreeCheckout("main:no-such-project"), {
      worktreeId: "main:no-such-project",
      verdict: "missing-db",
    });
    assert.equal(
      inProcessWorkerServedMethodForTests(FILE_METHODS.exists) - served,
      0,
      "DB verdicts need no Worker call",
    );
    assert.equal(checkoutCwd(await checkWorktreeCheckout(liveRow)), live);
    assert.equal(
      checkoutCwd(await checkWorktreeCheckout(absentRow)),
      undefined,
    );
  });

  test("a check rejects on a Worker failure", async () => {
    const live = fresh("refused");
    mkdirSync(live);
    const row = spawnedRow(live);
    answerForPathForTests(FILE_METHODS.exists, live, async () => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    });
    const error = await rejection(checkWorktreeCheckout(row));
    assert.ok(isWorkerFailure(error));
  });

  test("a checked cwd is the check's, and only for the session's current edge", async () => {
    const a = fresh("edge-a");
    mkdirSync(a);
    const b = fresh("edge-b");
    mkdirSync(b);
    const rowA = spawnedRow(a);
    const rowB = spawnedRow(b);
    const id = session(rowA);
    const checked = await checkWorktreeCheckout(checkoutEdgeTarget(id));
    assert.equal(worktreeCwdForSession(id, checked), a);
    linkSessionToWorktree(id, rowB);
    assert.throws(
      () => worktreeCwdForSession(id, checked),
      (error: unknown) =>
        error instanceof CheckoutEdgeChangedError &&
        error.message ===
          "the session's worktree changed while opening; try again",
    );
    assert.equal(checkoutEdgeTarget(id, rowA), rowA, "an explicit target");
  });

  test("the settle hook runs before the caller resumes, so a queued relink is visible to its comparison", async () => {
    const a = fresh("hook-a");
    mkdirSync(a);
    const b = fresh("hook-b");
    mkdirSync(b);
    const rowA = spawnedRow(a);
    const rowB = spawnedRow(b);
    const id = session(rowA);
    onCheckoutCheckSettledForTests(() =>
      queueMicrotask(() => linkSessionToWorktree(id, rowB)),
    );
    const checked = await checkWorktreeCheckout(checkoutEdgeTarget(id));
    assert.equal(checked.worktreeId, rowA);
    assert.equal(checkoutEdgeTarget(id), rowB, "changed before resuming");
  });

  test("retired is a DB verdict only; a refusal applies the predicate to a check", async () => {
    const absent = spawnedRow(fresh("not-retired"));
    const removed = spawnedRow(fresh("retired"));
    markWorktreeRemovedForTests(removed);
    const plain = fresh("no-repo");
    mkdirSync(plain);
    const noRepo = project([{ path: plain, kind: "repo" }]);
    await resolveMainWorktreeRow(noRepo);

    const onAbsent = session(absent);
    await checkWorktreeCheckout(absent);
    assert.equal(sessionWorktreeMissing(onAbsent), true);
    assert.equal(sessionWorktreeRetired(onAbsent), false, "filesystem-derived");
    assert.equal(sessionWorktreeRetired(session(removed)), true);
    assert.equal(sessionWorktreeRetired(session(mainWorktreeId(noRepo))), true);
    assert.equal(sessionWorktreeRetired(session("main:no-such-project")), true);
    assert.equal(sessionWorktreeRetired(session()), false, "no edge");
    const coordinator = session(removed, "workflow-coordinator");
    assert.equal(sessionWorktreeRetired(coordinator), false, "persona first");

    const checked = await checkWorktreeCheckout(absent);
    assert.equal(sessionCheckoutRefusal(onAbsent, checked), true);
    assert.equal(
      sessionCheckoutRefusal(session(absent, "workflow-coordinator"), checked),
      false,
    );
    sessionStore.acknowledgeMissingWorktree(onAbsent, absent);
    assert.equal(sessionCheckoutRefusal(onAbsent, checked), false, "acked");
  });

  test("spawned presence keys are the default Worker's, never the server's", async () => {
    const live = fresh("side");
    mkdirSync(live);
    const row = spawnedRow(live);
    worktreeMissingProbe()(row);
    await flushPresenceForTests();
    assert.equal(presenceNow(DEFAULT_WORKER_SIDE, live), "present");
    assert.ok(presenceKey(DEFAULT_WORKER_SIDE, live).startsWith("worker:"));
  });
});
