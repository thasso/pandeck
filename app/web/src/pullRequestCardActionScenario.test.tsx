// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  PullRequestCard,
  ServerMessage,
} from "@assistant/shared";
import { PullRequestCard as PullRequestCardView } from "./components/PullRequestCard.tsx";
import {
  useAssistant,
  type AssistantActions,
  type ClientPullRequestCard,
  type UIState,
} from "./hooks/useAssistant.ts";
import {
  readAppShellCacheRecord,
  writeAppShellCacheRecord,
} from "./lib/appShellCacheStore.ts";
import { getToasts } from "./lib/toast.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { dispatched } = vi.hoisted(() => ({ dispatched: [] as unknown[] }));

// Capture the actual dispatch boundary, including no-op reducer actions. A UI
// assertion alone cannot detect a redundant result after busy removed pending.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useReducer<S, A, I>(
      reducer: (state: S, action: A) => S,
      initial: I,
      init: (value: I) => S,
    ) {
      const [state, dispatch] = actual.useReducer(reducer, initial, init);
      const capture = actual.useCallback(
        (action: A) => {
          dispatched.push(action);
          dispatch(action);
        },
        [dispatch],
      );
      return [state, capture];
    },
  };
});
const resultActions = () =>
  dispatched.filter(
    (action) =>
      (action as { kind?: string }).kind === "pullRequestCardActionResult",
  );

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

