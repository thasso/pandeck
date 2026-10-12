// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type { RunProgress } from "@assistant/shared/session";

/**
 * The running turn's progress line in the real app: it follows the runtime's
 * observed progress (not committed transcript rows), ages on the clock, is
 * restored by every snapshot — reconnect, session switch, `/assistant` — and
 * never stands in for a Stop's hold.
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SESSION_A = "00000000-0000-4000-8000-00000000000a";
const SESSION_B = "00000000-0000-4000-8000-00000000000b";
const ASSISTANT = "00000000-0000-4000-8000-0000000000aa";

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: [SESSION_A, SESSION_B].map((id) => ({
      id,
      harness: "claude-sdk",
      agentType: "coding",
      title: id === SESSION_A ? "A" : "B",
      updatedAt: 1_700_000_000_000,
      messageCount: 1,
      isStreaming: true,
    })),
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

/** Progress as the server stamps it: `observedAt` is the server's clock. */
function progress(overrides: Partial<RunProgress> = {}): RunProgress {
  const now = Date.now();
  return {
    startedAt: now - 60_000,
    observedAt: now,
    lastActivityAt: now,
    runningTools: [],
    ...overrides,
  };
}

function snapshot(
  id: string,
  options: {
    agentType?: string;
    runProgress?: RunProgress;
    state?: Record<string, unknown>;
  } = {},
): ServerMessage {
  return {
    type: "snapshot",
    state: {
      sessionId: id,
      harness: "claude-sdk",
      agentType: options.agentType ?? "coding",
      thinkingLevel: "off",
      ...options.state,
    },
    contextInfo: null,
    snapshot: {
      sessionId: id,
      runState: options.runProgress ? "running" : "idle",
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
      ...(options.runProgress ? { progress: options.runProgress } : {}),
    },
  } as unknown as ServerMessage;
}

function progressEvent(id: string, value: RunProgress): ServerMessage {
  return {
    type: "event",
    sessionId: id,
    event: { type: "runProgress", progress: value },
  } as ServerMessage;
}

async function open(
  path: string,
  first: ServerMessage,
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
    socket.receive(readyMessage());
  });
  await act(async () => socket.receive(first));
  await settle();
  return socket;
}

const progressLine = () =>
  container!.querySelector<HTMLElement>("[data-run-progress]");

