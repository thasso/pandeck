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
import { SessionInbox } from "./components/SessionInbox.tsx";
import { stubMatchMedia } from "./test/matchMedia.ts";

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

stubMatchMedia();
let latestActions: AssistantActions;
let latestState: UIState;

/** The real hook driving the real SessionInbox, wired as App.tsx wires it. */
function Harness() {
  const { actions, state } = useAssistant();
  latestActions = actions;
  latestState = state;
  return (
    <SessionInbox
      sessions={state.sessions}
      archivedSessionCount={state.archivedSessionCount}
      archivedSessionsLoaded={state.archivedSessionsLoaded}
      currentId={undefined}
      readCurrentId={undefined}
      projects={[]}
      worktrees={[]}
      tasks={[]}
      workflowRuns={[]}
      workflowCards={{}}
      worktreeStatuses={{}}
      animateListChanges={false}
      density="comfortable"
      onSelect={() => {}}
      onSettle={() => {}}
      onDismissFailure={() => {}}
      onArchive={() => {}}
      onDeleteSession={() => {}}
      onRenameSession={() => {}}
      onLoadArchivedSessions={actions.loadArchivedSessions}
      onOpenBackgroundTasks={() => {}}
      onOpenProject={() => {}}
      onOpenTask={() => {}}
      onOpenWorkflowRun={() => {}}
      onSettleWorkflowRun={() => {}}
      onOpenWorktree={() => {}}
    />
  );
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
const archivedRow = (id: string): SessionListItem => ({
  ...listed(id, 0),
  archived: true,
});
const archivedReads = (socket: ScenarioSocket) =>
  socket.sent.flatMap((m) =>
    m.type === "loadArchivedSessions" ? [m.requestId] : [],
  );
const loadingShown = () =>
  container.textContent?.includes("Loading archived sessions") ?? false;

async function connect() {
  await act(async () => root.render(<Harness />));
  const socket = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => latestActions.setTopics(["sessions"]));
  await act(async () =>
    socket.receive(sessionTopic().snapshot([listed("a", 1)], 1)),
  );
  return socket;
}
function openShelf() {
  const toggle = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Archived"),
  );
  if (!toggle) throw new Error("no Archived toggle");
  act(() => toggle.click());
}
async function reconnect(socket: ScenarioSocket) {
  await act(async () => socket.close());
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  const next = ScenarioSocket.instances.at(-1)!;
  expect(next).not.toBe(socket);
  await act(async () => {
    next.open();
    next.receive(readyMessage());
  });
  expect(archivedReads(next)).toHaveLength(0);
  await act(async () =>
    next.receive(sessionTopic().snapshot([listed("a", 1)], 1)),
  );
  return next;
}

it("first shelf read lost to a disconnect; reconnect reads once after the snapshot", async () => {
  const socket = await connect();
  openShelf();
  expect(archivedReads(socket)).toHaveLength(1);
  expect(loadingShown()).toBe(true);
  const next = await reconnect(socket);
  expect(archivedReads(next)).toHaveLength(1);
  expect(latestState.archivedReadFlight).toBe(archivedReads(next)[0]);
  expect(loadingShown()).toBe(true);
  await act(async () =>
    next.receive({
      type: "archivedSessions",
      requestId: archivedReads(next)[0]!,
      sessions: [archivedRow("x")],
      archivedSessionCount: 1,
    }),
  );
  expect(latestState.archivedSessionsLoaded).toBe(true);
  expect(loadingShown()).toBe(false);
  expect(archivedReads(next)).toHaveLength(1);
});

it("ignores the pre-disconnect answer while the recovered read is in flight", async () => {
  const socket = await connect();
  openShelf();
  const [first] = archivedReads(socket);
  const next = await reconnect(socket);
  const [replacement] = archivedReads(next);
  expect(replacement).toBeDefined();
  await act(async () =>
    socket.receive({
      type: "archivedSessions",
      requestId: first!,
      sessions: [archivedRow("stale")],
      archivedSessionCount: 1,
    }),
  );
  expect(latestState.archivedReadFlight).toBe(replacement);
  expect(latestState.archivedSessionsLoaded).toBe(false);
  expect(latestState.archivedSessions).toHaveLength(0);
  expect(archivedReads(next)).toHaveLength(1);
});

