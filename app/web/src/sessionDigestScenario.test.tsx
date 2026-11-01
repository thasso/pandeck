// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  SessionListItem,
  StateDigestEntry,
} from "@assistant/shared";
import {
  createInitialState,
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";
import {
  readAppShellCacheRecord,
  writeAppShellCacheRecord,
} from "./lib/appShellCacheStore.ts";
import { STATE_ITEMS_TIMEOUT_MS } from "./lib/stateReplica.ts";

/**
 * The `sessions` digest resync through the real hook and socket
 * (`docs/state-sync.md`, Adopted domains → Sessions): a reconnect or warm start
 * asks for `{id, revision}` and fetches only what moved, falls back to the
 * snapshot when it cannot trust the answer, and the shell cache keeps a
 * revision only for the rows that were at rest when saved.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class ScenarioSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: ScenarioSocket[] = [];
  readyState = ScenarioSocket.CONNECTING;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    ScenarioSocket.instances.push(this);
  }
  open() {
    this.readyState = ScenarioSocket.OPEN;
    this.onopen?.();
  }
  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  send(source: string) {
    this.sent.push(JSON.parse(source) as ClientMessage);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: {
      sessionId: "s1",
      harness: "pi",
      agentType: "assistant",
      thinkingLevel: "off",
    },
    models: [],
    agents: [],
    settings: {},
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  };
}

let latestActions: AssistantActions;
let latestState: UIState;

function Harness() {
  const { actions, state } = useAssistant();
  latestActions = actions;
  latestState = state;
  return null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  ScenarioSocket.instances = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("WebSocket", ScenarioSocket);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A row as the server sends it for a session with nothing live. */
const row = (
  id: string,
  updatedAt: number,
  extra: Partial<SessionListItem> = {},
): SessionListItem => ({
  id,
  harness: "pi",
  agentType: "assistant",
  title: id,
  createdAt: 0,
  updatedAt,
  messageCount: 2,
  isStreaming: false,
  awaitingInput: false,
  unread: false,
  ...extra,
});

const at = (id: string, revision: number): StateDigestEntry => ({
  id,
  revision,
});

function snapshot(
  rows: SessionListItem[],
  revisions: StateDigestEntry[] = rows.map(({ id }) => at(id, 1)),
  archivedSessionCount = 0,
): ServerMessage {
  return {
    type: "sessionList",
    seq: 0,
    sessions: rows,
    revisions,
    archivedSessionCount,
  };
}

function digest(entries: StateDigestEntry[], seq = 0): ServerMessage {
  return { type: "stateDigest", topic: "sessions", seq, entries };
}

const sessionSubscribes = (socket: ScenarioSocket) =>
  socket.sent.filter(
    (message): message is Extract<ClientMessage, { type: "subscribe" }> =>
      message.type === "subscribe" && message.topics.includes("sessions"),
  );
const sessionUnsubscribes = (socket: ScenarioSocket) =>
  socket.sent.filter(
    (message) =>
      message.type === "unsubscribe" && message.topics.includes("sessions"),
  );
const itemFetches = (socket: ScenarioSocket) =>
  socket.sent.filter(
    (message): message is Extract<ClientMessage, { type: "getStateItems" }> =>
      message.type === "getStateItems" && message.topic === "sessions",
  );

async function boot(): Promise<ScenarioSocket> {
  await act(async () => root.render(<Harness />));
  const socket = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => latestActions.setTopics(["sessions"]));
  return socket;
}

async function reconnect(socket: ScenarioSocket): Promise<ScenarioSocket> {
  await act(async () => socket.close());
  expect(latestState.sessionListFresh).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  const next = ScenarioSocket.instances.at(-1)!;
  expect(next).not.toBe(socket);
  await act(async () => {
    next.open();
    next.receive(readyMessage());
  });
  return next;
}

const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => row(`r${i}`, 100 - i));

