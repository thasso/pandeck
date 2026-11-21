// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  OnboardingState,
  ServerMessage,
} from "@assistant/shared";

/**
 * First-run guided setup (`docs/onboarding.md`): once the server says `setup`,
 * the app opens the Personal Assistant's chat in the focused shell, with the
 * app's greeting above the transcript and Finish setup in the header, until
 * the server says `complete`.
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
let finishRequests = 0;
let finishAnswer: { status: number; body: unknown } = {
  status: 200,
  body: { state: "complete" },
};
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
  finishRequests = 0;
  finishAnswer = { status: 200, body: { state: "complete" } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/onboarding/finish") && init?.method === "POST") {
        finishRequests += 1;
        return new Response(JSON.stringify(finishAnswer.body), {
          status: finishAnswer.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ profiles: [], modelsByProfile: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
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

const ASSISTANT = "00000000-0000-4000-8000-0000000000ab";

function readyMessage(onboarding: OnboardingState): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    settings: {
      permanentAssistant: {
        name: "Larry",
        workingDirectory: "",
        defaultWorkingDirectory: "/data/pa",
        provider: "claude-sdk",
        modelId: "opus",
        thinkingLevel: "medium",
        additionalInstructions: "",
      },
    },
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
    onboarding,
  } as unknown as ServerMessage;
}

function assistantSnapshot(messages: string[]): ServerMessage {
  return {
    type: "snapshot",
    state: {
      sessionId: ASSISTANT,
      harness: "claude-sdk",
      agentType: "personal-assistant",
      thinkingLevel: "medium",
    },
    contextInfo: null,
    snapshot: {
      sessionId: ASSISTANT,
      runState: "idle",
      timelineStart: 0,
      totalEntryCount: messages.length,
      timeline: messages.map((text, index) => ({
        id: `u-${index}`,
        seq: index + 1,
        createdAt: new Date(1_700_000_000_000 + index).toISOString(),
        type: "message",
        role: "user",
        origin: { kind: "human" },
        content: [{ type: "text", text }],
      })),
      streaming: [],
    },
  } as unknown as ServerMessage;
}

async function boot(
  path: string,
  onboarding: OnboardingState,
): Promise<ScenarioSocket> {
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
    socket.receive(readyMessage(onboarding));
  });
  await settle();
  return socket;
}

const GREETING =
  "Should I keep it, or would you like to call me something else?";
const finishButton = () =>
  [...container!.querySelectorAll("button")].find(
    (button) => button.textContent === "Finish setup",
  );
const topBar = () => container!.querySelector('[aria-label="Toggle theme"]');

describe("guided setup", () => {
  it("opens the assistant's chat in the focused shell, greeting above the transcript", async () => {
    const socket = await boot("/sessions/create", "setup");
    // New Session leads to the assistant while setup lasts, replacing the
    // redirecting entry.
    expect(window.location.pathname).toBe("/assistant");
    await act(async () => socket.receive(assistantSnapshot([])));
    await settle();
    // Before the first message the greeting stands in for the transcript…
    expect(container!.textContent).toContain(GREETING);
    expect(container!.textContent).toContain("I’m Larry.");
    expect(finishButton()).toBeDefined();
    expect(topBar()).toBeNull();
    // …and stays above it once the conversation has begun (a reload too).
    await act(async () => socket.receive(assistantSnapshot(["Keep Larry."])));
    await settle();
    const text = container!.textContent ?? "";
    expect(text).toContain(GREETING);
    expect(text).toContain("Keep Larry.");
    expect(text.indexOf(GREETING)).toBeLessThan(text.indexOf("Keep Larry."));
  });

  it("moves from the welcome screen to setup when the server says so", async () => {
    const socket = await boot("/sessions/create", "pending");
    expect(container!.textContent).toContain("Connect your first AI account");
    await act(async () =>
      socket.receive({ type: "onboarding", state: "setup" }),
    );
    await settle();
    expect(window.location.pathname).toBe("/assistant");
    expect(finishButton()).toBeDefined();
  });

  it("Finish setup asks the server, and the normal shell returns on its word", async () => {
    const socket = await boot("/assistant", "setup");
    await act(async () => socket.receive(assistantSnapshot(["Done."])));
    await settle();
    await act(async () => finishButton()!.click());
    await settle();
    expect(finishRequests).toBe(1);
    // The broadcast, not the answer, ends setup on every client.
    await act(async () =>
      socket.receive({ type: "onboarding", state: "complete" }),
    );
    await settle();
    expect(finishButton()).toBeUndefined();
    expect(container!.textContent).not.toContain(GREETING);
    expect(container!.textContent).toContain("Done.");
    expect(topBar()).not.toBeNull();
    expect(window.location.pathname).toBe("/assistant");
  });

  it("a failed finish says so on the header and keeps setup", async () => {
    finishAnswer = {
      status: 500,
      body: { error: "Setup could not finish: disk full" },
    };
    const socket = await boot("/assistant", "setup");
    await act(async () => socket.receive(assistantSnapshot([])));
    await settle();
    await act(async () => finishButton()!.click());
    await settle();
    expect(container!.textContent).toContain(
      "Setup could not finish: disk full",
    );
    expect(finishButton()).toBeDefined();
  });

  it("an established install shows none of it", async () => {
    const socket = await boot("/assistant", "complete");
    await act(async () => socket.receive(assistantSnapshot([])));
    await settle();
    expect(container!.textContent).not.toContain(GREETING);
    expect(finishButton()).toBeUndefined();
    expect(topBar()).not.toBeNull();
  });
});