function CardHarness({ renderCard = false }: { renderCard?: boolean }) {
  const { actions, state } = useAssistant();
  latestActions = actions;
  latestState = state;
  const subject = state.pullRequestCards[0]?.blocks.find(
    (block) => block.kind === "pullRequest",
  )?.pullRequest;
  return renderCard && subject ? (
    <PullRequestCardView
      pullRequest={subject}
      onAction={actions.runPullRequestCardAction}
    />
  ) : null;
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
  dispatched.length = 0;
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
  action: "mark-task-done" | "cleanup" | "merge" | "update-with-main",
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

it("releases all migrated claims together on genuine loss and recovers after subscribe", async () => {
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
  expect(viewedCard()?.pendingAction).toBeUndefined();
  expect(viewedCard()?.optimisticLinkedTask).toBeUndefined();
  expect(latestState.stateEventRevisions.tasks).not.toHaveProperty("625");
  const results = resultActions().length;
  const offlineMark = socket.sent.length;
  await act(async () => vi.advanceTimersByTime(1000));
  expect(socket.sent.slice(offlineMark)).toEqual([]);
  const next = ScenarioSocket.instances[1]!;
  await act(async () => next.open());
  const subscribeAt = next.sent.findIndex((msg) => msg.type === "subscribe");
  const recoveryAt = next.sent.findIndex((msg) => msg.type === "getStateItems");
  expect(subscribeAt).toBeGreaterThanOrEqual(0);
  expect(recoveryAt).toBeGreaterThan(subscribeAt);
  expect(next.sent[subscribeAt]).toMatchObject({
    type: "subscribe",
    topics: ["tasks"],
  });
  expect(next.sent[subscribeAt]).not.toHaveProperty("digests");
  expect(resultActions()).toHaveLength(results);
  const recovery = next.sent[recoveryAt];
  if (recovery?.type !== "getStateItems") throw new Error("missing recovery");
  await act(async () =>
    next.receive({
      type: "stateItems",
      topic: "tasks",
      requestId: recovery.requestId,
      events: [
        { kind: "upsert", id: "625", revision: 1, item: card.linkedTask! },
      ],
    }),
  );
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
  expect(next.sent.at(-1)).toEqual({
    type: "subscribe",
    topics: ["tasks"],
    digests: ["tasks"],
  });
  await act(async () => {
    next.receive({ type: "mutationSettled", requestId });
    vi.advanceTimersByTime(900_000);
  });
  expect(viewedCard()?.actionError).toBeUndefined();
  expect(resultActions()).toHaveLength(results);
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

it("returns the linked-Task control on a stamped refusal without interrupting viewed streaming", async () => {
  const { socket, requestId, mark } = await clickedCard("mark-task-done");
  expect(viewedLinkedTask()?.status).toBe("done");
  await act(async () =>
    socket.receive({
      type: "snapshot",
      state: { sessionId: "s1", harness: "pi", agentType: "assistant" },
      snapshot: {
        sessionId: "s1",
        runState: "running",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [
          {
            streamId: "live-1",
            kind: "message",
            role: "assistant",
            content: [{ type: "text", text: "still streaming" }],
          },
        ],
      },
      contextInfo: null,
    } as unknown as ServerMessage),
  );
  const streams = latestState.liveStreams;
  const error = latestState.error;
  expect(
    latestState.messages.some(
      (message) => message.id === `pull-request-card-${card.id}`,
    ),
  ).toBe(true);

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
  expect(latestState.runState).toBe("running");
  expect(latestState.liveStreams).toBe(streams);
  expect(latestState.error).toBe(error);
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
  const command = socket.sent.findLast(
    (msg) => msg.type === "pullRequestCardAction",
  );
  if (command?.type !== "pullRequestCardAction")
    throw new Error("missing click");
  const results = resultActions().length;
  await act(async () =>
    socket.receive({ type: "mutationSettled", requestId: command.requestId! }),
  );
  expect(resultActions()).toHaveLength(results);
  expect(sentAfter(mark, "listWorktrees")).toHaveLength(1);
  expect(sentAfter(mark, "listSessions")).toHaveLength(1);
});

it.each(["card", "viewed", "listed"] as const)(
  "cleanup recovers worktree from %s and the current archived/live sessions",
  async (source) => {
    vi.useFakeTimers();
    await act(async () => root.render(<CardHarness />));
    const socket = ScenarioSocket.instances[0]!;
    const session = (id: string) => ({
      id,
      harness: "pi" as const,
      agentType: "assistant" as const,
      title: id,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      worktreeId: "wt-1",
    });
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
    const { worktreeId: _worktreeId, ...withoutWorktree } = card;
    const subject = source === "card" ? card : withoutWorktree;
    const ready = readyMessage();
    if (ready.type !== "ready") throw new Error("bad ready");
    await act(async () => {
      socket.open();
      socket.receive({
        ...ready,
        state: {
          sessionId: "s1",
          harness: "pi",
          agentType: "assistant",
          thinkingLevel: "off",
          ...(source === "viewed" ? { worktreeId: "wt-1" } : {}),
        },
      });
      socket.receive({
        type: "sessions",
        sessions: [session("s1"), session("s2")],
        archivedSessionsLoaded: source === "listed",
      });
      socket.receive({
        type: "worktreeList",
        worktrees: [worktree],
        updatedAt: 1,
      });
      socket.receive({
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: subject,
      });
    });
    await act(async () => latestActions.setTopics(["worktrees"]));
    await act(async () =>
      latestActions.runPullRequestCardAction(card.id, "cleanup"),
    );
    expect(latestState.worktrees).toEqual([]);
    const mark = socket.sent.length;
    await act(async () => socket.close());
    expect(latestState.worktrees).toEqual([]); // no inverse at loss
    expect(socket.sent.slice(mark)).toEqual([]);
    expect(viewedCard()?.pendingAction).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(1_000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    expect(
      next.sent.findIndex((msg) => msg.type === "listWorktrees"),
    ).toBeGreaterThan(next.sent.findIndex((msg) => msg.type === "subscribe"));
    expect(
      next.sent.filter((msg) => msg.type === "listWorktrees"),
    ).toHaveLength(1);
    expect(
      next.sent.filter(
        (msg) =>
          msg.type ===
          (source === "listed" ? "loadArchivedSessions" : "listSessions"),
      ),
    ).toHaveLength(1);
    expect(
      next.sent.filter(
        (msg) =>
          msg.type ===
          (source === "listed" ? "listSessions" : "loadArchivedSessions"),
      ),
    ).toHaveLength(0);
    await act(async () => {
      next.receive({
        type: "worktreeList",
        worktrees: source === "listed" ? [] : [worktree],
        updatedAt: 2,
      });
      next.receive({
        type: "sessions",
        sessions: [session("s1"), session("s2")].map((row) => ({
          ...row,
          settledAt: 2,
        })),
        archivedSessionsLoaded: source === "listed",
      });
    });
    expect(latestState.worktrees?.map((row) => row.id)).toEqual(
      source === "listed" ? [] : ["wt-1"],
    );
    expect(latestState.sessions.map((row) => [row.id, row.settledAt])).toEqual([
      ["s1", 2],
      ["s2", 2],
    ]);
  },
);

it("dispatches no result during busy, watcher, other-card or settle-only phases", async () => {
  const { socket, requestId } = await clickedCard("merge");
  expect(resultActions()).toEqual([]);
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...card, updatedAt: 30 },
    });
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...card, id: "other", busyAction: "merge" },
    });
    socket.receive({ type: "mutationSettled", requestId });
  });
  expect(
    resultActions(),
    "incomplete handshake must not dispatch a result",
  ).toEqual([]);
  await act(async () =>
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), busyAction: "merge" },
    }),
  );
  expect(
    resultActions(),
    "matching busy must not dispatch a redundant result",
  ).toEqual([]);
  await act(async () =>
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: dequeued(card),
    }),
  );
  expect(resultActions()).toEqual([
    { kind: "pullRequestCardActionResult", cardId: card.id },
  ]);
  await act(async () => socket.receive({ type: "mutationSettled", requestId }));
  expect(resultActions()).toHaveLength(1);
});

