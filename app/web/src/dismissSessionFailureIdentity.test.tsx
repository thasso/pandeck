// @vitest-environment jsdom
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  SessionListItem,
} from "@assistant/shared";
import { ActiveSessionCard } from "./components/ActiveSessionCard.tsx";
import { SpawnedSessionsLedge } from "./components/SpawnedSessionsLedge.tsx";
import { useAssistant } from "./hooks/useAssistant.ts";
import {
  buildSessionInbox,
  spawnedSessionsKey,
  spawnedSessionsView,
  type SessionInboxCard,
} from "./lib/sessionInbox.ts";
import { sessionTopic } from "./test/sessionTopic.ts";

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
  constructor(readonly url: string) {
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

const NOW = 1_800_000_000_000;
const parent: SessionListItem = {
  id: "root",
  harness: "pi",
  agentType: "assistant",
  title: "Root",
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 60_000,
  messageCount: 4,
};
const peer: SessionListItem = {
  ...parent,
  id: "kid",
  title: "Peer",
  spawnedBySessionId: "root",
  spawnOwnership: "coordinator",
  lastError: { at: NOW - 2_000, message: "first" },
};
const noop = () => {};
let rootNode: Root | null = null;
let container: HTMLDivElement | null = null;
let socket: ScenarioSocket;
let currentCard: SessionInboxCard | undefined;
let currentLedgeKey = "";

function Harness() {
  const assistant = useAssistant();
  const sessions = assistant.state.sessions;
  currentCard = buildSessionInbox(sessions).active.find(
    (item) => item.kind === "session",
  )?.card;
  const view = spawnedSessionsView({ sessions, coordinatorId: "root" });
  currentLedgeKey = spawnedSessionsKey(view, false);
  // Model App's content-keyed view retention: the key, not the rebuilt object,
  // decides whether the collapsed ledge sees a new bubble.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- this is the production spawnedLedgeView pattern
  const retainedView = useMemo(() => view, [currentLedgeKey]);
  return currentCard ? (
    <>
      <ActiveSessionCard
        card={currentCard}
        now={NOW}
        active={false}
        relations={{}}
        worktreeDirty={false}
        density="tight"
        onOpen={noop}
        onSettle={noop}
        onDismissFailure={assistant.actions.dismissSessionFailure}
        onRename={noop}
        onArchive={noop}
        onDelete={noop}
      />
      <SpawnedSessionsLedge
        sessionId="root"
        view={retainedView}
        open={false}
        onToggle={noop}
        onOpenSession={noop}
        onToggleSettled={noop}
        onDismissSessionFailure={assistant.actions.dismissSessionFailure}
      />
    </>
  ) : null;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/sessions/root");
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
  rootNode = createRoot(container);
});
afterEach(() => {
  act(() => rootNode?.unmount());
  rootNode = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let topic = sessionTopic();

async function boot(): Promise<void> {
  topic = sessionTopic();
  await act(async () => rootNode!.render(<Harness />));
  socket = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive({
      type: "ready",
      serverBuild: { version: "test" },
      state: null,
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
    });
    socket.receive(topic.snapshot([parent, peer]));
  });
}

async function replaceFailure(): Promise<void> {
  await act(async () =>
    socket.receive(
      topic.upsert({ ...peer, lastError: { at: NOW, message: "second" } }),
    ),
  );
}

describe("failure dismissal carries the rendered identity", () => {
  it("refreshes the retained cluster card X when its bubbled failure changes", async () => {
    await boot();
    const oldCard = currentCard!;
    const x = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss the failure in “Peer”"]',
    )!;
    expect(oldCard.cluster?.bubbled?.session.lastError?.at).toBe(NOW - 2_000);
    await replaceFailure();
    expect(currentCard!.cluster?.bubbled?.session.lastError?.at).toBe(NOW);
    expect(
      container!.querySelector('[aria-label="Dismiss the failure in “Peer”"]'),
    ).toBe(x);
    await act(async () => x.click());
    expect(
      socket.sent.find((message) => message.type === "dismissSessionFailure"),
    ).toMatchObject({
      id: "kid",
      errorAt: NOW,
      outcomeRevision: 0,
    });
  });

  it("refreshes the spawned-sessions ledge identity when its bubbled failure changes", async () => {
    await boot();
    const oldKey = currentLedgeKey;
    const x = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss the failure in “Peer”"]:last-of-type',
    )!;
    expect(x).toBeTruthy();
    await replaceFailure();
    expect(currentLedgeKey).not.toBe(oldKey);
    const buttons = container!.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Dismiss the failure in “Peer”"]',
    );
    await act(async () => buttons[buttons.length - 1]!.click());
    expect(
      socket.sent.find((message) => message.type === "dismissSessionFailure"),
    ).toMatchObject({
      id: "kid",
      errorAt: NOW,
      outcomeRevision: 0,
    });
  });
});
