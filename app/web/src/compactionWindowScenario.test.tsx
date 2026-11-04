// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  SessionCompactionWindow,
} from "@assistant/shared";
import {
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";
import { CompactionWindowSection } from "./components/CompactionWindowSection.tsx";
import { readAppShellCacheRecord } from "./lib/appShellCacheStore.ts";
import { getToasts } from "./lib/toast.ts";

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

const windowState: SessionCompactionWindow = {
  tokens: 150_000,
  applied: "pending",
  pendingReason: "next-turn",
  range: { min: 100_000, max: 1_000_000 },
};
function readyMessage() {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: {
      sessionId: "s1",
      harness: "claude-sdk",
      agentType: "assistant",
      thinkingLevel: "off",
      compactionWindow: windowState,
    },
    models: [],
    agents: [],
    settings: {},
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  } satisfies Extract<ServerMessage, { type: "ready" }>;
}
let actions: AssistantActions;
let state: UIState;
function Harness() {
  const current = useAssistant();
  actions = current.actions;
  state = current.state;
  return (
    <CompactionWindowSection
      sessionId="s1"
      harness="claude-sdk"
      window={state.session?.compactionWindow ?? windowState}
      edit={state.compactionWindowEdits.s1}
      onSave={(tokens) => actions.setCompactionWindow("s1", tokens)}
    />
  );
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  ScenarioSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", ScenarioSocket);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function boot(connected = true) {
  await act(async () => root.render(<Harness />));
  const socket = ScenarioSocket.instances[0]!;
  if (connected)
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
  await act(async () => actions.setTopics(["tasks"]));
  return socket;
}
async function save(tokens: number | null = 200_000, sessionId = "s1") {
  let id = "";
  await act(async () => {
    id = actions.setCompactionWindow(sessionId, tokens);
  });
  expect(id).toBeTypeOf("string");
  return id;
}
/** Applies one slider step up from the stored value through the real editor. */
async function applyStep() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        'button[aria-label^="Compaction window:"]',
      )!
      .click(),
  );
  const thumb = document.querySelector<HTMLInputElement>(
    'input[aria-label="Compaction window"]',
  )!;
  await act(async () => {
    thumb.focus();
    thumb.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Apply")!
      .click(),
  );
}
const writes = (socket: ScenarioSocket) =>
  socket.sent.filter((msg) => msg.type === "setCompactionWindow");
async function nextAttempt(socket: ScenarioSocket) {
  await act(async () => {
    socket.close();
    await vi.advanceTimersByTimeAsync(1_000);
  });
  return ScenarioSocket.instances.at(-1)!;
}

it("sends numeric Save and Clear and releases immediately only on the addressed receipt", async () => {
  const socket = await boot();
  const a = await save();
  expect(writes(socket)).toEqual([
    {
      type: "setCompactionWindow",
      sessionId: "s1",
      tokens: 200_000,
      requestId: a,
    },
  ]);
  await act(async () =>
    socket.receive({
      type: "snapshot",
      state: {
        ...readyMessage().state,
        compactionWindow: { ...windowState, tokens: 200_000 },
      },
      contextInfo: null,
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    } as unknown as ServerMessage),
  );
  expect(state.compactionWindowEdits.s1).toEqual({ requestId: a, busy: true });
  await act(async () =>
    socket.receive({ type: "mutationSettled", requestId: a }),
  );
  expect(state.compactionWindowEdits.s1).toEqual({ requestId: a, busy: false });
  const clear = await save(null);
  expect(writes(socket).at(-1)).toEqual({
    type: "setCompactionWindow",
    sessionId: "s1",
    tokens: null,
    requestId: clear,
  });
  await act(async () =>
    socket.receive({ type: "mutationSettled", requestId: clear }),
  );
  expect(state.compactionWindowEdits.s1).toEqual({
    requestId: clear,
    busy: false,
  });
  const receipt = state.compactionWindowEdits;
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(state.compactionWindowEdits).toBe(receipt);
});