describe("the running turn's progress line", () => {
  it("follows observed progress before anything commits, and ends with the run", async () => {
    const socket = await open(
      `/sessions/${SESSION_A}`,
      snapshot(SESSION_A, {
        runProgress: progress({
          runningTools: [
            { toolCallId: "t1", name: "Bash", startedAt: Date.now() - 7_000 },
          ],
        }),
      }),
    );
    expect(progressLine()?.textContent).toContain("Running command");
    expect(progressLine()?.textContent).toContain("7s");
    expect(progressLine()?.textContent).not.toContain("Thinking");

    // The tool finished: the results are with the model. No transcript row
    // moved, yet the line says so.
    await act(async () =>
      socket.receive(
        progressEvent(
          SESSION_A,
          progress({
            awaitingModelSince: Date.now(),
            lastTool: { name: "Bash", state: "completed", at: Date.now() },
          }),
        ),
      ),
    );
    await settle(1);
    expect(progressLine()?.textContent).toContain("Waiting for model");
    expect(progressLine()?.textContent).toContain("Bash finished");

    // What waits behind the turn, from the session's own queues.
    await act(async () => {
      socket.receive({
        type: "peerPromptQueue",
        sessionId: SESSION_A,
        items: [
          {
            id: "p1",
            senderTitle: "peer",
            senderSessionId: SESSION_B,
            message: "report",
            createdAt: Date.now(),
          },
        ],
      } as ServerMessage);
      socket.receive({
        type: "backgroundUpdateQueue",
        sessionId: SESSION_A,
        count: 2,
      } as ServerMessage);
    });
    await settle(1);
    expect(progressLine()?.textContent).toContain("1 peer message waiting");
    expect(progressLine()?.textContent).toContain(
      "2 background updates waiting",
    );

    // A retry the provider reported is the one warning.
    await act(async () =>
      socket.receive(
        progressEvent(
          SESSION_A,
          progress({
            awaitingModelSince: Date.now() - 90_000,
            retry: { attempt: 2, maxAttempts: 5, status: 529, at: Date.now() },
          }),
        ),
      ),
    );
    await settle(1);
    expect(progressLine()?.dataset.runProgress).toBe("warning");
    expect(progressLine()?.textContent).toContain("Retrying request");
    expect(progressLine()?.textContent).toContain("attempt 2 of 5");

    await act(async () =>
      socket.receive({
        type: "event",
        sessionId: SESSION_A,
        event: { type: "runStateChanged", runState: "idle" },
      } as ServerMessage),
    );
    await settle(1);
    expect(progressLine()).toBeNull();
    // A late progress frame for a run that ended cannot bring the line back.
    await act(async () => socket.receive(progressEvent(SESSION_A, progress())));
    await settle(1);
    expect(progressLine()).toBeNull();
  });

  it("ages on the clock while nothing arrives, without changing its tone", async () => {
    // Before the app mounts, so the line's clock runs on it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open(
      `/sessions/${SESSION_A}`,
      snapshot(SESSION_A, {
        runProgress: progress({ awaitingModelSince: Date.now() }),
      }),
    );
    expect(progressLine()?.textContent).toMatch(/Waiting for model\s*0s/);
    await act(async () => {
      vi.advanceTimersByTime(65_000);
    });
    await settle(1);
    expect(progressLine()?.textContent).toMatch(/Waiting for model\s*1m/);
    expect(progressLine()?.dataset.runProgress).toBe("default");
  });

  it("is restored by each snapshot across a session switch and a reconnect", async () => {
    const socket = await open(
      `/sessions/${SESSION_A}`,
      snapshot(SESSION_A, {
        runProgress: progress({ awaitingModelSince: Date.now() }),
      }),
    );
    expect(progressLine()?.textContent).toContain("Waiting for model");

    await act(async () => {
      window.history.pushState({ navIndex: 1 }, "", `/sessions/${SESSION_B}`);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await settle(1);
    await act(async () => socket.receive(snapshot(SESSION_B)));
    await settle();
    expect(container!.textContent).toContain(`prompt for ${SESSION_B}`);
    expect(progressLine()).toBeNull();
    // A's frames while B is on screen go nowhere.
    await act(async () =>
      socket.receive(
        progressEvent(
          SESSION_A,
          progress({
            runningTools: [
              { toolCallId: "t", name: "Read", startedAt: Date.now() },
            ],
          }),
        ),
      ),
    );
    await settle(1);
    expect(progressLine()).toBeNull();

    // Back to A: its snapshot carries what A is doing now.
    await act(async () => {
      window.history.pushState({ navIndex: 2 }, "", `/sessions/${SESSION_A}`);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await settle(1);
    await act(async () =>
      socket.receive(
        snapshot(SESSION_A, {
          runProgress: progress({
            runningTools: [
              { toolCallId: "t", name: "Read", startedAt: Date.now() },
            ],
          }),
        }),
      ),
    );
    await settle();
    expect(progressLine()?.textContent).toContain("Reading files");

    // A reconnect's snapshot replaces it wholesale — here, the run ended
    // while the socket was down.
    await act(async () => socket.receive(snapshot(SESSION_A)));
    await settle();
    expect(progressLine()).toBeNull();
  });

  it("shows on /assistant, and a Stop's hold is never shown as waiting", async () => {
    const socket = await open(
      "/assistant",
      snapshot(ASSISTANT, {
        agentType: "personal-assistant",
        runProgress: progress({ awaitingModelSince: Date.now() - 3_000 }),
      }),
    );
    expect(progressLine()?.textContent).toContain("Waiting for model");

    // Stopped: the run is over and the hold speaks for itself, with the
    // background updates it is holding.
    await act(async () =>
      socket.receive(
        snapshot(ASSISTANT, {
          agentType: "personal-assistant",
          state: {
            promptQueue: { items: [], paused: true, automaticTurnsHeld: true },
            queuedBackgroundUpdates: 2,
          },
        }),
      ),
    );
    await settle();
    expect(progressLine()).toBeNull();
    const ledge = container!.querySelector("[data-prompt-queue-ledge]");
    expect(ledge?.textContent).toContain("Stopped");
    const toggle = ledge!.querySelector<HTMLButtonElement>("button")!;
    if (toggle.getAttribute("aria-expanded") !== "true")
      await act(async () => toggle.click());
    expect(ledge?.textContent).toContain(
      "2 background updates wait until you resume.",
    );
  });
});
