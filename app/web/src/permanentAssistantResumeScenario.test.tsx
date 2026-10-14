// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

/**
 * The permanent Assistant after a Stop (`automaticTurnHold.ts`): it has no
 * draft queue to show, but what it is owed waits for Resume, so `/assistant`
 * offers that Resume — addressed to the Assistant's own session — and nothing
 * else of the queue.
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

const ASSISTANT = "00000000-0000-4000-8000-0000000000aa";

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
  } as unknown as ServerMessage;
}

function assistantSnapshot(held: boolean): ServerMessage {
  return {
    type: "snapshot",
    state: {
      sessionId: ASSISTANT,
      harness: "pi",
      agentType: "personal-assistant",
      thinkingLevel: "off",
      ...(held
        ? {
            promptQueue: { items: [], paused: true, automaticTurnsHeld: true },
          }
        : {}),
    },
    contextInfo: null,
    snapshot: {
      sessionId: ASSISTANT,
      runState: "idle",
      timelineStart: 0,
      totalEntryCount: 1,
      timeline: [
        {
          id: "u-assistant",
          seq: 1,
          createdAt: new Date(1_700_000_000_000).toISOString(),
          type: "message",
          role: "user",
          origin: { kind: "human" },
          content: [{ type: "text", text: "assistant conversation" }],
        },
      ],
      streaming: [],
    },
  } as unknown as ServerMessage;
}

async function openAssistant(held: boolean): Promise<ScenarioSocket> {
  window.history.replaceState(null, "", "/assistant");
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
  await act(async () => socket.receive(assistantSnapshot(held)));
  await settle();
  expect(container!.textContent).toContain("assistant conversation");
  return socket;
}

const resumeButton = () =>
  [...container!.querySelectorAll("button")].find(
    (button) => button.textContent === "Resume",
  );

describe("the permanent Assistant after a Stop", () => {
  it("releases its PA reader when App leaves /assistant and reopens it on return", async () => {
    const socket = await openAssistant(false);
    await act(async () => {
      window.history.pushState(null, "", "/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(
      socket.sent.filter(
        (message) => message.type === "releasePermanentAssistant",
      ),
    ).toEqual([{ type: "releasePermanentAssistant", sessionId: ASSISTANT }]);
    const previousOpens = socket.sent.filter(
      (message) => message.type === "openPermanentAssistant",
    ).length;
    await act(async () => {
      window.history.pushState(null, "", "/assistant");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const opens = socket.sent.filter(
      (message) => message.type === "openPermanentAssistant",
    );
    expect(opens).toHaveLength(previousOpens + 1);
    expect(opens.at(-1)).toMatchObject({
      timelineCache: {
        startIndex: 0,
        entryCount: 1,
        lastEntryId: "u-assistant",
      },
    });
  });
  it("keeps an explicitly deep-linked PA session attached while its transcript is visible", async () => {
    const socket = await openAssistant(false);
    await act(async () => {
      window.history.pushState(null, "", `/sessions/${ASSISTANT}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(
      socket.sent.filter(
        (message) => message.type === "releasePermanentAssistant",
      ),
    ).toEqual([]);
  });

  it("offers Resume with nothing queued, and sends it for the Assistant's session", async () => {
    const socket = await openAssistant(true);
    expect(
      container!.querySelector("[data-prompt-queue-ledge]"),
    ).not.toBeNull();
    expect(container!.textContent).toContain("Stopped");
    await act(async () => resumeButton()!.click());
    expect(socket.sent.filter((m) => m.type === "resumePromptQueue")).toEqual([
      { type: "resumePromptQueue", sessionId: ASSISTANT },
    ]);

    // The server lifts the hold: the strip goes.
    await act(async () =>
      socket.receive({
        type: "promptQueue",
        sessionId: ASSISTANT,
        queue: { items: [], paused: false },
      }),
    );
    await settle(1);
    expect(container!.querySelector("[data-prompt-queue-ledge]")).toBeNull();
  });

  it("shows no queue at all while it is not held", async () => {
    await openAssistant(false);
    expect(container!.querySelector("[data-prompt-queue-ledge]")).toBeNull();
    expect(resumeButton()).toBeUndefined();
  });
});
