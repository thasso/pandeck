/**
 * The paths that act on a checkout decide from their own Worker check (W3d,
 * `docs/workers.md` "Checkout presence"): the run door, provider turns,
 * recovery, host commands, acknowledge, engine constructions and the shared
 * resolver. The cache is made stale on purpose, so a pass proves the own
 * check decided. Every interleaving is a held Worker request, a queued
 * microtask or an explicit clock; none is timing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "presence-consumers-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
process.env.ASSISTANT_BACKGROUND_FETCH = "0";
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);
writeFileSync(
  join(tmp, "data", "settings", "openai-compatible.json"),
  JSON.stringify({
    enabled: true,
    name: "Fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "fixture",
    models: [
      {
        id: "fixture-model",
        name: "fixture-model",
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 4_000,
        reasoning: false,
      },
    ],
  }),
);

/** The recovery callbacks each runtime session was given, by session id. */
const recoveries = new Map<
  string,
  {
    admit: () => void;
    resume: (ticket: symbol, admit: () => void) => Promise<void>;
  }
>();
vi.mock("./sessionAccountSwitch.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  installAccountRecovery: (
    _live: unknown,
    driver: { sessionId: string },
    admit: () => void,
    _retain: unknown,
    resume: (ticket: symbol, admit: () => void) => Promise<void>,
  ) => {
    recoveries.set(driver.sessionId, { admit, resume });
  },
}));

const { KNOWLEDGE_WORKTREE_ID, WORKTREE_MISSING_BLOCKED_REASON } =
  await import("@assistant/shared");
