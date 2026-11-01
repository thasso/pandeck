// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  WorkflowRunCard,
  WorkflowRunDelivery,
  WorkflowRunSummary,
} from "@assistant/shared";
import {
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";

/**
 * The two DELIVERY controls on a Task's Workflow card, between the click and
 * the server's answer.
 *
 * The run's `busyAction` is the pull-request card's, re-projected onto the run
 * list and broadcast from there, so a control that follows only the server
 * stands still until a store write, an async broadcast and a whole run-list
 * rebuild have happened — which is a button that looks broken. The click's own
 * overlay covers exactly that window, and nothing beyond it: the moment the
 * server states the action, every viewer reads the same durable one.
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

const run: WorkflowRunSummary = {
  id: "7",
  taskId: "370",
  recipeId: "code-delivery",
  recipeVersion: 4,
  branch: "t370-card",
  lifecycle: "paused",
  limits: { maxIterations: 3, maxReviewPasses: 1 },
  createdAt: 1,
  updatedAt: 2,
};

/**
 * The run at its merge seam, carrying the PREVIOUS action's refusal: the card
 * clears that sentence only when it dequeues the next action, so every run-list
 * broadcast in between re-states it.
 */
const mergeable: WorkflowRunDelivery = {
  canMerge: true,
  canCleanUp: false,
  settleStillNeeded: false,
  mergeMethods: ["squash", "merge"],
  defaultMergeMethod: "squash",
  error: "The head moved while merging.",
};

function runList(delivery: WorkflowRunDelivery, updatedAt = 10): ServerMessage {
  const card: WorkflowRunCard = {
    runId: "7",
    phase: "merge",
    iterationsUsed: 1,
    nextAction: "waiting for your merge decision",
    mergeDecisionReady: true,
    canRebaseAndReview: false,
    canRetry: false,
    canResume: false,
    pullRequest: {
      cardId: "pr-1",
      sessionId: "impl-1",
      number: 42,
      url: "https://example.test/pull/42",
      delivery,
    },
  };
  return {
    type: "workflowRunList",
    runs: [run],
    cards: { "7": card },
    updatedAt,
  };
}

let latestActions: AssistantActions;
let latestState: UIState;

function DeliveryHarness() {
  const { actions, state } = useAssistant();
  latestActions = actions;
  latestState = state;
  return null;
}

let root: Root;
let container: HTMLDivElement;

const viewedDelivery = () =>
  latestState.workflowCards["7"]?.pullRequest?.delivery;

beforeEach(() => {
  ScenarioSocket.instances = [];
  // The click's deadline is 15 minutes — long enough that a merge talking to a
  // provider is never cut short — so the tests that ask what happens at it
  // drive the clock rather than wait.
  vi.useFakeTimers();
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
});

async function clickedMerge() {
  await act(async () => root.render(<DeliveryHarness />));
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  // The Task page holds the run topic; the card the controls belong to is what
  // that subscription answers with.
  await act(async () => latestActions.setTopics(["workflow"]));
  await act(async () => socket.receive(runList(mergeable)));
  await act(async () =>
    latestActions.mergeWorkflowRun("7", {
      mergeMethod: "merge",
      deleteBranch: true,
    }),
  );
  const sent = socket.sent.find(
    (message) => message.type === "mergeWorkflowRun",
  );
  expect(sent).toMatchObject({ runId: "7", mergeMethod: "merge" });
  const requestId =
    sent?.type === "mergeWorkflowRun" ? sent.requestId : undefined;
  expect(requestId).toBeTypeOf("string");
  return { socket, requestId: requestId!, mark: socket.sent.length };
}

it("does not bank a pre-settle idle list or repeat a settled relist", async () => {
  const { socket, requestId } = await clickedMerge();
  await act(async () => socket.receive(runList(mergeable, 11)));
  const mark = socket.sent.length;
  await act(async () => socket.receive({ type: "mutationSettled", requestId }));
  expect(viewedDelivery()?.pendingAction).toBe("merge");
  expect(socket.sent.slice(mark)).toEqual([
    { type: "unsubscribe", topics: ["workflow"] },
    { type: "subscribe", topics: ["workflow"] },
  ]);
  await act(async () => vi.advanceTimersByTime(899_999));
  await act(async () => socket.receive({ type: "mutationSettled", requestId }));
  expect(viewedDelivery()?.pendingAction).toBe("merge");
  expect(socket.sent.slice(mark)).toHaveLength(2);
  await act(async () => vi.advanceTimersByTime(1));
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
  expect(viewedDelivery()?.error).toBe(
    "The server did not answer this delivery action. Try again.",
  );
});

function runsList(
  deliveries: Record<string, WorkflowRunDelivery>,
  updatedAt: number,
): ServerMessage {
  const base = runList(mergeable);
  if (base.type !== "workflowRunList")
    throw new Error("Expected workflow list");
  const template = base.cards["7"]!;
  return {
    type: "workflowRunList",
    updatedAt,
    runs: Object.keys(deliveries).map((id) => ({ ...run, id })),
    cards: Object.fromEntries(
      Object.entries(deliveries).map(([id, delivery]) => [
        id,
        {
          ...template,
          runId: id,
          pullRequest: {
            ...template.pullRequest!,
            cardId: `pr-${id}`,
            delivery,
          },
        },
      ]),
    ),
  };
}

it("resolves two runs independently and ignores late addressed settles for a newer click", async () => {
  const { socket, requestId: old } = await clickedMerge();
  await act(async () =>
    socket.receive(runsList({ "7": mergeable, "8": mergeable }, 11)),
  );
  await act(async () => latestActions.cleanUpWorkflowRun("8"));
  expect(
    latestState.workflowCards["8"]?.pullRequest?.delivery?.pendingAction,
  ).toBe("cleanup");
  await act(async () =>
    socket.receive(
      runsList(
        { "7": mergeable, "8": { ...mergeable, busyAction: "cleanup" } },
        12,
      ),
    ),
  );
  expect(viewedDelivery()?.pendingAction).toBe("merge");
  expect(
    latestState.workflowCards["8"]?.pullRequest?.delivery?.pendingAction,
  ).toBeUndefined();
  await act(async () =>
    socket.receive({ type: "mutationSettled", requestId: old }),
  );
  await act(async () =>
    socket.receive(
      runsList(
        { "7": { ...mergeable, error: "durable refusal" }, "8": mergeable },
        13,
      ),
    ),
  );
  expect(viewedDelivery()?.error).toBe("durable refusal");
  await act(async () => latestActions.cleanUpWorkflowRun("7"));
  const current = socket.sent
    .filter((msg) => msg.type === "cleanUpWorkflowRun")
    .find((msg) => msg.runId === "7")!;
  expect(current.requestId).not.toBe(old);
  const mark = socket.sent.length;
  await act(async () =>
    socket.receive({ type: "mutationSettled", requestId: old }),
  );
  expect(socket.sent).toHaveLength(mark);
  expect(viewedDelivery()?.pendingAction).toBe("cleanup");
  await act(async () =>
    socket.receive(
      runsList(
        {
          "7": {
            ...mergeable,
            busyAction: "merge",
            canMerge: false,
            error: "authority",
          },
          "8": mergeable,
        },
        14,
      ),
    ),
  );
  expect(viewedDelivery()).toMatchObject({
    busyAction: "merge",
    canMerge: false,
    error: "authority",
  });
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
});

it("loss while settled-awaiting-list releases before reconnect and never relists twice", async () => {
  const { socket, requestId } = await clickedMerge();
  await act(async () => socket.receive({ type: "mutationSettled", requestId }));
  expect(viewedDelivery()?.pendingAction).toBe("merge");
  await act(async () => {
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
  const next = ScenarioSocket.instances.at(-1)!;
  expect(next.sent).toEqual([]);
  await act(async () => {
    next.open();
    next.receive(readyMessage());
    next.receive(runList({ ...mergeable, error: "fresh refusal" }, 20));
  });
  expect(next.sent).toEqual([{ type: "subscribe", topics: ["workflow"] }]);
  expect(viewedDelivery()?.error).toBe("fresh refusal");
  await act(async () => vi.advanceTimersByTime(900_000));
  expect(viewedDelivery()?.error).toBe("fresh refusal");
});

it.each([false, true])(
  "queued offline action survives failed attempts, previouslyConnected=%s",
  async (previouslyConnected) => {
    await act(async () => root.render(<DeliveryHarness />));
    let socket = ScenarioSocket.instances[0]!;
    if (previouslyConnected)
      await act(async () => {
        socket.open();
        socket.receive(readyMessage());
      });
    await act(async () => latestActions.setTopics(["workflow"]));
    // Never-connected state is explicitly synthetic. Workflow cards are NOT a
    // boot-cache slice; a prior live connection is the other fixture's source.
    await act(async () => socket.receive(runList(mergeable)));
    if (previouslyConnected) {
      await act(async () => {
        socket.close();
        await vi.advanceTimersByTimeAsync(1000);
      });
      socket = ScenarioSocket.instances.at(-1)!;
    }
    await act(async () => latestActions.cleanUpWorkflowRun("7"));
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => {
        socket.close();
        await vi.advanceTimersByTimeAsync(1000);
      });
      socket = ScenarioSocket.instances.at(-1)!;
    }
    expect(viewedDelivery()?.pendingAction).toBe("cleanup");
    await act(async () => latestActions.cleanUpWorkflowRun("7"));
    expect(socket.sent).toEqual([]);
    await act(async () => socket.open());
    const commands = socket.sent.filter(
      (msg) => msg.type === "cleanUpWorkflowRun",
    );
    expect(commands).toHaveLength(1);
    const requestId = commands[0]!.requestId!;
    expect(socket.sent.filter((msg) => msg.type !== "subscribe")).toEqual(
      commands,
    );
    await act(async () =>
      socket.receive({ type: "mutationSettled", requestId }),
    );
    expect(viewedDelivery()?.pendingAction).toBe("cleanup");
    await act(async () =>
      socket.receive(
        runList({ ...mergeable, canCleanUp: false, error: "finished" }, 20),
      ),
    );
    expect(viewedDelivery()?.pendingAction).toBeUndefined();
    expect(viewedDelivery()?.error).toBe("finished");
  },
);

it("A unknown recovery never releases B queued offline for the same run", async () => {
  const { socket, requestId: a } = await clickedMerge();
  await act(async () => {
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);
  });
  const next = ScenarioSocket.instances.at(-1)!;
  await act(async () => latestActions.cleanUpWorkflowRun("7"));
  expect(viewedDelivery()?.pendingAction).toBe("cleanup");
  await act(async () => next.open());
  expect(viewedDelivery()?.pendingAction).toBe("cleanup");
  const b = next.sent.find((msg) => msg.type === "cleanUpWorkflowRun")!;
  expect(b.requestId).not.toBe(a);
  await act(async () =>
    next.receive({ type: "mutationSettled", requestId: a }),
  );
  expect(viewedDelivery()?.pendingAction).toBe("cleanup");
  await act(async () => next.close());
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
  await act(async () => vi.advanceTimersByTime(900_000));
  expect(viewedDelivery()?.error).not.toContain("did not answer");
});

