// @vitest-environment jsdom
/**
 * An Initiative's Sessions inbox card through the real socket effect and the
 * real inbox (`docs/initiatives.md`, The attention list): the card is made of
 * the `initiatives` summary alone, Settle sends exactly the revision the
 * clicked card rendered and acknowledges optimistically with the server's
 * clamp, a newer outcome stays awake, a refusal re-reads the list and is
 * announced naming the Initiative, and a reconnect's snapshot is the truth.
 * A Settle survives its surface leaving mid-exit, and its refusal or deadline
 * is the Initiative's own outcome: said once, in place on a card that is on
 * screen or else naming it, never written over the chat being viewed.
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
import { initiativeSettleRevision } from "./lib/initiativeInbox.ts";
import { resetFailureHomes, setFailureHomes } from "./lib/messageArrival.ts";
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
  createdAt: NOW - 600_000,
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
    createdAt: NOW - 900_000,
    updatedAt: NOW - 120_000,
  };
}

let state: UIState;
let actions: ReturnType<typeof useAssistant>["actions"];
const opened: string[] = [];

/**
 * `inbox` is whether the Sessions inbox is the section on screen; leaving it
 * unmounts the inbox, as the sidebar's section switch does. The failure-home
 * claim is the one App states for it: the Initiatives whose card, with its
 * Settle control, the visible inbox is drawing.
 */
