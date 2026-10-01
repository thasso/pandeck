// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { describeTimelineCache } from "@assistant/shared/runtime";

/**
 * The lifecycle of a durable-body read (`loadTimelineBlock`), through the
 * whole app and real socket frames. A read that is answered by failure is
 * retried once; one that is lost to a disconnect is reissued by the reconnect
 * snapshot; a block the server says is gone is not asked for again until a
 * snapshot says otherwise; and an answer for another session is never taken
 * for this one — all without collapsing, toggling or reloading the block.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 20_000 });

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

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

/** Everything observed is at the viewport. */
class NearObserver {
  constructor(
    private readonly callback: (
      entries: Array<{ isIntersecting: boolean }>,
    ) => void,
  ) {}
  observe(): void {
    this.callback([{ isIntersecting: true }]);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

await import("./components/MessageList.tsx");
const App = (await import("./App.tsx")).default;
const { ShortcutsProvider } = await import("./components/ui/shortcuts.tsx");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Advance the fake clock inside act; effects and animation frames run. */
async function tick(ms = 30): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  // Reasoning shown and every block expanded, so a persisted thinking body is
  // asked for as soon as its block is near the viewport.
  window.localStorage.setItem(
    "assistant.prefs",
    JSON.stringify({ showThinking: true, expandThinking: true }),
  );
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NearObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
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
  vi.useRealTimers();
});

const SESSION = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const FULL = "the whole reasoning, which the snapshot withheld";
const PREVIEW = FULL.slice(0, 12);

/**
 * `state` is what the server puts on `ready` for the session its socket URL
 * deep-links to — on a reconnect that is the session still on screen, and it
 * follows the snapshot the reattached view sent (`Connection.init`).
 */
function readyMessage(viewed = false): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: viewed
      ? {
          sessionId: SESSION,
          harness: "pi",
          agentType: "assistant",
          thinkingLevel: "off",
        }
      : null,
    models: [],
    agents: [],
    sessions: [
      {
        id: SESSION,
        harness: "pi",
        agentType: "assistant",
        title: "A",
        updatedAt: 1_700_000_000_000,
        messageCount: 2,
        isStreaming: false,
      },
    ],
    settings: {},
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  } as unknown as ServerMessage;
}

const TIMELINE = [
  {
    id: "u1",
    seq: 1,
    createdAt: new Date(1_700_000_000_000).toISOString(),
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "think about it" }],
  },
  {
    id: "a1",
    seq: 2,
    createdAt: new Date(1_700_000_001_000).toISOString(),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "thinking",
        text: PREVIEW,
        lazy: {
          entryId: "a1",
          blockIndex: 0,
          kind: "thinking",
          fullLength: FULL.length,
          previewLength: PREVIEW.length,
        },
      },
      { type: "text", text: "done" },
    ],
  },
];

/**
 * A settled session whose one assistant entry has a lazily projected thinking
 * block. `cacheHit` is what the server answers a reconnecting browser that
 * offered the range it persisted: no entries, just the anchor — the client
 * splices its OWN cached entry objects back in, so every lazy ref keeps its
 * identity and no block effect re-fires.
 */
function snapshotMessage(cacheHit = false): ServerMessage {
  const base = describeTimelineCache(TIMELINE as never, 0);
  return {
    type: "snapshot",
    state: {
      sessionId: SESSION,
      harness: "pi",
      agentType: "assistant",
      thinkingLevel: "off",
    },
    contextInfo: null,
    snapshot: {
      sessionId: SESSION,
      runState: "idle",
      totalEntryCount: 2,
      ...(cacheHit
        ? {
            timelineStart: TIMELINE.length,
            timeline: [],
            timelineBase: base,
            timelineCache: base,
          }
        : { timelineStart: 0, timeline: TIMELINE }),
      streaming: [],
    },
  } as unknown as ServerMessage;
}

const BLOCK = { entryId: "a1", blockIndex: 0, kind: "thinking" as const };

function reads(socket: ScenarioSocket) {
  return socket.sent.filter(
    (m): m is Extract<ClientMessage, { type: "loadTimelineBlock" }> =>
      m.type === "loadTimelineBlock",
  );
}

function loaded(sessionId: string, content: string): ServerMessage {
  return { type: "timelineBlockLoaded", sessionId, ...BLOCK, content };
}