const { hub } = await import("./hub.ts");
(
  hub as unknown as { broadcastSessions: () => Promise<void> }
).broadcastSessions = async () => {};
const { Connection } = await import("./connection.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { harnessRegistry } = await import("./harnesses/registry.ts");
const { handoffEngine } = await import("./harnesses/handoffSession.ts");
const { createSession } = await import("./harnesses/create.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { beginRuntimeProviderTurn, promptRuntimeSessionWithRuntime } =
  await import("./session/runtimePrompt.ts");
const { reserveAccountRecovery, releaseAccountRecovery } =
  await import("./session/runtime/accountRecoveryAdmission.ts");
const { reserveWorktreeForRemoval } =
  await import("./session/sessionRunLease.ts");
const { drainPromptQueue } = await import("./promptQueue.ts");
const { buildSpawnProposal } = await import("./sessionSpawn.ts");
const { promptQueueStore } = await import("./db/promptQueueStore.ts");
const { projectStore } = await import("./db/projectStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const {
  activeWorktreePaths,
  insertWorktree,
  linkSessionToWorktree,
  markWorktreeRemovedForTests,
  worktreeIdForSession,
} = await import("./db/worktreeStore.ts");
const { canonicalPiSessionPath } = await import("./sessionStorage.ts");
const { failFileForTests, holdFileForTests } = await import("./fileReads.ts");
const gitExec = await import("./gitExec.ts");
const {
  MALFORMED_ANSWERS,
  answerForPathForTests,
  answering,
  recordServedForTests,
} = await import("./test/workerAnswers.ts");
const { WorkerMethodError } = await import("./workerProtocol/connection.ts");
const { FILE_METHODS } = await import("./workerProtocol/fileMethods.ts");
const { isWorkerFailure } = await import("./workers/fileClient.ts");
const { writeAsInProcessWorkerForTests } =
  await import("./workers/inProcessWorker.ts");
const { DEFAULT_WORKER_SIDE } = await import("./workers/placement.ts");
const {
  flushPresenceForTests,
  presenceCountsForTests,
  presenceKey,
  presenceNow,
  resetPresenceForTests,
} = await import("./worktrees/checkoutPresence.ts");
const {
  CheckoutEdgeChangedError,
  UnverifiedCheckoutError,
  acknowledgeMissingSessionWorktree,
  checkWorktreeCheckout,
  onCheckoutCheckSettledForTests,
  resolveUsableWorktree,
  sessionWorktreeMissing,
  worktreeCwdForSession,
} = await import("./worktrees/sessionCwd.ts");
const {
  clearMainRepoCache,
  invalidateMainRepo,
  mainWorktreeId,
  resolveMainWorktreeRow,
  resolveWorktreeRow,
} = await import("./worktrees/worktreeResolve.ts");
const { createWorktree, removeWorktree } =
  await import("./worktrees/worktrees.ts");
const { addWorktreeComment } = await import("./worktrees/worktreeComments.ts");
const worktreeStore = await import("./db/worktreeStore.ts");
const { writeClaudeSdkRecord } =
  await import("./claudeSdk/claudeSdkRecords.ts");
const { CLAUDE_SDK_STORE_DIR } = await import("./sessionStorage.ts");

const claudeProfile = createCredentialProfile({
  name: "Presence consumers",
  provider: "claude",
});
const INVALID_FRAME = new Uint8Array(8);
const EDGE_CHANGED = "the session's worktree changed while opening; try again";
let serial = 0;

/* --------------------------------- fixtures -------------------------------- */

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

function fresh(name: string): string {
  return join(tmp, `${name}-${++serial}`);
}

type LocalPath = { path: string; kind: "repo" | "workspace" };

/** A registered project with `localPaths`; answers its id. */
function project(
  localPaths: LocalPath[],
  worktreeRoot?: string,
  id = `cp-${++serial}`,
): string {
  projectStore.put({
    id,
    name: id,
    key: id.toUpperCase(),
    description: "",
    status: "active",
    localPaths: localPaths.map((p) => ({ ...p, match: "prefix" as const })),
    ...(worktreeRoot ? { worktreeRoot } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Parameters<typeof projectStore.put>[0]);
  return id;
}

/** An active spawned row at a fresh path, made present or not; answers it. */
function spawnedRow(present: boolean): { id: string; path: string } {
  const id = `wt-${++serial}`;
  const path = fresh("row");
  if (present) mkdirSync(path, { recursive: true });
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
  return { id, path };
}

type Persona = "developer" | "workflow-coordinator";

/** A session row linked to `worktreeId`; answers its id. */
function session(
  worktreeId?: string,
  agentType: Persona = "developer",
  harness: "pi" | "claude-sdk" = "pi",
): string {
  const id = `s-${++serial}`;
  sessionStore.upsert({ id, harness, agentType } as Parameters<
    typeof sessionStore.upsert
  >[0]);
  if (worktreeId) linkSessionToWorktree(id, worktreeId);
  return id;
}

/** A row whose cache answers `present` while its folder is already gone. */
async function stalePresent(): Promise<{ id: string; path: string }> {
  const row = spawnedRow(true);
  await checkWorktreeCheckout(row.id);
  rmSync(row.path, { recursive: true });
  return row;
}

/** A row whose cache answers `absent` while its folder is back. */
async function staleAbsent(): Promise<{ id: string; path: string }> {
  const row = spawnedRow(false);
  await checkWorktreeCheckout(row.id);
  mkdirSync(row.path, { recursive: true });
  return row;
}

async function settle(promise: unknown): Promise<unknown> {
  try {
    return { value: await (promise as Promise<unknown>) };
  } catch (error) {
    return { error };
  }
}

function errorOf(result: unknown): unknown {
  const { error } = result as { error?: unknown };
  assert.ok(error, "expected a rejection");
  return error;
}

/** A fake runtime recording what a run would have created and appended. */
function fakeRuntime() {
  const calls: Array<{ kind: "create" | "prompt"; id: string }> = [];
  const admissions = { taken: 0, released: 0 };
  const runtime = {
    get: () => ({}),
    createSession: (id: string) => {
      calls.push({ kind: "create", id });
      return {};
    },
    deliverPrompt: async (id: string) => {
      calls.push({ kind: "prompt", id });
    },
    admitPrompt: () => {
      admissions.taken += 1;
      return () => {
        admissions.released += 1;
      };
    },
  };
  return { runtime, calls, admissions };
}

function fakeDriver(sessionId: string, agentType: Persona = "developer") {
  return {
    id: sessionId,
    key: sessionId,
    sessionId,
    harness: "pi" as const,
    agentType,
    sessionFile: undefined,
    isRunning: false,
    canSteer: false,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => ({
      provider: "fake",
      capabilities: {
        fork: "none",
        compact: false,
        steer: false,
        attachments: false,
      },
      subscribe: () => () => {},
      getBinding: () => ({ provider: "fake" }),
      prompt: async () => ({ stopReason: "end" }),
      abort: () => {},
      setModel: () => {},
      setReasoning: () => {},
      dispose: () => {},
    }),
  };
}

/** One run through the ONE door, on a fake runtime. */
function door(sessionId: string, agentType: Persona = "developer") {
  const fake = fakeRuntime();
  const run = () =>
    (
      promptRuntimeSessionWithRuntime as unknown as (
        runtime: unknown,
        driver: unknown,
        text: string,
        options: unknown,
      ) => Promise<void>
    )(fake.runtime, fakeDriver(sessionId, agentType), "a turn", {
      hidden: true,
    });
  return { ...fake, run };
}

/** The worktree hold a removal would take; released again at once. */
function removalReservable(worktreeId: string): boolean {
  const release = reserveWorktreeForRemoval(worktreeId, "test");
  release?.();
  return release !== undefined;
}

function providerTurn(sessionId: string, agentType: Persona = "developer") {
  return beginRuntimeProviderTurn(
    fakeDriver(sessionId, agentType) as never,
    { kind: "system", source: "test" } as never,
  );
}

/** Captures the recovery callbacks of a session through the door's ensure. */
async function recoveryOf(sessionId: string, agentType: Persona = "developer") {
  const { runtime } = fakeRuntime();
  const { ensureRuntimeSessionWithRuntime } =
    await import("./session/runtimePrompt.ts");
  (
    ensureRuntimeSessionWithRuntime as unknown as (
      r: unknown,
      d: unknown,
    ) => unknown
  )({ ...runtime, get: () => undefined }, fakeDriver(sessionId, agentType));
  const recovery = recoveries.get(sessionId);
  assert.ok(recovery, "recovery installed");
  return recovery;
}

interface SentMessage {
  type: string;
  message?: string;
}

function connection() {
  const sent: SentMessage[] = [];
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )({
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s) as SentMessage),
  }) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & {
    viewing: unknown;
  };
  return { conn, sent };
}

/** A queued `/commit` for `sessionId`, drained once; answers its row error. */
async function queuedCommit(sessionId: string): Promise<string | undefined> {
  const id = `q-${++serial}`;
  promptQueueStore.append({
    id,
    sessionId,
    text: "/commit",
    command: { name: "commit", rawArgs: "" },
  });
  const driver = {
    ...fakeDriver(sessionId),
    beginSyntheticTool: () => ({ assistantId: "a", toolId: "t" }),
    updateSyntheticTool: () => {},
    finishSyntheticTool: () => {},
  };
  await drainPromptQueue(sessionId, () => true, driver as never);
  const row = promptQueueStore.get(sessionId, id) as
    { error?: string } | undefined;
  promptQueueStore.remove(sessionId, id);
  promptQueueStore.setPaused(sessionId, false);
  return row?.error;
}

/** A pi transcript for `id` (header cwd `cwd`) with one user entry. */
function piTranscript(id: string, cwd: string): string {
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(
    file,
    [
      { type: "session", version: 3, id, timestamp: at, cwd },
      {
        type: "model_change",
        id: `${id}-model`,
        parentId: null,
        timestamp: at,
        provider: "openai-compatible",
        modelId: "fixture-model",
      },
      {
        type: "message",
        id: `${id}-user`,
        parentId: `${id}-model`,
        timestamp: at,
        message: { role: "user", content: "start", timestamp: Date.now() },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return file;
}

/** Applies a Worker failure of `kind` to the request on `path`. */
type FailureKind = "coded refusal" | "malformed answer" | "connection end";
const FAILURE_KINDS: FailureKind[] = [
  "coded refusal",
  "malformed answer",
  "connection end",
];

async function underFailure(
  kind: FailureKind,
  path: string,
  run: () => unknown,
  method: string = FILE_METHODS.exists,
  phase: "exists" | "realpath" | "inspect" = "exists",
): Promise<unknown> {
  if (kind === "coded refusal")
    answerForPathForTests(method, path, async () => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    });
  if (kind === "malformed answer")
    answerForPathForTests(method, path, answering(MALFORMED_ANSWERS[method]!));
  if (kind !== "connection end") return settle(run());
  const held = holdFileForTests(path, phase);
  const pending = settle(run());
  await held.reached;
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  held.release();
  return pending;
}

function assertWorkerFailure(result: unknown): unknown {
  const error = errorOf(result);
  assert.ok(isWorkerFailure(error), String(error));
  return error;
}

beforeEach(() => {
  clearMainRepoCache();
  resetPresenceForTests();
  recoveries.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  onCheckoutCheckSettledForTests(undefined);
  await flushPresenceForTests();
});

/* ------------------------------ V5: run start ------------------------------ */

describe("run start decides from its own check (AC5)", () => {
  test("door: a stale present whose folder is gone refuses, appends nothing and releases lease and admission", async () => {
    const row = await stalePresent();
    const id = session(row.id);
    assert.equal(sessionWorktreeMissing(id), false, "the cache is stale");
    const run = door(id);
    const error = errorOf(await settle(run.run()));
    assert.equal((error as Error).message, WORKTREE_MISSING_BLOCKED_REASON);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.admissions, { taken: 1, released: 1 });
    assert.ok(removalReservable(row.id), "no lease left");
  });

  test("door: a stale absent whose folder is back is admitted", async () => {
    const row = await staleAbsent();
    const id = session(row.id);
    assert.equal(sessionWorktreeMissing(id), true, "the cache is stale");
    const run = door(id);
    await run.run();
    assert.deepEqual(run.calls, [{ kind: "prompt", id }]);
  });

  test("door: a removed row refuses before the lease, with no Worker request", async () => {
    const row = spawnedRow(true);
    markWorktreeRemovedForTests(row.id);
    const id = session(row.id);
    const served = recordServedForTests([FILE_METHODS.exists]);
    const run = door(id);
    const error = errorOf(await settle(run.run()));
    served.stop();
    assert.equal((error as Error).message, WORKTREE_MISSING_BLOCKED_REASON);
    assert.deepEqual(run.admissions, { taken: 0, released: 0 });
    assert.deepEqual(served.served, []);
  });

  test("door: no edge is admitted with no Worker request", async () => {
    const id = session();
    const served = recordServedForTests([FILE_METHODS.exists]);
    const run = door(id);
    await run.run();
    served.stop();
    assert.deepEqual(run.calls, [{ kind: "prompt", id }]);
    assert.deepEqual(served.served, []);
  });

  test("provider turn: success keeps the lease until its release; a refusal leaves none", async () => {
    const live = spawnedRow(true);
    const id = session(live.id);
    const release = await providerTurn(id);
    assert.equal(removalReservable(live.id), false, "held by the turn");
    release();
    assert.equal(removalReservable(live.id), true, "released");

    const gone = await stalePresent();
    const refused = session(gone.id);
    const error = errorOf(await settle(providerTurn(refused)));
    assert.equal((error as Error).message, WORKTREE_MISSING_BLOCKED_REASON);
    assert.equal(removalReservable(gone.id), true);
    assert.equal(sessionRuntime.get(refused), undefined, "no runtime session");

    const restored = await staleAbsent();
    (await providerTurn(session(restored.id)))();
  });

  test("provider turn: a removed row refuses before the lease", async () => {
    const row = spawnedRow(true);
    markWorktreeRemovedForTests(row.id);
    const error = errorOf(await settle(providerTurn(session(row.id))));
    assert.equal((error as Error).message, WORKTREE_MISSING_BLOCKED_REASON);
  });

  test("recovery: admission refuses a removed row synchronously; the continuation decides presence", async () => {
    const removed = spawnedRow(true);
    markWorktreeRemovedForTests(removed.id);
    const removedSession = session(removed.id);
    const removedRecovery = await recoveryOf(removedSession);
    assert.throws(() => removedRecovery.admit(), {
      message: WORKTREE_MISSING_BLOCKED_REASON,
    });

    const gone = await stalePresent();
    const id = session(gone.id);
    const recovery = await recoveryOf(id);
    recovery.admit(); // a cached answer is no DB verdict
    const ticket = reserveAccountRecovery(id);
    const error = errorOf(await settle(recovery.resume(ticket, () => {})));
    releaseAccountRecovery(id, ticket);
    assert.equal((error as Error).message, WORKTREE_MISSING_BLOCKED_REASON);
    assert.equal(removalReservable(gone.id), true);
  });

  test("coordinators: a removed row passes door, provider turn and recovery", async () => {
    const row = spawnedRow(true);
    markWorktreeRemovedForTests(row.id);
    const id = session(row.id, "workflow-coordinator");
    const run = door(id, "workflow-coordinator");
    await run.run();
    assert.deepEqual(run.calls, [{ kind: "prompt", id }]);
    (await providerTurn(id, "workflow-coordinator"))();
    (await recoveryOf(id, "workflow-coordinator")).admit();
  });

  test("coordinators: a Worker outage passes with no files.exists served for them", async () => {
    const row = spawnedRow(true);
    const id = session(row.id, "workflow-coordinator");
    answerForPathForTests(FILE_METHODS.exists, row.path, async () => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    });
    const served = recordServedForTests([FILE_METHODS.exists]);
    const run = door(id, "workflow-coordinator");
    await run.run();
    (await providerTurn(id, "workflow-coordinator"))();
    served.stop();
    assert.deepEqual(run.calls, [{ kind: "prompt", id }]);
    assert.deepEqual(served.pathsOf(FILE_METHODS.exists), []);
  });

  test("host command: /commit through the connection refuses on its own check, before any git", async () => {
    const resolveRepoRoot = vi.spyOn(gitExec, "resolveRepoRoot");
    const row = await stalePresent();
    const id = session(row.id, "developer", "claude-sdk");
    const { conn, sent } = connection();
    conn.viewing = claudeSdkStore.acquire(
      id,
      { agentType: "developer", credentialProfileId: claudeProfile.id },
      await checkWorktreeCheckout(row.id),
    );
    // The cache was stale until that check; the command checks again.
    mkdirSync(row.path);
    await checkWorktreeCheckout(row.id);
    rmSync(row.path, { recursive: true });
    await conn.onRunSlashCommand!("commit", "");
    assert.equal(sent.length, 1);
    assert.ok(sent[0]?.message?.startsWith(WORKTREE_MISSING_BLOCKED_REASON));
    assert.equal(resolveRepoRoot.mock.calls.length, 0);
  });

  test("queued host command: refuses on its own check, admitted on a restored folder", async () => {
    const gone = await stalePresent();
    assert.equal(
      await queuedCommit(session(gone.id)),
      WORKTREE_MISSING_BLOCKED_REASON,
    );
    // A restored folder passes the check: the error is the runner's, not ours.
    const restored = await staleAbsent();
    const error = await queuedCommit(session(restored.id));
    assert.notEqual(error, WORKTREE_MISSING_BLOCKED_REASON);
  });

  test("acknowledge: a restored folder records nothing; a deleted one records", async () => {
    const restored = await staleAbsent();
    const keep = session(restored.id);
    assert.equal(await acknowledgeMissingSessionWorktree(keep), undefined);
    assert.equal(sessionStore.worktreeMissingAck(keep), undefined);

    const gone = await stalePresent();
    const ack = session(gone.id);
    assert.equal(await acknowledgeMissingSessionWorktree(ack), gone.id);
    assert.equal(sessionStore.worktreeMissingAck(ack), gone.id);
    await door(ack).run();
  });

  test("acknowledge: an edge moved while checking records nothing", async () => {
    const gone = await stalePresent();
    const other = spawnedRow(false);
    const id = session(gone.id);
    onCheckoutCheckSettledForTests(() => {
      onCheckoutCheckSettledForTests(undefined);
      queueMicrotask(() => linkSessionToWorktree(id, other.id));
    });
    assert.equal(await acknowledgeMissingSessionWorktree(id), undefined);
    assert.equal(sessionStore.worktreeMissingAck(id), undefined);
  });

  test("main 'no repository' within 60 s refuses with no Worker request; invalidation or the TTL admits a restored main", async () => {
    for (const reopen of ["invalidate", "ttl"] as const) {
      const dir = fresh("no-repo");
      mkdirSync(dir);
      const projectId = project([{ path: dir, kind: "repo" }]);
      assert.equal(await resolveMainWorktreeRow(projectId), undefined);
      const id = session(mainWorktreeId(projectId));
      const served = recordServedForTests([
        FILE_METHODS.exists,
        FILE_METHODS.realpath,
      ]);
      const refused = door(id);
      const error = errorOf(await settle(refused.run()));
      served.stop();
      assert.equal((error as Error).message, WORKTREE_MISSING_BLOCKED_REASON);
      assert.deepEqual(served.served, []);
      initRepo(dir);
      if (reopen === "invalidate") invalidateMainRepo(projectId);
      else {
        const at = Date.now() + 61_000;
        vi.spyOn(Date, "now").mockReturnValue(at);
      }
      const admitted = door(id);
      await admitted.run();
      assert.deepEqual(admitted.calls, [{ kind: "prompt", id }]);
      vi.restoreAllMocks();
    }
  });

  test("cold main: a candidate deleted during its realpath refuses (RV-W3d-09)", async () => {
    const repo = fresh("realpath-deleted");
    initRepo(repo);
    const id = session(mainWorktreeId(project([{ path: repo, kind: "repo" }])));
    const held = holdFileForTests(repo, "realpath");
    const run = door(id);
    const pending = settle(run.run());
    await held.reached;
    rmSync(repo, { recursive: true });
    held.release();
    const error = errorOf(await pending);
    assert.equal((error as Error).message, WORKTREE_MISSING_BLOCKED_REASON);
    assert.deepEqual(run.calls, []);
  });

  test("cold main: a realpath filesystem error on a present folder is admitted with the chosen path", async () => {
    const repo = fresh("realpath-eacces");
    initRepo(repo);
    const mainId = mainWorktreeId(project([{ path: repo, kind: "repo" }]));
    failFileForTests(repo, { phase: "realpath", code: "EACCES" });
    const checked = await checkWorktreeCheckout(mainId);
    assert.deepEqual(checked, {
      worktreeId: mainId,
      verdict: "live",
      path: repo,
    });
    clearMainRepoCache();
    failFileForTests(repo, { phase: "realpath", code: "EACCES" });
    const id = session(mainId);
    const run = door(id);
    await run.run();
    assert.deepEqual(run.calls, [{ kind: "prompt", id }]);
  });

  test("the door's synchronous half still fails open on a store error", async () => {
    const row = spawnedRow(true);
    const id = session(row.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = sessionStore.get.bind(sessionStore);
    vi.spyOn(sessionStore, "get").mockImplementationOnce(() => {
      throw new Error("store down");
    });
    const run = door(id);
    await run.run();
    assert.deepEqual(run.calls, [{ kind: "prompt", id }]);
    assert.ok(
      warn.mock.calls.some((call) =>
        String(call[0]).includes("Failed to check session worktree"),
      ),
    );
    void get;
  });
});

/* -------------------------- V6: engine construction ------------------------ */

/** A nested-localPath project: answers its main id, the sub and the root. */
function nestedMain(): { mainId: string; sub: string; root: string } {
  const root = fresh("nested");
  initRepo(root);
  const sub = join(root, "pkg");
  mkdirSync(sub);
  const projectId = project([{ path: sub, kind: "repo" }]);
  return {
    mainId: mainWorktreeId(projectId),
    sub: realpathSync(sub),
    root: realpathSync(root),
  };
}

async function claudeOpen(sessionId: string) {
  return (await harnessRegistry.acquireById(sessionId)) as unknown as {
    cwd: string;
  };
}

function claudeSession(worktreeId?: string): string {
  return session(worktreeId, "developer", "claude-sdk");
}

/** Relinks `sessionId` to the next of `targets` from each settled check. */
function relinkOnSettle(sessionId: string, targets: string[]): void {
  const queue = [...targets];
  onCheckoutCheckSettledForTests(() => {
    const next = queue.shift();
    if (next) queueMicrotask(() => linkSessionToWorktree(sessionId, next));
  });
}

/**
 * A resident Claude source on `worktreeId` whose fork records the directory
 * it would run in, then stops.
 */
async function claudeFork(id: string, worktreeId: string) {
  const source = claudeSdkStore.acquire(
    id,
    { agentType: "developer", credentialProfileId: claudeProfile.id },
    await checkWorktreeCheckout(worktreeId),
  );
  vi.spyOn(source, "toRecordMeta").mockReturnValue({
    ...source.toRecordMeta(),
    providerSessionId: "provider-1",
  });
  vi.spyOn(sessionRuntime, "canForkLogAt").mockReturnValue(true);
  const dirs: string[] = [];
  claudeSdkStore.setSeam(
    async () =>
      ({
        forkSession: async (_id: string, opts: { dir: string }) => {
          dirs.push(opts.dir);
          throw new Error("stop after the cwd");
        },
      }) as never,
  );
  const fork = () =>
    claudeSdkStore.forkSession(id, {
      anchor: "a",
      keepThroughEntryId: "e",
      forkOrigin: {} as never,
    });
  return { dirs, fork };
}

describe("engine construction reads its own check (AC6)", () => {
  test("Claude open: spawned path; deleted folder falls back; never unverified", async () => {
    const live = spawnedRow(true);
    assert.equal((await claudeOpen(claudeSession(live.id))).cwd, live.path);
    const gone = await stalePresent();
    const opened = await claudeOpen(claudeSession(gone.id));
    assert.notEqual(opened.cwd, gone.path);
    assert.equal(opened.cwd, tmp, "base's fallback, the app CWD here");
  });

  test("Claude open: nested main is the scan's subdirectory cold, the root warm", async () => {
    const { mainId, sub, root } = nestedMain();
    assert.equal((await claudeOpen(claudeSession(mainId))).cwd, sub);
    await resolveWorktreeRow(mainId);
    assert.equal((await claudeOpen(claudeSession(mainId))).cwd, root);
  });

  test("Claude rename of a stored non-resident session opens it in its own check's cwd", async () => {
    const live = spawnedRow(true);
    const id = claudeSession(live.id);
    vi.spyOn(claudeSdkStore, "exists").mockReturnValue(true);
    await harnessRegistry.rename(
      { id, harness: "claude-sdk" } as never,
      "Renamed",
    );
    assert.equal(claudeSdkStore.get(id)?.cwd, live.path);
  });

  test("createSession (Claude): explicit path, pathless worktree, reused id with an edge", async () => {
    const explicit = spawnedRow(true);
    const a = await createSession({
      harness: "claude-sdk",
      agentType: "developer",
      credentialProfileId: claudeProfile.id,
      worktree: { id: explicit.id, path: explicit.path },
    } as never);
    assert.equal((a as unknown as { cwd: string }).cwd, explicit.path);
    assert.equal(worktreeIdForSession(a.sessionId), explicit.id);

    const pathless = spawnedRow(true);
    const b = await createSession({
      harness: "claude-sdk",
      agentType: "developer",
      credentialProfileId: claudeProfile.id,
      worktree: { id: pathless.id },
    } as never);
    assert.equal((b as unknown as { cwd: string }).cwd, pathless.path);

    const edge = spawnedRow(true);
    const reused = claudeSession(edge.id);
    const c = await createSession({
      harness: "claude-sdk",
      id: reused,
      agentType: "developer",
      credentialProfileId: claudeProfile.id,
    } as never);
    assert.equal((c as unknown as { cwd: string }).cwd, edge.path);
  });

  test("createSession (pi): a pathless worktree runs in its own check's path", async () => {
    const row = spawnedRow(true);
    const live = await createSession({
      harness: "pi",
      agentType: "developer",
      credentialProfileId: "default",
      worktree: { id: row.id },
    } as never);
    try {
      assert.equal((live as unknown as { cwd: string }).cwd, row.path);
    } finally {
      (live as unknown as { dispose: () => void }).dispose();
    }
  });

  test("pi reopen: the edge's path from its own check; a deleted folder takes the header cwd", async () => {
    const live = spawnedRow(true);
    const id = session(live.id);
    const header = fresh("header");
    mkdirSync(header);
    const reopened = await piStore.acquireExisting(
      "developer",
      piTranscript(id, header),
      id,
    );
    try {
      assert.equal(reopened.cwd, live.path);
    } finally {
      reopened.dispose();
    }
    const gone = await stalePresent();
    const goneId = session(gone.id);
    const fallback = await piStore.acquireExisting(
      "developer",
      piTranscript(goneId, header),
      goneId,
    );
    try {
      assert.equal(fallback.cwd, header);
    } finally {
      fallback.dispose();
    }
  });

  test("pi fork: inherits the parent's edge from its own check", async () => {
    const live = spawnedRow(true);
    const id = session(live.id);
    const header = fresh("fork-header");
    mkdirSync(header);
    const file = piTranscript(id, header);
    const child = await piStore.forkSession(
      "developer",
      file,
      `${id}-user`,
      "at",
      "app-entry",
    );
    try {
      assert.equal(child.cwd, live.path);
    } finally {
      child.dispose();
    }
  });

  test("Claude fork reads its own check", async () => {
    const live = spawnedRow(true);
    const { dirs, fork } = await claudeFork(claudeSession(live.id), live.id);
    await assert.rejects(fork(), /stop after the cwd/);
    assert.deepEqual(dirs, [live.path]);
  });

  test("cold scan held while the root warms: creation uses its own scan; the next gets the root (RV-W3d-02 B)", async () => {
    const { mainId, sub, root } = nestedMain();
    const id = claudeSession(mainId);
    const held = holdFileForTests(join(sub, ".git"), "exists");
    const pending = createSession({
      harness: "claude-sdk",
      id,
      agentType: "developer",
      credentialProfileId: claudeProfile.id,
    } as never);
    await held.reached;
    await resolveMainWorktreeRow(mainId.slice("main:".length));
    held.release();
    assert.equal(((await pending) as unknown as { cwd: string }).cwd, sub);
    assert.equal((await claudeOpen(claudeSession(mainId))).cwd, root);
  });

  test("a relink queued between a check settling and its caller resuming re-checks (RV-W3d-02 A)", async () => {
    // Claude open, pi reopen and a reused-id Claude create.
    const first = spawnedRow(true);
    const other = spawnedRow(true);

    const openId = claudeSession(first.id);
    relinkOnSettle(openId, [other.id]);
    assert.equal((await claudeOpen(openId)).cwd, other.path);

    const piId = session(first.id);
    const header = fresh("relink-header");
    mkdirSync(header);
    relinkOnSettle(piId, [other.id]);
    const reopened = await piStore.acquireExisting(
      "developer",
      piTranscript(piId, header),
      piId,
    );
    try {
      assert.equal(reopened.cwd, other.path);
    } finally {
      reopened.dispose();
    }

    const createId = claudeSession(first.id);
    relinkOnSettle(createId, [other.id]);
    const created = await createSession({
      harness: "claude-sdk",
      id: createId,
      agentType: "developer",
      credentialProfileId: claudeProfile.id,
    } as never);
    assert.equal((created as unknown as { cwd: string }).cwd, other.path);
  });

  test("three consecutive relinks refuse with the exact error and register nothing; two succeed", async () => {
    const rows = [
      spawnedRow(true),
      spawnedRow(true),
      spawnedRow(true),
      spawnedRow(true),
    ];
    const refused = claudeSession(rows[0]!.id);
    relinkOnSettle(refused, [rows[1]!.id, rows[2]!.id, rows[3]!.id]);
    const error = errorOf(await settle(claudeOpen(refused)));
    assert.ok(error instanceof CheckoutEdgeChangedError);
    assert.equal((error as Error).message, EDGE_CHANGED);
    assert.equal(claudeSdkStore.get(refused), undefined);

    const twice = claudeSession(rows[0]!.id);
    relinkOnSettle(twice, [rows[1]!.id, rows[2]!.id]);
    assert.equal((await claudeOpen(twice)).cwd, rows[2]!.path);
  });

  test("a relink while the probe is held re-checks and uses the new path", async () => {
    const first = spawnedRow(true);
    const other = spawnedRow(true);
    const id = claudeSession(first.id);
    const held = holdFileForTests(first.path, "exists");
    const pending = claudeOpen(id);
    await held.reached;
    linkSessionToWorktree(id, other.id);
    held.release();
    assert.equal((await pending).cwd, other.path);
  });

  test("an explicit target is checked once and linked; another session's relink has no effect", async () => {
    const target = spawnedRow(true);
    const elsewhere = spawnedRow(true);
    const bystander = claudeSession(target.id);
    let checks = 0;
    onCheckoutCheckSettledForTests(() => {
      checks += 1;
      queueMicrotask(() => linkSessionToWorktree(bystander, elsewhere.id));
    });
    const created = await createSession({
      harness: "claude-sdk",
      agentType: "developer",
      credentialProfileId: claudeProfile.id,
      worktree: { id: target.id },
    } as never);
    assert.equal(checks, 1);
    assert.equal(worktreeIdForSession(created.sessionId), target.id);
    assert.equal((created as unknown as { cwd: string }).cwd, target.path);
  });

  test("backstop: a stale check after a relink throws", async () => {
    const a = spawnedRow(true);
    const b = spawnedRow(true);
    const id = session(a.id);
    const checked = await checkWorktreeCheckout(a.id);
    linkSessionToWorktree(id, b.id);
    assert.throws(
      () => worktreeCwdForSession(id, checked),
      CheckoutEdgeChangedError,
    );
  });

  test("a root deleted while its check is held: the check's own absence decides, never the cached root", async () => {
    const repo = fresh("root-drop");
    initRepo(repo);
    const projectId = project([{ path: repo, kind: "repo" }]);
    const mainId = mainWorktreeId(projectId);
    const root = realpathSync(repo);
    await resolveWorktreeRow(mainId);
    await checkWorktreeCheckout(mainId);
    const id = claudeSession(mainId);
    const held = holdFileForTests(root, "exists");
    const pending = claudeOpen(id);
    await held.reached;
    rmSync(repo, { recursive: true });
    // A background probe answers absent and drops the resolve entry.
    presenceNow(DEFAULT_WORKER_SIDE, root);
    held.release();
    const opened = await pending;
    assert.equal(opened.cwd, tmp, "base's fallback; the cached root was live");
  });

  test("a root dropped after its check settled live: the construction uses its own answer", async () => {
    const repo = fresh("root-drop-settled");
    initRepo(repo);
    const projectId = project([{ path: repo, kind: "repo" }]);
    const mainId = mainWorktreeId(projectId);
    const root = realpathSync(repo);
    await resolveWorktreeRow(mainId);
    const id = claudeSession(mainId);
    onCheckoutCheckSettledForTests((checked) => {
      onCheckoutCheckSettledForTests(undefined);
      assert.equal(checked.verdict, "live");
      // Before the caller resumes: the root and every main key are forgotten.
      invalidateMainRepo(projectId);
    });
    assert.equal((await claudeOpen(id)).cwd, root);
    assert.equal(
      worktreeCwdForSessionOrUnverified(session(mainId)),
      "unverified",
      "the cache no longer holds the root",
    );
  });

  test("an invalidation during a held scan: the construction uses its own result, the cache records nothing", async () => {
    const { mainId, sub } = nestedMain();
    const id = claudeSession(mainId);
    const held = holdFileForTests(join(sub, ".git"), "exists");
    const pending = claudeOpen(id);
    await held.reached;
    invalidateMainRepo(mainId.slice("main:".length));
    held.release();
    assert.equal((await pending).cwd, sub);
    assert.equal(
      worktreeCwdForSessionOrUnverified(session(mainId)),
      "unverified",
      "nothing was recorded",
    );
  });

  test("Claude open of a cold main whose candidate is deleted during its realpath falls back (RV-W3d-09)", async () => {
    const repo = fresh("open-realpath-deleted");
    initRepo(repo);
    const id = claudeSession(
      mainWorktreeId(project([{ path: repo, kind: "repo" }])),
    );
    const held = holdFileForTests(repo, "realpath");
    const pending = claudeOpen(id);
    await held.reached;
    rmSync(repo, { recursive: true });
    held.release();
    const opened = await pending;
    assert.notEqual(opened.cwd, repo);
    assert.equal(opened.cwd, tmp);
  });
});

function worktreeCwdForSessionOrUnverified(sessionId: string): string {
  try {
    return worktreeCwdForSession(sessionId) ?? "none";
  } catch (error) {
    if (error instanceof UnverifiedCheckoutError) return "unverified";
    throw error;
  }
}

/* --------------------- V7: Worker failures at each consumer ---------------- */

interface Consumer {
  name: string;
  /** Sets up a live checkout; answers the probed path and the call. */
  prepare(): Promise<{ path: string; run: () => unknown; after?: () => void }>;
}

function liveRowSession(harness: "pi" | "claude-sdk" = "pi"): {
  row: { id: string; path: string };
  id: string;
} {
  const row = spawnedRow(true);
  return { row, id: session(row.id, "developer", harness) };
}

const CONSUMERS: Consumer[] = [
  {
    name: "door",
    prepare: async () => {
      const { row, id } = liveRowSession();
      const run = door(id);
      return {
        path: row.path,
        run: run.run,
        after: () => {
          assert.deepEqual(run.calls, []);
          assert.deepEqual(run.admissions, { taken: 1, released: 1 });
          assert.ok(removalReservable(row.id));
        },
      };
    },
  },
  {
    name: "provider turn",
    prepare: async () => {
      const { row, id } = liveRowSession();
      return {
        path: row.path,
        run: () => providerTurn(id),
        after: () => assert.ok(removalReservable(row.id)),
      };
    },
  },
  {
    name: "recovery continuation",
    prepare: async () => {
      const { row, id } = liveRowSession();
      const recovery = await recoveryOf(id);
      return {
        path: row.path,
        run: async () => {
          const ticket = reserveAccountRecovery(id);
          try {
            await recovery.resume(ticket, () => {});
          } finally {
            releaseAccountRecovery(id, ticket);
          }
        },
      };
    },
  },
  {
    name: "acknowledge",
    prepare: async () => {
      const { row, id } = liveRowSession();
      return {
        path: row.path,
        run: () => acknowledgeMissingSessionWorktree(id),
        after: () =>
          assert.equal(sessionStore.worktreeMissingAck(id), undefined),
      };
    },
  },
  {
    name: "shared resolver",
    prepare: async () => {
      const row = spawnedRow(true);
      return { path: row.path, run: () => resolveUsableWorktree(row.id) };
    },
  },
  {
    name: "Claude open",
    prepare: async () => {
      const { row, id } = liveRowSession("claude-sdk");
      return {
        path: row.path,
        run: () => harnessRegistry.acquireById(id),
        after: () => assert.equal(claudeSdkStore.get(id), undefined),
      };
    },
  },
  {
    name: "Claude create (reused id)",
    prepare: async () => {
      const { row, id } = liveRowSession("claude-sdk");
      return {
        path: row.path,
        run: () =>
          createSession({
            harness: "claude-sdk",
            id,
            agentType: "developer",
            credentialProfileId: claudeProfile.id,
          } as never),
        after: () => assert.equal(claudeSdkStore.get(id), undefined),
      };
    },
  },
  {
    name: "pi create (pathless worktree)",
    prepare: async () => {
      const row = spawnedRow(true);
      return {
        path: row.path,
        run: () =>
          createSession({
            harness: "pi",
            agentType: "developer",
            credentialProfileId: "default",
            worktree: { id: row.id },
          } as never),
      };
    },
  },
  {
    name: "Claude rename (stored, non-resident)",
    prepare: async () => {
      const { row, id } = liveRowSession("claude-sdk");
      vi.spyOn(claudeSdkStore, "exists").mockReturnValue(true);
      return {
        path: row.path,
        run: () =>
          harnessRegistry.rename({ id, harness: "claude-sdk" } as never, "R"),
        after: () => assert.equal(claudeSdkStore.get(id), undefined),
      };
    },
  },
  {
    name: "Claude fork",
    prepare: async () => {
      const { row, id } = liveRowSession("claude-sdk");
      const { dirs, fork } = await claudeFork(id, row.id);
      return {
        path: row.path,
        run: fork,
        after: () => assert.deepEqual(dirs, []),
      };
    },
  },
  {
    name: "pi fork",
    prepare: async () => {
      const { row, id } = liveRowSession();
      const header = fresh("fail-fork-header");
      mkdirSync(header);
      const file = piTranscript(id, header);
      return {
        path: row.path,
        run: () =>
          piStore.forkSession(
            "developer",
            file,
            `${id}-user`,
            "at",
            "app-entry",
          ),
      };
    },
  },
  {
    name: "pi reopen",
    prepare: async () => {
      const { row, id } = liveRowSession();
      const header = fresh("fail-header");
      mkdirSync(header);
      const file = piTranscript(id, header);
      return {
        path: row.path,
        run: () => piStore.acquireExisting("developer", file, id),
      };
    },
  },
  {
    name: "main row resolution (resolveMainRepo's local path)",
    prepare: async () => {
      const repo = fresh("fail-main");
      initRepo(repo);
      const projectId = project([{ path: repo, kind: "repo" }]);
      return { path: repo, run: () => resolveMainWorktreeRow(projectId) };
    },
  },
];

describe("Worker failures at each new consumer (AC7)", () => {
  for (const kind of FAILURE_KINDS)
    test.each(CONSUMERS)(`$name: a ${kind} rejects`, async (consumer) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { path, run, after } = await consumer.prepare();
      const error = assertWorkerFailure(await underFailure(kind, path, run));
      assert.ok(!String(error).includes(WORKTREE_MISSING_BLOCKED_REASON));
      if (kind === "connection end")
        assert.match(String(error), /The Worker connection ended/);
      after?.();
    });

  for (const kind of FAILURE_KINDS)
    test(`host command through the connection: a ${kind} is a failure, not the missing-worktree refusal`, async () => {
      const resolveRepoRoot = vi.spyOn(gitExec, "resolveRepoRoot");
      const { row, id } = liveRowSession("claude-sdk");
      const { conn, sent } = connection();
      conn.viewing = claudeSdkStore.acquire(
        id,
        { agentType: "developer", credentialProfileId: claudeProfile.id },
        await checkWorktreeCheckout(row.id),
      );
      await underFailure(kind, row.path, () =>
        conn.onRunSlashCommand!("commit", ""),
      );
      assert.equal(sent.length, 1);
      assert.match(sent[0]?.message ?? "", /^Failed to run \/commit: /);
      assert.ok(!sent[0]?.message?.includes(WORKTREE_MISSING_BLOCKED_REASON));
      assert.equal(resolveRepoRoot.mock.calls.length, 0);
    });

  for (const kind of FAILURE_KINDS)
    test(`queued host command: a ${kind} holds the row with the failure text`, async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { row, id } = liveRowSession();
      let error: string | undefined;
      await underFailure(kind, row.path, async () => {
        error = await queuedCommit(id);
      });
      assert.ok(error, "held");
      assert.notEqual(error, WORKTREE_MISSING_BLOCKED_REASON);
    });

  for (const kind of FAILURE_KINDS)
    test(`creation context: a ${kind} sends the failure, not "no longer available"`, async () => {
      const row = spawnedRow(true);
      // The resolver's own failure text under the same kind is what is sent.
      const expected = assertWorkerFailure(
        await underFailure(kind, row.path, () => resolveUsableWorktree(row.id)),
      ) as Error;
      const { conn, sent } = connection();
      const result = await underFailure(kind, row.path, () =>
        conn.resolveWorktreeContext!(row.id),
      );
      assert.deepEqual(result, { value: undefined });
      assert.deepEqual(sent, [{ type: "error", message: expected.message }]);
    });
});

