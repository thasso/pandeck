// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  SessionListItem,
  WorkflowRunCard,
  WorkflowRunSummary,
} from "@assistant/shared";
import {
  buildSessionInbox,
  classifySessionStatus,
  inboxItemId,
  type SessionInboxCard,
  type SessionInboxItem,
} from "./lib/sessionInbox.ts";

/** The session cards of a shaped list; the inbox also carries run items. */
function cards(items: SessionInboxItem[]): SessionInboxCard[] {
  return items.flatMap((item) => (item.kind === "session" ? [item.card] : []));
}

/**
 * Settle as ACKNOWLEDGEMENT, from the browser's side (Task-674): the command
 * carries the attention revision the clicked row actually showed, and the
 * authoritative row — the same one every other tab receives — decides where the
 * session ends up. What is under test is the pair: a settle that acknowledges
 * what the user saw, and a newer outcome arriving anyway.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { useAssistant } = await import("./hooks/useAssistant.ts");

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

  constructor(readonly url: string) {
    ScenarioSocket.instances.push(this);
  }

  open(): void {
    this.readyState = ScenarioSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(source: string): void {
    this.sent.push(JSON.parse(source) as ClientMessage);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const NOW = 1_800_000_000_000;

function row(partial: Partial<SessionListItem>): SessionListItem {
  return {
    id: "s-1",
    harness: "pi",
    agentType: "assistant",
    title: "A direct session",
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    messageCount: 4,
    ...partial,
  };
}

function readyMessage(sessions: SessionListItem[]): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions,
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

let actions: ReturnType<typeof useAssistant>["actions"] | null = null;
let uiState: ReturnType<typeof useAssistant>["state"] | null = null;

function AssistantHarness() {
  const assistant = useAssistant();
  actions = assistant.actions;
  uiState = assistant.state;
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/sessions/s-1");
  actions = null;
  uiState = null;
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ profiles: [], modelsByProfile: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Boot the hook with these session rows already in the list. */
async function bootAll(sessions: SessionListItem[]): Promise<ScenarioSocket> {
  await act(async () => root!.render(<AssistantHarness />));
  const socket = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage(sessions));
  });
  return socket;
}

/** Boot the hook with one session row already in the list. */
async function boot(session: SessionListItem): Promise<ScenarioSocket> {
  return bootAll([session]);
}

function current(id: string): SessionListItem {
  const found = uiState!.sessions.find((session) => session.id === id);
  expect(found, `session ${id} is in the list`).toBeDefined();
  return found!;
}

describe("settling a direct session", () => {
  it("acknowledges the revision the row showed, and shelves it optimistically", async () => {
    const socket = await boot(
      row({
        outcomeAttention: {
          revision: 2,
          settledRevision: 1,
          kind: "completed",
          at: NOW - 30_000,
        },
      }),
    );
    expect(classifySessionStatus(current("s-1"))).toBe("quiet");

    await act(async () => actions!.settleSession("s-1"));

    const settle = socket.sent.find((msg) => msg.type === "settleSession");
    expect(settle).toMatchObject({
      type: "settleSession",
      id: "s-1",
      settled: true,
      throughRevision: 2,
    });
    const optimistic = current("s-1");
    expect(optimistic.outcomeAttention?.settledRevision).toBe(2);
    expect(optimistic.settledAt).toBeDefined();
    expect(buildSessionInbox([optimistic]).settled).toHaveLength(1);
  });

  it("sends revision 0 for a row that has never had an outcome", async () => {
    const socket = await boot(row({}));
    await act(async () => actions!.settleSession("s-1"));
    expect(
      socket.sent.find((msg) => msg.type === "settleSession"),
    ).toMatchObject({ throughRevision: 0 });
  });

  it("converges on the authoritative row when a newer outcome lands anyway", async () => {
    const socket = await boot(
      row({
        outcomeAttention: {
          revision: 2,
          settledRevision: 1,
          kind: "completed",
          at: NOW - 30_000,
        },
      }),
    );
    await act(async () => actions!.settleSession("s-1"));
    expect(current("s-1").settledAt).toBeDefined();

    // The server's answer: the settle landed (revision 2 acknowledged), but
    // revision 3 had already happened, so the row carries no `settledAt`. Every
    // subscribed tab receives this exact row.
    await act(async () => {
      socket.receive({
        type: "sessionUpdated",
        session: row({
          unread: false,
          outcomeAttention: {
            revision: 3,
            settledRevision: 2,
            kind: "failed",
            at: NOW - 1_000,
          },
        }),
      });
    });

    const authoritative = current("s-1");
    expect(authoritative.settledAt).toBeUndefined();
    expect(classifySessionStatus(authoritative)).toBe("failed");
    expect(buildSessionInbox([authoritative]).settled).toHaveLength(0);
    expect(buildSessionInbox([authoritative]).active).toHaveLength(1);
  });
});