it("a reconnect catches up only the changed and new rows, keeping the rest by identity (W1, AC8)", async () => {
  const socket = await boot();
  const held = rows(10);
  await act(async () => socket.receive(snapshot(held)));
  const before = new Map(latestState.liveSessions.map((r) => [r.id, r]));
  const next = await reconnect(socket);

  // One subscribe asking the digest; no snapshot requested.
  const subscribes = sessionSubscribes(next);
  expect(subscribes).toHaveLength(1);
  expect(subscribes[0]!.digests).toEqual(["sessions"]);
  expect(sessionUnsubscribes(next)).toHaveLength(0);

  // r2, r3 moved; r9 was archived or deleted meanwhile; n1 is new.
  const entries = [
    ...held
      .slice(0, 9)
      .map(({ id }) => at(id, id === "r2" || id === "r3" ? 2 : 1)),
    at("n1", 4),
  ];
  await act(async () => next.receive(digest(entries)));
  const fetches = itemFetches(next);
  expect(fetches).toHaveLength(1);
  expect(fetches[0]!.ids).toEqual(["r2", "r3", "n1"]);
  // The digest pruned r9 and kept every unchanged row by identity.
  expect(latestState.liveSessions.map((r) => r.id)).not.toContain("r9");
  for (const id of ["r0", "r1", "r4", "r5", "r6", "r7", "r8"])
    expect(latestState.liveSessions.find((r) => r.id === id)).toBe(
      before.get(id),
    );
  expect(latestState.sessionListFresh).toBe(false);

  await act(async () =>
    next.receive({
      type: "stateItems",
      topic: "sessions",
      requestId: fetches[0]!.requestId,
      events: [
        {
          kind: "upsert",
          id: "r2",
          revision: 2,
          item: row("r2", 98, { title: "R2!" }),
        },
        {
          kind: "upsert",
          id: "r3",
          revision: 2,
          item: row("r3", 97, { unread: true }),
        },
        { kind: "upsert", id: "n1", revision: 4, item: row("n1", 200) },
      ],
    }),
  );
  expect(latestState.sessionListFresh).toBe(true);
  expect(latestState.liveSessions.map((r) => r.id)).toEqual([
    "n1",
    ...held.slice(0, 9).map(({ id }) => id),
  ]);
  expect(latestState.liveSessions.find((r) => r.id === "r2")?.title).toBe(
    "R2!",
  );
  expect(latestState.stateEventRevisions.sessions).toMatchObject({
    r2: 2,
    r3: 2,
    n1: 4,
    r0: 1,
  });
  expect(latestState.stateEventRevisions.sessions).not.toHaveProperty("r9");
  // Nothing else travelled: no snapshot, no resubscribe.
  expect(sessionSubscribes(next)).toHaveLength(1);
  expect(sessionUnsubscribes(next)).toHaveLength(0);
});

it("after a server restart the digest names every row and catch-up re-reads them all (W1, AC9)", async () => {
  const socket = await boot();
  const held = rows(5);
  await act(async () => socket.receive(snapshot(held)));
  const next = await reconnect(socket);
  await act(async () => next.receive(digest(held.map(({ id }) => at(id, 7)))));
  const [fetch] = itemFetches(next);
  expect(fetch?.ids).toEqual(held.map(({ id }) => id));
  await act(async () =>
    next.receive({
      type: "stateItems",
      topic: "sessions",
      requestId: fetch!.requestId,
      events: held.map((item) => ({
        kind: "upsert" as const,
        id: item.id,
        revision: 7,
        item,
      })),
    }),
  );
  expect(latestState.sessionListFresh).toBe(true);
  // Value-equal rows keep identity even when re-read.
  expect(latestState.liveSessions[0]).toBe(
    latestState.liveSessions.find((r) => r.id === "r0"),
  );
});