it("lets only A consume B's busy observation while A still awaits settle", async () => {
  const { socket, requestId: a } = await clickedCard("merge");
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), busyAction: "merge" },
    });
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: dequeued(card),
    });
  });
  expect(viewedCard()?.busyAction).toBeUndefined();
  await act(async () =>
    latestActions.runPullRequestCardAction(card.id, "cleanup"),
  );
  const b = socket.sent.findLast((msg) => msg.type === "pullRequestCardAction");
  if (b?.type !== "pullRequestCardAction") throw new Error("missing B");
  await act(async () =>
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), busyAction: "cleanup" },
    }),
  );
  expect(resultActions()).toHaveLength(0);
  await act(async () =>
    socket.receive({ type: "mutationSettled", requestId: a }),
  );
  expect(resultActions()).toHaveLength(1);
  // B did not see its own busy: neither idle nor its own settle can complete it.
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: dequeued(card),
    });
    socket.receive({ type: "mutationSettled", requestId: a });
    socket.receive({ type: "mutationSettled", requestId: b.requestId! });
  });
  expect(resultActions()).toHaveLength(1);
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), busyAction: "cleanup" },
    });
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: dequeued(card),
    });
  });
  expect(resultActions()).toHaveLength(2);
});

it("keeps two cards independent and treats later different busy as own outcome", async () => {
  const { socket, requestId: a, mark } = await clickedCard("merge");
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...card, id: "other" },
    });
  });
  await act(async () =>
    latestActions.runPullRequestCardAction("other", "cleanup"),
  );
  const b = socket.sent.findLast((msg) => msg.type === "pullRequestCardAction");
  if (b?.type !== "pullRequestCardAction") throw new Error("missing B");
  await act(async () => {
    socket.receive({ type: "mutationSettled", requestId: b.requestId! });
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), id: "other", busyAction: "merge" },
    });
  });
  expect(resultActions()).toEqual([
    {
      kind: "pullRequestCardActionResult",
      cardId: "other",
      authoritativeCard: {
        ...dequeued(card),
        id: "other",
        busyAction: "merge",
      },
    },
  ]);
  expect(viewedCard()?.pendingAction).toBe("merge");
  await act(async () => {
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), busyAction: "merge" },
    });
    socket.receive({
      type: "pullRequestCardUpdate",
      sessionId: "s1",
      card: { ...dequeued(card), busyAction: "cleanup" },
    });
    socket.receive({ type: "mutationSettled", requestId: a });
  });
  expect(resultActions()).toHaveLength(2);
  expect(sentAfter(mark, "listWorktrees")).toHaveLength(1); // Only losing B recovered.
});

