// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  SessionState,
} from "@assistant/shared";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";

/**
 * What a jump to a message COSTS, and — the part that fails silently — whether
 * the message is actually LOADED before the transcript is asked to show it.
 *
 * A peer prompt or a fork origin is old by the time anyone follows it, so its
 * row is routinely behind the transcript's window. Landing in the right session
 * at the wrong place looks exactly like a broken link, so this asserts the walk
 * back to the anchor: it asks for the distance the server reported, it keeps
 * asking while the window is still short of it, and it STOPS the moment a page
 * fails to move the window (a session start, or an anchor gone stale) rather
 * than asking forever.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock(import("./lib/sessionTimelineCache.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadSessionTimelineCache: async () => undefined,
  saveSessionTimelineCache: async () => {},
  deleteSessionTimelineCache: async () => {},
}));

const { useAssistant } = await import("./hooks/useAssistant.ts");
const { getToasts } = await import("./lib/toast.ts");

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

  open(): void {
    this.readyState = ScenarioSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(source: string): void {
    this.sent.push(JSON.parse(source) as ClientMessage);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const sessionState: SessionState = {
  sessionId: "s1",
  harness: "pi",
  agentType: "assistant",
  thinkingLevel: "off",
};

function entry(seq: number): ClientTimelineEntry {
  return {
    id: `e${seq}`,
    seq,
    createdAt: new Date(seq).toISOString(),
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: `row ${seq}` }],
  } as ClientTimelineEntry;
}

/** A viewed session whose transcript is a WINDOW: `timelineStart` rows precede it. */
function snapshotMessage(timelineStart: number): ServerMessage {
  return {
    type: "snapshot",
    state: sessionState,
    snapshot: {
      sessionId: "s1",
      runState: "idle",
      timeline: [entry(timelineStart), entry(timelineStart + 1)],
      timelineStart,
      totalEntryCount: timelineStart + 2,
      streaming: [],
    },
    contextInfo: {
      sessionId: "s1",
      updatedAt: 1,
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
  } as ServerMessage;
}

/** The rows between two window starts: a range only joins if it carries all of them. */
function page(from: number, to: number): ClientTimelineEntry[] {
  const rows: ClientTimelineEntry[] = [];
  for (let seq = from; seq < to; seq++) rows.push(entry(seq));
  return rows;
}

/** The server's answer to a "load earlier" page, joined onto the window's front. */
function rangeMessage(
  beforeSeq: number,
  newStart: number,
  entries: ClientTimelineEntry[],
): ServerMessage {
  return {
    type: "timelineRange",
    sessionId: "s1",
    beforeSeq,
    entries,
    timelineStart: newStart,
    totalEntryCount: 200,
  } as ServerMessage;
}

let actions: ReturnType<typeof useAssistant>["actions"] | null = null;
let uiState: ReturnType<typeof useAssistant>["state"] | null = null;

function AssistantHarness() {
  const assistant = useAssistant();
  actions = assistant.actions;
  uiState = assistant.state;
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function socket(): ScenarioSocket {
  return ScenarioSocket.instances.at(-1)!;
}

function rangeRequests(): Extract<
  ClientMessage,
  { type: "loadTimelineRange" }
>[] {
  return socket().sent.filter(
    (msg): msg is Extract<ClientMessage, { type: "loadTimelineRange" }> =>
      msg.type === "loadTimelineRange",
  );
}

/** Boot the hook onto a viewed session whose window starts `timelineStart` rows in. */
async function bootWindowedSession(timelineStart: number): Promise<void> {
  await act(async () => root!.render(<AssistantHarness />));
  await act(async () => {
    socket().open();
  });
  await act(async () => {
    socket().receive(snapshotMessage(timelineStart));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/sessions/s1");
  actions = null;
  uiState = null;
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
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("revealing a message the window does not hold", () => {
  it("asks where the message is, then loads back to it", async () => {
    await bootWindowedSession(300);

    await act(async () => actions!.revealPeerPromptMessage("k1"));
    const ask = socket().sent.find(
      (msg) => msg.type === "resolveTimelineAnchor",
    );
    expect(ask).toMatchObject({
      target: { kind: "peerPrompt", messageKey: "k1" },
    });
    expect(rangeRequests()).toHaveLength(0);

    // The anchor is 300 rows behind the window: one request covering the whole
    // distance, not a blind page.
    await act(async () => {
      socket().receive({
        type: "timelineAnchor",
        requestId: (ask as { requestId: string }).requestId,
        anchor: { sessionId: "s1", entryId: "e0", index: 0 },
      });
    });
    expect(rangeRequests()).toHaveLength(1);
    expect(rangeRequests()[0]).toMatchObject({ beforeSeq: 300, limit: 300 });
    expect(uiState!.messageReveal).toMatchObject({ entryId: "e0", index: 0 });

    // The server bounds a range by bytes too, so the first answer may fall
    // short — the walk continues from wherever it landed…
    await act(async () => {
      socket().receive(rangeMessage(300, 120, page(120, 300)));
    });
    expect(rangeRequests()).toHaveLength(2);
    expect(rangeRequests()[1]).toMatchObject({ beforeSeq: 120 });

    // …and ends once the window actually holds the row.
    await act(async () => {
      socket().receive(rangeMessage(120, 0, page(0, 120)));
    });
    expect(rangeRequests()).toHaveLength(2);
    expect(uiState!.timelineStart).toBe(0);

    // Landing on the row retires the jump. Left live, it would walk the session
    // back to this same anchor every time the reader opens it again.
    await act(async () => {
      actions!.retireMessageReveal(uiState!.messageReveal!.token);
    });
    expect(uiState!.messageReveal).toBeNull();
    await act(async () => {
      socket().receive(snapshotMessage(300));
    });
    expect(rangeRequests()).toHaveLength(2);
  });

  it("stops walking when a page does not move the window", async () => {
    await bootWindowedSession(50);

    await act(async () => actions!.revealPeerPromptMessage("k9"));
    const requestId = (
      socket().sent.find(
        (msg) => msg.type === "resolveTimelineAnchor",
      ) as unknown as { requestId: string }
    ).requestId;
    await act(async () => {
      socket().receive({
        type: "timelineAnchor",
        requestId,
        anchor: { sessionId: "s1", entryId: "e0", index: 0 },
      });
    });
    expect(rangeRequests()).toHaveLength(1);

    // A refused/stale range answers no entries and leaves the window where it
    // was. Asking again would repeat forever, so the walk ends here.
    await act(async () => {
      socket().receive(rangeMessage(50, 50, []));
    });
    expect(rangeRequests()).toHaveLength(1);
    // Giving up retires it too, so reopening the session does not restart it.
    expect(uiState!.messageReveal).toBeNull();
  });

  it("ignores an answer to a superseded ask, and reports a target that is gone", async () => {
    await bootWindowedSession(10);

    await act(async () => actions!.revealPeerPromptMessage("k1"));
    await act(async () => actions!.revealPeerPromptMessage("k2"));
    const asks = socket().sent.filter(
      (msg) => msg.type === "resolveTimelineAnchor",
    ) as unknown as { requestId: string }[];
    expect(asks).toHaveLength(2);

    await act(async () => {
      socket().receive({
        type: "timelineAnchor",
        requestId: asks[0]!.requestId,
        anchor: { sessionId: "s1", entryId: "stale", index: 0 },
      });
    });
    expect(uiState!.messageReveal).toBeNull();

    await act(async () => {
      socket().receive({
        type: "timelineAnchor",
        requestId: asks[1]!.requestId,
      });
    });
    expect(uiState!.messageReveal).toBeNull();
    expect(uiState!.revealRequest).toBeNull();
    // A miss is SAID at its arrival and leaves nothing behind to say it again.
    expect(getToasts().map((toast) => toast.message)).toContain(
      "That message is no longer in the other session.",
    );
  });
});

describe("revealing an approval card", () => {
  const pendingCard = (createdAt = 5, id = "appr_1"): ServerMessage =>
    ({
      type: "approvalUpdate",
      sessionId: "s1",
      approval: {
        renderKind: "approval",
        id,
        sessionId: "s1",
        kind: "commit",
        status: "pending",
        title: "Merge #4 into main",
        createdAt,
        body: { kind: "commit", message: "wip", files: ["a.ts"] },
      },
    }) as unknown as ServerMessage;

  const lastAsk = () =>
    socket()
      .sent.filter((msg) => msg.type === "resolveTimelineAnchor")
      .at(-1)!;

  it("loads back to the turn that proposed the card, and lands on the card's row", async () => {
    await bootWindowedSession(300);
    await act(async () => socket().receive(pendingCard()));

    await act(async () => actions!.revealApproval("appr_1"));
    const ask = lastAsk();
    expect(ask).toMatchObject({
      target: { kind: "approval", approvalId: "appr_1" },
    });

    await act(async () => {
      socket().receive({
        type: "timelineAnchor",
        requestId: (ask as { requestId: string }).requestId,
        anchor: { sessionId: "s1", entryId: "approval-appr_1", index: 5 },
      });
    });
    expect(rangeRequests()[0]).toMatchObject({ beforeSeq: 300, limit: 295 });
    expect(uiState!.messageReveal).toMatchObject({
      entryId: "approval-appr_1",
      index: 5,
    });
  });

  it("asks for the card when a `#m-` address names a card's row", async () => {
    await bootWindowedSession(10);

    await act(async () =>
      actions!.revealTimelineEntry("s1", "approval-appr_1"),
    );
    expect(lastAsk()).toMatchObject({
      target: { kind: "approval", approvalId: "appr_1" },
    });
  });

  const rowIds = () => uiState!.messages.map((message) => message.id);

  it("holds a card older than the window back until its turn is loaded", async () => {
    await bootWindowedSession(10);
    await act(async () => socket().receive(pendingCard(5, "appr_old")));
    await act(async () => socket().receive(pendingCard(10, "appr_new")));
    // Placed by time, the old card would sort ahead of every loaded row: a long
    // session stacked all its history's cards on top of the window.
    expect(rowIds()).toEqual(["e10", "approval-appr_new", "e11"]);

    await act(async () => {
      socket().receive(rangeMessage(10, 0, page(0, 10)));
    });
    expect(rowIds().slice(4, 8)).toEqual([
      "e4",
      "e5",
      "approval-appr_old",
      "e6",
    ]);
  });

  it("lands on a card the viewed transcript holds even when the server cannot place it", async () => {
    await bootWindowedSession(10);
    await act(async () => socket().receive(pendingCard(10)));
    const toastsBefore = getToasts().length;

    await act(async () => actions!.revealApproval("appr_1"));
    await act(async () => {
      socket().receive({
        type: "timelineAnchor",
        requestId: (lastAsk() as { requestId: string }).requestId,
      });
    });
    expect(uiState!.messageReveal).toMatchObject({
      sessionId: "s1",
      entryId: "approval-appr_1",
      index: 10,
    });
    expect(rangeRequests()).toHaveLength(0);
    // It landed, so there is no miss to report.
    expect(getToasts()).toHaveLength(toastsBefore);
  });

  it("loads back to a card the server cannot place when it predates the window", async () => {
    await bootWindowedSession(10);
    await act(async () => socket().receive(pendingCard(5)));

    await act(async () => actions!.revealApproval("appr_1"));
    await act(async () => {
      socket().receive({
        type: "timelineAnchor",
        requestId: (lastAsk() as { requestId: string }).requestId,
      });
    });
    expect(uiState!.messageReveal).toMatchObject({
      entryId: "approval-appr_1",
      index: 0,
    });
    expect(rangeRequests()[0]).toMatchObject({ beforeSeq: 10 });

    await act(async () => {
      socket().receive(rangeMessage(10, 0, page(0, 10)));
    });
    expect(rowIds()).toContain("approval-appr_1");
  });

  it("says a card is gone when neither the server nor the transcript has it", async () => {
    await bootWindowedSession(10);

    await act(async () => actions!.revealApproval("appr_gone"));
    await act(async () => {
      socket().receive({
        type: "timelineAnchor",
        requestId: (lastAsk() as { requestId: string }).requestId,
      });
    });
    expect(uiState!.messageReveal).toBeNull();
    expect(getToasts().map((toast) => toast.message)).toContain(
      "That approval card no longer exists.",
    );
  });
});