function Harness({
  inbox = true,
  animate = false,
}: {
  inbox?: boolean;
  animate?: boolean;
}) {
  const assistant = useAssistant();
  state = assistant.state;
  actions = assistant.actions;
  useEffect(
    () => assistant.actions.setTopics(["initiatives"]),
    [assistant.actions],
  );
  const claimed = inbox
    ? assistant.state.initiatives
        .filter((item) => initiativeSettleRevision(item) !== undefined)
        .map((item) => item.id)
        .join(",")
    : "";
  useEffect(() => {
    setFailureHomes({
      viewedSessionId: null,
      stagedSend: null,
      openObjects: { project: [], task: [] },
      initiativeCards: claimed ? claimed.split(",") : [],
    });
  }, [claimed]);
  if (!inbox) return null;
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
      animateListChanges={animate}
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
      initiativesRefreshing={assistant.state.initiativesRefreshing}
      initiativeListError={assistant.state.initiativeListError}
      initiativeSettleErrors={assistant.state.initiativeSettleErrors}
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
  resetFailureHomes();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function boot(
  items: InitiativeSummary[],
  props: { animate?: boolean } = {},
): Promise<ScenarioSocket> {
  await act(async () => root.render(<Harness {...props} />));
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

/** The whole inbox item: the card and what is said under it. */
function item(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[data-inbox-card="initiative:${id}"]`,
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

/** Whether the client re-read the Initiative list since `mark`. */
function resubscribed(socket: ScenarioSocket, mark: number): boolean {
  const after = socket.sent.slice(mark);
  return (
    after.some(
      (message) =>
        message.type === "unsubscribe" &&
        message.topics.includes("initiatives"),
    ) &&
    after.some(
      (message) =>
        message.type === "subscribe" && message.topics.includes("initiatives"),
    )
  );
}

/** The toasts about the Initiative LIST. */
const listToasts = () =>
  getToasts()
    .map((toast) => toast.message)
    .filter((message) => message.includes("Failed to list Initiatives"));

/** The list failure's Retry. */
function retryButton(): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    ) ?? null
  );
}

/** The toasts that name the Billing migration Initiative. */
const billingToasts = () =>
  getToasts().filter((toast) =>
    toast.message.includes("Initiative-6 Billing migration"),
  );

/** View `s-quota` with its turn running and its answer streaming in. */
async function streamViewedChat(socket: ScenarioSocket) {
  await act(async () => {
    socket.receive({
      type: "snapshot",
      state: {
        sessionId: "s-quota",
        harness: "pi",
        agentType: "developer",
        thinkingLevel: "off",
      },
      contextInfo: {
        sessionId: "s-quota",
        updatedAt: NOW,
        messageCounts: {
          user: 0,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          total: 0,
        },
        tokenUsage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
        cost: 0,
      },
      snapshot: {
        sessionId: "s-quota",
        runState: "running",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });
    socket.receive({
      type: "event",
      sessionId: "s-quota",
      event: { type: "messageStarted", streamId: "m1" },
    });
    socket.receive({
      type: "event",
      sessionId: "s-quota",
      event: {
        type: "messageDelta",
        streamId: "m1",
        delta: { kind: "text", text: "Drafting the quota plan" },
      },
    });
    await vi.advanceTimersByTimeAsync(50);
  });
}

/** Everything the viewed chat's turn is: its run, its live output, its outcome. */
function chatRuntime() {
  return {
    runState: state.runState,
    streaming: state.streaming,
    runProgress: state.runProgress,
    liveStreams: state.liveStreams,
    streamingMessageId: state.streamingMessageId,
    messages: state.messages,
    error: state.error,
  };
}

describe("Initiative inbox card", () => {
  it("settles exactly what the card rendered, and the event confirms it", async () => {
    const socket = await boot([active, paused(1)]);
    expect(card("7")).not.toBeNull();
    expect(
      settleButton("7"),
      "an active Initiative offers no Settle",
    ).toBeNull();
    expect(settleButton("6")).not.toBeNull();
    // The outcome is an item of Needs you; the active one heads the working set.
    expect(card("6")?.closest("[data-inbox-needs-you]")).not.toBeNull();
    expect(card("7")?.closest("[data-inbox-initiatives]")).not.toBeNull();

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
    expect(card("6")?.closest("[data-inbox-needs-you]")).not.toBeNull();
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
    expect(
      card("6")?.closest("[data-inbox-needs-you]"),
      "active again leaves Needs you",
    ).toBeNull();
    expect(card("6")?.closest("[data-inbox-initiatives]")).not.toBeNull();
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
    // That re-read is a read in progress over the list held (F055).
    expect([state.initiativesFresh, state.initiativesRefreshing]).toEqual([
      false,
      true,
    ]);

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
    expect([state.initiativesFresh, state.initiativesRefreshing]).toEqual([
      true,
      false,
    ]);
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
    // The snapshot said it; its deadline has nothing left to add.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(billingToasts()).toHaveLength(0);
    expect(item("6")?.textContent).not.toContain("did not answer");
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

  it("sends a Settle whose exit the inbox did not live to finish (F037)", async () => {
    const socket = await boot([paused(1)], { animate: true });
    await act(async () => settleButton("6")!.click());
    expect(settles(socket), "the card is still playing its exit").toEqual([]);
    // Done lands while the card slides out, then the user switches section
    // before the 350 ms exit is over: the inbox unmounts.
    await events(socket, 2, 11, paused(2));
    await act(async () => root.render(<Harness inbox={false} animate />));
    expect(settles(socket)).toHaveLength(1);
    expect(settles(socket)[0]).toMatchObject({ id: "6", throughRevision: 1 });

    // Neither the exit's own timer nor coming back sends it again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => root.render(<Harness animate />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(settles(socket)).toHaveLength(1);
    // The click saw revision 1; done is still waiting for the user.
    const held = state.initiatives.find((item) => item.id === "6")!;
    expect(held.attention).toMatchObject({ revision: 2, settledRevision: 1 });
    expect(settleButton("6")).not.toBeNull();
  });

  it("keeps a refusal off the chat being viewed while its turn streams (F038)", async () => {
    const socket = await boot([paused(1)]);
    await streamViewedChat(socket);
    const before = chatRuntime();
    expect(before.runState).toBe("running");
    expect(before.streaming).toBe(true);
    expect(before.liveStreams).toHaveLength(1);
    expect(JSON.stringify(before.messages)).toContain(
      "Drafting the quota plan",
    );

    await act(async () => settleButton("6")!.click());
    const requestId = (settles(socket)[0] as { requestId: string }).requestId;
    const mark = socket.sent.length;
    await act(async () => {
      socket.receive({
        type: "error",
        requestId,
        target: { type: "initiative", id: "6" },
        message: "Failed to settle Initiative: database is locked",
      });
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(chatRuntime(), "the chat's turn is untouched").toEqual(before);
    expect(resubscribed(socket, mark)).toBe(true);
    expect(billingToasts()).toHaveLength(1);
    expect(billingToasts()[0]!.message).toContain("database is locked");

    // The re-read is the answer: still unsettled, offered again.
    await act(async () =>
      socket.receive({
        type: "initiativeList",
        items: [paused(1)],
        seq: 5,
        revisions: [{ id: "6", revision: 10 }],
      }),
    );
    expect(settleButton("6")).not.toBeNull();
    expect(chatRuntime()).toEqual(before);
    expect(billingToasts()).toHaveLength(1);
  });

  it("states an unanswered Settle on the card a newer outcome put back (F039)", async () => {
    const socket = await boot([paused(1)]);
    await streamViewedChat(socket);
    const before = chatRuntime();
    await act(async () => settleButton("6")!.click());
    expect(card("6"), "acknowledged optimistically").toBeNull();
    // Done lands while the server has not answered: the card is back, on
    // screen, offering the newer revision.
    await events(socket, 2, 11, paused(2));
    expect(settleButton("6")).not.toBeNull();
    const mark = socket.sent.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(resubscribed(socket, mark), "the list is re-read").toBe(true);
    expect(item("6")?.textContent, "said in place").toContain("did not answer");
    expect(billingToasts(), "and not said again in passing").toHaveLength(0);
    expect(chatRuntime()).toEqual(before);

    // The re-read: the click did land, revision 2 still waits for the user.
    await act(async () =>
      socket.receive({
        type: "initiativeList",
        items: [paused(2, 1)],
        seq: 6,
        revisions: [{ id: "6", revision: 12 }],
      }),
    );
    expect(
      state.initiatives.find((item) => item.id === "6")?.attention,
    ).toMatchObject({ revision: 2, settledRevision: 1 });
    expect(settleButton("6")).not.toBeNull();
    expect(billingToasts()).toHaveLength(0);

    // The Initiative's own next Settle retires the note, saying nothing new.
    await act(async () => settleButton("6")!.click());
    expect(settles(socket)[1]).toMatchObject({ throughRevision: 2 });
    expect(container.textContent).not.toContain("did not answer");
    expect(billingToasts()).toHaveLength(0);
  });

  it("does not carry an unanswered Settle's note onto a newer outcome", async () => {
    const socket = await boot([paused(1)]);
    await act(async () => settleButton("6")!.click());
    await events(socket, 2, 11, paused(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(item("6")?.textContent).toContain("did not answer");
    // Paused again: a different outcome, about which nothing failed.
    await events(socket, 3, 12, paused(3, 1));
    expect(settleButton("6")).not.toBeNull();
    expect(container.textContent).not.toContain("did not answer");
    expect(billingToasts()).toHaveLength(0);
  });

  it("names the Initiative when its unanswered Settle has no card on screen (F039)", async () => {
    const socket = await boot([paused(1)]);
    await act(async () => settleButton("6")!.click());
    expect(card("6")).toBeNull();
    const mark = socket.sent.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(resubscribed(socket, mark)).toBe(true);
    expect(billingToasts()).toHaveLength(1);
    expect(billingToasts()[0]!.message).toContain("did not answer");

    // The re-read puts the card back: shown, not announced a second time.
    await act(async () =>
      socket.receive({
        type: "initiativeList",
        items: [paused(1)],
        seq: 5,
        revisions: [{ id: "6", revision: 10 }],
      }),
    );
    expect(settleButton("6")).not.toBeNull();
    expect(item("6")?.textContent).not.toContain("did not answer");
    expect(billingToasts()).toHaveLength(1);

    // A refusal arriving after the deadline was already told, and is still
    // not the viewed chat's outcome.
    const requestId = (settles(socket)[0] as { requestId: string }).requestId;
    await act(async () =>
      socket.receive({
        type: "error",
        requestId,
        target: { type: "initiative", id: "6" },
        message: "Failed to settle Initiative: database is locked",
      }),
    );
    expect(billingToasts()).toHaveLength(1);
    expect(state.error).toBeNull();
  });

  it("names a refused Initiative the list no longer holds by its clicked name", async () => {
    const socket = await boot([paused(1)]);
    await act(async () => settleButton("6")!.click());
    const requestId = (settles(socket)[0] as { requestId: string }).requestId;
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "initiatives",
        seq: 2,
        events: [{ kind: "delete", id: "6", revision: 11 }],
      }),
    );
    await act(async () =>
      socket.receive({
        type: "error",
        requestId,
        target: { type: "initiative", id: "6" },
        message: "Initiative not found.",
      }),
    );
    expect(billingToasts()).toHaveLength(1);
    expect(billingToasts()[0]!.message).toContain("Initiative not found.");
  });

  it("says nothing at the deadline of a Settle the server confirmed", async () => {
    const socket = await boot([paused(1)]);
    await act(async () => settleButton("6")!.click());
    const requestId = (settles(socket)[0] as { requestId: string }).requestId;
    await act(async () =>
      socket.receive({ type: "mutationSettled", requestId }),
    );
    await events(socket, 2, 11, paused(1, 1));
    const mark = socket.sent.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(billingToasts()).toHaveLength(0);
    expect(socket.sent.slice(mark), "no recovery re-read").toEqual([]);
    expect(card("6")).toBeNull();
  });

  it("names the Initiative when the inbox was left before the deadline (F039)", async () => {
    const socket = await boot([paused(1)]);
    await streamViewedChat(socket);
    const before = chatRuntime();
    await act(async () => settleButton("6")!.click());
    // The user leaves the Sessions section; done lands while they are away.
    await act(async () => root.render(<Harness inbox={false} />));
    await events(socket, 2, 11, paused(2));
    const mark = socket.sent.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(resubscribed(socket, mark)).toBe(true);
    expect(billingToasts()).toHaveLength(1);
    expect(billingToasts()[0]!.message).toContain("did not answer");
    expect(chatRuntime()).toEqual(before);

    // Coming back shows the card with its newer outcome, and no second word.
    await act(async () => root.render(<Harness />));
    expect(settleButton("6")).not.toBeNull();
    expect(item("6")?.textContent).not.toContain("did not answer");
    expect(billingToasts()).toHaveLength(1);
    expect(
      state.initiatives.find((item) => item.id === "6")?.attention,
    ).toMatchObject({ revision: 2 });
  });

  it("keeps a failed Initiative list read as its condition, said once (F041)", async () => {
    await act(async () => root.render(<Harness />));
    const socket = ScenarioSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
      socket.receive({
        type: "error",
        message: "Failed to list Initiatives: database is locked",
        target: { type: "initiative" },
      });
    });
    expect(state.initiativeListError).toBe(
      "Failed to list Initiatives: database is locked",
    );
    expect(container.textContent).toContain("database is locked");
    expect(retryButton()).not.toBeNull();
    expect(listToasts(), "the condition is not also said in passing").toEqual(
      [],
    );
  });

  it("keeps a failed Initiative list read off the chat being viewed (F042)", async () => {
    const socket = await boot([paused(1)]);
    await streamViewedChat(socket);
    const before = chatRuntime();
    expect(before.runState).toBe("running");
    expect(before.liveStreams).toHaveLength(1);

    // A refresh of the list fails: no request of the user's is waiting on it.
    await act(async () => {
      socket.receive({
        type: "error",
        message: "Failed to list Initiatives: database is locked",
        target: { type: "initiative" },
      });
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(chatRuntime(), "the chat's turn is untouched").toEqual(before);
    expect(state.initiativeListError).toBe(
      "Failed to list Initiatives: database is locked",
    );
    expect(retryButton()).not.toBeNull();
    expect(card("6"), "held items stay under the failure").not.toBeNull();
    expect(listToasts()).toEqual([]);

    // Retry reads again; the list's answer retires the condition.
    const mark = socket.sent.length;
    await act(async () => retryButton()!.click());
    expect(resubscribed(socket, mark)).toBe(true);
    expect(state.initiativeListError).toBeNull();
    await act(async () =>
      socket.receive({
        type: "initiativeList",
        items: [paused(1)],
        seq: 7,
        revisions: [{ id: "6", revision: 10 }],
      }),
    );
    expect(container.textContent).not.toContain("database is locked");
    expect(chatRuntime()).toEqual(before);
  });
});
