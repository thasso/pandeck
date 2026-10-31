// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { createMutationLifecycle } from "./mutationLifecycle.ts";
import { AssistantSocket } from "./socket.ts";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static created: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.created.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** The server side went away and the browser finally noticed. */
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

const loadSession: ClientMessage = { type: "loadSession", id: "s1" };

let socket: AssistantSocket;
let statuses: boolean[];
let received: ServerMessage[];

function resume(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

function latest(): FakeSocket {
  return FakeSocket.created.at(-1)!;
}

/** The id of the probe this socket was last pinged with. */
function pingId(ws: FakeSocket): string {
  const ping = ws.sent.findLast((msg) => msg.type === "ping");
  if (ping?.type !== "ping") throw new Error("no ping sent");
  return ping.id;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.created = [];
  statuses = [];
  received = [];
  socket = new AssistantSocket("ws://test/ws");
  socket.onStatus((connected) => statuses.push(connected));
  socket.onMessage((msg) => received.push(msg));
  socket.connect();
  latest().accept();
});

afterEach(() => {
  socket.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AssistantSocket liveness probe", () => {
  it("pings on resume and releases held sends once its pong answers", () => {
    const ws = latest();
    resume();
    const id = pingId(ws);
    expect(ws.sent).toEqual([{ type: "ping", id }]);

    socket.send(loadSession);
    expect(ws.sent).toEqual([{ type: "ping", id }]);

    ws.receive({ type: "pong", id });
    expect(ws.sent).toEqual([{ type: "ping", id }, loadSession]);
    expect(received).toEqual([]);

    vi.advanceTimersByTime(5000);
    expect(FakeSocket.created).toHaveLength(1);
  });

  it("is not released by a frame queued before the probe or by an older pong", () => {
    const ws = latest();
    resume();
    const first = pingId(ws);
    socket.send(loadSession);
    // Both may have waited in the browser's event queue through suspension.
    ws.receive({ type: "accountHealthChanged" });
    ws.receive({ type: "pong", id: `${first}-earlier` });
    expect(ws.sent).toEqual([{ type: "ping", id: first }]);
    expect(received).toEqual([{ type: "accountHealthChanged" }]);

    vi.advanceTimersByTime(1500);
    expect(FakeSocket.created).toHaveLength(2);
  });

  it("replaces a socket that stays silent and sends the held messages on the new one", () => {
    const dead = latest();
    resume();
    socket.send(loadSession);

    vi.advanceTimersByTime(1499);
    expect(FakeSocket.created).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(dead.readyState).toBe(FakeSocket.CLOSED);
    expect(statuses).toEqual([true, false]);
    const fresh = latest();
    expect(fresh).not.toBe(dead);
    fresh.accept();
    expect(fresh.sent).toEqual([loadSession]);
    expect(statuses).toEqual([true, false, true]);

    // The dead socket's late close neither reports nor schedules a reconnect.
    dead.drop();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.created).toHaveLength(2);
    expect(statuses).toEqual([true, false, true]);
  });

  it("keeps a write held by a failed probe pending, and sends it once on the new socket", () => {
    const lifecycle = createMutationLifecycle<{ topic?: string }>();
    const terminals: string[] = [];
    // The status wiring useAssistant installs for a lost socket.
    let connected = true;
    socket.onStatus((next) => {
      if (connected && !next) lifecycle.disconnect(socket.unsentRequestIds());
      connected = next;
    });
    const sentBeforeProbe = lifecycle.start({
      context: {},
      timeoutMs: 30_000,
      recover: () => {},
      disconnected: () => {},
      terminal: (outcome) => terminals.push(`sent:${outcome.type}`),
    });
    socket.send({
      type: "deleteSession",
      id: "s0",
      requestId: sentBeforeProbe,
    });

    resume();
    const held = lifecycle.start({
      context: {},
      timeoutMs: 30_000,
      recover: () => {},
      disconnected: () => {},
      terminal: (outcome) => terminals.push(`held:${outcome.type}`),
    });
    const write: ClientMessage = {
      type: "deleteSession",
      id: "s1",
      requestId: held,
    };
    socket.send(write);
    expect(socket.unsentRequestIds()).toEqual(new Set([held]));

    vi.advanceTimersByTime(1500);
    // The write the dead socket carried is unknown; the held one never left.
    expect(terminals).toEqual(["sent:unknown"]);
    expect(lifecycle.get(held)).toBeDefined();

    const fresh = latest();
    fresh.accept();
    expect(fresh.sent).toEqual([write]);
    lifecycle.settle(held);
    expect(terminals).toEqual(["sent:unknown", "held:settled"]);
  });

  it("runs a pending reconnect at once instead of waiting it out", () => {
    latest().drop();
    expect(FakeSocket.created).toHaveLength(1);
    resume();
    expect(FakeSocket.created).toHaveLength(2);
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.created).toHaveLength(2);
  });

  it("sends one probe at a time", () => {
    const ws = latest();
    resume();
    resume();
    window.dispatchEvent(new Event("online"));
    expect(ws.sent.filter((msg) => msg.type === "ping")).toHaveLength(1);
  });

  it("stops listening once disposed", () => {
    const ws = latest();
    socket.dispose();
    resume();
    expect(ws.sent).toEqual([]);
  });
});