/* ------------------------- V10, V12, V14: lifecycle ----------------------- */

describe("lifecycle, shared resolver and placement", () => {
  test("a created worktree is present at once; its removal forgets it and a held probe completes into nothing (AC10)", async () => {
    const repo = fresh("lifecycle");
    initRepo(repo);
    const projectId = project([{ path: repo, kind: "repo" }], fresh("wt-root"));
    const record = await createWorktree({ projectId, name: "seeded" });
    const id = session(record.id);
    assert.equal(worktreeCwdForSession(id), record.path, "no awaited probe");
    await flushPresenceForTests();
    assert.equal(worktreeCwdForSession(id), record.path);

    const held = holdFileForTests(record.path, "exists");
    presenceNow(DEFAULT_WORKER_SIDE, record.path);
    await held.reached;
    const before = presenceCountsForTests();
    try {
      await removeWorktree(record.id, { force: true, deleteBranch: true });
      assert.equal(presenceCountsForTests().entries, before.entries - 1);
    } finally {
      held.release();
    }
    await flushPresenceForTests();
    const after = presenceCountsForTests();
    assert.equal(after.droppedLate, before.droppedLate + 1);
    assert.equal(
      after.entries,
      before.entries - 1,
      "the late answer cached nothing",
    );
  });

  test("after 50 create/remove cycles and 5 project edits, entries stay within the live bound (AC11)", async () => {
    const repo = fresh("cycles");
    initRepo(repo);
    const projectId = project(
      [{ path: repo, kind: "repo" }],
      fresh("cycle-root"),
    );
    for (let i = 0; i < 50; i++) {
      const record = await createWorktree({ projectId, name: `cycle-${i}` });
      presenceNow(DEFAULT_WORKER_SIDE, record.path);
      await removeWorktree(record.id, { force: true, deleteBranch: true });
    }
    for (let i = 0; i < 5; i++) {
      const before = fresh("edit-before");
      initRepo(before);
      const edited = project([{ path: before, kind: "repo" }]);
      await checkWorktreeCheckout(mainWorktreeId(edited));
      const after = fresh("edit-after");
      mkdirSync(after);
      // Edited as the registry writers do: the record, then invalidation.
      project([{ path: after, kind: "repo" }], undefined, edited);
      invalidateMainRepo(edited);
      await checkWorktreeCheckout(mainWorktreeId(edited));
    }
    await flushPresenceForTests();
    const bound =
      activeWorktreePaths().size +
      projectStore
        .list()
        .reduce((sum, p) => sum + (p.localPaths?.length ?? 0) + 1, 0);
    const { entries } = presenceCountsForTests();
    assert.ok(entries <= bound, `${entries} entries > bound ${bound}`);
  }, 120_000);

  test("shared resolver: present answers the row and path, deleted answers undefined, nested main the root (AC12)", async () => {
    const live = spawnedRow(true);
    const usable = await resolveUsableWorktree(live.id);
    assert.equal(usable?.row.id, live.id);
    assert.equal(usable?.path, live.path);
    const gone = await stalePresent();
    assert.equal(await resolveUsableWorktree(gone.id), undefined);
    const { mainId, root } = nestedMain();
    assert.equal((await resolveUsableWorktree(mainId))?.path, root);

    const { conn, sent } = connection();
    assert.deepEqual(await conn.resolveWorktreeContext!(live.id), {
      id: live.id,
      path: live.path,
      projectId: "none",
    });
    assert.equal(await conn.resolveWorktreeContext!(gone.id), undefined);
    assert.deepEqual(sent, [
      { type: "error", message: "That worktree is no longer available." },
    ]);
  });

  test("spawn proposals and review handoffs resolve through the shared resolver (AC12)", async () => {
    const live = spawnedRow(true);
    const gone = await stalePresent();
    const sender = session();
    const propose = (worktreeId: string) =>
      buildSpawnProposal({
        senderSessionId: sender,
        rows: [{ title: "T", agentType: "assistant", prompt: "p", worktreeId }],
      } as never);
    const proposal = await propose(live.id);
    assert.equal(proposal.items[0]?.worktreeId, live.id);
    await assert.rejects(propose(gone.id), {
      message: `Worktree ${gone.id} does not exist, was removed, or its checkout is gone.`,
    });

    const handoff = async (worktreeId: string) => {
      const { conn, sent } = connection();
      await conn.onAttachWorktreeComments!(worktreeId, [], {
        kind: "existing",
        sessionId: session(worktreeId),
      });
      return sent.map((message) => message.message);
    };
    // An empty selection is refused only after the worktree resolved.
    assert.deepEqual(await handoff(live.id), [
      "Failed to attach comments: Select at least one comment.",
    ]);
    assert.deepEqual(await handoff(gone.id), [
      "Failed to attach comments: That worktree is no longer available.",
    ]);
  });

  for (const kind of FAILURE_KINDS)
    test(`spawn proposal and review handoff: a ${kind} is a Worker failure, not a missing worktree`, async () => {
      const row = spawnedRow(true);
      const sender = session();
      const spawned = await underFailure(kind, row.path, () =>
        buildSpawnProposal({
          senderSessionId: sender,
          rows: [
            {
              title: "T",
              agentType: "assistant",
              prompt: "p",
              worktreeId: row.id,
            },
          ],
        } as never),
      );
      const expected = assertWorkerFailure(spawned) as Error;
      const { conn, sent } = connection();
      const target = session(row.id);
      await underFailure(kind, row.path, () =>
        conn.onAttachWorktreeComments!(row.id, [], {
          kind: "existing",
          sessionId: target,
        }),
      );
      assert.deepEqual(
        sent.map((message) => message.message),
        [`Failed to attach comments: ${expected.message}`],
      );
    });

  test("placement: edges probe on the default Worker; the KB row never resolves; DATA_DIR checkouts probe on the Worker (AC14)", async () => {
    const kbServed = recordServedForTests([
      FILE_METHODS.exists,
      FILE_METHODS.realpath,
      FILE_METHODS.inspect,
    ]);
    assert.equal(await resolveWorktreeRow(KNOWLEDGE_WORKTREE_ID), undefined);
    assert.equal(await resolveUsableWorktree(KNOWLEDGE_WORKTREE_ID), undefined);
    kbServed.stop();
    assert.deepEqual(kbServed.served, [], "the KB row reaches no Worker");
    const repo = join(tmp, "data", `inside-${++serial}`);
    initRepo(repo);
    const mainId = mainWorktreeId(project([{ path: repo, kind: "repo" }]));
    const served = recordServedForTests([FILE_METHODS.exists]);
    assert.equal((await checkWorktreeCheckout(mainId)).verdict, "live");
    served.stop();
    assert.ok(served.pathsOf(FILE_METHODS.exists).length > 0);
    const row = spawnedRow(true);
    await checkWorktreeCheckout(row.id);
    assert.equal(
      presenceNow(DEFAULT_WORKER_SIDE, row.path),
      "present",
      presenceKey(DEFAULT_WORKER_SIDE, row.path),
    );
    assert.equal(presenceNow("server", row.path), "unverified");
  });
});