it("offline failed attempts preserve the original cleanup deadline", async () => {
  await act(async () => root.render(<DeliveryHarness />));
  let socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    latestActions.setTopics(["workflow"]);
    socket.receive(runList(mergeable));
  });
  await act(async () => latestActions.cleanUpWorkflowRun("7"));
  await act(async () => {
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);
  });
  socket = ScenarioSocket.instances.at(-1)!;
  await act(async () => socket.open());
  await act(async () => vi.advanceTimersByTime(898_999));
  expect(viewedDelivery()?.pendingAction).toBe("cleanup");
  await act(async () => vi.advanceTimersByTime(1));
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
  expect(viewedDelivery()?.error).toBe(
    "The server did not answer this delivery action. Try again.",
  );
});

it("cleanup pre-card refusal releases silently and follows the Task error route", async () => {
  const { socket } = await clickedMerge();
  await act(async () =>
    socket.receive(runList({ ...mergeable, busyAction: "merge" }, 11)),
  );
  await act(async () => socket.receive(runList(mergeable, 12)));
  await act(async () => latestActions.cleanUpWorkflowRun("7"));
  const command = socket.sent.find((msg) => msg.type === "cleanUpWorkflowRun")!;
  await act(async () =>
    socket.receive({
      type: "error",
      requestId: command.requestId!,
      target: { type: "task", id: "370" },
      message: "Workflow delivery failed: cleanup refused",
    }),
  );
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
  expect(viewedDelivery()?.error).not.toBe(
    "Workflow delivery failed: cleanup refused",
  );
  expect(latestState.objectFailures.task?.["370"]).toBe(
    "Workflow delivery failed: cleanup refused",
  );
});

