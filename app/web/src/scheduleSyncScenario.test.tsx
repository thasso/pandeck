// @vitest-environment jsdom
/**
 * The always-held `schedules` topic through the real socket effect, when its
 * read fails (Task-1513): an unstamped Schedule collection error is held as
 * `scheduleListError`, apart from the chat and never announced, and it releases
 * the snapshot a resubscribe was awaiting, so the next resync sends its own.
 * The next snapshot clears the condition. Nothing renders it until P2.
 *   pnpm --filter @assistant/web test src/scheduleSyncScenario.test.tsx
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { useAssistant, type UIState } from "./hooks/useAssistant.ts";
import { getToasts } from "./lib/toast.ts";
import type { ReplicaTransport } from "./lib/stateReplica.ts";

/** The hook's own replica transport, captured as it is created. */
const captured = vi.hoisted(() => ({
  transports: [] as unknown[],
}));

vi.mock("./lib/stateReplica.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./lib/stateReplica.ts")>();
  return {
    ...original,
    createReplicaTransport: ((
      ...args: Parameters<typeof original.createReplicaTransport>
    ) => {
      const transport = original.createReplicaTransport(...args);
      captured.transports.push(transport);
      return transport;
    }) as typeof original.createReplicaTransport,
  };
});

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

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    onboarding: "complete",
    serverBuild: { version: "0.0.0-test" },
    state: null,
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
  };
}

let latestState: UIState;

function ScheduleHarness() {
  const { actions, state } = useAssistant();
  latestState = state;
  useEffect(() => actions.setTopics(["sessions", "schedules"]), [actions]);
  return null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  ScenarioSocket.instances = [];
  captured.transports = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const snapshotPair: ClientMessage[] = [
  { type: "unsubscribe", topics: ["schedules"] },
  { type: "subscribe", topics: ["schedules"] },
];

const scheduleList = (seq: number): ServerMessage => ({
  type: "scheduleList",
  items: [],
  seq,
  revisions: [],
});

const listFailure: ServerMessage = {
  type: "error",
  message: "Failed to list Schedules: database is locked",
  target: { type: "schedule" },
};

async function connected() {
  await act(async () => root.render(<ScheduleHarness />));
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
    socket.receive(scheduleList(5));
  });
  const transport = captured.transports.at(-1) as ReplicaTransport<UIState>;
  return { socket, transport };
}

/** A sequence gap: the transport resubscribes and awaits the snapshot. */
async function gap(socket: ScenarioSocket) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mark = socket.sent.length;
  await act(async () =>
    socket.receive({
      type: "stateEvents",
      topic: "schedules",
      seq: 9,
      events: [{ kind: "delete", id: "sch_1", revision: 3 }],
    }),
  );
  warn.mockRestore();
  expect(socket.sent.slice(mark)).toEqual(snapshotPair);
}

describe("a Schedule list read that fails", () => {
  it("joins a resync to the awaited snapshot while no failure released it", async () => {
    const { socket, transport } = await connected();
    await gap(socket);
    expect(transport.resync("schedules", [])).toEqual([]);
  });

  it("releases the awaited snapshot, so the next resync sends its own", async () => {
    const { socket, transport } = await connected();
    await gap(socket);

    const mark = socket.sent.length;
    await act(async () => socket.receive(listFailure));
    expect(latestState.scheduleListError).toBe(
      "Failed to list Schedules: database is locked",
    );
    // Nothing is sent for the failure itself: no retry loop.
    expect(socket.sent.slice(mark)).toEqual([]);
    // A condition: no toast, no chat error.
    expect(getToasts()).toEqual([]);
    expect(latestState.error).toBeNull();

    expect(transport.resync("schedules", [])).toEqual(snapshotPair);
    await act(async () => socket.receive(scheduleList(10)));
    expect(latestState.scheduleListError).toBeNull();
  });

  it("releases nothing for a failure stamped with a request id", async () => {
    const { socket, transport } = await connected();
    await gap(socket);
    await act(async () =>
      socket.receive({ ...listFailure, requestId: "someone-elses" }),
    );
    expect(transport.resync("schedules", [])).toEqual([]);
  });
});
