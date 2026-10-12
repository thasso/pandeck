// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  WorkflowRunSummary,
} from "@assistant/shared";
import {
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";

/**
 * A dragged Sessions inbox order the server refuses. The browser already moved
 * the cards, and an undo it worked out locally could not tell its own guess
 * from a list that has since CONFIRMED the same number, so the recovery is to
 * re-read both lists the drop touched: the sessions, and the runs — which have
 * no list command, only the topic resync.
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

const run: WorkflowRunSummary = {
  id: "7",
  taskId: "370",
  recipeId: "code-delivery",
  recipeVersion: 4,
  lifecycle: "active",
  limits: { maxIterations: 3, maxReviewPasses: 1 },
  createdAt: 1_000,
  updatedAt: 2_000,
};

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
});

it("re-reads sessions and runs when a reorder is refused", async () => {
  await act(async () => root.render(<Harness />));
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => latestActions.setTopics(["workflow"]));
  await act(async () =>
    socket.receive({
      type: "workflowRunList",
      runs: [run],
      cards: {},
      updatedAt: 10,
    }),
  );

  await act(async () =>
    latestActions.setInboxPositions([
      { kind: "run", runId: "7", position: 5_000 },
    ]),
  );
  // The cards move at once.
  expect(latestState.workflowRuns?.[0]?.inboxPosition).toBe(5_000);
  const sent = socket.sent.find(
    (message) => message.type === "setInboxPositions",
  );
  const requestId =
    sent?.type === "setInboxPositions" ? sent.requestId : undefined;
  expect(requestId).toBeTypeOf("string");
  const mark = socket.sent.length;

  await act(async () =>
    socket.receive({
      type: "error",
      message: "Failed to reorder the Sessions inbox: nope.",
      requestId: requestId!,
    }),
  );
  const recovery = socket.sent.slice(mark);
  expect(recovery).toContainEqual({ type: "listSessions" });
  expect(recovery).toContainEqual({
    type: "unsubscribe",
    topics: ["workflow"],
  });
  expect(recovery).toContainEqual(
    expect.objectContaining({ type: "subscribe", topics: ["workflow"] }),
  );
});
