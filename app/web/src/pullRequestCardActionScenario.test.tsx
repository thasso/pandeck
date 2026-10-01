// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  PullRequestCard,
  ServerMessage,
} from "@assistant/shared";
import {
  useAssistant,
  type AssistantActions,
  type ClientPullRequestCard,
  type UIState,
} from "./hooks/useAssistant.ts";
import { getToasts } from "./lib/toast.ts";

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
    sessions: [],
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

/**
 * The card as it stands after a PREVIOUS action completed: the outcome text is
 * durable and the server clears it only when it dequeues the NEXT action, so
 * every watcher poll in between re-broadcasts it with a fresh `updatedAt`.
 */
const card: PullRequestCard = {
  renderKind: "pullRequest",
  id: "pr-1",
  sessionId: "s1",
  status: "open",
  createdAt: 1,
  updatedAt: 10,
  title: "Optimistic card actions",
  headBranch: "feature",
  baseBranch: "main",
  worktreeId: "wt-1",
  warnings: [],
  actionMessage: "Rebased onto main and force-pushed.",
  linkedTask: {
    id: "625",
    title: "Optimistic card actions",
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 1,
    updatedAt: 1,
  },
};

/** The card as the server's DEQUEUE leaves it: the old outcome is gone. */
const dequeued = ({
  actionMessage: _actionMessage,
  actionError: _actionError,
  ...rest
}: PullRequestCard): PullRequestCard => rest;

let latestActions: AssistantActions;
let latestState: UIState;

function CardHarness() {
  const { actions, state } = useAssistant();
  latestActions = actions;
  latestState = state;
  return null;
}

let root: Root;
let container: HTMLDivElement;

const viewedCard = (): ClientPullRequestCard | undefined =>
  latestState.pullRequestCards
    .find((message) => message.id === `pull-request-card-${card.id}`)
    ?.blocks.find((block) => block.kind === "pullRequest")?.pullRequest as
    ClientPullRequestCard | undefined;
const viewedLinkedTask = () =>
  viewedCard()?.optimisticLinkedTask ?? viewedCard()?.linkedTask;

const sentAfter = (mark: number, type: ClientMessage["type"]) =>
  ScenarioSocket.instances[0]!.sent.slice(mark).filter(
    (message) => message.type === type,
  );

beforeEach(() => {
  ScenarioSocket.instances = [];
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
});

async function clickedCard(action: "mark-task-done" | "cleanup") {
  await act(async () => root.render(<CardHarness />));
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
    socket.receive({ type: "pullRequestCardUpdate", sessionId: "s1", card });
  });
  await act(async () =>
    latestActions.runPullRequestCardAction(card.id, action),
  );
  const sent = socket.sent.find(
    (message) => message.type === "pullRequestCardAction",
  );
  expect(sent?.type).toBe("pullRequestCardAction");
  const requestId =
    sent?.type === "pullRequestCardAction" ? sent.requestId : undefined;
  expect(requestId).toBeTypeOf("string");
  return { socket, requestId: requestId!, mark: socket.sent.length };
}

it("holds the click through a watcher echo carrying the last action's message", async () => {
  const { socket, requestId, mark } = await clickedCard("mark-task-done");
  expect(viewedCard()?.pendingAction).toBe("mark-task-done");
  expect(viewedLinkedTask()?.status).toBe("done");

  // A routine CI/review poll: no action of its own, a bumped `updatedAt`, and
  // the PREVIOUS action's message still on the card.
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: {
        ...card,
        updatedAt: 11,
        ci: { state: "success", total: 3 },
      },
    });
  });
  expect(viewedCard()?.pendingAction).toBe("mark-task-done");
  expect(viewedLinkedTask()?.status).toBe("done");
  expect(viewedCard()?.actionMessage).toBeUndefined();
  expect(viewedCard()?.ci?.state).toBe("success");
  expect(sentAfter(mark, "getStateItems")).toHaveLength(0);
  expect(sentAfter(mark, "listTasks")).toHaveLength(0);

  // The server dequeues — the write that clears the previous outcome — and then
  // answers: only now does the card speak for this click.
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: {
        ...dequeued(card),
        updatedAt: 12,
        busyAction: "mark-task-done",
      },
    });
  });
  expect(viewedCard()?.pendingAction).toBeUndefined();
  expect(viewedCard()?.busyAction).toBe("mark-task-done");
  expect(viewedLinkedTask()?.status).toBe("done");

  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: {
        ...card,
        updatedAt: 13,
        actionMessage: "Marked Task-625 done.",
        linkedTask: { ...card.linkedTask!, status: "done" },
      },
    });
    socket.receive({ type: "mutationSettled", requestId });
  });
  expect(viewedCard()?.actionMessage).toBe("Marked Task-625 done.");
  expect(viewedCard()?.pendingAction).toBeUndefined();
  expect(sentAfter(mark, "getStateItems")).toHaveLength(0);
  expect(sentAfter(mark, "listTasks")).toHaveLength(0);
});

