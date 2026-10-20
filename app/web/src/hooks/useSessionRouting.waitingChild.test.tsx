// @vitest-environment jsdom
/**
 * A directly spawned child keeps its `/sessions/<id>` page before it has a
 * message or a list row — waiting for a slot, or refused or cancelled before
 * its first prompt — whatever order its snapshot and the list arrive in
 * ([Task-967](pa://task/967)). Only a proven client-staged bootstrap rehomes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  QueuedPeerPrompt,
  SessionListItem,
  SessionState,
} from "@assistant/shared";
import {
  useSessionRouting,
  viewedSessionIdentity,
} from "./useSessionRouting.ts";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Snapshot = Pick<SessionState, "directSpawnedBy" | "queuedPeerPrompts">;
interface Inputs {
  connected: boolean;
  sessionListFresh: boolean;
  sessions: SessionListItem[];
  currentId: string | undefined;
  hasMessages: boolean;
  snapshot: Snapshot | null;
}

let root: Root;
let container: HTMLDivElement;
let inputs: Inputs;
let routing: ReturnType<typeof useSessionRouting>;
const loadSession = vi.fn();

function Probe() {
  // As `App.tsx` threads it: the identity comes from the snapshot `currentId`
  // comes from.
  routing = useSessionRouting({
    connected: inputs.connected,
    hydrated: true,
    sessions: inputs.sessions,
    currentId: inputs.currentId,
    hasMessages: inputs.hasMessages,
    sessionListFresh: inputs.sessionListFresh,
    viewedIdentity: viewedSessionIdentity(inputs.snapshot),
    loadSession,
    openPermanentAssistant: vi.fn(),
  });
  return null;
}

function render(changes: Partial<Inputs> = {}) {
  inputs = { ...inputs, ...changes };
  act(() => root.render(<Probe />));
}

const OLD = { id: "old", messageCount: 2 } as SessionListItem;
const startedRow = {
  id: "C",
  messageCount: 0,
  spawnedBySessionId: "coordinator",
} as SessionListItem;
const childRow: SessionListItem = {
  ...startedRow,
  waitingForSlot: { position: 1 },
};
const waitingItem = {
  id: "k",
  senderTitle: "Coordinator",
  senderSessionId: "coordinator",
  message: "start",
  responseRequested: true,
  createdAt: 1,
  waitingForSlot: true,
} as QueuedPeerPrompt;
const heldSnapshot: Snapshot = {
  directSpawnedBy: "coordinator",
  queuedPeerPrompts: [waitingItem],
};
const terminalSnapshot: Snapshot = { directSpawnedBy: "coordinator" };

/** Open C from the old chat; the server has not answered yet. */
function openChild() {
  act(() => routing.navigate("/sessions/C"));
  expect(loadSession).toHaveBeenLastCalledWith("C");
}

function expectChildRoute() {
  expect(location.pathname).toBe("/sessions/C");
  expect(routing.route).toEqual({ name: "session", id: "C" });
}

beforeEach(() => {
  resetHistoryNavForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/sessions/old");
  initHistoryNav();
  loadSession.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  inputs = {
    connected: true,
    sessionListFresh: true,
    sessions: [OLD],
    currentId: "old",
    hasMessages: true,
    snapshot: null,
  };
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("after a reconnect, a held child's snapshot before the fresh list keeps its page", () => {
  render({ connected: false });
  render({ connected: true, sessionListFresh: false });
  openChild();
  render({ currentId: "C", hasMessages: false, snapshot: heldSnapshot });
  expectChildRoute();
  render({ sessions: [OLD, childRow], sessionListFresh: true });
  expectChildRoute();
});

test("in one episode, a terminal child's snapshot before its first row keeps its page", () => {
  openChild();
  render({ currentId: "C", hasMessages: false, snapshot: terminalSnapshot });
  expectChildRoute();
  render({ sessions: [OLD, startedRow] });
  expectChildRoute();
});

test("in one episode, a held child whose queue clears before its first row keeps its page", () => {
  openChild();
  render({ currentId: "C", hasMessages: false, snapshot: heldSnapshot });
  expectChildRoute();
  render({ snapshot: terminalSnapshot });
  expectChildRoute();
  render({ sessions: [OLD, startedRow] });
  expectChildRoute();
});

test("in one episode, an unknown empty target with no server identity rehomes", () => {
  openChild();
  render({ currentId: "C", hasMessages: false, snapshot: {} });
  expect(location.pathname).toBe("/sessions/create");
  expect(routing.route).toEqual({ name: "new" });
});
