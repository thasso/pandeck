/**
 * Session navigation is latest-request-wins.
 *
 * A `loadSession` now attaches SYNCHRONOUSLY — reading a session needs its
 * metadata row and its log, never its harness (`viewSession.ts`) — so a whole
 * class of races is gone by construction: there is no window in which an
 * ordinary navigation is "still loading" and can be overtaken. What remains
 * are the paths that genuinely await something before they view (creating a
 * session, opening the singleton Assistant, the deep link's list read, a
 * delete's blocker check), and those still may not steal the view from a
 * navigation the reader made after them. That is what this file pins, together
 * with the removal transitions (delete/archive) that detach a viewed session.
 *
 *   pnpm --filter @assistant/server test src/sessionViewRace.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "./claudeSdk/sdkSeam.ts";
import { parseServerFrame } from "./test/serverFrames.ts";

const tmp = mkdtempSync(join(tmpdir(), "session-view-race-"));
process.env.ASSISTANT_CWD = tmp;

const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { ClaudeSdkSession } = await import("./test/claudeSdkSession.ts");
const { sessionStore } = await import("./db/sessionStore.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

function fakeSeam(): ClaudeSdkSeam {
  return {
    query: (_p: ClaudeQueryParams) => ({
      async *[Symbol.asyncIterator]() {
        // Never prompted here; only viewed.
        yield* [] as ClaudeSdkMessage[];
      },
    }),
  };
}

/** Minimal open socket: `Connection` only reads `readyState`/`OPEN` and sends. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (frame: string | Buffer) => sent.push(parseServerFrame(frame)),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

/** Each acquisition is answered by the test, in the order the test chooses. */
function controlledAcquisitions() {
  const sessions = new Map<string, InstanceType<typeof ClaudeSdkSession>>();
  const pending: Array<{ id: string; resolve: () => void; done: boolean }> = [];
  const sessionFor = (id: string) => {
    let session = sessions.get(id);
    if (!session) {
      session = new ClaudeSdkSession(id, {
        seam: async () => fakeSeam(),
        agentType: "assistant",
      });
      sessions.set(id, session);
    }
    return session;
  };
  vi.spyOn(hub, "acquireById").mockImplementation(
    (id: string) =>
      new Promise((resolve) => {
        const entry = {
          id,
          done: false,
          resolve: () => {
            entry.done = true;
            resolve(sessionFor(id));
          },
        };
        pending.push(entry);
      }),
  );
  // Reading a session is SYNCHRONOUS (`hub.viewById`): it needs the metadata
  // row and the app-owned log, never the harness. A tombstoned row answers
  // nothing, exactly as the real resolver does.
  vi.spyOn(hub, "viewById").mockImplementation((id: string) =>
    sessionStore.getIncludingDeleted(id)?.deletedAt !== undefined
      ? undefined
      : sessionFor(id),
  );
  return {
    /** Complete the n-th acquisition made so far (0-based), whichever session it was for. */
    complete: async (index: number) => {
      const entry = pending[index];
      if (!entry) throw new Error(`no acquisition #${index}`);
      entry.resolve();
      // Let the handler continue past its await and attach (or not).
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
    /** Complete the latest acquisition of `id`. */
    completeFor: async (id: string) => {
      const index = pending.map((p) => p.id).lastIndexOf(id);
      if (index < 0) throw new Error(`no acquisition of ${id}`);
      const entry = pending[index]!;
      entry.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
    /** Complete everything outstanding, including acquisitions those completions trigger. */
    completeAll: async () => {
      for (let round = 0; round < 10; round += 1) {
        const open = pending.filter((p) => !p.done);
        if (open.length === 0) return;
        for (const entry of open) entry.resolve();
        await settle();
      }
    },
    requested: () => pending.map((p) => p.id),
    session: (id: string) => sessionFor(id),
  };
}

/** Let awaited I/O-free continuations run (several macrotasks' worth). */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

function snapshots(sent: ServerMessage[]): string[] {
  return sent
    .filter(
      (m): m is Extract<ServerMessage, { type: "snapshot" }> =>
        m.type === "snapshot",
    )
    .map((m) => m.snapshot.sessionId);
}

/** Commands route to `id`: a windowed-range request for `other` is ignored. */
async function expectCommandsRouteTo(
  connection: InstanceType<typeof Connection>,
  sent: ServerMessage[],
  id: string,
  other: string,
): Promise<void> {
  sent.length = 0;
  await connection.handle({
    type: "loadTimelineRange",
    sessionId: other,
    beforeSeq: 0,
  } as ClientMessage);
  expect(sent.filter((m) => m.type === "timelineRange")).toEqual([]);
  await connection.handle({
    type: "loadTimelineRange",
    sessionId: id,
    beforeSeq: 0,
  } as ClientMessage);
  expect(
    sent
      .filter((m) => m.type === "timelineRange")
      .map((m) => (m.type === "timelineRange" ? m.sessionId : "")),
  ).toEqual([id]);
}

const A = "session-a";
const B = "session-b";

describe("session view requests", () => {
  test("A→B→A attaches each in turn and ends on A", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    // Handled the way the socket handles them: concurrently, not awaited (a
    // viewed session's post-attach peer-prompt drain keeps its promise open).
    for (const id of [A, B, A])
      void connection.handle({ type: "loadSession", id } as ClientMessage);
    await settle();
    // Each navigation paints when it is made — no acquisition to wait for, so
    // no completion order to get wrong.
    expect(snapshots(sent)).toEqual([A, B, A]);
    expect(acquire.session(B).viewers.size).toBe(0);
    expect(acquire.session(A).viewers.size).toBe(1);

    // Commands route to A: a windowed-range request for B is a stale request
    // and is ignored, while the same request for A is answered.
    sent.length = 0;
    await connection.handle({
      type: "loadTimelineRange",
      sessionId: B,
      beforeSeq: 0,
    } as ClientMessage);
    expect(sent.filter((m) => m.type === "timelineRange")).toEqual([]);
    await connection.handle({
      type: "loadTimelineRange",
      sessionId: A,
      beforeSeq: 0,
    } as ClientMessage);
    expect(
      sent
        .filter((m) => m.type === "timelineRange")
        .map((m) => (m.type === "timelineRange" ? m.sessionId : "")),
    ).toEqual([A]);
  });

  test("opening the Assistant after a load supersedes it", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    void connection.handle({ type: "loadSession", id: A } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([A]);
    // The Assistant is the NEWER intent, and it resolves its singleton
    // asynchronously; it still ends up on show.
    void connection.handle({ type: "openPermanentAssistant" } as ClientMessage);
    await settle();
    await acquire.completeAll();
    expect(snapshots(sent).at(-1)).not.toBe(A);
    expect(acquire.session(A).viewers.size).toBe(0);
  });

  test("a durable-body read that cannot be answered is failed by name", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    controlledAcquisitions();
    void connection.handle({ type: "loadSession", id: A } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([A]);
    sent.length = 0;
    await connection.handle({
      type: "loadTimelineBlock",
      entryId: "no-such-entry",
      blockIndex: 0,
      kind: "thinking",
    } as ClientMessage);
    expect(sent.find((m) => m.type === "timelineBlockFailed")).toEqual({
      type: "timelineBlockFailed",
      sessionId: A,
      entryId: "no-such-entry",
      blockIndex: 0,
      kind: "thinking",
      reason: "unavailable",
      message: "That timeline block is no longer available.",
    });
  });

  test("a load that arrives after the socket closed attaches nothing", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    connection.dispose();
    void connection.handle({ type: "loadSession", id: A } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([]);
    // No ghost: the session has no viewer holding it open (a pi session's
    // idle eviction and read marks both key off that) and no transport.
    expect(acquire.session(A).viewers.size).toBe(0);
    // Nor does anything that reaches `view` directly after disposal.
    void connection.handle({ type: "openPermanentAssistant" } as ClientMessage);
    await settle();
    await acquire.completeAll();
    expect(snapshots(sent)).toEqual([]);
  });

  test("a deep link is viewed and ready sent before a pre-ready load can interleave", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent), { sessionId: A });
    const acquire = controlledAcquisitions();
    // `init` no longer reads the session list (the `sessions` topic subscribe
    // answers it), so nothing yields between the deep link's view and
    // `ready`: a load the client sends next simply moves the view on. Not
    // awaited: `init` also drains peer prompts for the viewed session.
    void connection.init();
    const ready = sent.find(
      (m): m is Extract<ServerMessage, { type: "ready" }> => m.type === "ready",
    );
    expect(ready?.state?.sessionId).toBe(A);
    void connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([A, B]);
    expect(acquire.session(A).viewers.size).toBe(0);
    // Commands route to B.
    sent.length = 0;
    await connection.handle({
      type: "loadTimelineRange",
      sessionId: A,
      beforeSeq: 0,
    } as ClientMessage);
    expect(sent.filter((m) => m.type === "timelineRange")).toEqual([]);
    await connection.handle({
      type: "loadTimelineRange",
      sessionId: B,
      beforeSeq: 0,
    } as ClientMessage);
    expect(sent.filter((m) => m.type === "timelineRange")).toHaveLength(1);
  });

  test("the assistant's snapshot and route message leave together, with no gap a load could use", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    controlledAcquisitions();
    // Publishing pending rows replaced the list read the handler used to
    // await between the acquisition and the view; nothing yields there now.
    void connection.handle({ type: "openPermanentAssistant" } as ClientMessage);
    void connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await settle();
    const opened = sent.findIndex((m) => m.type === "permanentAssistantOpened");
    const snapshot = sent.findIndex((m) => m.type === "snapshot");
    if (opened >= 0)
      expect(snapshots(sent.slice(snapshot, opened + 1))).toHaveLength(1);
    expect(snapshots(sent).at(-1)).toBe(B);
  });

  test("a draft created while a newer load is in flight is not viewed and sends no route message", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    controlledAcquisitions();
    // The draft's creation is held open; the load for B arrives after it.
    let releaseDraft!: () => void;
    const draft = new ClaudeSdkSession("draft-1", {
      seam: async () => fakeSeam(),
    });
    vi.spyOn(piStore, "acquireNew").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDraft = () => resolve(draft as never);
        }),
    );
    void connection.handle({
      type: "createDraftSession",
      agentType: "assistant",
      draftText: "draft this",
    } as ClientMessage);
    await settle();
    void connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([B]);
    // Creation completes LAST: the draft exists, but the newer navigation
    // keeps the view, and no route message tries to move the client to it.
    releaseDraft();
    await settle();
    expect(snapshots(sent)).toEqual([B]);
    expect(sent.some((m) => m.type === "draftSession")).toBe(false);
    expect(draft.viewers.size).toBe(0);
  });

  test("a load after deleting the viewed session attaches normally", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    controlledAcquisitions();
    // The record's kind must match the resident session's, or the delete would
    // not see A as the viewed one.
    sessionStore.upsert({ id: A, harness: "pi", agentType: "assistant" });
    void connection.handle({ type: "loadSession", id: A } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([A]);
    // The delete's blocker check reads the list synchronously, so no load can
    // arrive between the check and the views clearing: the reader is told A
    // went, and the load that follows attaches B.
    void connection.handle({ type: "deleteSession", id: A } as ClientMessage);
    await settle();
    expect(sent.some((m) => m.type === "sessionViewCleared")).toBe(true);
    void connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([A, B]);
  });

  test("a load made just before the viewed session is deleted keeps the view", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    const DELETED = "session-a-deleted-under-load";
    sessionStore.upsert({ id: DELETED, harness: "pi", agentType: "assistant" });
    void connection.handle({
      type: "loadSession",
      id: DELETED,
    } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([DELETED]);
    // The reader clicks B, then deletes the session they left (the client is
    // already on B's route — nothing re-requests B).
    void connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await settle();
    vi.spyOn(hub, "listSessions").mockReturnValue([]);
    void connection.handle({
      type: "deleteSession",
      id: DELETED,
    } as ClientMessage);
    await settle();
    // The deleted session is detached and gone from this connection…
    expect(acquire.session(DELETED).viewers.size).toBe(0);
    // …and B, viewed after it, is untouched.
    expect(snapshots(sent)).toEqual([DELETED, B]);
    expect(acquire.session(B).viewers.size).toBe(1);
    await expectCommandsRouteTo(connection, sent, B, DELETED);
  });

  test("a load made just before the viewed session is archived keeps the view", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    const ARCHIVED = "session-a-archived-under-load";
    sessionStore.upsert({
      id: ARCHIVED,
      harness: "pi",
      agentType: "assistant",
    });
    void connection.handle({
      type: "loadSession",
      id: ARCHIVED,
    } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([ARCHIVED]);
    void connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await settle();
    await connection.handle({
      type: "archiveSession",
      id: ARCHIVED,
      archived: true,
    } as ClientMessage);
    expect(acquire.session(ARCHIVED).viewers.size).toBe(0);
    expect(snapshots(sent)).toEqual([ARCHIVED, B]);
    expect(acquire.session(B).viewers.size).toBe(1);
    await expectCommandsRouteTo(connection, sent, B, ARCHIVED);
  });

  test("a delete refused for background work is no view intent: the load in flight still attaches", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    const BUSY = "session-a-busy";
    sessionStore.upsert({ id: BUSY, harness: "pi", agentType: "assistant" });
    void connection.handle({ type: "loadSession", id: BUSY } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([BUSY]);
    vi.spyOn(hub, "listSessions").mockReturnValue([
      { id: BUSY, backgroundActivity: { activeCount: 1, retainedHost: false } },
    ] as never);
    vi.spyOn(hub, "republishSessionRow").mockReturnValue(undefined);
    await connection.handle({
      type: "deleteSession",
      id: BUSY,
    } as ClientMessage);
    // Refused by name, nothing detached, and the delete claimed nothing.
    expect(
      sent.some(
        (m) => m.type === "error" && /background process/.test(m.message),
      ),
    ).toBe(true);
    expect(sent.some((m) => m.type === "sessionViewCleared")).toBe(false);
    expect(acquire.session(BUSY).viewers.size).toBe(1);
    // A refused delete claims no view intent, so the next navigation works.
    void connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([BUSY, B]);
    expect(acquire.session(BUSY).viewers.size).toBe(0);
    await expectCommandsRouteTo(connection, sent, B, BUSY);
  });

  test("a reload of the viewed session after it is deleted attaches nothing", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    const RELOADED = "session-a-reloaded-then-deleted";
    sessionStore.upsert({
      id: RELOADED,
      harness: "pi",
      agentType: "assistant",
    });
    void connection.handle({
      type: "loadSession",
      id: RELOADED,
    } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([RELOADED]);
    vi.spyOn(hub, "listSessions").mockReturnValue([]);
    void connection.handle({
      type: "deleteSession",
      id: RELOADED,
    } as ClientMessage);
    await settle();
    expect(sent.some((m) => m.type === "sessionViewCleared")).toBe(true);
    // The client's full-snapshot fallback re-requests the SAME session after
    // the delete: there is nothing to show, and nothing is shown.
    void connection.handle({
      type: "loadSession",
      id: RELOADED,
    } as ClientMessage);
    await settle();
    // No ghost viewer on the evicted driver, no second snapshot.
    expect(snapshots(sent)).toEqual([RELOADED]);
    expect(acquire.session(RELOADED).viewers.size).toBe(0);
  });

  test("a reload of an archived session is a deliberate open and attaches", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    const RELOADED = "session-a-reloaded-then-archived";
    sessionStore.upsert({
      id: RELOADED,
      harness: "pi",
      agentType: "assistant",
    });
    void connection.handle({
      type: "loadSession",
      id: RELOADED,
    } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([RELOADED]);
    // The reader archives the session they are looking at (the client moves to
    // the new-session route).
    await connection.handle({
      type: "archiveSession",
      id: RELOADED,
      archived: true,
    } as ClientMessage);
    expect(sent.some((m) => m.type === "sessionViewCleared")).toBe(true);
    expect(sessionStore.get(RELOADED)?.archivedAt).toBeDefined();
    // The archive stands: the view is gone and commands for it are stale.
    expect(acquire.session(RELOADED).viewers.size).toBe(0);
    sent.length = 0;
    await connection.handle({
      type: "loadTimelineRange",
      sessionId: RELOADED,
      beforeSeq: 0,
    } as ClientMessage);
    expect(sent.filter((m) => m.type === "timelineRange")).toEqual([]);
    // A later, deliberate open of the archived session is a new intent and works.
    void connection.handle({
      type: "loadSession",
      id: RELOADED,
    } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([RELOADED]);
  });

  test("deleting a session this connection is not viewing leaves its view alone", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    const GONE = "session-a-deleted-while-loading";
    sessionStore.upsert({ id: GONE, harness: "pi", agentType: "assistant" });
    void connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([B]);
    // Another session is deleted from the list while B is on show: every
    // connection is told (a client whose route named it must leave), and B is
    // untouched.
    vi.spyOn(hub, "listSessions").mockReturnValue([]);
    await connection.handle({
      type: "deleteSession",
      id: GONE,
    } as ClientMessage);
    expect(acquire.session(B).viewers.size).toBe(1);
    // The deleted session cannot be opened afterwards.
    void connection.handle({ type: "loadSession", id: GONE } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([B]);
    expect(acquire.session(GONE).viewers.size).toBe(0);
    await expectCommandsRouteTo(connection, sent, B, GONE);
  });

  test("deleting a session detaches every connection viewing it, including one that attached during the blocker check", async () => {
    const sentA: ServerMessage[] = [];
    const sentB: ServerMessage[] = [];
    const sentC: ServerMessage[] = [];
    const deleter = new Connection(fakeSocket(sentA));
    const viewer = new Connection(fakeSocket(sentB));
    const late = new Connection(fakeSocket(sentC));
    for (const c of [deleter, viewer, late]) hub.register(c);
    const acquire = controlledAcquisitions();
    const SHARED = "session-a-shared-then-deleted";
    sessionStore.upsert({
      id: SHARED,
      harness: "pi",
      agentType: "assistant",
    });
    try {
      // Three browsers show the session when the delete arrives.
      for (const c of [deleter, viewer, late])
        void c.handle({ type: "loadSession", id: SHARED } as ClientMessage);
      await settle();
      expect(acquire.session(SHARED).viewers.size).toBe(3);
      await deleter.handle({
        type: "deleteSession",
        id: SHARED,
      } as ClientMessage);
      // Every viewer left in the same run as the tombstone and eviction, and
      // each client was told so — the deleter as well as the others.
      expect(acquire.session(SHARED).viewers.size).toBe(0);
      for (const sent of [sentA, sentB, sentC])
        expect(sent.filter((m) => m.type === "sessionViewCleared")).toEqual([
          { type: "sessionViewCleared", sessionId: SHARED, reason: "deleted" },
        ]);
      expect(sessionStore.get(SHARED)).toBeUndefined();
      // Nothing routes into the disposed driver any more, from any of them…
      for (const [c, sent] of [
        [deleter, sentA],
        [viewer, sentB],
        [late, sentC],
      ] as const) {
        sent.length = 0;
        await c.handle({
          type: "loadTimelineRange",
          sessionId: SHARED,
          beforeSeq: 0,
        } as ClientMessage);
        expect(sent.filter((m) => m.type === "timelineRange")).toEqual([]);
      }
      // …and each is free to view something else.
      void viewer.handle({ type: "loadSession", id: B } as ClientMessage);
      await settle();
      expect(snapshots(sentB)).toEqual([B]);
    } finally {
      for (const c of [deleter, viewer, late]) hub.unregister(c);
    }
  });

  test("deleting a session another connection is viewing detaches it and tells its client", async () => {
    const sentA: ServerMessage[] = [];
    const sentB: ServerMessage[] = [];
    const deleter = new Connection(fakeSocket(sentA));
    const loader = new Connection(fakeSocket(sentB));
    for (const c of [deleter, loader]) hub.register(c);
    const acquire = controlledAcquisitions();
    const PENDING = "session-a-deleted-while-another-loads";
    sessionStore.upsert({
      id: PENDING,
      harness: "pi",
      agentType: "assistant",
    });
    try {
      void loader.handle({ type: "loadSession", id: PENDING } as ClientMessage);
      await settle();
      // The deleter (viewing nothing) removes the session the other browser
      // is reading.
      vi.spyOn(hub, "listSessions").mockReturnValue([]);
      await deleter.handle({
        type: "deleteSession",
        id: PENDING,
      } as ClientMessage);
      // Its route names a session that is gone: told, and detached.
      expect(sentB.filter((m) => m.type === "sessionViewCleared")).toEqual([
        { type: "sessionViewCleared", sessionId: PENDING, reason: "deleted" },
      ]);
      expect(acquire.session(PENDING).viewers.size).toBe(0);
      // It is free to view something else, and commands follow.
      void loader.handle({ type: "loadSession", id: B } as ClientMessage);
      await settle();
      expect(acquire.session(B).viewers.size).toBe(1);
      await expectCommandsRouteTo(loader, sentB, B, PENDING);
    } finally {
      for (const c of [deleter, loader]) hub.unregister(c);
    }
  });

  test("archiving the viewed session detaches it; a later deliberate open still works", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const acquire = controlledAcquisitions();
    const COLD = "session-a-archived-while-loading";
    sessionStore.upsert({ id: COLD, harness: "pi", agentType: "assistant" });
    void connection.handle({ type: "loadSession", id: COLD } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([COLD]);
    await connection.handle({
      type: "archiveSession",
      id: COLD,
      archived: true,
    } as ClientMessage);
    expect(sessionStore.get(COLD)?.archivedAt).toBeDefined();
    // The view is cleared and the client told, so its route can leave.
    expect(sent.filter((m) => m.type === "sessionViewCleared")).toEqual([
      { type: "sessionViewCleared", sessionId: COLD, reason: "archived" },
    ]);
    expect(acquire.session(COLD).viewers.size).toBe(0);
    // Archiving a session that is NOT on show disturbs nothing.
    const OTHER = "session-archive-bystander";
    void connection.handle({ type: "loadSession", id: OTHER } as ClientMessage);
    await settle();
    await connection.handle({
      type: "archiveSession",
      id: COLD,
      archived: true,
    } as ClientMessage);
    expect(snapshots(sent)).toEqual([COLD, OTHER]);
    expect(acquire.session(OTHER).viewers.size).toBe(1);
    // Opening the archived session on purpose is a new intent that attaches.
    void connection.handle({ type: "loadSession", id: COLD } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([COLD, OTHER, COLD]);
    expect(acquire.session(COLD).viewers.size).toBe(1);
  });

  test("ready describes the session viewed when it is sent, not when it was begun", async () => {
    const sent: ServerMessage[] = [];
    const DEEP = "session-deep-linked";
    const connection = new Connection(fakeSocket(sent), { sessionId: DEEP });
    controlledAcquisitions();
    // `ready` reads nothing that yields since the list left it, so the view
    // it describes is the one attached in the same run.
    void connection.init();
    await settle();
    void connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await settle();
    expect(snapshots(sent)).toEqual([DEEP, B]);
    const ready = sent.find(
      (m): m is Extract<ServerMessage, { type: "ready" }> => m.type === "ready",
    );
    // State and context are ONE capture, of the session the client holds.
    expect(ready?.state?.sessionId).toBe(DEEP);
    expect(ready?.contextInfo?.sessionId).toBe(DEEP);
    expect(sent.indexOf(ready!)).toBeLessThan(
      sent.findIndex(
        (m) => m.type === "snapshot" && m.snapshot.sessionId === B,
      ),
    );
  });
});