it("holds the click through a run-list broadcast that is about something else", async () => {
  const { socket } = await clickedMerge();
  expect(viewedDelivery()?.pendingAction).toBe("merge");

  // An agent step somewhere in the run moves the list. It says nothing about
  // this click, so the click keeps the control.
  await act(async () => {
    socket.receive(runList(mergeable, 11));
  });
  expect(viewedDelivery()?.pendingAction).toBe("merge");

  // The server dequeues — the write that clears the previous outcome — and from
  // here the durable action speaks for every viewer.
  await act(async () => {
    const { error: _error, ...dequeued } = mergeable;
    socket.receive(runList({ ...dequeued, busyAction: "merge" }, 12));
  });
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
  expect(viewedDelivery()?.busyAction).toBe("merge");
});

it("hands the failure back to the card when the merge itself is refused", async () => {
  const { socket, requestId } = await clickedMerge();
  const { error: _error, ...dequeued } = mergeable;

  // The card dequeued this merge and then failed at it. The click never edits
  // that field — it only hides it while it still owns the control — so the
  // refusal is intact and shown once the server's own action speaks.
  await act(async () => {
    socket.receive(runList({ ...dequeued, busyAction: "merge" }, 12));
    socket.receive(
      runList({ ...dequeued, error: "The provider refused the merge." }, 13),
    );
    socket.receive({ type: "mutationSettled", requestId });
  });
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
  expect(viewedDelivery()?.busyAction).toBeUndefined();
  expect(viewedDelivery()?.error).toBe("The provider refused the merge.");
});

