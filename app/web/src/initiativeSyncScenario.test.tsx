// @vitest-environment jsdom
/**
 * The `initiatives` topic through the real socket effect: the subscribe asks
 * for a snapshot, the snapshot sets the sequence baseline, a continuing batch
 * applies quietly, and a gap resubscribes for a fresh snapshot.
 *   pnpm --filter @assistant/web test src/initiativeSyncScenario.test.tsx
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  InitiativeSummary,
  ServerMessage,
} from "@assistant/shared";
import { useAssistant, type UIState } from "./hooks/useAssistant.ts";

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
    state: null,
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

function summary(id: string, title = `Initiative ${id}`): InitiativeSummary {
  return {
    id,
    title,
    state: "active",
    progress: { total: 1, done: 0, doing: 0, startable: 1, blocked: 0 },
    sessionIds: [],
    sessionCount: 0,
    updatedAt: 1,
  };
}

let latestState: UIState;
let latestActions: ReturnType<typeof useAssistant>["actions"];

function InitiativeHarness() {
  const { actions, state } = useAssistant();
  latestState = state;
  latestActions = actions;
  useEffect(() => actions.setTopics(["initiatives"]), [actions]);
  return null;
}

let root: Root;
let container: HTMLDivElement;

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

const subscribes = (socket: ScenarioSocket) =>
  socket.sent.filter(
    (message) =>
      message.type === "subscribe" && message.topics.includes("initiatives"),
  );
const unsubscribes = (socket: ScenarioSocket) =>
  socket.sent.filter(
    (message) =>
      message.type === "unsubscribe" && message.topics.includes("initiatives"),
  );

describe("Initiative socket/reducer scenario", () => {
  it("baselines on the snapshot and resubscribes on a sequence gap", async () => {
    await act(async () => root.render(<InitiativeHarness />));
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    const [subscribe] = subscribes(socket);
    expect(subscribe).toBeDefined();
    expect(
      subscribe?.type === "subscribe" &&
        subscribe.digests?.includes("initiatives"),
    ).toBeFalsy();

    await act(async () => {
      socket.receive({
        type: "initiativeList",
        items: [summary("1")],
        seq: 5,
        revisions: [{ id: "1", revision: 1 }],
      });
      socket.receive({
        type: "stateEvents",
        topic: "initiatives",
        seq: 6,
        events: [
          { kind: "upsert", id: "1", revision: 2, item: summary("1", "Moved") },
        ],
      });
    });
    expect(latestState.initiatives.map((item) => item.title)).toEqual([
      "Moved",
    ]);
    expect(unsubscribes(socket)).toHaveLength(0);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => {
      socket.receive({
        type: "stateEvents",
        topic: "initiatives",
        seq: 8,
        events: [{ kind: "delete", id: "1", revision: 3 }],
      });
    });
    warn.mockRestore();
    expect(unsubscribes(socket)).toHaveLength(1);
    expect(subscribes(socket)).toHaveLength(2);
  });

  it("reads one Initiative by id, drops a superseded answer, and answers a lost read", async () => {
    await act(async () => root.render(<InitiativeHarness />));
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    await act(async () => latestActions.requestInitiativeDetail("7"));
    // A second ask while the first is in flight sends nothing.
    await act(async () => latestActions.requestInitiativeDetail("7"));
    const reads = socket.sent.filter(
      (message) => message.type === "getInitiative",
    );
    expect(reads).toHaveLength(1);
    const first = reads[0]!;
    if (first.type !== "getInitiative") throw new Error("unreachable");
    expect(first.collapsed).toBeUndefined();
    expect(latestState.initiativeDetails["7"]?.status).toBe("loading");

    // An answer to a request this tab no longer waits on is ignored.
    await act(async () =>
      socket.receive({
        type: "initiativeDetail",
        id: "7",
        item: null,
        requestId: "someone-else",
      }),
    );
    expect(latestState.initiativeDetails["7"]?.status).toBe("loading");

    await act(async () => socket.close());
    expect(latestState.initiativeDetails["7"]).toEqual({
      status: "error",
      error: "Connection lost while loading this Initiative.",
    });
  });
});