/**
 * A formal Workflow Run settles as ONE thing ([Task-677](pa://task/677)): the
 * command acknowledges the revision the run's summary showed, and the browser
 * shelves the run AND the roles its card names in the same dispatch, so no
 * role surfaces as a card of its own in the gap before the server's two lists
 * arrive.
 */
describe("settling a Workflow Run", () => {
  const ended: WorkflowRunSummary = {
    id: "r1",
    taskId: "677",
    recipeId: "code-delivery",
    recipeVersion: 1,
    lifecycle: "completed",
    limits: { maxIterations: 3, maxReviewPasses: 2 },
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 10_000,
    endedAt: NOW - 10_000,
    attention: {
      revision: 2,
      settledRevision: 1,
      kind: "completed",
      at: NOW - 10_000,
    },
  };
  const card: WorkflowRunCard = {
    runId: "r1",
    phase: "merge",
    iterationsUsed: 1,
    nextAction: "Run complete",
    mergeDecisionReady: false,
    canRebaseAndReview: false,
    canRetry: false,
    canResume: false,
    coordinatorSessionId: "s-1",
    implementerSessionId: "s-2",
  };
  const pending = {
    revision: 1,
    settledRevision: 0,
    kind: "completed" as const,
    at: NOW - 20_000,
  };
  /** The same card with the coordinator as its only role. */
  const { implementerSessionId: _implementer, ...soloCard } = card;

  it("acknowledges the revision the item showed and shelves the run with its roles", async () => {
    const socket = await bootAll([
      row({ id: "s-1", title: "Coordinator", outcomeAttention: pending }),
      row({ id: "s-2", title: "Implementer", outcomeAttention: pending }),
    ]);
    await act(async () => {
      socket.receive({
        type: "workflowRunList",
        runs: [ended],
        cards: { r1: card },
        updatedAt: NOW,
      });
    });
    const before = buildSessionInbox(uiState!.sessions, {
      workflowRuns: uiState!.workflowRuns ?? [],
      workflowCards: uiState!.workflowCards,
    });
    expect(before.needsYou.map(inboxItemId)).toEqual(["run:r1"]);

    await act(async () => actions!.settleWorkflowRun("r1", 2));

    expect(
      socket.sent.find((msg) => msg.type === "settleWorkflowRun"),
    ).toMatchObject({ runId: "r1", throughRevision: 2 });
    const after = buildSessionInbox(uiState!.sessions, {
      workflowRuns: uiState!.workflowRuns ?? [],
      workflowCards: uiState!.workflowCards,
    });
    expect(after.needsYou).toEqual([]);
    expect(after.active).toEqual([]);
    expect(after.settled.map((session) => session.id).sort()).toEqual([
      "s-1",
      "s-2",
    ]);
    expect(current("s-1").outcomeAttention?.settledRevision).toBe(1);
  });

  it("leaves a newer event awake when the click saw an older revision", async () => {
    const socket = await bootAll([
      row({ id: "s-1", outcomeAttention: pending }),
    ]);
    await act(async () => {
      socket.receive({
        type: "workflowRunList",
        runs: [ended],
        cards: { r1: soloCard },
        updatedAt: NOW,
      });
    });
    // The item was rendered at revision 1 and the run moved to 2 during the
    // exit animation: the click acknowledges 1, and the run stays an item.
    await act(async () => actions!.settleWorkflowRun("r1", 1));
    expect(
      socket.sent.find((msg) => msg.type === "settleWorkflowRun"),
    ).toMatchObject({ throughRevision: 1 });
    const view = buildSessionInbox(uiState!.sessions, {
      workflowRuns: uiState!.workflowRuns ?? [],
      workflowCards: uiState!.workflowCards,
    });
    expect(view.needsYou.map(inboxItemId)).toEqual(["run:r1"]);
  });

  it("converges on the authoritative lists when a newer event lands anyway", async () => {
    const socket = await bootAll([
      row({ id: "s-1", outcomeAttention: pending }),
    ]);
    await act(async () => {
      socket.receive({
        type: "workflowRunList",
        runs: [
          {
            ...ended,
            lifecycle: "paused",
            attention: { ...ended.attention!, kind: "paused" },
          },
        ],
        cards: {
          r1: soloCard,
        },
        updatedAt: NOW,
      });
    });
    await act(async () => actions!.settleWorkflowRun("r1", 2));
    // The server's answer: revision 2 acknowledged, but the run has since been
    // cancelled at revision 3, so the item is awake on every subscribed tab.
    await act(async () => {
      socket.receive({
        type: "workflowRunList",
        runs: [
          {
            ...ended,
            lifecycle: "cancelled",
            attention: {
              revision: 3,
              settledRevision: 2,
              kind: "cancelled",
              at: NOW,
            },
          },
        ],
        cards: {
          r1: soloCard,
        },
        updatedAt: NOW + 1,
      });
    });
    const view = buildSessionInbox(uiState!.sessions, {
      workflowRuns: uiState!.workflowRuns ?? [],
      workflowCards: uiState!.workflowCards,
    });
    expect(view.needsYou.map(inboxItemId)).toEqual(["run:r1"]);
  });
});

