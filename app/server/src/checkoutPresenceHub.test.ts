/**
 * A presence answer that changes reaches every reader of it with no further
 * read (W3d AC3): the session list on a real connection, a viewer showing a
 * session DETACHED, and a resident engine's state. Quiescence is the presence
 * pump drained and the hub's own pending broadcast awaited, bounded: no sleep.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "presence-hub-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
process.env.ASSISTANT_BACKGROUND_FETCH = "0";
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

const { hub } = await import("./hub.ts");
const { Connection } = await import("./connection.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { harnessRegistry } = await import("./harnesses/registry.ts");
const { projectStore } = await import("./db/projectStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { insertWorktree, linkSessionToWorktree } =
  await import("./db/worktreeStore.ts");
const { flushPresenceForTests, presenceCountsForTests, resetPresenceForTests } =
  await import("./worktrees/checkoutPresence.ts");
const { checkWorktreeCheckout } = await import("./worktrees/sessionCwd.ts");
const { recordServedForTests } = await import("./test/workerAnswers.ts");
const { FILE_METHODS } = await import("./workerProtocol/fileMethods.ts");
const { clearMainRepoCache, mainWorktreeId, resolveWorktreeRow } =
  await import("./worktrees/worktreeResolve.ts");

const claudeProfile = createCredentialProfile({
  name: "Presence hub",
  provider: "claude",
});
let serial = 0;

function sh(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
  });
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

/** A registered project over `paths`; answers its main worktree id. */
function mainOf(paths: string[]): string {
  const id = `hp-${++serial}`;
  projectStore.put({
    id,
    name: id,
    key: id.toUpperCase(),
    description: "",
    status: "active",
    localPaths: paths.map((path) => ({ path, kind: "repo", match: "prefix" })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Parameters<typeof projectStore.put>[0]);
  return mainWorktreeId(id);
}

function spawnedRow(): { id: string; path: string } {
  const id = `hw-${++serial}`;
  const path = fresh("row");
  mkdirSync(path, { recursive: true });
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

function session(worktreeId: string, harness: "pi" | "claude-sdk" = "pi") {
  const id = `hs-${++serial}`;
  sessionStore.upsert({
    id,
    harness,
    agentType: "developer",
    title: id,
    updatedAt: Date.now(),
    messageCount: 1,
  } as Parameters<typeof sessionStore.upsert>[0]);
  linkSessionToWorktree(id, worktreeId);
  return id;
}

type Message = {
  type: string;
  sessions?: Array<{ id: string; worktreeMissing?: boolean }>;
  session?: { id: string; worktreeMissing?: boolean };
  state?: { worktreeMissing?: boolean };
};

const open: Array<{ dispose?: () => void }> = [];

/** A real connection, registered with the hub, recording what it is sent. */
async function connect() {
  const sent: Message[] = [];
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )({
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s) as Message),
  }) as unknown as {
    init: () => Promise<void>;
    dispatch: (msg: unknown) => Promise<void>;
    dispose?: () => void;
  };
  await conn.init();
  open.push(conn);
  return { conn, sent };
}

/** The flag the latest list traffic shows for `sessionId`. */
function listed(sent: Message[], sessionId: string): boolean | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    const message = sent[i]!;
    const row =
      message.type === "sessionUpdated"
        ? message.session?.id === sessionId
          ? message.session
          : undefined
        : message.type === "sessions"
          ? message.sessions?.find((s) => s.id === sessionId)
          : undefined;
    if (row) return !!row.worktreeMissing;
  }
  return undefined;
}

/** The flag in the latest state a viewer was sent (snapshot or state frame). */
function shown(sent: Message[]): boolean | undefined {
  const state = sent.findLast(
    (message) =>
      (message.type === "state" || message.type === "snapshot") &&
      !!message.state,
  );
  return state ? !!state.state?.worktreeMissing : undefined;
}

const pending = hub as unknown as {
  sessionsBroadcastPromise: Promise<void> | undefined;
};

/**
 * Drains probes and the broadcasts they cause until neither is pending;
 * answers the rounds it took. Unbounded traffic fails it.
 */
async function quiescent(): Promise<number> {
  for (let round = 1; round <= 10; round++) {
    await flushPresenceForTests();
    const broadcast = pending.sessionsBroadcastPromise;
    if (!broadcast) return round;
    await broadcast;
  }
  return assert.fail("presence and list traffic did not settle");
}

