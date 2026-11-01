// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  PullRequestCard,
  ServerMessage,
  SessionListItem,
  StateDigestEntry,
  WorkflowRunCard,
  WorkflowRunSummary,
} from "@assistant/shared";
import {
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";
import { readAppShellCacheRecord } from "./lib/appShellCacheStore.ts";
import { sessionSettleCascade } from "./lib/sessionInbox.ts";

/**
 * A failed optimistic mutation that touched session rows forgets those rows'
 * revisions before anything can cache them (`docs/state-sync.md`, Client
 * contract). The shell cache may be written between the failure and the
 * resync snapshot (any cache dependency moves, then `pagehide`); the cached
 * guess must then carry no revision, so the warm start's digest fetches it
 * even though the server's revision never moved.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** `MUTATION_SETTLE_TIMEOUT_MS` in `useAssistant`. */
const MUTATION_SETTLE_TIMEOUT_MS = 30_000;
/** `LONG_MUTATION_SETTLE_TIMEOUT_MS` in `useAssistant` (card cleanup). */
const LONG_MUTATION_SETTLE_TIMEOUT_MS = 15 * 60_000;

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

/** Every row the server holds, all at revision 5 throughout. */
const serverRows = [
  row("s1", 5, { worktreeId: "wt-1" }),
  row("s2", 4, { worktreeId: "wt-1" }),
  row("coord", 3),
  row("impl", 2),
  row("other", 1),
];
const REVISION = 5;
const atRevision = (rows: SessionListItem[]): StateDigestEntry[] =>
  rows.map(({ id }) => ({ id, revision: REVISION }));

const run: WorkflowRunSummary = {
  id: "run-1",
  taskId: "677",
  recipeId: "code-delivery",
  recipeVersion: 1,
  lifecycle: "completed",
  limits: { maxIterations: 3, maxReviewPasses: 2 },
  createdAt: 1,
  updatedAt: 2,
  endedAt: 2,
  attention: { revision: 2, settledRevision: 1, kind: "completed", at: 2 },
};
const runCard: WorkflowRunCard = {
  runId: "run-1",
  phase: "merge",
  iterationsUsed: 1,
  nextAction: "Run complete",
  mergeDecisionReady: false,
  canRebaseAndReview: false,
  canRetry: false,
  canResume: false,
  coordinatorSessionId: "coord",
  implementerSessionId: "impl",
};
const pullRequestCard: PullRequestCard = {
  renderKind: "pullRequest",
  id: "pr-1",
  sessionId: "s1",
  status: "merged",
  createdAt: 1,
  updatedAt: 10,
  title: "Cleanup subject",
  headBranch: "feature",
  baseBranch: "main",
  worktreeId: "wt-1",
  warnings: [],
};
const worktree = {
  id: "wt-1",
  projectId: "p1",
  mainRepoRoot: "/repo",
  path: "/repo/wt",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "abc",
  status: "active" as const,
  sessionIds: ["s1", "s2"],
  taskIds: [],
  createdAt: 1,
  updatedAt: 1,
};

const itemFetches = (socket: ScenarioSocket) =>
  socket.sent.filter(
    (message): message is Extract<ClientMessage, { type: "getStateItems" }> =>
      message.type === "getStateItems" && message.topic === "sessions",
  );
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
const shown = (id: string) =>
  latestState.liveSessions.find((session) => session.id === id);

async function boot(): Promise<ScenarioSocket> {
  await act(async () => root.render(<Harness />));
  const socket = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => latestActions.setTopics(["sessions", "worktrees"]));
  return socket;
}

/** Connected, holding every row at its revision, the run and the card. */
async function bootHolding(): Promise<ScenarioSocket> {
  const socket = await boot();
  await act(async () => {
    socket.receive({
      type: "sessionList",
      seq: 0,
      sessions: serverRows,
      revisions: atRevision(serverRows),
      archivedSessionCount: 0,
    });
    socket.receive({
      type: "workflowRunList",
      runs: [run],
      cards: { "run-1": runCard },
      updatedAt: 1,
    });
    socket.receive({
      type: "worktreeList",
      worktrees: [worktree],
      updatedAt: 1,
    });
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: pullRequestCard,
    });
  });
  return socket;
}

