// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type { SessionTimelineCacheRecord } from "./lib/sessionTimelineCache.ts";

/**
 * What opening a chat COSTS, in counts (Task-435). Never durations: this file
 * exists to keep the switch from growing a second transcript read or a second
 * `loadSession`, both of which are invisible until a phone on a slow disk shows
 * the pending panel for a beat too long.
 *
 * The cached timeline prefix is read once per session and kept in memory: a
 * row's tap WARMS that read so `loadSession` finds the descriptor already
 * there, and the descriptor is what earns the server's tail-only answer — a
 * load that leaves without it re-sends the whole transcript.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const reads: string[] = [];
let resolveRead: (() => void) | null = null;

function record(sessionId: string): SessionTimelineCacheRecord {
  return {
    version: 2,
    sessionId,
    timeline: [
      { id: "e1", seq: 1 } as SessionTimelineCacheRecord["timeline"][number],
    ],
    descriptor: {
      projectionVersion: 1,
      startIndex: 0,
      entryCount: 1,
      lastEntryId: "e1",
      lastEntrySeq: 1,
      fingerprint: `fp-${sessionId}`,
    },
    savedAt: 1,
  };
}

const deletes: string[] = [];

vi.mock(import("./lib/sessionTimelineCache.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadSessionTimelineCache: (sessionId: string) => {
    reads.push(sessionId);
    return new Promise<SessionTimelineCacheRecord>((resolve) => {
      resolveRead = () => resolve(record(sessionId));
    });
  },
  saveSessionTimelineCache: async () => {},
  deleteSessionTimelineCache: async (sessionId: string) => {
    deletes.push(sessionId);
  },
}));

const { useAssistant } = await import("./hooks/useAssistant.ts");
const { useSessionRouting } = await import("./hooks/useSessionRouting.ts");

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

let actions: ReturnType<typeof useAssistant>["actions"] | null = null;
let uiState: ReturnType<typeof useAssistant>["state"] | null = null;

function AssistantHarness() {
  const assistant = useAssistant();
  actions = assistant.actions;
  uiState = assistant.state;
  return null;
}

/** The route→server half of the app: the one caller of `loadSession`. */
function RoutingHarness({
  path,
  currentId,
  loadSession,
}: {
  path: string;
  currentId?: string;
  loadSession: (id: string) => void;
}) {
  const { navigate } = useSessionRouting({
    connected: true,
    hydrated: true,
    sessions: [],
    currentId,
    hasMessages: false,
    loadSession,
    openPermanentAssistant: () => {},
  });
  useEffect(() => {
    if (location.pathname !== path) navigate(path);
  }, [navigate, path]);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/sessions/create");
  reads.length = 0;
  deletes.length = 0;
  resolveRead = null;
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

describe("session switch request counts", () => {
  it("boots with one cache read, and connects with the descriptor it answers", async () => {
    window.history.replaceState(null, "", "/sessions/s-boot");
    await act(async () => root!.render(<AssistantHarness />));

    // The read is started by the first render, and the socket waits for it:
    // the descriptor rides on the connection URL, which is what makes the
    // server's first snapshot a tail.
    expect(reads).toEqual(["s-boot"]);
    expect(ScenarioSocket.instances).toHaveLength(0);

    await act(async () => resolveRead!());
    const socket = ScenarioSocket.instances[0]!;
    expect(socket.url).toContain("sessionId=s-boot");
    expect(socket.url).toContain("tlf=fp-s-boot");

    // Viewing the session the app booted on reuses that read.
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    await act(async () => actions!.loadSession("s-boot"));
    expect(reads).toEqual(["s-boot"]);
    expect(
      socket.sent.filter((message) => message.type === "loadSession"),
    ).toHaveLength(1);

    // R2 across a dropped socket: the prefix is in memory, so the reconnect
    // re-attaches against it — no second read, and the answer is still a tail,
    // which is what lets the rows on screen stay there.
    vi.useFakeTimers();
    await act(async () => {
      socket.close();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(reads).toEqual(["s-boot"]);
    expect(ScenarioSocket.instances[1]!.url).toContain("tlf=fp-s-boot");
    vi.useRealTimers();
  });

  it("reads a switched-to session's cache once across warm and load", async () => {
    await act(async () => root!.render(<AssistantHarness />));
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    expect(reads).toEqual([]);

    // Tapping the row warms the read; the navigation that follows joins it.
    await act(async () => actions!.warmSessionTimeline("s-b"));
    window.history.replaceState(null, "", "/sessions/s-b");
    await act(async () => actions!.loadSession("s-b"));
    expect(reads).toEqual(["s-b"]);

    await act(async () => resolveRead!());
    const loads = socket.sent.filter(
      (message): message is Extract<ClientMessage, { type: "loadSession" }> =>
        message.type === "loadSession",
    );
    expect(loads).toHaveLength(1);
    expect(loads[0]!.timelineCache?.fingerprint).toBe("fp-s-b");

    // Re-viewing it later answers from memory: no second read, no second load
    // without one.
    await act(async () => actions!.loadSession("s-b"));
    expect(reads).toEqual(["s-b"]);
    expect(
      socket.sent.filter((message) => message.type === "loadSession"),
    ).toHaveLength(2);
  });

  it("asks for older entries only when the reader does, and once", async () => {
    await act(async () => root!.render(<AssistantHarness />));
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });

    // A windowed snapshot: the transcript starts at entry 400 of 600.
    await act(async () =>
      socket.receive({
        type: "snapshot",
        state: {
          sessionId: "s-w",
          harness: "pi",
          agentType: "assistant",
          thinkingLevel: "off",
        },
        contextInfo: null as never,
        snapshot: {
          sessionId: "s-w",
          runState: "idle",
          timeline: [
            {
              id: "e400",
              seq: 400,
              createdAt: "2026-01-01T00:00:00.000Z",
              type: "message",
              role: "user",
              origin: { kind: "human" },
              content: [{ type: "text", text: "hi" }],
            },
          ],
          timelineStart: 400,
          totalEntryCount: 401,
          streaming: [],
        },
      }),
    );
    const ranges = () =>
      socket.sent.filter((message) => message.type === "loadTimelineRange");
    // Opening it is ONE snapshot and nothing else: older entries are not
    // speculatively fetched.
    expect(ranges()).toHaveLength(0);

    await act(async () => actions!.loadOlderTimeline());
    expect(ranges()).toHaveLength(1);

    // A second tap while the first is in flight is not a second request.
    await act(async () => actions!.loadOlderTimeline());
    expect(ranges()).toHaveLength(1);
  });

  it("re-requests a window when the cached range renders nothing", async () => {
    // Task 450: the server accepted the browser's anchor, so the answer is only
    // the tail after it — and here that tail plus the cached range projects to
    // ZERO rows (a range of orphan tool results). Rendering it would leave a
    // blank transcript, and the same record would be re-saved on every open, so
    // the load is retried with an empty descriptor: an authoritative window.
    window.history.replaceState(null, "", "/sessions/s-boot");
    await act(async () => root!.render(<AssistantHarness />));
    await act(async () => resolveRead!());
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });

    await act(async () =>
      socket.receive({
        type: "snapshot",
        state: {
          sessionId: "s-boot",
          harness: "pi",
          agentType: "assistant",
          thinkingLevel: "off",
        },
        contextInfo: null as never,
        snapshot: {
          sessionId: "s-boot",
          runState: "idle",
          timeline: [
            {
              id: "e2",
              seq: 2,
              createdAt: "2026-01-01T00:00:00.000Z",
              type: "message",
              role: "toolResult",
              toolCallId: "tc-2",
              content: [{ type: "text", text: "output" }],
              isError: false,
            },
          ],
          timelineStart: 1,
          totalEntryCount: 2,
          timelineBase: record("s-boot").descriptor,
          streaming: [],
        },
      }),
    );

    const loads = socket.sent.filter(
      (message): message is Extract<ClientMessage, { type: "loadSession" }> =>
        message.type === "loadSession",
    );
    expect(loads).toHaveLength(1);
    expect(loads[0]!.id).toBe("s-boot");
    expect(loads[0]!.timelineCache?.entryCount).toBe(0);
    expect(deletes).toEqual(["s-boot"]);
    // Nothing was rendered from the poisoned splice while the retry is in flight.
    expect(uiState!.timeline).toEqual([]);
  });

  it("issues exactly one loadSession per navigation", async () => {
    const loadSession = vi.fn();
    await act(async () =>
      root!.render(
        <RoutingHarness path="/sessions/s-a" loadSession={loadSession} />,
      ),
    );
    expect(loadSession.mock.calls).toEqual([["s-a"]]);

    // Re-rendering the same route (a broadcast, a prop change) is not a
    // navigation and must not re-request the transcript.
    await act(async () =>
      root!.render(
        <RoutingHarness
          path="/sessions/s-a"
          currentId="s-a"
          loadSession={loadSession}
        />,
      ),
    );
    expect(loadSession.mock.calls).toEqual([["s-a"]]);

    await act(async () =>
      root!.render(
        <RoutingHarness
          path="/sessions/s-b"
          currentId="s-a"
          loadSession={loadSession}
        />,
      ),
    );
    expect(loadSession.mock.calls).toEqual([["s-a"], ["s-b"]]);
  });
});