/** After quiescence nothing more is probed or sent. */
async function assertSettled(...feeds: Message[][]): Promise<void> {
  const probes = presenceCountsForTests().probesIssued;
  const lengths = feeds.map((feed) => feed.length);
  const served = recordServedForTests([FILE_METHODS.exists]);
  assert.equal(await quiescent(), 1);
  served.stop();
  assert.deepEqual(served.served, [], "no files.exists served");
  assert.equal(presenceCountsForTests().probesIssued, probes, "no loop");
  assert.deepEqual(
    feeds.map((feed) => feed.length),
    lengths,
    "no further traffic",
  );
}

beforeEach(async () => {
  await quiescent();
  clearMainRepoCache();
  resetPresenceForTests();
});
afterEach(async () => {
  for (const conn of open.splice(0)) conn.dispose?.();
  vi.restoreAllMocks();
  await quiescent();
});

describe("a changed presence answer reaches its readers unasked (AC3)", () => {
  test("a spawned checkout deleted then recreated: the list, a detached viewer and a resident engine follow", async () => {
    const row = spawnedRow();
    const listedId = session(row.id);
    const viewedId = session(row.id);
    const residentId = session(row.id, "claude-sdk");
    await checkWorktreeCheckout(row.id);
    const resident = claudeSdkStore.acquire(
      residentId,
      { agentType: "developer", credentialProfileId: claudeProfile.id },
      await checkWorktreeCheckout(row.id),
    );
    const residentState = vi.spyOn(resident, "broadcastState");
    const residents = harnessRegistry.resident().map((s) => s.sessionId);

    const list = await connect();
    const viewer = await connect();
    await viewer.conn.dispatch({ type: "loadSession", id: viewedId });
    assert.equal(shown(viewer.sent), false);
    // No probe may be in flight across the change: a read coalesces onto one.
    await quiescent();
    rmSync(row.path, { recursive: true });
    // The ONE read: answered from the stale cache, it refreshes the entry.
    await list.conn.dispatch({ type: "listSessions" });
    assert.equal(listed(list.sent, listedId), false, "stale until the probe");

    await quiescent();
    assert.equal(listed(list.sent, listedId), true);
    assert.equal(shown(viewer.sent), true, "the detached viewer re-sent state");
    assert.ok(residentState.mock.calls.length > 0, "resident state re-sent");
    await assertSettled(list.sent, viewer.sent);

    // Recreated: the next read refreshes the absent answer back.
    await quiescent();
    mkdirSync(row.path);
    residentState.mockClear();
    await list.conn.dispatch({ type: "listSessions" });
    await quiescent();
    assert.equal(listed(list.sent, listedId), false);
    assert.equal(shown(viewer.sent), false);
    assert.ok(residentState.mock.calls.length > 0);
    await assertSettled(list.sent, viewer.sent);
    assert.deepEqual(
      harnessRegistry.resident().map((s) => s.sessionId),
      residents,
      "no harness opened for a reader",
    );
  });

  test("a resolved main's root deleted: the list converges to missing", async () => {
    const repo = fresh("main-root");
    initRepo(repo);
    const mainId = mainOf([repo]);
    await resolveWorktreeRow(mainId);
    await checkWorktreeCheckout(mainId);
    const listedId = session(mainId);
    const viewedId = session(mainId);
    const list = await connect();
    const viewer = await connect();
    await viewer.conn.dispatch({ type: "loadSession", id: viewedId });
    assert.equal(shown(viewer.sent), false);
    // No probe may be in flight across the change: a read coalesces onto one.
    await quiescent();
    rmSync(repo, { recursive: true });
    await list.conn.dispatch({ type: "listSessions" });
    await quiescent();
    assert.equal(listed(list.sent, listedId), true);
    assert.equal(shown(viewer.sent), true);
    await assertSettled(list.sent, viewer.sent);
  });

  test("a cold main whose local paths are all absent converges from unknown to missing", async () => {
    const mainId = mainOf([fresh("never-a"), fresh("never-b")]);
    const listedId = session(mainId);
    const viewedId = session(mainId);
    const list = await connect();
    const viewer = await connect();
    await viewer.conn.dispatch({ type: "loadSession", id: viewedId });
    await list.conn.dispatch({ type: "listSessions" });
    assert.equal(listed(list.sent, listedId), false, "unknown is not missing");
    assert.equal(shown(viewer.sent), false);

    await quiescent();
    assert.equal(listed(list.sent, listedId), true);
    assert.equal(shown(viewer.sent), true);
    await assertSettled(list.sent, viewer.sent);
  });

  test("worktree watch events are no presence oracle", () => {
    for (const file of [
      "worktrees/checkoutPresence.ts",
      "worktrees/sessionCwd.ts",
      "worktrees/worktreeResolve.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.doesNotMatch(
        source,
        /from "[^"]*(worktreeWatcher|watchClient|worktreeEvents|watchDeliveries)[^"]*"/,
        file,
      );
    }
  });
});