it("a digest with no changes fetches nothing and is fresh at once (W2)", async () => {
  const socket = await boot();
  const held = rows(4);
  await act(async () => socket.receive(snapshot(held)));
  const live = latestState.liveSessions;
  const next = await reconnect(socket);
  await act(async () => next.receive(digest(held.map(({ id }) => at(id, 1)))));
  expect(itemFetches(next)).toHaveLength(0);
  expect(latestState.sessionListFresh).toBe(true);
  expect(latestState.liveSessions).toBe(live);
});

const fallbackCases: Array<
  [
    string,
    (
      next: ScenarioSocket,
      fetch: Extract<ClientMessage, { type: "getStateItems" }> | undefined,
    ) => Promise<void>,
    string,
  ]
> = [
  [
    "an invalid digest",
    async () => {},
    "[state-sync] sessions digest fallback: cached objects or revisions were invalid",
  ],
  [
    "a catch-up answer missing an id",
    async (next, fetch) =>
      act(async () =>
        next.receive({
          type: "stateItems",
          topic: "sessions",
          requestId: fetch!.requestId,
          events: [],
        }),
      ),
    "[state-sync] sessions digest fallback: targeted item response was incomplete",
  ],
  [
    "a catch-up error",
    async (next, fetch) =>
      act(async () =>
        next.receive({
          type: "error",
          requestId: fetch!.requestId,
          message: "Failed to fetch Session state items: boom",
        }),
      ),
    "[state-sync] sessions digest fallback: Failed to fetch Session state items: boom",
  ],
  [
    "a catch-up timeout",
    async () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(STATE_ITEMS_TIMEOUT_MS);
      }),
    "[state-sync] sessions digest fallback: targeted item fetch timed out",
  ],
];
for (const [label, fail, warning] of fallbackCases)
  it(`${label} falls back to one snapshot resubscribe (W4)`, async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await boot();
    const held = rows(3);
    await act(async () => socket.receive(snapshot(held)));
    const next = await reconnect(socket);
    const mark = next.sent.length;
    const entries =
      label === "an invalid digest"
        ? [at("r0", 1), at("r0", 2)]
        : [at("r0", 1), at("r1", 2), at("r2", 1)];
    await act(async () => next.receive(digest(entries)));
    await fail(next, itemFetches(next)[0]);
    expect(warn).toHaveBeenCalledWith(warning);
    const after = next.sent
      .slice(mark)
      .filter((m) => m.type !== "getStateItems");
    expect(after).toEqual([
      { type: "unsubscribe", topics: ["sessions"] },
      { type: "subscribe", topics: ["sessions"] },
    ]);
    expect(latestState.sessionListFresh).toBe(false);
    await act(async () =>
      next.receive(
        snapshot(
          held,
          held.map(({ id }) => at(id, 2)),
        ),
      ),
    );
    expect(latestState.sessionListFresh).toBe(true);
    // One fallback pair, no loop.
    expect(sessionSubscribes(next)).toHaveLength(2);
  });

it("a pending session mutation at reconnect takes the snapshot, which its resync joins (W5)", async () => {
  const socket = await boot();
  const held = rows(2);
  await act(async () => socket.receive(snapshot(held)));
  await act(async () => latestActions.renameSession("r0", "Renamed"));
  const next = await reconnect(socket);
  const subscribes = sessionSubscribes(next);
  expect(subscribes).toHaveLength(1);
  expect(subscribes[0]!.digests).toBeUndefined();
  // The rename times out unanswered: its resync joins the awaited snapshot.
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(sessionSubscribes(next)).toHaveLength(1);
  expect(sessionUnsubscribes(next)).toHaveLength(0);
  await act(async () =>
    next.receive(
      snapshot(
        held,
        held.map(({ id }) => at(id, 2)),
      ),
    ),
  );
  expect(latestState.sessionListFresh).toBe(true);
  expect(latestState.liveSessions.find((r) => r.id === "r0")?.title).toBe("r0");
});

