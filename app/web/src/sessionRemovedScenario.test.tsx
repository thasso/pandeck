// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

/**
 * What the app does when the SERVER takes a session away — `sessionViewCleared`
 * for a session deleted from another client while this one showed it, or for a
 * load of it that a deletion or archive superseded before it attached. The URL
 * then names nothing: it moves to the staged new-session surface, once, on
 * arrival — a later deliberate open of an archived session must not bounce.
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
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
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
  // The new-session composer's runtime picker scrolls its selection into view;
  // jsdom has no layout.
  Element.prototype.scrollIntoView = () => {};
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

function sessionRow(id: string, title: string) {
  return {
    id,
    harness: "pi",
    agentType: "assistant",
    title,
    updatedAt: 1_700_000_000_000,
    messageCount: 1,
    isStreaming: false,
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

function snapshotMessage(id: string): ServerMessage {
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
      runState: "idle",
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
      streaming: [],
    },
  } as unknown as ServerMessage;
}

function cleared(
  sessionId: string,
  reason: "deleted" | "archived",
): ServerMessage {
  return { type: "sessionViewCleared", sessionId, reason };
}

function loads(socket: ScenarioSocket): string[] {
  return socket.sent
    .filter(
      (m): m is Extract<ClientMessage, { type: "loadSession" }> =>
        m.type === "loadSession",
    )
    .map((m) => m.id);
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
  await act(async () => socket.receive(snapshotMessage(SESSION_A)));
  await settle();
  expect(container!.textContent).toContain(`prompt for ${SESSION_A}`);
  return socket;
}

async function navigateTo(path: string): Promise<void> {
  await act(async () => {
    window.history.pushState({ navIndex: 1 }, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  });
  await settle(1);
}

describe("a session the server takes away", () => {
  it("leaves the route of a session deleted from elsewhere while it was on show", async () => {
    const socket = await openChat();
    await act(async () => socket.receive(cleared(SESSION_A, "deleted")));
    await settle();
    expect(window.location.pathname).toBe("/sessions/create");
    expect(container!.textContent).not.toContain(`prompt for ${SESSION_A}`);
  });

  it("leaves the route of a session it was still loading when that load was superseded", async () => {
    const socket = await openChat();
    // Click B: the route names it and the load is out, nothing on show yet
    // beyond A. The server then removes B before the load attaches.
    await navigateTo(`/sessions/${SESSION_B}`);
    expect(loads(socket)).toEqual([SESSION_A, SESSION_B]);
    await act(async () => socket.receive(cleared(SESSION_B, "deleted")));
    await settle();
    expect(window.location.pathname).toBe("/sessions/create");
    // The pending route did not wait: no further load of B was asked for.
    expect(loads(socket)).toEqual([SESSION_A, SESSION_B]);
  });

  it("does not bounce a later deliberate open of an archived session", async () => {
    const socket = await openChat();
    // The reader archives A: the client leaves for the new-session surface
    // before asking, and the server's clear arrives there.
    await navigateTo("/sessions/create");
    await act(async () => socket.receive(cleared(SESSION_A, "archived")));
    await settle();
    expect(window.location.pathname).toBe("/sessions/create");
    // Opening A from the archive later is a new intent: the route holds and
    // the session is asked for.
    await navigateTo(`/sessions/${SESSION_A}`);
    await settle();
    expect(window.location.pathname).toBe(`/sessions/${SESSION_A}`);
    expect(loads(socket).at(-1)).toBe(SESSION_A);
    await act(async () => socket.receive(snapshotMessage(SESSION_A)));
    await settle();
    expect(window.location.pathname).toBe(`/sessions/${SESSION_A}`);
    expect(container!.textContent).toContain(`prompt for ${SESSION_A}`);
  });
});