/** The page goes away: the pending shell-cache write is flushed, then gone. */
async function saveAndReload(): Promise<void> {
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  act(() => root.unmount());
  root = createRoot(container);
}

const lastSent = <Type extends ClientMessage["type"]>(
  socket: ScenarioSocket,
  type: Type,
) => {
  const sent = socket.sent.findLast((message) => message.type === type);
  if (sent?.type !== type || !("requestId" in sent) || !sent.requestId)
    throw new Error(`no ${type} sent`);
  return sent.requestId;
};

interface Family {
  /** The rows the mutation touched: exactly the ids the warm start fetches. */
  touched: string[];
  /** Starts the mutation and returns the request id its answer carries. */
  start: (socket: ScenarioSocket) => Promise<string>;
  /** What the refused guess showed, checked before and after the reload. */
  guessShown: () => boolean;
  timeoutMs: number;
}

const families: Record<string, Family> = {
  "an inbox drag": {
    touched: ["s2"],
    start: async (socket) => {
      await act(async () =>
        latestActions.setInboxPositions([
          { kind: "session", id: "s2", position: 99 },
          { kind: "run", runId: "run-1", position: 98 },
        ]),
      );
      return lastSent(socket, "setInboxPositions");
    },
    guessShown: () => shown("s2")?.inboxPosition === 99,
    timeoutMs: MUTATION_SETTLE_TIMEOUT_MS,
  },
  "a Workflow Run settle": {
    touched: ["coord", "impl"],
    start: async (socket) => {
      await act(async () => latestActions.settleWorkflowRun("run-1", 2));
      return lastSent(socket, "settleWorkflowRun");
    },
    guessShown: () =>
      shown("coord")?.settledAt !== undefined &&
      shown("impl")?.settledAt !== undefined,
    timeoutMs: MUTATION_SETTLE_TIMEOUT_MS,
  },
  "a pull-request card cleanup": {
    // It changes no row optimistically, but its declared effect is the
    // worktree's sessions; their revisions go with the rest.
    touched: ["s1", "s2"],
    start: async (socket) => {
      await act(async () =>
        latestActions.runPullRequestCardAction("pr-1", "cleanup"),
      );
      return lastSent(socket, "pullRequestCardAction");
    },
    guessShown: () => true,
    timeoutMs: LONG_MUTATION_SETTLE_TIMEOUT_MS,
  },
};

const failures = {
  refused: async (socket: ScenarioSocket, requestId: string) =>
    act(async () =>
      socket.receive({ type: "error", requestId, message: "refused" }),
    ),
  "timed out": async (
    _socket: ScenarioSocket,
    _requestId: string,
    ms: number,
  ) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    }),
};

for (const [familyName, family] of Object.entries(families))
  for (const [failureName, fail] of Object.entries(failures))
    it(`${familyName} ${failureName} and cached before its snapshot is re-read on the warm start`, async () => {
      const socket = await bootHolding();
      const requestId = await family.start(socket);
      expect(family.guessShown()).toBe(true);
      const unsubscribed = sessionUnsubscribes(socket).length;
      await fail(socket, requestId, family.timeoutMs);
      // The recovery resubscribes for the snapshot, which never lands here.
      expect(sessionUnsubscribes(socket).length).toBe(unsubscribed + 1);
      // An unrelated cache dependency moves, then the page goes away.
      await act(async () =>
        socket.receive({ type: "archivedSessionCount", count: 3 }),
      );
      await saveAndReload();

      const record = readAppShellCacheRecord()!;

      // The server never applied it: the digest repeats every revision.
      const warm = await boot();
      expect(sessionSubscribes(warm)[0]?.digests).toEqual(["sessions"]);
      expect(family.guessShown()).toBe(true);
      await act(async () =>
        warm.receive({
          type: "stateDigest",
          topic: "sessions",
          seq: 0,
          entries: atRevision(serverRows),
        }),
      );
      const fetches = itemFetches(warm);
      expect(fetches).toHaveLength(1);
      expect([...fetches[0]!.ids].sort()).toEqual([...family.touched].sort());
      expect(latestState.sessionListFresh).toBe(false);
      await act(async () =>
        warm.receive({
          type: "stateItems",
          topic: "sessions",
          requestId: fetches[0]!.requestId,
          events: serverRows
            .filter(({ id }) => family.touched.includes(id))
            .map((item) => ({
              kind: "upsert" as const,
              id: item.id,
              revision: REVISION,
              item,
            })),
        }),
      );
      expect(latestState.sessionListFresh).toBe(true);
      for (const id of family.touched)
        expect(shown(id)).toEqual(serverRows.find((item) => item.id === id));
      // The cause: the guesses were cached without a revision.
      const untouched = serverRows
        .map(({ id }) => id)
        .filter((id) => !family.touched.includes(id));
      expect(Object.keys(record.sessionRevisions ?? {}).sort()).toEqual(
        untouched.sort(),
      );
    });