it("a topic due a snapshot after a resync asks no digest on reconnect (W5)", async () => {
  const socket = await boot();
  const held = rows(2);
  await act(async () => socket.receive(snapshot(held)));
  await act(async () => latestActions.renameSession("r0", "Renamed"));
  const rename = socket.sent.findLast((m) => m.type === "renameSession");
  if (rename?.type !== "renameSession" || !rename.requestId)
    throw new Error("no rename");
  const requestId = rename.requestId;
  // Refused: the resync resubscribes; its snapshot is lost to a disconnect.
  await act(async () =>
    socket.receive({
      type: "error",
      requestId,
      message: "refused",
    }),
  );
  expect(sessionUnsubscribes(socket)).toHaveLength(1);
  const next = await reconnect(socket);
  const subscribes = sessionSubscribes(next);
  expect(subscribes).toHaveLength(1);
  expect(subscribes[0]!.digests).toBeUndefined();
});

/* ------------------------------ shell cache ------------------------------ */

async function saveAndReload(): Promise<void> {
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  act(() => root.unmount());
  root = createRoot(container);
}

it("a warm start re-reads only the changed rows and the rows that were live when cached (W6)", async () => {
  const socket = await boot();
  const resting = Array.from({ length: 50 }, (_, i) =>
    row(`rest${i}`, 1_000 - i, {
      ...(i % 2 ? { settledAt: 5 } : {}),
      ...(i % 3 ? { unread: true } : {}),
      ...(i % 5 === 0
        ? {
            outcomeAttention: {
              revision: 2,
              settledRevision: 1,
              kind: "completed" as const,
              at: 3,
            },
          }
        : {}),
      ...(i % 7 === 0 ? { taskProgress: { todo: 1, doing: 1, done: 0 } } : {}),
    }),
  );
  const live = [
    row("streaming", 2_000, { isStreaming: true, runStartedAt: 10 }),
    row("approval", 1_999, { awaitingInput: true, attention: "approval" }),
    row("queued", 1_998, { queuedWork: true }),
    row("owed", 1_997, { awaitingRepliesFrom: ["peer"] }),
  ];
  const all = [...live, ...resting];
  const revisionOf = (id: string) => 10 + all.findIndex((r) => r.id === id);
  await act(async () =>
    socket.receive(
      snapshot(
        all,
        all.map(({ id }) => at(id, revisionOf(id))),
      ),
    ),
  );
  // An archived-slice row (read by the shelf) and a stale cached singleton.
  await act(async () => latestActions.loadArchivedSessions());
  const read = socket.sent.findLast((m) => m.type === "loadArchivedSessions");
  if (read?.type !== "loadArchivedSessions") throw new Error("no read");
  await act(async () =>
    socket.receive({
      type: "archivedSessions",
      requestId: read.requestId,
      sessions: [row("shelved", 1, { archived: true })],
      archivedSessionCount: 1,
    }),
  );
  await saveAndReload();
  const record = readAppShellCacheRecord()!;
  // The singleton an older build cached is added to the stored record.
  writeAppShellCacheRecord({
    ...record,
    sessions: [
      ...(record.sessions as SessionListItem[]),
      row("pa", 5_000, { agentType: "personal-assistant" }),
    ],
  });
  expect(Object.keys(record.sessionRevisions as object).sort()).toEqual(
    resting.map(({ id }) => id).sort(),
  );

  // Hydration: rows at rest, the singleton gone, revisions for resting rows.
  const hydrated = createInitialState();
  expect(hydrated.hydrationSource).toBe("cache");
  expect(hydrated.sessions.some((r) => r.id === "pa")).toBe(false);
  for (const id of live.map((r) => r.id)) {
    const cached = hydrated.liveSessions.find((r) => r.id === id)!;
    expect(cached.isStreaming).toBe(false);
    expect(cached.awaitingInput).toBe(false);
    expect(cached).not.toHaveProperty("attention");
    expect(cached).not.toHaveProperty("runStartedAt");
    expect(cached).not.toHaveProperty("queuedWork");
    expect(cached).not.toHaveProperty("awaitingRepliesFrom");
    expect(hydrated.stateEventRevisions.sessions).not.toHaveProperty(id);
  }
  expect(hydrated.archivedSessions.map((r) => r.id)).toEqual(["shelved"]);
  expect(hydrated.stateEventRevisions.sessions).not.toHaveProperty("shelved");

  // Mount from that cache and connect.
  const warm = await boot();
  const identity = new Map(latestState.liveSessions.map((r) => [r.id, r]));
  const [subscribe] = sessionSubscribes(warm);
  expect(subscribe?.digests).toEqual(["sessions"]);
  expect(latestState.sessionListFresh).toBe(false);
  // Every row at its revision, but two resting rows moved meanwhile.
  await act(async () =>
    warm.receive(
      digest(
        all.map(({ id }) =>
          at(
            id,
            revisionOf(id) + (id === "rest3" || id === "rest40" ? 100 : 0),
          ),
        ),
      ),
    ),
  );
  const fetches = itemFetches(warm);
  expect(fetches).toHaveLength(1);
  expect([...fetches[0]!.ids].sort()).toEqual(
    ["streaming", "approval", "queued", "owed", "rest3", "rest40"].sort(),
  );
  await act(async () =>
    warm.receive({
      type: "stateItems",
      topic: "sessions",
      requestId: fetches[0]!.requestId,
      events: fetches[0]!.ids.map((id) => {
        const item = all.find((r) => r.id === id)!;
        return {
          kind: "upsert" as const,
          id,
          revision: revisionOf(id) + (id.startsWith("rest") ? 100 : 0),
          item: id.startsWith("rest") ? { ...item, title: `${id}!` } : item,
        };
      }),
    }),
  );
  expect(latestState.sessionListFresh).toBe(true);
  // Live rows are live again; unchanged resting rows kept hydration identity.
  expect(
    latestState.liveSessions.find((r) => r.id === "approval")?.attention,
  ).toBe("approval");
  for (const { id } of resting)
    if (id !== "rest3" && id !== "rest40")
      expect(latestState.liveSessions.find((r) => r.id === id)).toBe(
        identity.get(id),
      );
  expect(latestState.liveSessions.find((r) => r.id === "rest3")?.title).toBe(
    "rest3!",
  );
  expect(sessionUnsubscribes(warm)).toHaveLength(0);
});