it("returns the linked-Task control on a stamped refusal", async () => {
  const { socket, requestId, mark } = await clickedCard("mark-task-done");
  expect(viewedLinkedTask()?.status).toBe("done");

  await act(async () => {
    socket.receive({
      type: "error",
      requestId,
      message: "The server is restarting. Try again.",
    });
  });

  expect(sentAfter(mark, "getStateItems")).toHaveLength(1);
  expect(viewedCard()?.pendingAction).toBeUndefined();
  expect(viewedCard()?.optimisticLinkedTask).toBeUndefined();
  expect(viewedLinkedTask()?.status).toBe("todo");
  expect(viewedCard()?.actionError).toContain("restarting");
});

it("announces a refusal for a card the loaded window no longer shows", async () => {
  const { socket, requestId } = await clickedCard("cleanup");
  // A reattach answers with a window that starts after the card's turn: the
  // card stays in the store but has no row until "load earlier" reaches it.
  await act(async () => {
    socket.receive({
      type: "snapshot",
      state: { sessionId: "s1", harness: "pi", agentType: "assistant" },
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [
          {
            id: "e5",
            seq: 5,
            createdAt: new Date(1000).toISOString(),
            type: "message",
            role: "user",
            origin: { kind: "human" },
            content: [{ type: "text", text: "later turn" }],
          },
        ],
        timelineStart: 5,
        totalEntryCount: 6,
        streaming: [],
      },
      contextInfo: null,
    } as unknown as ServerMessage);
  });
  expect(viewedCard()).toBeDefined();
  expect(
    latestState.messages.some(
      (message) => message.id === `pull-request-card-${card.id}`,
    ),
  ).toBe(false);

  await act(async () => {
    socket.receive({
      type: "error",
      requestId,
      message: "Cleanup refused: the worktree is dirty.",
    });
  });

  expect(viewedCard()?.actionError).toContain("dirty");
  expect(getToasts().map((toast) => toast.message)).toContain(
    "Cleanup refused: the worktree is dirty.",
  );
});

it("recovers when a competing busy echo precedes mutationSettled", async () => {
  const { socket, requestId, mark } = await clickedCard("cleanup");
  expect(viewedCard()?.pendingAction).toBe("cleanup");

  // The server gate refuses this request by first broadcasting the action that
  // already owns the card. No generic settle has arrived yet, so this echo
  // must be remembered rather than recovered immediately or forgotten.
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), busyAction: "mark-task-done", updatedAt: 14 },
    });
  });
  expect(viewedCard()?.pendingAction).toBeUndefined();
  expect(viewedCard()?.busyAction).toBe("mark-task-done");
  expect(sentAfter(mark, "listWorktrees")).toHaveLength(0);
  expect(sentAfter(mark, "listSessions")).toHaveLength(0);

  // The refusal's mutationSettled follows the card broadcast. Recovery must
  // happen here, without waiting for the long-action timeout.
  await act(async () => {
    socket.receive({ type: "mutationSettled", requestId });
  });
  expect(sentAfter(mark, "listWorktrees")).toHaveLength(1);
  expect(sentAfter(mark, "listSessions")).toHaveLength(1);
});

