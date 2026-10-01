/**
 * Ownership of an acquired pi session that nobody ends up viewing.
 *   pnpm --filter @assistant/server test src/piSdk/piOwnership.test.ts
 *
 * A session is acquired asynchronously for a view request that may already be
 * superseded (a rapid A→B→A) or belong to a socket that has closed by the time
 * the reopen completes. Nothing then ever adds a viewer, so nothing ever
 * removed one — and only a viewer's departure used to arm the idle clock. Such
 * a session stayed resident, with its subscriptions, for the process lifetime.
 * Two concurrent reopens of one session used to open it twice as well, with
 * the second registration overwriting the first wrapper in the live map.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pi-ownership-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { PiSessionDeletedError, piStore } = await import("./piStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());

const IDLE_EVICT_MS = 5 * 60_000;

function fakeAgentSession(sessionId: string) {
  return {
    sessionId,
    sessionName: "Already named",
    isStreaming: false,
    sessionManager: { getBranch: () => [] },
    subscribe: () => () => {},
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextSize: 0,
    }),
    steer: () => Promise.resolve(),
    prompt: () => Promise.resolve(),
    dispose: () => {},
  };
}

function host() {
  return {
    broadcastSessions: () => Promise.resolve(),
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    browserRuntimesFor: () => [],
  };
}

test("a registered session nobody views idles out like one a viewer left", () => {
  vi.useFakeTimers();
  const evicted: string[] = [];
  const onEvict = (key: string) => {
    evicted.push(key);
  };
  const live = new PiLiveSession(
    "coding" as never,
    fakeAgentSession("pi-unviewed") as never,
    host() as never,
    onEvict,
  );
  // What the store does on registration (`track`).
  live.armIdleIfUnviewed();
  vi.advanceTimersByTime(IDLE_EVICT_MS - 1);
  assert.deepEqual(evicted, []);
  vi.advanceTimersByTime(1);
  assert.deepEqual(evicted, ["pi-unviewed"], "evicted once, by key");

  // A viewer arriving in time cancels the clock; leaving re-arms it.
  const watched = new PiLiveSession(
    "coding" as never,
    fakeAgentSession("pi-watched") as never,
    host() as never,
    onEvict,
  );
  watched.armIdleIfUnviewed();
  vi.advanceTimersByTime(IDLE_EVICT_MS / 2);
  const viewer = { send: () => {} };
  watched.addViewer(viewer);
  vi.advanceTimersByTime(IDLE_EVICT_MS * 2);
  assert.deepEqual(evicted, ["pi-unviewed"], "a viewed session stays");
  watched.removeViewer(viewer);
  vi.advanceTimersByTime(IDLE_EVICT_MS);
  assert.deepEqual(evicted, ["pi-unviewed", "pi-watched"]);
});

interface StoreInternals {
  create: (...args: unknown[]) => Promise<{ session: unknown; notices: [] }>;
  track: (
    kind: string,
    session: { sessionId: string; sessionFile?: string },
    notices: unknown[],
    cwd: string,
  ) => unknown;
  live: Map<string, unknown>;
  opening: Map<string, Promise<unknown>>;
  toolRuntimes: Map<string, { dispose: () => void }>;
  sessionModes: Map<string, string>;
}

/** A transcript on disk for `id`, as a cold reopen finds it. */
async function writeTranscript(id: string): Promise<string> {
  const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: new Date().toISOString(),
      cwd: tmp,
    })}\n`,
  );
  return file;
}

test("concurrent reopens of one session share a single open and registration", async () => {
  const internals = piStore as unknown as StoreInternals;
  const originalCreate = internals.create;
  const originalTrack = internals.track;
  let creates = 0;
  let tracks = 0;
  let releaseOpen!: () => void;
  const opened = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const wrappers: unknown[] = [];
  internals.create = async (...args: unknown[]) => {
    creates += 1;
    await opened;
    const manager = args[1] as {
      getSessionId(): string;
      getSessionFile(): string | undefined;
    };
    return {
      session: {
        sessionId: manager.getSessionId(),
        sessionFile: manager.getSessionFile(),
        sessionManager: manager,
      },
      notices: [],
    };
  };
  internals.track = (kind, session) => {
    tracks += 1;
    // What the live-map lookup reads of a registered session.
    const wrapper = {
      kind,
      key: session.sessionId,
      sessionId: session.sessionId,
      session,
      // Reusing a resident session restarts its idle clock.
      armIdleIfUnviewed: () => {},
    };
    wrappers.push(wrapper);
    internals.live.set(session.sessionId, wrapper);
    return wrapper;
  };
  try {
    const id = "pi-reopen-twice";
    const file = await writeTranscript(id);
    const first = piStore.acquireExisting("coding" as never, file, id);
    const second = piStore.acquireExisting("coding" as never, file, id);
    releaseOpen();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(creates, 1, "one open");
    assert.equal(tracks, 1, "one registration");
    assert.equal(a, b, "both callers hold the same wrapper");
    assert.equal(wrappers.length, 1);
    // And a later acquisition finds it resident rather than reopening.
    const third = await piStore.acquireExisting("coding" as never, file, id);
    assert.equal(third, a);
    assert.equal(creates, 1);
  } finally {
    internals.create = originalCreate;
    internals.track = originalTrack;
    internals.live.delete("pi-reopen-twice");
  }
});

test("a reopen the delete beat to registration registers nothing, disposes what it built, and refuses every sharer", async () => {
  const internals = piStore as unknown as StoreInternals;
  const originalCreate = internals.create;
  const originalTrack = internals.track;
  let releaseOpen!: () => void;
  const opened = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  let creates = 0;
  let tracks = 0;
  const disposed: string[] = [];
  internals.create = async (...args: unknown[]) => {
    creates += 1;
    if (creates === 1) await opened;
    const manager = args[1] as {
      getSessionId(): string;
      getSessionFile(): string | undefined;
    };
    const sessionId = manager.getSessionId();
    // What `create` leaves behind for the session it built, before `track`.
    internals.toolRuntimes.set(sessionId, {
      dispose: () => disposed.push(`runtime:${sessionId}`),
    });
    internals.sessionModes.set(sessionId, "build");
    return {
      session: {
        sessionId,
        sessionFile: manager.getSessionFile(),
        sessionManager: manager,
        dispose: () => disposed.push(`session:${sessionId}`),
      },
      notices: [],
    };
  };
  internals.track = (kind, session) => {
    tracks += 1;
    const wrapper = { kind, key: session.sessionId, session };
    internals.live.set(session.sessionId, wrapper);
    return wrapper;
  };
  const id = "pi-deleted-while-opening";
  const other = "pi-opened-after-a-delete";
  try {
    const file = await writeTranscript(id);
    sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
    // Two owners share the one cold open (a load and, say, a comment handoff).
    const load = piStore.acquireExisting("developer" as never, file, id);
    const handoff = piStore.acquireExisting("developer" as never, file, id);
    // The delete wins while the transcript is opening: it tombstones the
    // record and evicts — which finds nothing, since nothing is registered yet.
    sessionStore.remove(id);
    piStore.evict(id);
    releaseOpen();
    await assert.rejects(load, PiSessionDeletedError);
    await assert.rejects(handoff, PiSessionDeletedError);
    assert.equal(creates, 1, "one open");
    assert.equal(tracks, 0, "never registered");
    assert.equal(internals.live.has(id), false);
    assert.equal(piStore.getLiveById(id), undefined);
    // What was built is torn down at once, not left for idle eviction.
    assert.deepEqual(disposed, [`runtime:${id}`, `session:${id}`]);
    assert.equal(internals.toolRuntimes.has(id), false);
    assert.equal(internals.sessionModes.has(id), false);
    // The in-flight slot is released exactly once: a later acquisition of the
    // id opens afresh (and is refused again — the session is gone), while a
    // session that exists opens and registers as ever.
    assert.equal(internals.opening.size, 0);
    await assert.rejects(
      piStore.acquireExisting("developer" as never, file, id),
      PiSessionDeletedError,
    );
    assert.equal(creates, 2);
    assert.equal(tracks, 0);
    const otherFile = await writeTranscript(other);
    sessionStore.upsert({ id: other, harness: "pi", agentType: "developer" });
    const live = await piStore.acquireExisting(
      "developer" as never,
      otherFile,
      other,
    );
    assert.equal(tracks, 1);
    assert.equal(internals.live.get(other), live);
  } finally {
    internals.create = originalCreate;
    internals.track = originalTrack;
    internals.live.delete(id);
    internals.live.delete(other);
  }
});