it("asks for the authoritative list when the settle overtakes it", async () => {
  const { socket, requestId, mark } = await clickedMerge();

  // `mutationSettled` is sent as the handler resolves, while the list stating
  // what the action CAME TO is a best-effort broadcast: it can follow this
  // message, and a send that fails drops it for good. Letting go here would
  // offer Merge again over a pull request that may already be merged, and put
  // the previous action's failure back on screen as this click's answer —
  // while waiting for a list that may never come would end at the deadline,
  // calling a finished merge unanswered. So the settle asks.
  await act(async () => {
    socket.receive({ type: "mutationSettled", requestId });
  });
  expect(viewedDelivery()?.pendingAction).toBe("merge");
  const resync = socket.sent.slice(mark);
  expect(resync.filter((message) => message.type === "unsubscribe")).toEqual([
    { type: "unsubscribe", topics: ["workflow"] },
  ]);
  expect(resync.find((message) => message.type === "subscribe")).toMatchObject({
    topics: ["workflow"],
  });

  // The subscribe answers from the stores as they stand: merged, so the seam
  // is closed and the click has nothing left to claim.
  await act(async () => {
    const { error: _error, ...dequeued } = mergeable;
    socket.receive(runList({ ...dequeued, canMerge: false }, 12));
  });
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
  // The deadline went with it: no late note about an action that finished.
  await act(async () => {
    vi.advanceTimersByTime(20 * 60_000);
  });
  expect(viewedDelivery()?.error).toBeUndefined();
});