it("keeps latest-only ownership across overlapping saves and independent sessions", async () => {
  const socket = await boot();
  const a = await save();
  const b = await save(250_000);
  const other = await save(null, "s2");
  await act(async () =>
    socket.receive({
      type: "error",
      requestId: a,
      message: "late",
      target: { type: "session", id: "s1" },
    }),
  );
  expect(state.compactionWindowEdits.s1).toEqual({ requestId: b, busy: true });
  await act(async () =>
    socket.receive({ type: "mutationSettled", requestId: other }),
  );
  expect(state.compactionWindowEdits.s2).toEqual({
    requestId: other,
    busy: false,
  });
  expect(state.compactionWindowEdits.s1?.busy).toBe(true);
  await act(async () =>
    socket.receive({
      type: "error",
      requestId: b,
      message: "refused",
      target: { type: "session", id: "s1" },
    }),
  );
  expect(state.compactionWindowEdits.s1).toEqual({
    requestId: b,
    busy: false,
    error: "refused",
  });
  const receipts = state.compactionWindowEdits;
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(state.compactionWindowEdits).toBe(receipts);
});

it("routes an active refusal to the inspector without stopping the viewed runtime or setting its chat error", async () => {
  const socket = await boot();
  await act(async () =>
    socket.receive({
      type: "snapshot",
      state: readyMessage().state,
      contextInfo: null,
      snapshot: {
        sessionId: "s1",
        runState: "running",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [
          {
            streamId: "live-1",
            kind: "message",
            role: "assistant",
            content: [{ type: "text", text: "still streaming" }],
          },
        ],
      },
    } as unknown as ServerMessage),
  );
  const id = await save();
  expect(state.runState).toBe("running");
  const priorRunState = state.runState;
  const priorStreams = state.liveStreams;
  expect(priorStreams).toHaveLength(1);
  const priorChatError = state.error;
  const before = getToasts().length;
  await act(async () =>
    socket.receive({
      type: "error",
      requestId: id,
      target: { type: "session", id: "s1" },
      message: "Saving failed: disk",
    }),
  );
  expect(state.compactionWindowEdits.s1).toEqual({
    requestId: id,
    busy: false,
    error: "Saving failed: disk",
  });
  expect(container.textContent).toContain("Saving failed: disk");
  expect(state.runState).toBe(priorRunState);
  expect(state.liveStreams).toBe(priorStreams);
  expect(state.error).toBe(priorChatError);
  // Preserve arrival policy: without a registered failure-home claim the
  // addressed session failure is announced, even though the receipt is inline.
  expect(getToasts()).toHaveLength(before + 1);
  expect(getToasts().at(-1)?.message).toContain("Saving failed: disk");
});

it("uses the original 30 second deadline and affects only its receipt", async () => {
  await boot();
  const a = await save();
  await act(async () => vi.advanceTimersByTime(20_000));
  const other = await save(null, "s2");
  await act(async () => vi.advanceTimersByTime(9_999));
  expect(state.compactionWindowEdits.s1?.busy).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(state.compactionWindowEdits.s1).toEqual({
    requestId: a,
    busy: false,
    error: "The server did not answer. Try again.",
  });
  expect(state.compactionWindowEdits.s2).toEqual({
    requestId: other,
    busy: true,
  });
  expect(state.error).toBeNull();
});

it.each([200_000, null])(
  "releases %s on genuine loss as unknown with no reads/retry or old timeout",
  async (tokens) => {
    const socket = await boot();
    const id = await save(tokens);
    const next = await nextAttempt(socket);
    expect(state.compactionWindowEdits.s1).toEqual({
      requestId: id,
      busy: false,
      unknown: true,
    });
    expect(next.sent).toEqual([]);
    await act(async () => {
      next.open();
      next.receive(readyMessage());
      next.receive({
        type: "state",
        state: {
          ...readyMessage().state,
          compactionWindow: {
            ...windowState,
            tokens: 175_000,
            applied: "confirmed",
          },
        },
      });
    });
    expect(state.session?.compactionWindow?.tokens).toBe(175_000);
    expect(next.sent.map((msg) => msg.type)).toEqual(["subscribe"]);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(state.compactionWindowEdits.s1).toEqual({
      requestId: id,
      busy: false,
      unknown: true,
    });
  },
);