it("a Workflow Run settle pending at reconnect takes the snapshot its refusal joins", async () => {
  const socket = await bootHolding();
  const requestId = await family("a Workflow Run settle").start(socket);
  await act(async () => socket.close());
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  const next = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    next.open();
    next.receive(readyMessage());
  });
  // Its role rows are a guess at their held revisions: no digest may keep them.
  const subscribes = sessionSubscribes(next);
  expect(subscribes).toHaveLength(1);
  expect(subscribes[0]!.digests).toBeUndefined();
  await act(async () =>
    next.receive({ type: "error", requestId, message: "refused" }),
  );
  expect(sessionSubscribes(next)).toHaveLength(1);
  expect(sessionUnsubscribes(next)).toHaveLength(0);
  await act(async () =>
    next.receive({
      type: "sessionList",
      seq: 0,
      sessions: serverRows,
      revisions: atRevision(serverRows),
      archivedSessionCount: 0,
    }),
  );
  expect(latestState.sessionListFresh).toBe(true);
  expect(shown("coord")?.settledAt).toBeUndefined();
});

it("a cleanup lost to a disconnect forgets its sessions' revisions before the cache can save them", async () => {
  const socket = await bootHolding();
  await family("a pull-request card cleanup").start(socket);
  await act(async () => socket.close());
  const held = latestState.stateEventRevisions.sessions ?? {};
  expect(held.s1).toBeUndefined();
  expect(held.s2).toBeUndefined();
  expect(held.other).toBe(REVISION);
  await saveAndReload();
  const record = readAppShellCacheRecord()!;
  expect(Object.keys(record.sessionRevisions ?? {}).sort()).toEqual(
    ["coord", "impl", "other"].sort(),
  );
});

function family(name: string): Family {
  return families[name]!;
}

// A workflow role can spawn a child. A stale paused+acknowledged run leaves
// that child under the role in the browser, while working-set re-entry on the
// server excludes the role from the spawn forest without stamping the child.
const cascadeRows = [
  row("R", 3, { agentType: "developer" }),
  row("Q", 2, { spawnedBySessionId: "R", spawnOwnership: "coordinator" }),
  row("untouched", 1),
];
const cascadeCard: WorkflowRunCard = {
  ...runCard,
  coordinatorSessionId: "C",
  implementerSessionId: "R",
};
const pausedRun: WorkflowRunSummary = {
  ...run,
  lifecycle: "paused",
  attention: { revision: 1, settledRevision: 1, kind: "paused", at: 1 },
};
function runList(
  currentRun: WorkflowRunSummary,
  card = cascadeCard,
): ServerMessage {
  return {
    type: "workflowRunList",
    runs: [currentRun],
    cards: { [currentRun.id]: card },
    updatedAt: 2,
  };
}
async function bootCascade() {
  const socket = await boot();
  await act(async () => {
    socket.receive({
      type: "sessionList",
      seq: 0,
      sessions: cascadeRows,
      revisions: atRevision(cascadeRows),
      archivedSessionCount: 0,
    });
    socket.receive(runList(pausedRun));
  });
  return socket;
}

