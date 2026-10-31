// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
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
  it("pings on resume and releases held sends once the socket answers", () => {
    const ws = latest();
    resume();
    expect(ws.sent).toEqual([{ type: "ping" }]);

    socket.send(loadSession);
    expect(ws.sent).toEqual([{ type: "ping" }]);

    ws.receive({ type: "pong" });
    expect(ws.sent).toEqual([{ type: "ping" }, loadSession]);
    expect(received).toEqual([]);

    vi.advanceTimersByTime(5000);
    expect(FakeSocket.created).toHaveLength(1);
  });

  it("any frame proves the socket alive, not only the pong", () => {
    const ws = latest();
    resume();
    socket.send(loadSession);
    ws.receive({ type: "accountHealthChanged" });
    expect(ws.sent).toEqual([{ type: "ping" }, loadSession]);
    expect(received).toHaveLength(1);
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
    expect(ws.sent).toEqual([{ type: "ping" }]);
  });

  it("stops listening once disposed", () => {
    const ws = latest();
    socket.dispose();
    resume();
    expect(ws.sent).toEqual([]);
  });
});