it.each([false, true])(
  "preserves queued Save/Clear over failed attempts, previouslyConnected=%s",
  async (previouslyConnected) => {
    let socket = await boot(previouslyConnected);
    if (previouslyConnected) socket = await nextAttempt(socket);
    const a = await save();
    const b = await save(null, "s2");
    socket = await nextAttempt(socket);
    socket = await nextAttempt(socket);
    expect(state.compactionWindowEdits.s1).toEqual({
      requestId: a,
      busy: true,
    });
    expect(state.compactionWindowEdits.s2).toEqual({
      requestId: b,
      busy: true,
    });
    expect(socket.sent).toEqual([]);
    await act(async () => socket.open());
    expect(writes(socket)).toEqual([
      {
        type: "setCompactionWindow",
        sessionId: "s1",
        tokens: 200_000,
        requestId: a,
      },
      {
        type: "setCompactionWindow",
        sessionId: "s2",
        tokens: null,
        requestId: b,
      },
    ]);
    expect(socket.sent.filter((msg) => msg.type !== "subscribe")).toEqual(
      writes(socket),
    );
    await act(async () =>
      socket.receive({ type: "mutationSettled", requestId: b }),
    );
    expect(state.compactionWindowEdits.s2).toEqual({
      requestId: b,
      busy: false,
    });
    await act(async () => socket.close());
    expect(state.compactionWindowEdits.s1).toEqual({
      requestId: a,
      busy: false,
      unknown: true,
    });
  },
);

it("failed attempts do not reset an offline receipt deadline", async () => {
  let socket = await boot(false);
  const id = await save();
  socket = await nextAttempt(socket);
  await nextAttempt(socket);
  await act(async () => vi.advanceTimersByTime(27_999));
  expect(state.compactionWindowEdits.s1?.busy).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(state.compactionWindowEdits.s1).toEqual({
    requestId: id,
    busy: false,
    error: "The server did not answer. Try again.",
  });
});

it("the editor's Apply sends through the real hook and loss releases it as unknown", async () => {
  const socket = await boot();
  await applyStep();
  expect(writes(socket)).toEqual([
    {
      type: "setCompactionWindow",
      sessionId: "s1",
      tokens: 175_000,
      requestId: expect.any(String),
    },
  ]);
  const id = writes(socket)[0]!.requestId;
  expect(state.compactionWindowEdits.s1).toEqual({ requestId: id, busy: true });
  await act(async () => socket.close());
  expect(state.compactionWindowEdits.s1).toEqual({
    requestId: id,
    busy: false,
    unknown: true,
  });
});

it("unmount abandons correlations/timers and a remounted hook is usable", async () => {
  const socket = await boot();
  await save();
  await act(async () => root.unmount());
  const abandoned = state;
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(state).toBe(abandoned);
  expect(
    socket.sent.filter(
      (msg) => msg.type === "unsubscribe" && msg.topics.includes("sessions"),
    ),
  ).toEqual([]);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  const fresh = ScenarioSocket.instances.at(-1)!;
  await act(async () => {
    fresh.open();
    fresh.receive(readyMessage());
  });
  const id = await save(null);
  await act(async () =>
    fresh.receive({ type: "mutationSettled", requestId: id }),
  );
  expect(state.compactionWindowEdits.s1).toEqual({
    requestId: id,
    busy: false,
  });
});

it("a receipt-only pending write does not block shell cache admission or claim a sessions digest", async () => {
  const socket = await boot();
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  const baseline = readAppShellCacheRecord();
  expect(baseline).not.toBeNull();
  const id = await save();
  await act(async () =>
    socket.receive({
      type: "settings",
      settings: { ...state.settings, skills: { notes: "on" } },
    }),
  );
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(readAppShellCacheRecord()?.settings).toMatchObject({
    skills: { notes: "on" },
  });
  expect(state.compactionWindowEdits.s1).toEqual({ requestId: id, busy: true });
  // An ordinary effect-bearing mutation still suppresses subsequent writes.
  await act(async () => actions.saveTask({ title: "pending", status: "todo" }));
  await act(async () =>
    socket.receive({
      type: "settings",
      settings: { ...state.settings, skills: { notes: "off" } },
    }),
  );
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(readAppShellCacheRecord()?.settings).toMatchObject({
    skills: { notes: "on" },
  });
  expect(state.sessions).toEqual([]);
});