/* ------------- V5 completion: store failures, admission, recovery ------------ */

/** Every read of the worktrees table throws from now on; the rest works. */
function worktreesTableDown(): void {
  vi.spyOn(worktreeStore, "getWorktree").mockImplementation(() => {
    throw new Error("worktrees table down");
  });
}

function warnedStoreFailure(warn: { mock: { calls: unknown[][] } }): boolean {
  return warn.mock.calls.some((call) =>
    String(call[0]).includes("Failed to check session worktree"),
  );
}

/**
 * The recovery continuation of `sessionId`, run to its end on a fake runtime
 * that records what it created and prompted.
 */
async function recoveryRun(
  sessionId: string,
  agentType: Persona = "developer",
) {
  const fake = fakeRuntime();
  const { ensureRuntimeSessionWithRuntime } =
    await import("./session/runtimePrompt.ts");
  (
    ensureRuntimeSessionWithRuntime as unknown as (
      r: unknown,
      d: unknown,
    ) => unknown
  )(
    { ...fake.runtime, get: () => undefined },
    fakeDriver(sessionId, agentType),
  );
  const recovery = recoveries.get(sessionId);
  assert.ok(recovery, "recovery installed");
  const resume = async () => {
    recovery.admit();
    const ticket = reserveAccountRecovery(sessionId);
    try {
      return await settle(recovery.resume(ticket, () => {}));
    } finally {
      releaseAccountRecovery(sessionId, ticket);
    }
  };
  const prompted = () =>
    fake.calls.filter((call) => call.kind === "prompt" && call.id === sessionId)
      .length;
  return { resume, prompted };
}