it.each(["mark-task-done", "merge", "update-with-main", "cleanup"] as const)(
  "keeps the original %s deadline after settle",
  async (action) => {
    vi.useFakeTimers();
    const { socket, requestId, mark } = await clickedCard(action);
    const deadline = action === "mark-task-done" ? 30_000 : 900_000;
    await act(async () => vi.advanceTimersByTime(deadline - 1));
    await act(async () =>
      socket.receive({ type: "mutationSettled", requestId }),
    );
    expect(resultActions()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(1));
    expect(resultActions()).toEqual([
      {
        kind: "pullRequestCardActionResult",
        cardId: card.id,
        error: "The server did not answer this pull request action. Try again.",
      },
    ]);
    expect(sentAfter(mark, "getStateItems")).toHaveLength(
      action === "mark-task-done" ? 1 : 0,
    );
    expect(sentAfter(mark, "listWorktrees")).toHaveLength(
      action === "cleanup" ? 1 : 0,
    );
    expect(sentAfter(mark, "listSessions")).toHaveLength(
      action === "cleanup" ? 1 : 0,
    );
    await act(async () => vi.advanceTimersByTime(deadline));
    expect(resultActions()).toHaveLength(1);
  },
);

it.each(["before-busy", "busy", "settled", "outcome"] as const)(
  "retires unknown in the %s phase, retaining durable authority",
  async (phase) => {
    vi.useFakeTimers();
    const { socket, requestId, mark } = await clickedCard("mark-task-done");
    const toasts = getToasts().length;
    await act(async () => {
      if (phase === "busy" || phase === "outcome")
        socket.receive({
          type: "pullRequestCardUpdate",
          sessionId: "s1",
          card: { ...dequeued(card), busyAction: "mark-task-done" },
        });
      if (phase === "outcome")
        socket.receive({
          type: "pullRequestCardUpdate",
          sessionId: "s1",
          card: dequeued(card),
        });
      if (phase === "settled")
        socket.receive({ type: "mutationSettled", requestId });
      socket.close();
      socket.close();
    });
    expect(resultActions()).toHaveLength(1);
    expect(viewedCard()?.pendingAction).toBeUndefined();
    expect(viewedCard()?.optimisticLinkedTask).toBeUndefined();
    expect(viewedCard()?.busyAction).toBe(
      phase === "busy" ? "mark-task-done" : undefined,
    );
    expect(viewedCard()?.actionError).toBeUndefined();
    expect(sentAfter(mark, "getStateItems")).toHaveLength(0);
    expect(getToasts()).toHaveLength(toasts);
    await act(async () => vi.advanceTimersByTime(900_000));
    expect(resultActions()).toHaveLength(1);
    expect(viewedCard()?.actionError).toBeUndefined();
  },
);