/**
 * A cluster card settles its COORDINATOR through the revision its own row
 * showed, and shelves the peers it still coordinates with it — one command,
 * the server settling the peers through their current revisions, and the
 * browser shelving them optimistically so none of them surfaces as a card of
 * its own in the meantime.
 */
describe("settling a cluster", () => {
  const coordinator = (extra: Partial<SessionListItem> = {}) =>
    row({
      id: "s-1",
      title: "Coordinator",
      outcomeAttention: {
        revision: 2,
        settledRevision: 1,
        kind: "completed",
        at: NOW - 30_000,
      },
      ...extra,
    });
  const peer = (extra: Partial<SessionListItem> = {}) =>
    row({
      id: "s-2",
      title: "Peer",
      spawnedBySessionId: "s-1",
      spawnOwnership: "coordinator",
      ...extra,
    });

  it("acknowledges the coordinator's own observed revision and shelves its peers", async () => {
    const socket = await bootAll([
      coordinator(),
      peer(),
      row({
        id: "s-3",
        title: "Grandchild",
        spawnedBySessionId: "s-2",
        spawnOwnership: "coordinator",
        lastError: { at: NOW - 10_000, message: "boom" },
      }),
      row({
        id: "s-4",
        title: "Taken over",
        spawnedBySessionId: "s-1",
        spawnOwnership: "taken-over",
      }),
    ]);
    const view = buildSessionInbox(uiState!.sessions);
    expect(
      cards(view.active)
        .map((card) => card.session.id)
        .sort(),
    ).toEqual(["s-1", "s-4"]);
    expect(
      cards(view.active).find((card) => card.session.id === "s-1")?.cluster
        ?.counts.total,
    ).toBe(2);

    await act(async () => actions!.settleSession("s-1"));

    // ONE command: the server settles the peers with the coordinator, so the
    // browser sends nothing for them.
    const settles = socket.sent.filter((msg) => msg.type === "settleSession");
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ id: "s-1", throughRevision: 2 });

    // The coordinator goes to the shelf with every peer it coordinated, at
    // any depth; the peer the user took over is their own and stays.
    const settled = buildSessionInbox(uiState!.sessions);
    expect(settled.settled.map((item) => item.id).sort()).toEqual([
      "s-1",
      "s-2",
      "s-3",
    ]);
    expect(cards(settled.active).map((card) => card.session.id)).toEqual([
      "s-4",
    ]);
  });

  it("keeps an already-settled peer's settled time while shelving it again", async () => {
    // A settled bridge with live work below it folds, so the cascade reaches
    // it; re-stamping it would lift it to the top of the shelf.
    await bootAll([
      coordinator(),
      peer({ settledAt: NOW - 600_000 }),
      row({
        id: "s-3",
        title: "Live under the bridge",
        spawnedBySessionId: "s-2",
        spawnOwnership: "coordinator",
      }),
    ]);
    await act(async () => actions!.settleSession("s-1"));
    expect(current("s-2").settledAt).toBe(NOW - 600_000);
    expect(current("s-3").settledAt).toBeDefined();
  });

  it("unsettles the coordinator alone", async () => {
    const socket = await bootAll([
      coordinator({ settledAt: NOW - 20_000 }),
      peer({ settledAt: NOW - 20_000 }),
    ]);
    await act(async () => actions!.settleSession("s-1", false));
    expect(socket.sent.filter((msg) => msg.type === "settleSession")).toEqual([
      expect.objectContaining({ id: "s-1", settled: false }),
    ]);
    expect(current("s-1").settledAt).toBeUndefined();
    expect(current("s-2").settledAt).toBeDefined();
  });

  it("refuses to settle while a folded peer is waiting for the user", async () => {
    await bootAll([coordinator(), peer({ attention: "question" })]);
    const view = buildSessionInbox(uiState!.sessions);
    expect(cards(view.needsYou)[0]?.settleBlocked).toBe(
      "it is waiting for your answer.",
    );
  });

  it("keeps a settled coordinator in the working set for a waiting peer", async () => {
    await bootAll([coordinator(), peer()]);
    await act(async () => actions!.settleSession("s-1"));
    expect(current("s-1").settledAt).toBeDefined();

    await act(async () => {
      ScenarioSocket.instances.at(-1)!.receive({
        type: "sessionUpdated",
        session: peer({ attention: "question", awaitingInput: true }),
      });
    });

    const view = buildSessionInbox(uiState!.sessions);
    expect(view.settled).toHaveLength(0);
    expect(cards(view.needsYou).map((card) => card.session.id)).toEqual([
      "s-1",
    ]);
    expect(cards(view.needsYou)[0]?.cluster?.bubbled?.session.id).toBe("s-2");
  });
});