function failed(reason: "error" | "unavailable"): ServerMessage {
  return {
    type: "timelineBlockFailed",
    sessionId: SESSION,
    ...BLOCK,
    reason,
    message: reason,
  };
}

async function openChat(): Promise<ScenarioSocket> {
  window.history.replaceState(null, "", `/sessions/${SESSION}`);
  await act(async () => {
    root!.render(
      <ShortcutsProvider>
        <App />
      </ShortcutsProvider>,
    );
  });
  await tick();
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => socket.receive(snapshotMessage()));
  await tick();
  return socket;
}

async function reconnect(
  previous: ScenarioSocket,
  cacheHit = false,
): Promise<ScenarioSocket> {
  await act(async () => previous.close());
  await tick(1_100);
  const next = ScenarioSocket.instances.at(-1)!;
  expect(next).not.toBe(previous);
  // As the server does on a deep-linked (re)connect: the reattached view's
  // snapshot first, then `ready` carrying that session's state.
  await act(async () => {
    next.open();
    next.receive(snapshotMessage(cacheHit));
    next.receive(readyMessage(true));
  });
  await tick();
  return next;
}

describe("durable-body reads", () => {
  it("retries a failed read once, and a second failure is terminal for the transport", async () => {
    const socket = await openChat();
    // The expanded block asked for its body exactly once.
    expect(reads(socket)).toEqual([{ type: "loadTimelineBlock", ...BLOCK }]);
    expect(container!.textContent).toContain(PREVIEW);
    expect(container!.textContent).not.toContain(FULL);

    // A read failure is not an answer: one more attempt follows, after a pause,
    // and no earlier.
    await act(async () => socket.receive(failed("error")));
    await tick(500);
    expect(reads(socket)).toHaveLength(1);
    await tick(1_200);
    expect(reads(socket)).toHaveLength(2);
    // The second failure is terminal for this transport: no storm.
    await act(async () => socket.receive(failed("error")));
    await tick(3_000);
    expect(reads(socket)).toHaveLength(2);

    // An answer for another session is not this block's.
    await act(async () => socket.receive(loaded(OTHER, "someone else's")));
    await tick();
    expect(container!.textContent).not.toContain("someone else's");
  });

  it("reissues a read lost to a disconnect from the reconnect snapshot, with cached entries kept by identity", async () => {
    const socket = await openChat();
    expect(reads(socket)).toHaveLength(1);
    // Nothing answers the read; the connection drops with it outstanding.
    // The browser reconnects OFFERING the range it persisted (the socket URL
    // carries the anchor), and the server answers with a cache hit: no
    // entries, so the client splices its own cached entry objects back in.
    // Every lazy ref keeps its identity, no block effect re-fires — only the
    // pending-read reissue can ask again.
    const second = await reconnect(socket, true);
    expect(
      new URL(second.url, "http://localhost").searchParams.get("tlf"),
    ).toBe(describeTimelineCache(TIMELINE as never, 0).fingerprint);
    expect(container!.textContent).toContain(PREVIEW);
    expect(reads(second)).toEqual([{ type: "loadTimelineBlock", ...BLOCK }]);

    // The answer lands in the block that was never collapsed or toggled.
    await act(async () => second.receive(loaded(SESSION, FULL)));
    await tick();
    expect(container!.textContent).toContain(FULL);
  });

  it("stops asking for a block the server says is gone, until a snapshot says otherwise", async () => {
    const socket = await openChat();
    expect(reads(socket)).toHaveLength(1);
    await act(async () => socket.receive(failed("unavailable")));
    await tick(3_000);
    expect(reads(socket)).toHaveLength(1);
    // The block is still on screen as its preview, not blank.
    expect(container!.textContent).toContain(PREVIEW);

    // A fresh snapshot is the server's new word. Here it is a cache HIT: the
    // client splices its own entry objects back in, every ref keeps its
    // identity and the still-open block's effect does not re-fire — so the
    // ONE bounded read that follows can only come from the snapshot requeuing
    // what the server had refused. Then it is answered, with no toggle.
    const second = await reconnect(socket, true);
    expect(reads(second)).toEqual([{ type: "loadTimelineBlock", ...BLOCK }]);
    await tick(3_000);
    expect(reads(second)).toHaveLength(1);
    await act(async () => second.receive(loaded(SESSION, FULL)));
    await tick();
    expect(container!.textContent).toContain(FULL);
  });
});