/** Exercise the actual cache writer, storage, hydration and equal-revision read. */
async function warmCascade(
  socket: ScenarioSocket,
  authoritativeRows: SessionListItem[],
  expectedRevisions: Record<string, number>,
  expectedFetch: string[],
) {
  // Mutation completion alone does not schedule a save. An ordinary later
  // collection change does, and pagehide flushes the writer before teardown.
  await act(async () =>
    socket.receive({ type: "archivedSessionCount", count: 3 }),
  );
  await saveAndReload();
  const record = readAppShellCacheRecord()!;
  const cachedQ = (record.sessions as SessionListItem[]).find(
    ({ id }) => id === "Q",
  );
  const warm = await boot();
  expect(sessionSubscribes(warm)[0]?.digests).toEqual(["sessions"]);
  const hydratedQ = shown("Q");
  expect(hydratedQ).toEqual(cachedQ);
  await act(async () =>
    warm.receive({
      type: "stateDigest",
      topic: "sessions",
      seq: 0,
      entries: authoritativeRows.map(({ id }) => ({
        id,
        revision: expectedRevisions[id] ?? 5,
      })),
    }),
  );
  expect(itemFetches(warm).map(({ ids }) => ids)).toEqual(
    expectedFetch.length ? [expectedFetch] : [],
  );
  expect(record.sessionRevisions).toEqual(expectedRevisions);
  expect(latestState.sessionListFresh).toBe(expectedFetch.length === 0);
  if (expectedFetch.length) {
    expect(hydratedQ?.settledAt).toBeDefined();
    await act(async () =>
      warm.receive({
        type: "stateItems",
        topic: "sessions",
        requestId: itemFetches(warm)[0]!.requestId,
        events: authoritativeRows
          .filter(({ id }) => expectedFetch.includes(id))
          .map((item) => ({ kind: "upsert", id: item.id, revision: 5, item })),
      }),
    );
  } else expect(shown("Q")).toBe(hydratedQ);
  expect(latestState.sessionListFresh).toBe(true);
  expect(shown("Q")).toEqual(authoritativeRows.find(({ id }) => id === "Q"));
  expect(sessionUnsubscribes(warm)).toHaveLength(0);
}

for (const reentry of ["active", "paused gate"] as const)
  it(`a successful settle with ${reentry} re-entry never caches an unechoed peer at its old revision`, async () => {
    const socket = await bootCascade();
    const serverRun =
      reentry === "active"
        ? { ...pausedRun, lifecycle: "active" as const }
        : pausedRun;
    const serverCard = {
      ...cascadeCard,
      mergeDecisionReady: reentry === "paused gate",
    };
    // These are the shared cascade inputs used by the browser and server.
    expect(
      sessionSettleCascade("R", cascadeRows, [pausedRun], {
        [run.id]: cascadeCard,
      }).peerIds,
    ).toEqual(["Q"]);
    expect(
      sessionSettleCascade("R", cascadeRows, [serverRun], {
        [run.id]: serverCard,
      }).peerIds,
    ).toEqual([]);
    await act(async () => latestActions.settleSession("R"));
    const requestId = lastSent(socket, "settleSession");
    expect(shown("Q")?.settledAt).toBeDefined();
    const settledR = { ...cascadeRows[0]!, settledAt: 10 };
    // The production order: session rows flush before mutationSettled; the
    // corrected workflow view may arrive afterwards. Neither confirms Q.
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "sessions",
        seq: 1,
        events: [{ kind: "upsert", id: "R", revision: 6, item: settledR }],
      }),
    );
    await act(async () =>
      socket.receive({ type: "mutationSettled", requestId }),
    );
    await act(async () => socket.receive(runList(serverRun, serverCard)));
    expect(shown("Q")?.settledAt).toBeDefined();
    await warmCascade(
      socket,
      [settledR, ...cascadeRows.slice(1)],
      { R: 6, untouched: 5 },
      ["Q"],
    );
  });

for (const order of ["echo before settle", "echo after settle"] as const)
  it(`a stamped peer corrects a successful settle, ${order}`, async () => {
    const socket = await bootCascade();
    await act(async () => latestActions.settleSession("R"));
    const requestId = lastSent(socket, "settleSession");
    const settledR = { ...cascadeRows[0]!, settledAt: 10 };
    const echo: ServerMessage = {
      type: "stateEvents",
      topic: "sessions",
      seq: 1,
      events: [
        { kind: "upsert", id: "R", revision: 6, item: settledR },
        { kind: "upsert", id: "Q", revision: 6, item: cascadeRows[1]! },
      ],
    };
    if (order === "echo after settle")
      await act(async () =>
        socket.receive({ type: "mutationSettled", requestId }),
      );
    await act(async () => socket.receive(echo));
    if (order === "echo before settle")
      await act(async () =>
        socket.receive({ type: "mutationSettled", requestId }),
      );
    expect(shown("Q")?.settledAt).toBeUndefined();
    await warmCascade(
      socket,
      [settledR, ...cascadeRows.slice(1)],
      { R: 6, Q: 6, untouched: 5 },
      [],
    );
  });