it("a cache without, or with an invalid, session sidecar takes a snapshot (W7)", async () => {
  const defaults = createInitialState();
  for (const sessionRevisions of [undefined, { r0: -1 }, "nope"]) {
    window.localStorage.clear();
    writeAppShellCacheRecord({
      version: 1,
      savedAt: Date.now(),
      models: [],
      agents: [],
      sessions: rows(3),
      ...(sessionRevisions !== undefined ? { sessionRevisions } : {}),
      settings: defaults.settings,
      slashCommands: [],
      taskList: null,
      projectList: null,
      worktrees: [],
    });
    const hydrated = createInitialState();
    expect(hydrated.liveSessions.map((r) => r.id)).toEqual(["r0", "r1", "r2"]);
    expect(hydrated.stateEventRevisions.sessions).toBeUndefined();
    const socket = await boot();
    const [subscribe] = sessionSubscribes(socket);
    expect(subscribe).toBeDefined();
    expect(subscribe!.digests).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);
  }
});

it("an empty sidecar, or one naming only unknown ids, takes a snapshot (W7)", async () => {
  const defaults = createInitialState();
  writeAppShellCacheRecord({
    version: 1,
    savedAt: Date.now(),
    models: [],
    agents: [],
    sessions: rows(2),
    sessionRevisions: { gone: 4 },
    settings: defaults.settings,
    slashCommands: [],
    taskList: null,
    projectList: null,
    worktrees: [],
  });
  expect(createInitialState().stateEventRevisions.sessions).toEqual({});
  const socket = await boot();
  expect(sessionSubscribes(socket)[0]!.digests).toBeUndefined();
});