it("restores the card's linked Task when a competing echo wins first", async () => {
  const { socket, requestId, mark } = await clickedCard("mark-task-done");
  expect(viewedLinkedTask()?.status).toBe("done");

  // The competing cleanup owns the durable card. The card reducer preserves
  // this click's linked-Task patch until correlation settles which click ran.
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), busyAction: "cleanup", updatedAt: 15 },
    });
  });
  expect(viewedCard()?.pendingAction).toBeUndefined();
  expect(viewedCard()?.busyAction).toBe("cleanup");
  expect(viewedLinkedTask()?.status).toBe("done");

  // The gate refusal settles this click. Domain recovery re-reads the Task and
  // the same authoritative competing card restores its linked summary now,
  // rather than waiting for another broadcast to make the two surfaces agree.
  await act(async () => {
    socket.receive({ type: "mutationSettled", requestId });
  });
  expect(sentAfter(mark, "getStateItems")).toHaveLength(1);
  expect(viewedCard()?.busyAction).toBe("cleanup");
  expect(viewedLinkedTask()?.status).toBe("todo");
});

it("discards an earlier competitor once this click acquires the gate", async () => {
  const { socket, requestId, mark } = await clickedCard("mark-task-done");

  await act(async () => {
    // Another action starts and finishes before the server handles this click.
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), busyAction: "cleanup", updatedAt: 16 },
    });
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: {
        ...dequeued(card),
        actionMessage: "Removed the competing worktree.",
        updatedAt: 17,
      },
    });
    // The gate is free, so this click now dequeues and completes normally.
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: {
        ...dequeued(card),
        busyAction: "mark-task-done",
        updatedAt: 18,
      },
    });
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: {
        ...dequeued(card),
        actionMessage: "Marked Task-625 done.",
        linkedTask: { ...card.linkedTask!, status: "done" },
        updatedAt: 19,
      },
    });
    socket.receive({ type: "mutationSettled", requestId });
  });

  // The earlier competing snapshot is no longer eligible to recover this
  // successful click or overwrite its newer card outcome.
  expect(sentAfter(mark, "getStateItems")).toHaveLength(0);
  expect(viewedCard()?.busyAction).toBeUndefined();
  expect(viewedCard()?.actionMessage).toBe("Marked Task-625 done.");
  expect(viewedLinkedTask()?.status).toBe("done");
});

it("does not settle a click on the refusal a retry was answering", async () => {
  const refused: PullRequestCard = {
    ...dequeued(card),
    actionError: "The branch is not contained in main.",
  };
  await act(async () => root.render(<CardHarness />));
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: refused,
    });
  });
  // Retrying after a refusal is a supported flow: the buttons stay active
  // beside the error, and the error stays on the card until the next dequeue.
  await act(async () =>
    latestActions.runPullRequestCardAction(card.id, "cleanup"),
  );
  const mark = socket.sent.length;
  expect(viewedCard()?.pendingAction).toBe("cleanup");
  expect(viewedCard()?.actionError).toBeUndefined();

  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: {
        ...refused,
        updatedAt: 20,
        review: { changesRequested: false },
      },
    });
  });
  expect(viewedCard()?.pendingAction).toBe("cleanup");
  expect(viewedCard()?.actionError).toBeUndefined();
  expect(sentAfter(mark, "listWorktrees")).toHaveLength(0);
  expect(sentAfter(mark, "listSessions")).toHaveLength(0);

  // The action's OWN refusal, after the server's dequeue, does settle it — and
  // restores the worktree row this tab removed optimistically.
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(refused), updatedAt: 21, busyAction: "cleanup" },
    });
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: {
        ...refused,
        updatedAt: 22,
        actionError: "A session is still running on that worktree.",
      },
    });
  });
  expect(viewedCard()?.pendingAction).toBeUndefined();
  expect(viewedCard()?.actionError).toBe(
    "A session is still running on that worktree.",
  );
  expect(sentAfter(mark, "listWorktrees")).toHaveLength(1);
  expect(sentAfter(mark, "listSessions")).toHaveLength(1);
});