it("CONTROL: a loaded shelf re-reads exactly once after the reconnect snapshot (V10)", async () => {
  const socket = await connect();
  openShelf();
  const [first] = archivedReads(socket);
  await act(async () =>
    socket.receive({
      type: "archivedSessions",
      requestId: first!,
      sessions: [archivedRow("x")],
      archivedSessionCount: 1,
    }),
  );
  expect(latestState.archivedSessionsLoaded).toBe(true);
  expect(loadingShown()).toBe(false);
  const next = await reconnect(socket);
  expect(archivedReads(next)).toHaveLength(1);
});

it("CONTROL: a loaded shelf whose RE-read is lost to a disconnect re-reads once after reconnect", async () => {
  const socket = await connect();
  openShelf();
  const [first] = archivedReads(socket);
  await act(async () =>
    socket.receive({
      type: "archivedSessions",
      requestId: first!,
      sessions: [archivedRow("x")],
      archivedSessionCount: 1,
    }),
  );
  await act(async () =>
    socket.receive({ type: "archivedSessionCount", count: 2 }),
  );
  expect(archivedReads(socket)).toHaveLength(2);
  const next = await reconnect(socket);
  expect(archivedReads(next)).toHaveLength(1);
});

it("REPRO C1b/c: error or timeout on the first read leaves the shelf loading with no error; toggling the shelf reads again", async () => {
  const socket = await connect();
  openShelf();
  const [first] = archivedReads(socket);
  await act(async () =>
    socket.receive({
      type: "error",
      requestId: first!,
      message: "Failed to load archived sessions: injected",
      target: { type: "session" },
    }),
  );
  expect(latestState.archivedReadFlight).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(archivedReads(socket)).toHaveLength(1);
  expect(loadingShown()).toBe(true);
  expect(container.textContent?.includes("Failed to load archived")).toBe(
    false,
  );
  // timeout path
  openShelf();
  openShelf();
  expect(archivedReads(socket)).toHaveLength(2);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(latestState.archivedReadFlight).toBeNull();
  expect(archivedReads(socket)).toHaveLength(2);
  expect(loadingShown()).toBe(true);
});

it("a reconnect answered by a digest re-reads a loaded shelf once, after catch-up (W3)", async () => {
  const socket = await connect();
  openShelf();
  const [first] = archivedReads(socket);
  await act(async () =>
    socket.receive({
      type: "archivedSessions",
      requestId: first!,
      sessions: [archivedRow("x")],
      archivedSessionCount: 1,
    }),
  );
  // The count moved: a re-read is in flight when the socket drops.
  await act(async () =>
    socket.receive({ type: "archivedSessionCount", count: 2 }),
  );
  expect(archivedReads(socket)).toHaveLength(2);
  await act(async () => socket.close());
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  const next = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    next.open();
    next.receive(readyMessage());
  });
  const subscribe = next.sent.find(
    (m) => m.type === "subscribe" && m.topics.includes("sessions"),
  );
  expect(subscribe?.type === "subscribe" && subscribe.digests).toEqual([
    "sessions",
  ]);
  // The digest names a moved row, then the server's count follows it.
  await act(async () =>
    next.receive({
      type: "stateDigest",
      topic: "sessions",
      seq: 0,
      entries: [{ id: "a", revision: 2 }],
    }),
  );
  await act(async () =>
    next.receive({ type: "archivedSessionCount", count: 3 }),
  );
  expect(latestState.sessionListFresh).toBe(false);
  expect(archivedReads(next)).toHaveLength(0);
  const fetch = next.sent.find((m) => m.type === "getStateItems");
  if (fetch?.type !== "getStateItems") throw new Error("no catch-up");
  await act(async () =>
    next.receive({
      type: "stateItems",
      topic: "sessions",
      requestId: fetch.requestId,
      events: [{ kind: "upsert", id: "a", revision: 2, item: listed("a", 1) }],
    }),
  );
  expect(latestState.sessionListFresh).toBe(true);
  expect(archivedReads(next)).toHaveLength(1);
  await act(async () =>
    next.receive({
      type: "archivedSessions",
      requestId: archivedReads(next)[0]!,
      sessions: [archivedRow("x"), archivedRow("y"), archivedRow("z")],
      archivedSessionCount: 3,
    }),
  );
  expect(latestState.archivedSessionsLoaded).toBe(true);
  expect(archivedReads(next)).toHaveLength(1);
});