it("releases the click when no surface is holding the run topic any more", async () => {
  const { socket, requestId } = await clickedMerge();

  // The user left the Task while the merge ran. No list can arrive for a topic
  // this browser no longer holds, so asking for one would be a subscription the
  // app did not ask for — the click is simply released instead.
  await act(async () => latestActions.setTopics([]));
  const mark = socket.sent.length;
  await act(async () => {
    socket.receive({ type: "mutationSettled", requestId });
  });
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
  expect(
    socket.sent.slice(mark).filter((message) => message.type === "subscribe"),
  ).toHaveLength(0);
});

it("hands the control back to the server's own state on a reconnect", async () => {
  const { socket, requestId } = await clickedMerge();
  expect(viewedDelivery()?.pendingAction).toBe("merge");

  // The settle and any refusal for this click can only arrive on the socket it
  // was sent on. A click carried into the next episode would wait for an answer
  // that cannot come, and eventually claim the server never replied.
  await act(async () => {
    socket.close();
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(viewedDelivery()?.pendingAction).toBeUndefined();

  // The fresh subscription answers with the authoritative state — here, the
  // merge still running — and that is what the control shows.
  const reconnected = ScenarioSocket.instances[1]!;
  await act(async () => {
    reconnected.open();
    reconnected.receive(readyMessage());
    const { error: _error, ...dequeued } = mergeable;
    reconnected.receive(runList({ ...dequeued, busyAction: "merge" }, 20));
  });
  expect(viewedDelivery()?.busyAction).toBe("merge");
  expect(viewedDelivery()?.error).toBeUndefined();
  // And the click's deadline died with its episode: nothing writes a failure
  // over the action the server is still running.
  await act(async () => {
    vi.advanceTimersByTime(20 * 60_000);
  });
  expect(viewedDelivery()?.error).toBeUndefined();
  expect(requestId).toBeTypeOf("string");
});

it("stops counting down once the server states the action", async () => {
  const { socket } = await clickedMerge();
  await act(async () => {
    const { error: _error, ...dequeued } = mergeable;
    socket.receive(runList({ ...dequeued, busyAction: "merge" }, 12));
  });
  expect(viewedDelivery()?.pendingAction).toBeUndefined();

  // A merge can take a long time, and its settle can be lost with a socket.
  // Neither is a reason to write "the server did not answer" over a card whose
  // action the server is plainly running.
  await act(async () => {
    vi.advanceTimersByTime(20 * 60_000);
  });
  expect(viewedDelivery()?.error).toBeUndefined();
  expect(viewedDelivery()?.busyAction).toBe("merge");
});

it("releases the control on a refusal raised before the card was touched", async () => {
  const { socket, requestId } = await clickedMerge();

  // A stale gate: the run moved past its merge seam before the click landed.
  // The server states that on the Task — the control only stops waiting.
  await act(async () => {
    socket.receive(runList({ ...mergeable, canMerge: false }, 12));
    socket.receive({
      type: "error",
      requestId,
      target: { type: "task", id: "370" },
      message: "Workflow delivery failed: run 7 is completed.",
    });
  });
  expect(viewedDelivery()?.pendingAction).toBeUndefined();
});

it("refuses a second delivery click while one is still in flight", async () => {
  const { socket, mark } = await clickedMerge();

  await act(async () =>
    latestActions.mergeWorkflowRun("7", {
      mergeMethod: "squash",
      deleteBranch: true,
    }),
  );
  expect(
    socket.sent
      .slice(mark)
      .filter((message) => message.type === "mergeWorkflowRun"),
  ).toHaveLength(0);

  // And the server's own action gate is respected the same way, whoever won it.
  await act(async () => {
    const { error: _error, ...dequeued } = mergeable;
    socket.receive(runList({ ...dequeued, busyAction: "merge" }, 12));
  });
  await act(async () => latestActions.cleanUpWorkflowRun("7"));
  expect(
    socket.sent
      .slice(mark)
      .filter((message) => message.type === "cleanUpWorkflowRun"),
  ).toHaveLength(0);
});
