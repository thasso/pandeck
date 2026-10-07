// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

/**
 * Live-body demand across a session switch, through the whole app and real
 * socket frames. The case this pins: both sessions stream, both use the SAME
 * stream/block key for their thinking block, and the expanded block sits near
 * the viewport — so React keeps the live row mounted across the switch and no
 * visibility toggles. The old subscription must go, the new session must be
 * subscribed under ITS id after its snapshot is in, stale frames for the old
 * session must be ignored, and the new session's exact text must land.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Mounts the whole app into jsdom (see `transcriptRedrawScenario.test.tsx`).
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

/** Everything observed is at the viewport: what "near" means for this test. */
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
const { ShortcutsProvider } = await import("./components/common/shortcuts.tsx");

const FRAME_MS = 25;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(frames = 4): Promise<void> {
  for (let i = 0; i < frames; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
    });
}

beforeEach(() => {
  window.localStorage.clear();
  // Reasoning is hidden by default; this reader shows it, and a live block
  // opens itself while streaming (`ThinkingBlock`).
  window.localStorage.setItem(
    "assistant.prefs",
    JSON.stringify({ showThinking: true }),
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
});

const SESSION_A = "00000000-0000-4000-8000-00000000000a";
const SESSION_B = "00000000-0000-4000-8000-00000000000b";
const THINKING_KEY = { streamId: "m1", blockIndex: 0, kind: "thinking" };

function sessionRow(id: string, title: string) {
  return {
    id,
    harness: "pi",
    agentType: "assistant",
    title,
    updatedAt: 1_700_000_000_000,
    messageCount: 1,
    isStreaming: true,
  };
}

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: [sessionRow(SESSION_A, "A"), sessionRow(SESSION_B, "B")],
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

/** A mid-turn snapshot: one live thinking block, same key in both sessions. */
function streamingSnapshot(id: string, length: number): ServerMessage {
  return {
    type: "snapshot",
    state: {
      sessionId: id,
      harness: "pi",
      agentType: "assistant",
      thinkingLevel: "off",
    },
    contextInfo: null,
    snapshot: {
      sessionId: id,
      runState: "running",
      timelineStart: 0,
      totalEntryCount: 1,
      timeline: [
        {
          id: `u-${id}`,
          seq: 1,
          createdAt: new Date(1_700_000_000_000).toISOString(),
          type: "message",
          role: "user",
          origin: { kind: "human" },
          content: [{ type: "text", text: `prompt for ${id}` }],
        },
      ],
      streaming: [
        {
          streamId: "m1",
          kind: "message",
          role: "assistant",
          content: [
            { type: "thinking", text: "", live: { ...THINKING_KEY, length } },
          ],
        },
      ],
    },
  } as unknown as ServerMessage;
}

function liveBody(sessionId: string, content: string): ServerMessage {
  return {
    type: "event",
    sessionId,
    event: {
      type: "liveBody",
      key: THINKING_KEY,
      mode: "replace",
      offset: 0,
      content,
      length: content.length,
    },
  } as unknown as ServerMessage;
}

function subscriptions(socket: ScenarioSocket) {
  return socket.sent.filter(
    (m): m is Extract<ClientMessage, { type: "setLiveBodySubscriptions" }> =>
      m.type === "setLiveBodySubscriptions",
  );
}

async function openChat(): Promise<ScenarioSocket> {
  window.history.replaceState(null, "", `/sessions/${SESSION_A}`);
  await act(async () => {
    root!.render(
      <ShortcutsProvider>
        <App />
      </ShortcutsProvider>,
    );
  });
  await settle();
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => socket.receive(streamingSnapshot(SESSION_A, 40)));
  await settle();
  return socket;
}

describe("live-body demand across a session switch", () => {
  it("re-subscribes the mounted expanded block under the new session and ignores the old one's frames", async () => {
    const socket = await openChat();

    // Session A: the live thinking block opened itself (streaming) near the
    // viewport, so the app declared demand for it under A's id.
    let declared = subscriptions(socket);
    expect(declared.at(-1)).toEqual({
      type: "setLiveBodySubscriptions",
      sessionId: SESSION_A,
      bodies: [THINKING_KEY],
    });
    await act(async () => socket.receive(liveBody(SESSION_A, "A is thinking")));
    await settle();
    expect(container!.textContent).toContain("A is thinking");

    // Switch to session B the way the sidebar does — navigate, and the server
    // answers with B's snapshot, which reuses the same stream and block.
    const before = subscriptions(socket).length;
    await act(async () => {
      window.history.pushState({ navIndex: 1 }, "", `/sessions/${SESSION_B}`);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await settle(1);
    expect(
      socket.sent.some((m) => m.type === "loadSession" && m.id === SESSION_B),
    ).toBe(true);
    await act(async () => socket.receive(streamingSnapshot(SESSION_B, 12)));
    await settle();
    declared = subscriptions(socket).slice(before);
    // Leaving A can only RELEASE under A's id (the transcript unmounts while A
    // is still the viewed session; the server ignores it once the view has
    // moved), never subscribe; and the last word is a complete declaration
    // under B's id for the block, made after B's snapshot was applied.
    for (const m of declared)
      if (m.sessionId !== SESSION_B) {
        expect(m.sessionId).toBe(SESSION_A);
        expect(m.bodies).toEqual([]);
      }
    expect(declared.at(-1)).toEqual({
      type: "setLiveBodySubscriptions",
      sessionId: SESSION_B,
      bodies: [THINKING_KEY],
    });
    // The compact snapshot replaced A's text; nothing of A is on screen.
    expect(container!.textContent).not.toContain("A is thinking");

    // A late frame for A is not B's body.
    await act(async () => socket.receive(liveBody(SESSION_A, "stale from A")));
    await settle();
    expect(container!.textContent).not.toContain("stale from A");

    // B's snapshot of the body lands in the block that never toggled.
    await act(async () => socket.receive(liveBody(SESSION_B, "B is here")));
    await settle();
    expect(container!.textContent).toContain("B is here");
  });
});
