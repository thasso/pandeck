// @vitest-environment jsdom
/**
 * An Initiative's Sessions inbox card through the real socket effect and the
 * real inbox (`docs/initiatives.md`, The attention list): the card is made of
 * the `initiatives` summary alone, Settle sends exactly the revision the
 * clicked card rendered and acknowledges optimistically with the server's
 * clamp, a newer outcome stays awake, a refusal re-reads the list and is
 * announced naming the Initiative, and a reconnect's snapshot is the truth.
 *   pnpm --filter @assistant/web test src/initiativeInboxScenario.test.tsx
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  InitiativeSummary,
  ServerMessage,
  SessionListItem,
} from "@assistant/shared";
import { useAssistant, type UIState } from "./hooks/useAssistant.ts";
import { SessionInbox } from "./components/SessionInbox.tsx";
import { dismissToast, getToasts } from "./lib/toast.ts";
import { stubMatchMedia } from "./test/matchMedia.ts";

stubMatchMedia();

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

const NOW = 1_800_000_000_000;

function sessionRow(id: string, title: string): SessionListItem {
  return {
    id,
    harness: "pi",
    agentType: "developer",
    title,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 30_000,
    messageCount: 2,
  } as SessionListItem;
}

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: [sessionRow("s-quota", "Quota service")],
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

const active: InitiativeSummary = {
  id: "7",
  title: "Hosted Labs",
  state: "active",
  progress: { total: 32, done: 5, doing: 5, startable: 5, blocked: 18 },
  nextMilestone: { id: "931", title: "First hosted release" },
  sessionIds: ["s-quota"],
  sessionCount: 1,
  updatedAt: NOW - 60_000,
};

function paused(revision: number, settledRevision = 0): InitiativeSummary {
  return {
    id: "6",
    title: "Billing migration",
    state: revision % 2 === 0 ? "done" : "paused",
    attention: {
      revision,
      settledRevision,
      kind: revision % 2 === 0 ? "done" : "paused",
      at: NOW,
    },
    progress: { total: 20, done: 12, doing: 1, startable: 2, blocked: 3 },
    sessionIds: ["s-quota"],
    sessionCount: 1,
    updatedAt: NOW - 120_000,
  };
}

let state: UIState;
let actions: ReturnType<typeof useAssistant>["actions"];
const opened: string[] = [];

function Harness() {
  const assistant = useAssistant();
  state = assistant.state;
  actions = assistant.actions;
  useEffect(
    () => assistant.actions.setTopics(["initiatives"]),
    [assistant.actions],
  );
  return (
    <SessionInbox
      sessions={assistant.state.sessions}
      archivedSessionCount={0}
      archivedSessionsLoaded
      currentId={undefined}
      readCurrentId={undefined}
      projects={[]}
      worktrees={[]}
      tasks={[]}
      workflowRuns={[]}
      workflowCards={{}}
      worktreeStatuses={{}}
      animateListChanges={false}
      density="tight"
      onSelect={() => {}}
      onSettle={() => {}}
      onArchive={() => {}}
      onDeleteSession={() => {}}
      onRenameSession={() => {}}
      onLoadArchivedSessions={() => {}}
      onOpenBackgroundTasks={() => {}}
      onOpenProject={() => {}}
      onOpenTask={() => {}}
      onOpenWorkflowRun={() => {}}
      onSettleWorkflowRun={() => {}}
      initiatives={assistant.state.initiatives}
      initiativesFresh={assistant.state.initiativesFresh}
      initiativeListError={assistant.state.initiativeListError}
      onRetryInitiatives={assistant.actions.retryInitiatives}
      onOpenInitiative={(id) => opened.push(id)}
      onSettleInitiative={assistant.actions.settleInitiative}
      onOpenWorktree={() => {}}
    />
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  ScenarioSocket.instances = [];
  opened.length = 0;
  vi.stubGlobal("WebSocket", ScenarioSocket);
  window.localStorage.clear();
  for (const toast of getToasts()) dismissToast(toast.id);
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

async function boot(items: InitiativeSummary[]): Promise<ScenarioSocket> {
  await act(async () => root.render(<Harness />));
  const socket = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
    socket.receive({
      type: "initiativeList",
      items,
      seq: 1,
      revisions: items.map((item) => ({ id: item.id, revision: 10 })),
    });
  });
  return socket;
}

function events(
  socket: ScenarioSocket,
  seq: number,
  revision: number,
  item: InitiativeSummary,
) {
  return act(async () => {
    socket.receive({
      type: "stateEvents",
      topic: "initiatives",
      seq,
      events: [{ kind: "upsert", id: item.id, revision, item }],
    });
  });
}

function card(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[data-list-row-id="initiative:${id}"]`,
  );
}

function settleButton(id: string): HTMLButtonElement | null {
  return (
    card(id)?.querySelector<HTMLButtonElement>(
      'button[aria-label^="Settle"]',
    ) ?? null
  );
}

const settles = (socket: ScenarioSocket) =>
  socket.sent.filter((message) => message.type === "settleInitiative");

describe("Initiative inbox card", () => {
  it("settles exactly what the card rendered, and the event confirms it", async () => {
    const socket = await boot([active, paused(1)]);
    expect(card("7")).not.toBeNull();
    expect(
      settleButton("7"),
      "an active Initiative offers no Settle",
    ).toBeNull();
    expect(settleButton("6")).not.toBeNull();

    await act(async () => settleButton("6")!.click());
    const [sent] = settles(socket);
    expect(sent).toMatchObject({ id: "6", throughRevision: 1 });
    expect(typeof (sent as { requestId?: string }).requestId).toBe("string");
    expect(opened, "Settle never opens the Initiative").toEqual([]);
    expect(card("6"), "acknowledged optimistically").toBeNull();

    await act(async () =>
      socket.receive({
        type: "mutationSettled",
        requestId: (sent as { requestId: string }).requestId,
      }),
    );
    await events(socket, 2, 11, paused(1, 1));
    expect(card("6")).toBeNull();
    expect(card("7"), "the active one stays").not.toBeNull();

    // A member Task's change reaches the card as the Initiative's own event.
    await events(socket, 3, 12, {
      ...active,
      progress: { total: 32, done: 6, doing: 4, startable: 6, blocked: 17 },
      nextMilestone: { id: "932", title: "Second hosted release" },
    });
    expect(card("7")?.textContent).toContain("6/32");
    expect(card("7")?.textContent).toContain("6 ready");
    expect(card("7")?.textContent).toContain("Second hosted release");
    // The card is the summary: the inbox never reads a graph or a layout.
    expect(
      socket.sent.some((message) => message.type === "getInitiative"),
    ).toBe(false);
  });

  it("keeps a newer outcome awake against an older click", async () => {
    const socket = await boot([paused(1)]);
    // The phone rendered revision 1; done (revision 2) has landed since.
    await events(socket, 2, 11, paused(2));
    expect(card("6")?.getAttribute("aria-label")).toContain("Done");
    await act(async () => actions.settleInitiative("6", 1));
    expect(settles(socket)[0]).toMatchObject({ throughRevision: 1 });
    expect(card("6"), "revision 2 is still unacknowledged").not.toBeNull();
    expect(
      state.initiatives.find((item) => item.id === "6")?.attention
        ?.settledRevision,
    ).toBe(1);

    // The server's clamp agrees, and the card offers the newer revision.
    await events(socket, 3, 12, paused(2, 1));
    await act(async () => settleButton("6")!.click());
    expect(settles(socket)[1]).toMatchObject({ throughRevision: 2 });
    expect(card("6")).toBeNull();

    // Active again: back as an item, with nothing to settle.
    await events(socket, 4, 13, {
      ...paused(2, 2),
      state: "active",
    });
    expect(card("6")).not.toBeNull();
    expect(settleButton("6")).toBeNull();
  });

  it("re-reads the list after a refusal and names the Initiative", async () => {
    const socket = await boot([paused(1)]);
    await act(async () => settleButton("6")!.click());
    const requestId = (settles(socket)[0] as { requestId: string }).requestId;
    expect(card("6")).toBeNull();
    const mark = socket.sent.length;

    await act(async () =>
      socket.receive({
        type: "error",
        requestId,
        target: { type: "initiative", id: "6" },
        message: "Failed to settle Initiative: database is locked",
      }),
    );
    const after = socket.sent.slice(mark);
    expect(
      after.some(
        (message) =>
          message.type === "unsubscribe" &&
          message.topics.includes("initiatives"),
      ),
    ).toBe(true);
    expect(
      after.some(
        (message) =>
          message.type === "subscribe" &&
          message.topics.includes("initiatives"),
      ),
    ).toBe(true);
    expect(
      getToasts().some((toast) =>
        toast.message.includes("Initiative-6 Billing migration"),
      ),
    ).toBe(true);

    // The fresh snapshot is the server's own answer: still unsettled.
    await act(async () =>
      socket.receive({
        type: "initiativeList",
        items: [paused(1)],
        seq: 5,
        revisions: [{ id: "6", revision: 10 }],
      }),
    );
    expect(settleButton("6")).not.toBeNull();
  });

  it("takes the reconnect's snapshot as the truth", async () => {
    const socket = await boot([paused(1)]);
    await act(async () => settleButton("6")!.click());
    expect(card("6")).toBeNull();
    await act(async () => {
      socket.close();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const reconnected = ScenarioSocket.instances.at(-1)!;
    expect(reconnected).not.toBe(socket);
    await act(async () => {
      reconnected.open();
      reconnected.receive(readyMessage());
      // The settle never reached the server: the snapshot still holds it.
      reconnected.receive({
        type: "initiativeList",
        items: [paused(1)],
        seq: 1,
        revisions: [{ id: "6", revision: 10 }],
      });
    });
    expect(settleButton("6")).not.toBeNull();
  });

  it("drops the item when the Initiative is archived or deleted", async () => {
    const socket = await boot([active, paused(1)]);
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "initiatives",
        seq: 2,
        events: [
          { kind: "delete", id: "7", revision: 11 },
          { kind: "delete", id: "6", revision: 11 },
        ],
      }),
    );
    expect(card("7")).toBeNull();
    expect(card("6")).toBeNull();
  });
});