describe("a worktrees-table failure fails open as base; a Worker failure fails closed (AC5, AC7)", () => {
  test("door, provider turn and recovery continuation admit a turn while every worktrees read throws", async () => {
    const row = spawnedRow(true);
    const id = session(row.id);
    const recovery = await recoveryRun(id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    worktreesTableDown();

    const run = door(id);
    await run.run();
    assert.deepEqual(run.calls, [{ kind: "prompt", id }]);

    const release = await providerTurn(id);
    assert.equal(sessionRuntime.isBusy(id), true);
    release();
    assert.equal(sessionRuntime.isBusy(id), false);

    assert.deepEqual(await recovery.resume(), { value: undefined });
    assert.equal(recovery.prompted(), 1, "the continuation prompted");
    assert.ok(warnedStoreFailure(warn), "the store failure was logged");
  });

  test("a host command through the connection is not refused while every worktrees read throws", async () => {
    const row = spawnedRow(true);
    const id = session(row.id, "developer", "claude-sdk");
    const { conn, sent } = connection();
    conn.viewing = claudeSdkStore.acquire(
      id,
      { agentType: "developer", credentialProfileId: claudeProfile.id },
      await checkWorktreeCheckout(row.id),
    );
    const resolveRepoRoot = vi
      .spyOn(gitExec, "resolveRepoRoot")
      .mockRejectedValue(new Error("stop at git"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    worktreesTableDown();
    await conn.onRunSlashCommand!("commit", "");
    assert.ok(warnedStoreFailure(warn), "the store failure was logged");
    assert.ok(
      !sent.some((message) =>
        message.message?.startsWith(WORKTREE_MISSING_BLOCKED_REASON),
      ),
      JSON.stringify(sent),
    );
    assert.ok(resolveRepoRoot.mock.calls.length > 0, "the command ran");
  });

  test("a queued host command: a worktrees-table failure throws out of the drain as base's check did, holding nothing", async () => {
    const row = spawnedRow(true);
    const id = session(row.id);
    worktreesTableDown();
    const drained = settle(queuedCommit(id));
    assert.match(String(errorOf(await drained)), /worktrees table down/);
    vi.restoreAllMocks();
    const [left] = promptQueueStore.list(id);
    assert.equal((left as { error?: string } | undefined)?.error, undefined);
    if (left) promptQueueStore.remove(id, left.id);
  });

  test("a Worker failure with the stores working is no store failure: door, provider turn and recovery reject", async () => {
    const row = spawnedRow(true);
    const id = session(row.id);
    const recovery = await recoveryRun(id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const kind of FAILURE_KINDS) {
      const run = door(id);
      assertWorkerFailure(await underFailure(kind, row.path, () => run.run()));
      assert.deepEqual(run.calls, []);
      assertWorkerFailure(
        await underFailure(kind, row.path, () => providerTurn(id)),
      );
      assert.equal(sessionRuntime.isBusy(id), false, `${kind}: no admission`);
      assert.ok(removalReservable(row.id), `${kind}: no lease`);
      assertWorkerFailure(
        await underFailure(kind, row.path, async () => {
          const result = await recovery.resume();
          if ("error" in (result as object))
            throw (result as { error: unknown }).error;
        }),
      );
      assert.equal(recovery.prompted(), 0, `${kind}: no continuation turn`);
    }
    assert.ok(!warnedStoreFailure(warn), "never taken for a store failure");
  });
});

describe("run start: admission ownership and recovery continuations (AC5)", () => {
  test("provider turn: busy from success until its release; a refusal and a Worker failure leave it idle", async () => {
    const live = spawnedRow(true);
    const id = session(live.id);
    const release = await providerTurn(id);
    assert.equal(sessionRuntime.isBusy(id), true, "admitted by the turn");
    release();
    assert.equal(sessionRuntime.isBusy(id), false);

    const gone = await stalePresent();
    const refused = session(gone.id);
    const error = errorOf(await settle(providerTurn(refused)));
    assert.equal((error as Error).message, WORKTREE_MISSING_BLOCKED_REASON);
    assert.equal(sessionRuntime.isBusy(refused), false);

    const failing = spawnedRow(true);
    const failed = session(failing.id);
    for (const kind of FAILURE_KINDS) {
      assertWorkerFailure(
        await underFailure(kind, failing.path, () => providerTurn(failed)),
      );
      assert.equal(sessionRuntime.isBusy(failed), false, kind);
      assert.ok(removalReservable(failing.id), kind);
    }
  });

  test("recovery: a stale absent whose folder is back runs the continuation", async () => {
    const restored = await staleAbsent();
    const id = session(restored.id);
    assert.equal(sessionWorktreeMissing(id), true, "the cache is stale");
    const recovery = await recoveryRun(id);
    assert.deepEqual(await recovery.resume(), { value: undefined });
    assert.equal(recovery.prompted(), 1);
  });

  test("coordinators: a removed row and a Worker outage run the recovery continuation, with no files.exists served", async () => {
    const removed = spawnedRow(true);
    markWorktreeRemovedForTests(removed.id);
    const removedId = session(removed.id, "workflow-coordinator");
    const removedRecovery = await recoveryRun(
      removedId,
      "workflow-coordinator",
    );
    assert.deepEqual(await removedRecovery.resume(), { value: undefined });
    assert.equal(removedRecovery.prompted(), 1);

    const outage = spawnedRow(true);
    const outageId = session(outage.id, "workflow-coordinator");
    answerForPathForTests(FILE_METHODS.exists, outage.path, async () => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    });
    const outageRecovery = await recoveryRun(outageId, "workflow-coordinator");
    const served = recordServedForTests([FILE_METHODS.exists]);
    assert.deepEqual(await outageRecovery.resume(), { value: undefined });
    served.stop();
    assert.equal(outageRecovery.prompted(), 1);
    assert.deepEqual(served.pathsOf(FILE_METHODS.exists), []);
  });
});

/* --------------- V6 completion: every construction, every edge -------------- */

/** A stored, non-resident Claude record of `id` whose cwd is `cwd`. */
function claudeRecord(id: string, cwd: string): void {
  writeClaudeSdkRecord(
    CLAUDE_SDK_STORE_DIR,
    { id, title: id, cwd, createdAt: 1, updatedAt: 1 },
    [],
    undefined,
  );
}

async function claudeRename(id: string): Promise<string | undefined> {
  await harnessRegistry.rename(
    { id, harness: "claude-sdk" } as never,
    "Renamed",
  );
  return claudeSdkStore.get(id)?.cwd;
}

async function claudeCreate(spec: Record<string, unknown>): Promise<string> {
  const live = await createSession({
    harness: "claude-sdk",
    agentType: "developer",
    credentialProfileId: claudeProfile.id,
    ...spec,
  } as never);
  return (live as unknown as { cwd: string }).cwd;
}

async function piCreate(worktreeId: string): Promise<string> {
  const live = (await createSession({
    harness: "pi",
    agentType: "developer",
    credentialProfileId: "default",
    worktree: { id: worktreeId },
  } as never)) as unknown as { cwd: string; dispose: () => void };
  try {
    return live.cwd;
  } finally {
    live.dispose();
  }
}

async function piReopen(worktreeId: string, header: string): Promise<string> {
  const id = session(worktreeId);
  const live = await piStore.acquireExisting(
    "developer",
    piTranscript(id, header),
    id,
  );
  try {
    return live.cwd;
  } finally {
    live.dispose();
  }
}

async function piFork(worktreeId: string, header: string): Promise<string> {
  const id = session(worktreeId);
  const child = await piStore.forkSession(
    "developer",
    piTranscript(id, header),
    `${id}-user`,
    "at",
    "app-entry",
  );
  try {
    return child.cwd;
  } finally {
    child.dispose();
  }
}

async function claudeForkDir(worktreeId: string): Promise<string[]> {
  const { dirs, fork } = await claudeFork(
    claudeSession(worktreeId),
    worktreeId,
  );
  await assert.rejects(fork(), /stop after the cwd/);
  return dirs;
}

/** A header directory for pi transcripts, present on disk. */
function headerDir(): string {
  const header = fresh("header");
  mkdirSync(header);
  return header;
}

/**
 * Runs `construct` against a nested-localPath main cold (caches reset), then
 * warm (resolved): base's scan subdirectory first, the git root after.
 */
async function coldThenWarm(
  construct: (mainId: string) => Promise<string | string[] | undefined>,
  shape: (path: string) => string | string[] = (path) => path,
): Promise<void> {
  const { mainId, sub, root } = nestedMain();
  assert.deepEqual(await construct(mainId), shape(sub), "cold: the scan");
  await resolveWorktreeRow(mainId);
  assert.deepEqual(await construct(mainId), shape(root), "warm: the root");
}

describe("engine construction: the full V6 matrix (AC6)", () => {
  test("Claude open: a deleted folder takes the record's cwd", async () => {
    const gone = await stalePresent();
    const id = claudeSession(gone.id);
    const recorded = headerDir();
    claudeRecord(id, recorded);
    assert.equal((await claudeOpen(id)).cwd, recorded);
  });

  test("Claude rename: nested main cold and warm; a deleted folder takes the record's cwd", async () => {
    await coldThenWarm(async (mainId) => {
      const id = claudeSession(mainId);
      claudeRecord(id, headerDir());
      return claudeRename(id);
    });
    const gone = await stalePresent();
    const id = claudeSession(gone.id);
    const recorded = headerDir();
    claudeRecord(id, recorded);
    assert.equal(await claudeRename(id), recorded);
  });

  test("Claude fork: nested main cold and warm; a folder deleted under a resident source takes the source's cwd", async () => {
    await coldThenWarm(claudeForkDir, (path) => [path]);
    const live = spawnedRow(true);
    const { dirs, fork } = await claudeFork(claudeSession(live.id), live.id);
    rmSync(live.path, { recursive: true });
    await assert.rejects(fork(), /stop after the cwd/);
    assert.deepEqual(dirs, [live.path], "base: the source's own cwd");
  });

  test("pi reopen: nested main cold and warm", async () => {
    const header = headerDir();
    await coldThenWarm((mainId) => piReopen(mainId, header));
  });

  test("pi fork: nested main cold and warm; a deleted folder takes the header cwd", async () => {
    const header = headerDir();
    await coldThenWarm((mainId) => piFork(mainId, header));
    const gone = await stalePresent();
    assert.equal(await piFork(gone.id, header), header);
  });

  test("createSession (Claude) with an explicit path: nested main cold and warm; a deleted folder keeps the explicit path", async () => {
    await coldThenWarm((mainId) =>
      claudeCreate({ worktree: { id: mainId, path: headerDir() } }),
    );
    const gone = await stalePresent();
    assert.equal(
      await claudeCreate({ worktree: { id: gone.id, path: gone.path } }),
      gone.path,
    );
  });

  test("createSession (Claude) with a pathless worktree: nested main cold and warm; a deleted folder takes the app CWD", async () => {
    await coldThenWarm((mainId) => claudeCreate({ worktree: { id: mainId } }));
    const gone = await stalePresent();
    assert.equal(await claudeCreate({ worktree: { id: gone.id } }), tmp);
  });

  test("createSession (Claude) for a reused id with an edge: nested main cold and warm; a deleted folder takes the app CWD", async () => {
    await coldThenWarm((mainId) => claudeCreate({ id: claudeSession(mainId) }));
    const gone = await stalePresent();
    assert.equal(await claudeCreate({ id: claudeSession(gone.id) }), tmp);
  });

  test("createSession (pi) with a pathless worktree: nested main cold and warm; a deleted folder takes the app CWD", async () => {
    await coldThenWarm(piCreate);
    const gone = await stalePresent();
    assert.equal(await piCreate(gone.id), tmp);
  });
});

/* ------------------ V12 completion: complete resolver outputs ---------------- */

describe("shared resolver outputs, complete (AC12)", () => {
  test("creation context and spawn proposals answer the whole target; a nested main runs at the root", async () => {
    const { conn, sent } = connection();
    const { mainId, root } = nestedMain();
    const projectId = mainId.slice("main:".length);
    assert.deepEqual(await conn.resolveWorktreeContext!(mainId), {
      id: mainId,
      path: root,
      projectId,
    });

    const sender = session();
    const proposed = async (worktreeId: string) =>
      (
        await buildSpawnProposal({
          senderSessionId: sender,
          rows: [
            { title: "T", agentType: "developer", prompt: "p", worktreeId },
          ],
        } as never)
      ).items[0];
    const target = async (worktreeId: string) => {
      const item = await proposed(worktreeId);
      return {
        worktreeId: item?.worktreeId,
        worktreeName: item?.worktreeName,
        projectId: item?.projectId,
      };
    };
    const live = spawnedRow(true);
    assert.deepEqual(await target(live.id), {
      worktreeId: live.id,
      worktreeName: live.id,
      projectId: undefined,
    });
    assert.deepEqual(await target(mainId), {
      worktreeId: mainId,
      worktreeName: "main",
      projectId,
    });

    rmSync(root, { recursive: true });
    assert.equal(await resolveUsableWorktree(mainId), undefined);
    assert.equal(await conn.resolveWorktreeContext!(mainId), undefined);
    assert.deepEqual(sent, [
      { type: "error", message: "That worktree is no longer available." },
    ]);
  });

  test("review handoff: a nested main resolves past the worktree check; its deleted root is no longer available", async () => {
    const handoff = async (worktreeId: string) => {
      const { conn, sent } = connection();
      await conn.onAttachWorktreeComments!(worktreeId, [], {
        kind: "existing",
        sessionId: session(worktreeId),
      });
      return sent.map((message) => message.message);
    };
    const { mainId, root } = nestedMain();
    assert.deepEqual(await handoff(mainId), [
      "Failed to attach comments: Select at least one comment.",
    ]);
    rmSync(root, { recursive: true });
    assert.deepEqual(await handoff(mainId), [
      "Failed to attach comments: That worktree is no longer available.",
    ]);
  });

  test("review handoff: a nested main, by an aliased id, hands the new session the canonical id and the repo root", async () => {
    const { mainId, sub, root } = nestedMain();
    const projectId = mainId.slice("main:".length);
    const alias = `main:${projectId.toUpperCase()}`;
    assert.notEqual(alias, mainId);
    assert.notEqual(sub, root);
    const comment = await addWorktreeComment({
      worktreeId: mainId,
      body: "Please look.",
      author: { kind: "user" },
      anchor: { path: "readme.md", side: "new", line: 1 },
    });
    const engine = handoffEngine("claude-sdk");
    const create = vi.spyOn(engine, "create");
    // The real Worker check and creation run; only the provider turn stops.
    let delivered!: (sessionId: string) => void;
    const deliveredTo = new Promise<string>((resolve) => {
      delivered = resolve;
    });
    vi.spyOn(sessionRuntime, "deliverPrompt").mockImplementation(
      async (sessionId: string) => delivered(sessionId),
    );

    const { conn, sent } = connection();
    await conn.onAttachWorktreeComments!(alias, [comment.id], {
      kind: "new",
      harness: "claude-sdk",
      agentType: "developer",
      credentialProfileId: claudeProfile.id,
      additionalPrompt: "Address the review.",
    });

    assert.deepEqual(
      sent.filter((message) => message.type === "error"),
      [],
    );
    assert.equal(create.mock.calls.length, 1);
    assert.deepEqual(create.mock.calls[0]?.[1], { id: mainId, path: root });
    const live = (await create.mock.results[0]?.value) as {
      sessionId: string;
      cwd: string;
    };
    assert.equal(live.cwd, root);
    assert.equal(worktreeIdForSession(live.sessionId), mainId);
    assert.equal(await deliveredTo, live.sessionId);
  });
});