it("a successful cascade's equal echo restores revisions without replacing optimistic rows", async () => {
  const socket = await bootCascade();
  const untouched = shown("untouched");
  await act(async () => latestActions.settleSession("R"));
  const requestId = lastSent(socket, "settleSession");
  const optimisticR = shown("R")!;
  const optimisticQ = shown("Q")!;
  await act(async () =>
    socket.receive({
      type: "stateEvents",
      topic: "sessions",
      seq: 1,
      events: [
        { kind: "upsert", id: "R", revision: 6, item: optimisticR },
        { kind: "upsert", id: "Q", revision: 6, item: optimisticQ },
      ],
    }),
  );
  await act(async () => socket.receive({ type: "mutationSettled", requestId }));
  expect(shown("R")).toBe(optimisticR);
  expect(shown("Q")).toBe(optimisticQ);
  expect(shown("untouched")).toBe(untouched);
  await warmCascade(
    socket,
    [optimisticR, optimisticQ, cascadeRows[2]!],
    { R: 6, Q: 6, untouched: 5 },
    [],
  );
});

it("an unechoed peer is re-read by the in-memory reconnect digest too", async () => {
  const socket = await bootCascade();
  const untouched = shown("untouched");
  await act(async () => latestActions.settleSession("R"));
  const requestId = lastSent(socket, "settleSession");
  await act(async () =>
    socket.receive({
      type: "stateEvents",
      topic: "sessions",
      seq: 1,
      events: [
        {
          kind: "upsert",
          id: "R",
          revision: 6,
          item: { ...cascadeRows[0]!, settledAt: 10 },
        },
      ],
    }),
  );
  await act(async () => socket.receive({ type: "mutationSettled", requestId }));
  await act(async () => socket.close());
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  const next = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    next.open();
    next.receive(readyMessage());
  });
  expect(sessionSubscribes(next)[0]?.digests).toEqual(["sessions"]);
  await act(async () =>
    next.receive({
      type: "stateDigest",
      topic: "sessions",
      seq: 0,
      entries: [
        { id: "R", revision: 6 },
        { id: "Q", revision: 5 },
        { id: "untouched", revision: 5 },
      ],
    }),
  );
  expect(itemFetches(next).map(({ ids }) => ids)).toEqual([["Q"]]);
  expect(latestState.sessionListFresh).toBe(false);
  await act(async () =>
    next.receive({
      type: "stateItems",
      topic: "sessions",
      requestId: itemFetches(next)[0]!.requestId,
      events: [{ kind: "upsert", id: "Q", revision: 5, item: cascadeRows[1]! }],
    }),
  );
  expect(shown("Q")?.settledAt).toBeUndefined();
  expect(shown("untouched")).toBe(untouched);
  expect(latestState.sessionListFresh).toBe(true);
});

it("a successful Workflow Run settle cannot trust a role omitted by the current server card", async () => {
  const socket = await bootCascade();
  // The browser still names Q as a reviewer; the current server card no longer
  // does. Role membership is workflow data, not a change to Q's session row.
  const staleCard = {
    ...cascadeCard,
    reviewerSessions: [{ pass: 1, sessionId: "Q" }],
  };
  await act(async () => socket.receive(runList(run, staleCard)));
  await act(async () => latestActions.settleWorkflowRun(run.id, 2));
  const requestId = lastSent(socket, "settleWorkflowRun");
  expect(shown("Q")?.settledAt).toBeDefined();
  const settledR = { ...cascadeRows[0]!, settledAt: 10 };
  await act(async () =>
    socket.receive({
      type: "stateEvents",
      topic: "sessions",
      seq: 1,
      events: [{ kind: "upsert", id: "R", revision: 6, item: settledR }],
    }),
  );
  await act(async () => socket.receive(runList(run)));
  await act(async () => socket.receive({ type: "mutationSettled", requestId }));
  await warmCascade(
    socket,
    [settledR, ...cascadeRows.slice(1)],
    { R: 6, untouched: 5 },
    ["Q"],
  );
});