it.each(["mark-task-done", "cleanup"] as const)(
  "deferred %s recovery cannot release newer offline B",
  async (action) => {
    vi.useFakeTimers();
    const { socket, requestId: a } = await clickedCard(action);
    await act(async () => {
      // A remembers raw competitor history, which must never be restored by
      // its deferred recovery over B's newer local claim.
      socket.receive({
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: { ...dequeued(card), busyAction: "merge" },
      });
      socket.receive({
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: dequeued(card),
      });
      socket.close();
    });
    await act(async () =>
      latestActions.runPullRequestCardAction(card.id, action),
    );
    expect(viewedCard()?.pendingAction).toBe(action);
    const results = resultActions().length;
    await act(async () =>
      latestActions.runPullRequestCardAction(card.id, action),
    );
    await act(async () => vi.advanceTimersByTime(1_000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.close()); // failed attempt must leave B queued
    expect(viewedCard()?.pendingAction).toBe(action);
    await act(async () => vi.advanceTimersByTime(2_000));
    const open = ScenarioSocket.instances[2]!;
    await act(async () => open.open());
    const commands = open.sent.filter(
      (msg) => msg.type === "pullRequestCardAction",
    );
    expect(commands).toHaveLength(1);
    expect(resultActions()).toHaveLength(results);
    expect(viewedCard()?.pendingAction).toBe(action);
    expect(
      open.sent.filter((msg) => msg.type === "getStateItems"),
    ).toHaveLength(action === "mark-task-done" ? 1 : 0);
    expect(
      open.sent.filter((msg) => msg.type === "listWorktrees"),
    ).toHaveLength(action === "cleanup" ? 1 : 0);
    expect(open.sent.filter((msg) => msg.type === "listSessions")).toHaveLength(
      action === "cleanup" ? 1 : 0,
    );
    await act(async () =>
      open.receive({ type: "mutationSettled", requestId: a }),
    );
    expect(viewedCard()?.pendingAction).toBe(action);
    expect(resultActions()).toHaveLength(results);
  },
);

it.each(["known", "timeout", "loss"] as const)(
  "preserves synthetic boot-offline claims through failed attempts until %s",
  async (answer) => {
    vi.useFakeTimers();
    await act(async () => root.render(<CardHarness />));
    const offline = ScenarioSocket.instances[0]!;
    // Synthetic known authority, not a PR boot-cache feature.
    await act(async () => {
      offline.receive(readyMessage());
      offline.receive({ type: "pullRequestCardUpdate", sessionId: "s1", card });
    });
    await act(async () =>
      latestActions.runPullRequestCardAction(card.id, "mark-task-done"),
    );
    await act(async () => offline.close());
    expect(viewedCard()?.pendingAction).toBe("mark-task-done");
    await act(async () => vi.advanceTimersByTime(1_000));
    const failed = ScenarioSocket.instances[1]!;
    await act(async () => failed.close());
    await act(async () =>
      latestActions.runPullRequestCardAction(card.id, "mark-task-done"),
    );
    expect(resultActions()).toHaveLength(0);
    expect(failed.sent).toEqual([]);
    if (answer === "timeout") {
      await act(async () => vi.advanceTimersByTime(28_999));
      expect(resultActions()).toHaveLength(0);
      await act(async () => vi.advanceTimersByTime(1));
      expect(viewedCard()?.actionError).toBe(
        "The server did not answer this pull request action. Try again.",
      );
      return;
    }
    await act(async () => vi.advanceTimersByTime(2_000));
    const open = ScenarioSocket.instances[2]!;
    await act(async () => open.open());
    const command = open.sent.find(
      (msg) => msg.type === "pullRequestCardAction",
    );
    if (command?.type !== "pullRequestCardAction")
      throw new Error("missing queued command");
    expect(
      open.sent.filter((msg) => msg.type === "pullRequestCardAction"),
    ).toHaveLength(1);
    if (answer === "known")
      await act(async () => {
        open.receive({
          type: "pullRequestCardUpdate",
          sessionId: "s1",
          card: { ...dequeued(card), busyAction: "mark-task-done" },
        });
        open.receive({
          type: "mutationSettled",
          requestId: command.requestId!,
        });
        open.receive({
          type: "pullRequestCardUpdate",
          sessionId: "s1",
          card: dequeued(card),
        });
      });
    else await act(async () => open.close());
    expect(viewedCard()?.pendingAction).toBeUndefined();
    expect(resultActions()).toHaveLength(1);
  },
);

it("abandons pending timers at teardown and remains usable on remount", async () => {
  vi.useFakeTimers();
  const { socket, mark } = await clickedCard("cleanup");
  await act(async () => root.unmount());
  const results = resultActions().length;
  await act(async () => vi.advanceTimersByTime(900_000));
  expect(socket.sent.slice(mark)).toEqual([]);
  expect(resultActions()).toHaveLength(results);
  root = createRoot(container);
  await act(async () => root.render(<CardHarness />));
  const next = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    next.open();
    next.receive(readyMessage());
    next.receive({ type: "pullRequestCardUpdate", sessionId: "s1", card });
  });
  await act(async () =>
    latestActions.runPullRequestCardAction(card.id, "merge"),
  );
  expect(viewedCard()?.pendingAction).toBe("merge");
});

