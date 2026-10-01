// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

/**
 * `/sessions/:id#m-<entryId>` — one message, addressed in the URL — measured on
 * the whole app, because the thing that breaks is the wiring between the
 * fragment and the app's route state.
 *
 * A fragment moves UNDER an unchanged route: back/forward between two messages
 * of one session, or leaving a deep link and returning to it later, changes no
 * route field at all. An effect keyed on the route alone therefore never re-runs
 * and the reader is left wherever the transcript happens to sit, which looks
 * exactly like a dead link. Every assertion here is about that: the app ASKS
 * where the addressed message is, once per address it arrives at.
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
const { ShortcutsProvider } = await import("./components/ui/shortcuts.tsx");

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const FRAME_MS = 25;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
    });
}

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: [
      {
        id: SESSION_ID,
        harness: "pi",
        agentType: "assistant",
        title: "Session",
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

function snapshotMessage(): ServerMessage {
  return {
    type: "snapshot",
    state: {
      sessionId: SESSION_ID,
      harness: "pi",
      agentType: "assistant",
      thinkingLevel: "off",
    },
    contextInfo: null,
    snapshot: {
      sessionId: SESSION_ID,
      runState: "idle",
      timelineStart: 0,
      streaming: [],
      timeline: Array.from({ length: 4 }, (_, i) => ({
        id: `e${i}`,
        seq: i + 1,
        createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        type: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        ...(i % 2 === 0 ? { origin: { kind: "human" } } : {}),
        content: [{ type: "text", text: `entry ${i}` }],
      })),
      pendingApprovals: [],
      activity: [],
    },
  } as unknown as ServerMessage;
}

/** The addresses the app asked the server to resolve, in order. */
function asked(socket: ScenarioSocket): string[] {
  return socket.sent
    .filter((msg) => msg.type === "resolveTimelineAnchor")
    .map((msg) => {
      const target = (msg as { target: { kind: string; entryId?: string } })
        .target;
      return `${target.kind}:${target.entryId ?? ""}`;
    });
}

/** Move the browser to `path` the way the back/forward arrows do. */
async function goTo(path: string): Promise<void> {
  await act(async () => {
    window.history.pushState({ navIndex: 1 }, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  });
  await settle(1);
}

async function boot(path: string): Promise<ScenarioSocket> {
  window.history.replaceState(null, "", path);
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
  await act(async () => socket.receive(snapshotMessage()));
  await settle();
  return socket;
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

describe("a message addressed in the URL", () => {
  it("asks where it is on arrival, and not again while sitting on it", async () => {
    const socket = await boot(`/sessions/${SESSION_ID}#m-e1`);
    expect(asked(socket)).toEqual(["entry:e1"]);

    await settle();
    expect(asked(socket)).toEqual(["entry:e1"]);
  });

  it("follows the fragment moving under an unchanged route", async () => {
    const socket = await boot(`/sessions/${SESSION_ID}#m-e1`);

    // Back/forward between two messages of the SAME session: the route does not
    // change, only the address does.
    await goTo(`/sessions/${SESSION_ID}#m-e3`);
    expect(asked(socket)).toEqual(["entry:e1", "entry:e3"]);

    // Leaving the fragment asks nothing…
    await goTo(`/sessions/${SESSION_ID}`);
    expect(asked(socket)).toEqual(["entry:e1", "entry:e3"]);

    // …and coming back to an address already visited reveals it again, rather
    // than being swallowed as "already done".
    await goTo(`/sessions/${SESSION_ID}#m-e3`);
    expect(asked(socket)).toEqual(["entry:e1", "entry:e3", "entry:e3"]);
  });

  it("ignores a fragment that is not a message address", async () => {
    const socket = await boot(`/sessions/${SESSION_ID}`);
    await goTo(`/sessions/${SESSION_ID}#something-else`);
    expect(asked(socket)).toEqual([]);
  });
});