/**
 * Taking a peer over is explicit ([Task-637](pa://task/637)): one command, and
 * the inbox re-folds at once — the peer stands on its own while the user owns
 * it, and folds back under its coordinator when handed back.
 */
describe("taking a peer over", () => {
  it("sends one command and re-folds the inbox optimistically", async () => {
    const socket = await bootAll([
      row({ id: "s-1", title: "Coordinator" }),
      row({
        id: "s-2",
        title: "Peer",
        spawnedBySessionId: "s-1",
        spawnOwnership: "coordinator",
      }),
    ]);
    const topLevel = () =>
      cards(buildSessionInbox(uiState!.sessions).active)
        .map((card) => card.session.id)
        .sort();
    expect(topLevel()).toEqual(["s-1"]);

    await act(async () => actions!.setSpawnOwnership("s-2", "taken-over"));
    expect(
      socket.sent.filter((msg) => msg.type === "setSpawnOwnership"),
    ).toEqual([
      expect.objectContaining({ id: "s-2", ownership: "taken-over" }),
    ]);
    expect(current("s-2").spawnOwnership).toBe("taken-over");
    expect(topLevel()).toEqual(["s-1", "s-2"]);

    await act(async () => actions!.setSpawnOwnership("s-2", "coordinator"));
    expect(current("s-2").spawnOwnership).toBe("coordinator");
    expect(topLevel()).toEqual(["s-1"]);
  });

  it("recovers the authoritative owner when the server refuses", async () => {
    const rows = [
      row({ id: "s-1", title: "Coordinator" }),
      row({
        id: "s-2",
        title: "Peer",
        spawnedBySessionId: "s-1",
        spawnOwnership: "coordinator" as const,
      }),
    ];
    const socket = await bootAll(rows);
    await act(async () => actions!.setSpawnOwnership("s-2", "taken-over"));
    expect(current("s-2").spawnOwnership).toBe("taken-over");
    const command = socket.sent.find(
      (msg) => msg.type === "setSpawnOwnership",
    ) as { requestId: string };
    expect(command.requestId).toBeDefined();

    // The refusal carries the command's id, so that exact change is
    // recovered: the list is re-read and its answer replaces the guess.
    const listsBefore = socket.sent.filter(
      (msg) => msg.type === "listSessions",
    ).length;
    await act(async () => {
      socket.receive({
        type: "error",
        message: "Could not change who runs this session. Try again.",
        requestId: command.requestId,
        target: { type: "session", id: "s-2" },
      });
    });
    expect(
      socket.sent.filter((msg) => msg.type === "listSessions").length,
    ).toBeGreaterThan(listsBefore);
    await act(async () => {
      socket.receive({ type: "sessions", sessions: rows });
    });
    expect(current("s-2").spawnOwnership).toBe("coordinator");
  });
});