it.each([false, true])(
  "retains real merge choices through refusal and reconnect, batched loss=%s",
  async (batched) => {
    vi.useFakeTimers();
    const offered: PullRequestCard = {
      ...card,
      repositoryCapabilities: {
        defaultBranch: "main",
        mergeMethods: ["squash", "merge", "rebase"],
        canClose: true,
      },
    };
    await act(async () => root.render(<CardHarness renderCard />));
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
      socket.receive({
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: offered,
      });
    });
    const method = container.querySelector<HTMLButtonElement>(
      '[aria-label="Merge method"]',
    )!;
    await act(async () => method.click());
    const rebase = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((node) => node.textContent?.trim() === "Rebase")!;
    await act(async () => rebase.click());
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => checkbox.click());
    const merge = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent?.trim() === "Merge",
      )!;
    const node = merge();
    await act(async () => node.click());
    const command = socket.sent.find(
      (msg) => msg.type === "pullRequestCardAction",
    );
    if (command?.type !== "pullRequestCardAction")
      throw new Error("missing merge");
    expect(command).toMatchObject({
      mergeMethod: "rebase",
      deleteBranch: false,
    });
    await act(async () =>
      socket.receive({
        type: "error",
        requestId: command.requestId!,
        message: "Merge refused",
      }),
    );
    expect(viewedCard()?.actionError).toBe("Merge refused");
    if (batched)
      await act(async () => {
        merge().click();
        socket.close();
      });
    else {
      await act(async () => merge().click());
      await act(async () => socket.close());
    }
    expect(checkbox.checked).toBe(false);
    expect(
      container.querySelector('[aria-label="Merge method"]')?.textContent,
    ).toContain("Rebase");
    await act(async () => vi.advanceTimersByTime(1_000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => {
      next.open();
      next.receive({
        type: "snapshot",
        state: { sessionId: "s1", harness: "pi", agentType: "assistant" },
        snapshot: {
          sessionId: "s1",
          runState: "idle",
          timeline: [],
          timelineStart: 0,
          totalEntryCount: 0,
          streaming: [],
        },
        contextInfo: null,
      } as unknown as ServerMessage);
      next.receive({
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: offered,
      });
    });
    expect(merge()).toBe(node);
    expect(container.querySelector('input[type="checkbox"]')).toBe(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(method.textContent).toContain("Rebase");
    await act(async () => merge().click());
    expect(
      next.sent.find((msg) => msg.type === "pullRequestCardAction"),
    ).toMatchObject({ mergeMethod: "rebase", deleteBranch: false });
  },
);

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

  it.each([false, true])(
    "unknown linked-Task recovery is targeted beside snapshot, newer offline B=%s",
    async (newer) => {
      vi.useFakeTimers();
      const { socket, requestId: a } = await clickedCard(
        "mark-task-done",
        warmBaseline,
      );
      expect(
        latestState.taskList?.items.find((item) => item.id === linkedId)
          ?.status,
      ).toBe("done");
      await act(async () => socket.close());
      expect(latestState.stateEventRevisions.tasks).not.toHaveProperty(
        linkedId,
      );
      expect(viewedLinkedTask()?.status).toBe("todo");
      // No canonical inverse is applied on loss.
      expect(
        latestState.taskList?.items.find((item) => item.id === linkedId)
          ?.status,
      ).toBe("done");
      if (newer)
        await act(async () =>
          latestActions.runPullRequestCardAction(card.id, "mark-task-done"),
        );
      const results = resultActions().length;
      await act(async () => vi.advanceTimersByTime(1_000));
      const next = ScenarioSocket.instances[1]!;
      await act(async () => next.open());
      expect(taskSubscribes(next.sent)).toEqual([
        { type: "subscribe", topics: ["tasks"] },
      ]);
      const recovery = next.sent.find((msg) => msg.type === "getStateItems");
      if (recovery?.type !== "getStateItems")
        throw new Error("missing recovery");
      expect(next.sent.indexOf(recovery)).toBeGreaterThan(
        next.sent.findIndex((msg) => msg.type === "subscribe"),
      );
      expect(
        next.sent.some(
          (msg) => msg.type === "unsubscribe" || msg.type === "listTasks",
        ),
      ).toBe(false);
      // A filtered list cannot answer canonical recovery.
      await act(async () =>
        next.receive({
          type: "taskList",
          list: { request: { status: "done" }, items: [], updatedAt: 2 },
          seq: 2,
          revisions: [],
        }),
      );
      expect(latestState.taskList?.items).toHaveLength(2);
      await act(async () => next.receive(canonicalTasks(2)));
      const authoritative = {
        ...card.linkedTask!,
        title: "Current recovery authority",
        status: "doing" as const,
      };
      await act(async () =>
        next.receive({
          type: "stateItems",
          topic: "tasks",
          requestId: recovery.requestId,
          events: [
            { kind: "upsert", id: linkedId, revision: 3, item: authoritative },
          ],
        }),
      );
      expect(
        latestState.taskList?.items.find((item) => item.id === linkedId),
      ).toMatchObject(authoritative);
      expect(viewedCard()?.linkedTask).toMatchObject(authoritative);
      expect(viewedCard()?.optimisticLinkedTask).toBeUndefined();
      expect(viewedCard()?.pendingAction).toBe(
        newer ? "mark-task-done" : undefined,
      );
      expect(resultActions()).toHaveLength(results);
      await act(async () =>
        next.receive({ type: "mutationSettled", requestId: a }),
      );
      expect(resultActions()).toHaveLength(results);
      if (!newer)
        expect(await retake(next)).toEqual([
          { type: "subscribe", topics: ["tasks"], digests: ["tasks"] },
        ]);
      else {
        const at = next.sent.length;
        await act(async () =>
          latestActions.runPullRequestCardAction(card.id, "mark-task-done"),
        );
        expect(next.sent.slice(at)).toEqual([]); // B's guard remains.
      }
    },
  );

  it("resumes cache admission after unknown without persisting the unsafe Task baseline", async () => {
    const { socket } = await clickedCard("mark-task-done", async (socket) => {
      await warmBaseline(socket);
      await act(async () => window.dispatchEvent(new Event("pagehide")));
      expect(readAppShellCacheRecord()?.taskList).toMatchObject({
        items: [expect.objectContaining({ status: "todo" }), expect.anything()],
      });
    });
    await act(async () =>
      socket.receive({
        type: "settings",
        settings: { ...latestState.settings, skills: { notes: "on" } },
      }),
    );
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(readAppShellCacheRecord()?.settings).not.toMatchObject({
      skills: { notes: "on" },
    });
    await act(async () => socket.close());
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(readAppShellCacheRecord()?.settings).toMatchObject({
      skills: { notes: "on" },
    });
    expect(readAppShellCacheRecord()?.taskList).toBeNull();
  });

  it("keeps unheld Tasks unheld on unknown and drops a recovery lost again without retry", async () => {
    vi.useFakeTimers();
    const { socket } = await clickedCard("mark-task-done", async (socket) => {
      await warmBaseline(socket);
      await act(async () => latestActions.setTopics([]));
    });
    await act(async () => socket.close());
    await act(async () => vi.advanceTimersByTime(1_000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    expect(taskSubscribes(next.sent)).toEqual([]);
    expect(
      next.sent.filter((msg) => msg.type === "getStateItems"),
    ).toHaveLength(1);
    await act(async () => next.close());
    const results = resultActions().length;
    await act(async () => vi.advanceTimersByTime(30_000));
    const third = ScenarioSocket.instances[2]!;
    await act(async () => third.open());
    expect(
      third.sent.filter((msg) => msg.type === "getStateItems"),
    ).toHaveLength(0);
    expect(resultActions()).toHaveLength(results);
    expect(await retake(third)).toEqual([
      { type: "subscribe", topics: ["tasks"] },
    ]);
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
