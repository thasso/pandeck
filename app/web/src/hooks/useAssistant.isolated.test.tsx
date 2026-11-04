// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { useAssistant } from "./useAssistant.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class EchoSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: EchoSocket[] = [];
  readyState = EchoSocket.CONNECTING;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    EchoSocket.instances.push(this);
  }

  open(): void {
    this.readyState = EchoSocket.OPEN;
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

let root: Root | null = null;
let latest: ReturnType<typeof useAssistant> | null = null;

function Harness() {
  latest = useAssistant({ isolated: true });
  return null;
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function snapshot(sessionId: string): ServerMessage {
  return {
    type: "snapshot",
    state: {
      sessionId,
      harness: "pi",
      agentType: "assistant",
      thinkingLevel: "off",
    },
    contextInfo: null,
    snapshot: {
      sessionId,
      runState: "idle",
      timelineStart: 0,
      totalEntryCount: 1,
      timeline: [
        {
          id: "u1",
          seq: 1,
          createdAt: new Date(1_700_000_000_000).toISOString(),
          type: "message",
          role: "user",
          origin: { kind: "human" },
          content: [{ type: "text", text: "hello" }],
        },
      ],
      streaming: [],
    },
  } as unknown as ServerMessage;
}

beforeEach(async () => {
  EchoSocket.instances = [];
  vi.stubGlobal("WebSocket", EchoSocket);
  // The address bar names the MAIN pane's session.
  window.history.replaceState(null, "", "/sessions/routed");
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(<Harness />);
    await Promise.resolve();
  });
  await settle();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("does not open on the address bar's session", () => {
  expect(EchoSocket.instances[0]?.url).not.toContain("sessionId");
});

it("loads a session the address bar does not name, from a cold cache", async () => {
  const socket = EchoSocket.instances[0]!;
  await act(async () => socket.open());
  act(() => latest!.actions.loadSession("panel"));
  await settle();
  expect(socket.sent.filter((m) => m.type === "loadSession")).toEqual([
    { type: "loadSession", id: "panel" },
  ]);
});

it("asks for only the delta when it reopens the session it retained", async () => {
  const socket = EchoSocket.instances[0]!;
  await act(async () => socket.open());
  await act(async () => socket.receive(snapshot("panel")));
  act(() => latest!.actions.loadSession("panel"));
  await settle();
  expect(
    socket.sent.filter((m) => m.type === "loadSession").at(-1),
  ).toMatchObject({
    id: "panel",
    timelineCache: { startIndex: 0, entryCount: 1, lastEntryId: "u1" },
  });
});

it("releases any session it shows", async () => {
  const socket = EchoSocket.instances[0]!;
  await act(async () => socket.open());
  act(() => latest!.actions.releaseSessionView("panel"));
  expect(socket.sent).toContainEqual({
    type: "releaseSessionView",
    sessionId: "panel",
  });
});
