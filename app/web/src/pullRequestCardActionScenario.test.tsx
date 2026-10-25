// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { writeAppShellCacheRecord } from "./lib/appShellCacheStore.ts";
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function clickedCard(
  action: "mark-task-done" | "cleanup",
  beforeClick?: (socket: ScenarioSocket) => Promise<void>,
) {
  await act(async () => root.render(<CardHarness />));
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
    socket.receive({ type: "pullRequestCardUpdate", sessionId: "s1", card });
  });
  await beforeClick?.(socket);
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

it("keeps a legacy linked-Task claim across disconnect while ordinary Task controls release", async () => {
  const { socket, requestId } = await clickedCard(
    "mark-task-done",
    async (socket) => {
      await act(async () => {
        latestActions.setTopics(["tasks"]);
        socket.receive({
          type: "taskList",
          list: { request: {}, items: [card.linkedTask!], updatedAt: 1 },
          seq: 1,
          revisions: [{ id: "625", revision: 1 }],
        });
      });
    },
  );
  vi.useFakeTimers();
  await act(async () =>
    latestActions.saveTask({
      id: "625",
      title: "Ordinary edit",
      status: "todo",
    }),
  );
  let windowRequest = "";
  await act(async () => {
    socket.receive({
      type: "workflowRunList",
      updatedAt: 10,
      runs: [
        {
          id: "run-1",
          taskId: "625",
          recipeId: "code-delivery",
          recipeVersion: 1,
          branch: "feature",
          lifecycle: "paused",
          limits: { maxIterations: 3, maxReviewPasses: 1 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      cards: {
        "run-1": {
          runId: "run-1",
          phase: "merge",
          iterationsUsed: 1,
          nextAction: "merge",
          mergeDecisionReady: true,
          canRebaseAndReview: false,
          canRetry: false,
          canResume: false,
          pullRequest: {
            cardId: "workflow-pr",
            sessionId: "impl-1",
            number: 7,
            url: "https://example.test/pull/7",
            delivery: {
              canMerge: true,
              canCleanUp: false,
              settleStillNeeded: false,
              mergeMethods: ["squash"],
              defaultMergeMethod: "squash",
            },
          },
        },
      },
    });
  });
  await act(async () => {
    windowRequest = latestActions.setCompactionWindow("s1", 200_000);
    latestActions.mergeWorkflowRun("run-1", {
      mergeMethod: "squash",
      deleteBranch: true,
    });
  });
  expect(
    latestState.workflowCards["run-1"]?.pullRequest?.delivery?.pendingAction,
  ).toBe("merge");
  await act(async () => socket.close());
  expect(latestState.compactionWindowEdits.s1).toEqual({
    requestId: windowRequest,
    busy: false,
    unknown: true,
  });
  expect(
    latestState.workflowCards["run-1"]?.pullRequest?.delivery?.pendingAction,
  ).toBeUndefined();
  expect(Object.values(latestState.taskMutations)[0]?.status).toBe("idle");
  expect(viewedCard()?.pendingAction).toBe("mark-task-done");
  await act(async () => vi.advanceTimersByTime(1000));
  const next = ScenarioSocket.instances[1]!;
  await act(async () => next.open());
  await act(async () =>
    next.receive({
      type: "taskList",
      list: { request: {}, items: [card.linkedTask!], updatedAt: 2 },
      seq: 2,
      revisions: [{ id: "625", revision: 1 }],
    }),
  );
  await act(async () => latestActions.setTopics([]));
  await act(async () => latestActions.setTopics(["tasks"]));
  expect(next.sent.at(-1)).toEqual({ type: "subscribe", topics: ["tasks"] });
  await act(async () =>
    next.receive({ type: "error", requestId, message: "Legacy refusal" }),
  );
  expect(viewedCard()?.pendingAction).toBeUndefined();
  await act(async () => latestActions.setTopics([]));
  await act(async () => latestActions.setTopics(["tasks"]));
  expect(next.sent.at(-1)).toEqual({
    type: "subscribe",
    topics: ["tasks"],
    digests: ["tasks"],
  });
});

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

describe("the linked Task's recovery from a warm Tasks baseline", () => {
  const linkedId = card.linkedTask!.id;
  const pair: ClientMessage[] = [
    { type: "unsubscribe", topics: ["tasks"] },
    { type: "subscribe", topics: ["tasks"] },
  ];
  const taskSubscribes = (messages: ClientMessage[]) =>
    messages.filter(
      (message) =>
        message.type === "subscribe" && message.topics.includes("tasks"),
    );
  const canonicalTasks = (seq: number): ServerMessage => ({
    type: "taskList",
    list: {
      request: {},
      items: [card.linkedTask!, { ...card.linkedTask!, id: "626" }],
      updatedAt: seq,
    },
    seq,
    revisions: [
      { id: linkedId, revision: 3 },
      { id: "626", revision: 1 },
    ],
  });
  /** Drop `tasks` and take it again; what the re-take sent. */
  async function retake(socket: ScenarioSocket) {
    await act(async () => latestActions.setTopics([]));
    const at = socket.sent.length;
    await act(async () => latestActions.setTopics(["tasks"]));
    return taskSubscribes(socket.sent.slice(at));
  }
  /** Held `tasks` over a canonical list that covers the linked Task. */
  async function warmBaseline(socket: ScenarioSocket) {
    await act(async () => latestActions.setTopics(["tasks"]));
    await act(async () => socket.receive(canonicalTasks(1)));
    expect(latestState.stateEventRevisions.tasks).toHaveProperty(linkedId);
    expect(await retake(socket)).toEqual([
      { type: "subscribe", topics: ["tasks"], digests: ["tasks"] },
    ]);
  }
  /** Refuse the click; the recovery fetch it opened. */
  async function refused(socket: ScenarioSocket, requestId: string) {
    await act(async () =>
      socket.receive({
        type: "error",
        requestId,
        message: "The server is restarting. Try again.",
      }),
    );
    const recovery = socket.sent.findLast(
      (message) => message.type === "getStateItems",
    );
    if (recovery?.type !== "getStateItems") throw new Error("no recovery");
    expect(recovery.ids).toEqual([linkedId]);
    return recovery;
  }

  beforeEach(() => {
    // No Task list survives from another case.
    writeAppShellCacheRecord({
      version: 1,
      savedAt: Date.now(),
      models: [],
      agents: [],
      sessions: [],
      settings: {},
      slashCommands: [],
    });
  });

  it("resubscribes a held topic when the recovery answers incompletely", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { socket, requestId } = await clickedCard(
      "mark-task-done",
      warmBaseline,
    );
    const recovery = await refused(socket, requestId);
    const mark = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateItems",
        topic: "tasks",
        requestId: recovery.requestId,
        events: [],
      }),
    );
    expect(socket.sent.slice(mark)).toEqual(pair);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] tasks recovery fallback: targeted item response was incomplete",
    );
    expect(latestState.stateEventRevisions.tasks).not.toHaveProperty(linkedId);
    expect(socket.sent.some((message) => message.type === "listTasks")).toBe(
      false,
    );
  });

  it("consumes a stamped recovery error into the same fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { socket, requestId } = await clickedCard(
      "mark-task-done",
      warmBaseline,
    );
    const recovery = await refused(socket, requestId);
    const errorBefore = latestState.error;
    const mark = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "error",
        requestId: recovery.requestId,
        message: "Recovery read failed",
      }),
    );
    expect(socket.sent.slice(mark)).toEqual(pair);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] tasks recovery fallback: Recovery read failed",
    );
    expect(latestState.error).toBe(errorBefore);
    expect(latestState.error).not.toBe("Recovery read failed");
    expect(latestState.stateEventRevisions.tasks).not.toHaveProperty(linkedId);
    expect(socket.sent.some((message) => message.type === "listTasks")).toBe(
      false,
    );
  });

  it("times an unheld recovery out into a due snapshot, sending nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { socket, requestId } = await clickedCard(
      "mark-task-done",
      async (socket) => {
        await warmBaseline(socket);
        await act(async () => latestActions.setTopics([]));
        vi.useFakeTimers();
      },
    );
    await refused(socket, requestId);
    const mark = socket.sent.length;
    await act(async () => vi.advanceTimersByTime(9_999));
    expect(socket.sent.slice(mark)).toEqual([]);
    expect(latestState.stateEventRevisions.tasks).toHaveProperty(linkedId);
    await act(async () => vi.advanceTimersByTime(1));
    expect(socket.sent.slice(mark)).toEqual([]);
    expect(latestState.stateEventRevisions.tasks).not.toHaveProperty(linkedId);

    const takenAt = socket.sent.length;
    await act(async () => latestActions.setTopics(["tasks"]));
    expect(taskSubscribes(socket.sent.slice(takenAt))).toEqual([
      { type: "subscribe", topics: ["tasks"] },
    ]);
    await act(async () => socket.receive(canonicalTasks(2)));
    expect(await retake(socket)).toEqual([
      { type: "subscribe", topics: ["tasks"], digests: ["tasks"] },
    ]);
  });

  it("makes the reconnect a snapshot when the recovery is open at the disconnect", async () => {
    const { socket, requestId } = await clickedCard(
      "mark-task-done",
      async (socket) => {
        await warmBaseline(socket);
        vi.useFakeTimers();
      },
    );
    await refused(socket, requestId);
    expect(latestState.stateEventRevisions.tasks).toHaveProperty(linkedId);
    await act(async () => socket.close());
    expect(latestState.stateEventRevisions.tasks).not.toHaveProperty(linkedId);
    await act(async () => vi.advanceTimersByTime(1_000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    expect(taskSubscribes(next.sent)).toEqual([
      { type: "subscribe", topics: ["tasks"] },
    ]);
    await act(async () => next.receive(canonicalTasks(2)));
    expect(await retake(next)).toEqual([
      { type: "subscribe", topics: ["tasks"], digests: ["tasks"] },
    ]);
  });
});
