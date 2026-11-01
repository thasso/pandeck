// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  SessionListItem,
} from "@assistant/shared";
import {
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";
import { sessionTopic } from "./test/sessionTopic.ts";

/**
 * The `sessions` topic through the real hook and socket (`docs/session-list.md`):
 * a `seq` gap resubscribes for a snapshot (V11), and the archived slice is read
 * single-flight, released by its own answer or error, a timeout or a drop (V10).
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
});

const listed = (id: string, updatedAt: number): SessionListItem => ({
  id,
  harness: "pi",
  agentType: "assistant",
  title: id,
  createdAt: 0,
  updatedAt,
  messageCount: 2,
});

const sent = (socket: ScenarioSocket, type: ClientMessage["type"]) =>
  socket.sent.filter((message) => message.type === type);
const sessionsResubscribes = (socket: ScenarioSocket) =>
  socket.sent.filter(
    (message) =>
      message.type === "unsubscribe" && message.topics.includes("sessions"),
  ).length;
const archivedReads = (socket: ScenarioSocket) =>
  sent(socket, "loadArchivedSessions").map((message) =>
    message.type === "loadArchivedSessions" ? message.requestId : "",
  );

async function connect(topic = sessionTopic()) {
  await act(async () => root.render(<Harness />));
  const socket = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => latestActions.setTopics(["sessions"]));
  await act(async () =>
    socket.receive(topic.snapshot([listed("a", 1), listed("b", 2)], 1)),
  );
  return socket;
}

it("resubscribes once for a seq gap, and the snapshot repairs the list", async () => {
  const topic = sessionTopic();
  const socket = await connect(topic);
  expect(
    sent(socket, "subscribe").filter((message) =>
      message.type === "subscribe"
        ? message.topics.includes("sessions")
        : false,
    ),
  ).toHaveLength(1);
  await act(async () => socket.receive(topic.upsert(listed("c", 3))));
  expect(sessionsResubscribes(socket)).toBe(0);
  // One batch is lost: the next one's seq skips.
  topic.upsert(listed("d", 4));
  await act(async () => socket.receive(topic.upsert(listed("e", 5))));
  expect(sessionsResubscribes(socket)).toBe(1);
  // The batch that revealed the gap still applied; the snapshot is the truth.
  expect(latestState.sessions.map((row) => row.id)).toContain("e");
  await act(async () =>
    socket.receive(
      topic.snapshot([
        listed("a", 1),
        listed("b", 2),
        listed("c", 3),
        listed("d", 4),
        listed("e", 5),
      ]),
    ),
  );
  expect(latestState.sessions.map((row) => row.id)).toEqual([
    "e",
    "d",
    "c",
    "b",
    "a",
  ]);
  await act(async () => socket.receive(topic.upsert(listed("f", 6))));
  expect(sessionsResubscribes(socket)).toBe(1);
});

it("flies one archived read, queues one more, and ignores a stale answer", async () => {
  const socket = await connect();
  await act(async () => latestActions.loadArchivedSessions());
  await act(async () => latestActions.loadArchivedSessions());
  await act(async () => latestActions.loadArchivedSessions());
  const [first] = archivedReads(socket);
  expect(archivedReads(socket)).toHaveLength(1);
  await act(async () =>
    socket.receive({
      type: "archivedSessions",
      requestId: first!,
      sessions: [{ ...listed("x", 0), archived: true }],
      archivedSessionCount: 1,
    }),
  );
  expect(latestState.archivedSessionsLoaded).toBe(true);
  // The queued read goes out once the first lands, under a fresh id.
  const reads = archivedReads(socket);
  expect(reads).toHaveLength(2);
  expect(reads[1]).not.toBe(first);
  // Its own server's mutationSettled and a repeat of the first answer change
  // nothing; the second read still flies.
  await act(async () => {
    socket.receive({ type: "mutationSettled", requestId: reads[1]! });
    socket.receive({
      type: "archivedSessions",
      requestId: first!,
      sessions: [],
      archivedSessionCount: 0,
    });
  });
  expect(latestState.archivedSessions.map((row) => row.id)).toEqual(["x"]);
  expect(latestState.archivedReadFlight).toBe(reads[1]);
});

it("releases an archived read on its own error, and on a timeout", async () => {
  const socket = await connect();
  await act(async () => latestActions.loadArchivedSessions());
  await act(async () => latestActions.loadArchivedSessions());
  const [first] = archivedReads(socket);
  // Another request's error releases nothing.
  await act(async () =>
    socket.receive({
      type: "error",
      message: "Failed to load archived sessions: other",
      requestId: "someone-else",
      target: { type: "session" },
    }),
  );
  expect(archivedReads(socket)).toHaveLength(1);
  await act(async () =>
    socket.receive({
      type: "error",
      message: "Failed to load archived sessions: injected",
      requestId: first!,
      target: { type: "session" },
    }),
  );
  const reads = archivedReads(socket);
  expect(reads).toHaveLength(2);
  // No answer: the timeout frees the flight for the next request.
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(latestState.archivedReadFlight).toBeNull();
  await act(async () => latestActions.loadArchivedSessions());
  expect(archivedReads(socket)).toHaveLength(3);
  // The timed-out read's late answer is ignored.
  await act(async () =>
    socket.receive({
      type: "archivedSessions",
      requestId: reads[1]!,
      sessions: [],
      archivedSessionCount: 0,
    }),
  );
  expect(latestState.archivedSessionsLoaded).toBe(false);
});

it("drops the flight with the socket, and a reconnect reads once on request", async () => {
  const socket = await connect();
  await act(async () => latestActions.loadArchivedSessions());
  await act(async () => latestActions.loadArchivedSessions());
  expect(archivedReads(socket)).toHaveLength(1);
  await act(async () => socket.close());
  expect(latestState.archivedReadFlight).toBeNull();
  expect(latestState.archivedReadQueued).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  const next = ScenarioSocket.instances.at(-1)!;
  expect(next).not.toBe(socket);
  await act(async () => next.open());
  await act(async () =>
    next.receive(sessionTopic().snapshot([listed("a", 1)])),
  );
  expect(archivedReads(next)).toHaveLength(0);
  await act(async () => latestActions.loadArchivedSessions());
  expect(archivedReads(next)).toHaveLength(1);
});
