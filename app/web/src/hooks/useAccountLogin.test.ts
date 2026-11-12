// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "../test/mount.tsx";
import { useAccountLogin } from "./useAccountLogin.ts";

/** A browser socket the test drives; every one opened lands in `sockets`. */
class FakeWebSocket {
  static OPEN = 1;
  static sockets: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  receive(message: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  drop() {
    this.readyState = 3;
    act(() => this.onclose?.());
  }
}

const intent = (socket: FakeWebSocket) =>
  new URL(socket.url).searchParams.get("intent");

let latest: ReturnType<typeof useAccountLogin> | undefined;
function Probe({ profileId }: { profileId: string }) {
  latest = useAccountLogin(profileId, () => {});
  return null;
}

beforeEach(() => {
  FakeWebSocket.sockets = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useAccountLogin", () => {
  test("the first socket starts the login; a reconnect while connecting only attaches", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    expect(new URL(first!.url).pathname).toBe("/ws/account-login");
    expect(new URL(first!.url).searchParams.get("profileId")).toBe(
      "cp_fixture",
    );
    expect(intent(first!)).toBe("start");
    first!.drop();
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(FakeWebSocket.sockets).toHaveLength(2);
    expect(intent(FakeWebSocket.sockets[1]!)).toBe("attach");
    act(() => view.root.unmount());
  });

  test("no reconnect after a terminal status", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [socket] = FakeWebSocket.sockets;
    socket!.receive({ type: "status", status: "cancelled" });
    socket!.drop();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(FakeWebSocket.sockets).toHaveLength(1);
    expect(latest?.status).toBe("cancelled");
    act(() => view.root.unmount());
  });

  test("takes the device code from the snapshot or its own message, and sends cancel", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [socket] = FakeWebSocket.sockets;
    socket!.open();
    socket!.receive({
      type: "snapshot",
      profileId: "cp_fixture",
      provider: "openai-codex",
      status: "connecting",
      output: "",
      startedAt: 0,
    });
    expect(latest?.device).toBeUndefined();
    const device = {
      verificationUri: "https://auth.example/device",
      userCode: "ABCD-1234",
    };
    socket!.receive({ type: "device", device });
    expect(latest?.device).toEqual(device);
    act(() => latest!.cancel());
    expect(socket!.sent).toEqual([JSON.stringify({ type: "cancel" })]);
    act(() => view.root.unmount());
  });

  // C1 (rv-1402-b1-code-01): a Cancel pressed while no socket is open is
  // latched, not dropped.
  const CANCEL = JSON.stringify({ type: "cancel" });
  const snapshot = {
    type: "snapshot",
    profileId: "cp_fixture",
    provider: "openai-codex",
    status: "connecting",
    output: "",
    startedAt: 0,
  };

  test("a Cancel pressed before the socket opens goes out once it opens", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [socket] = FakeWebSocket.sockets;
    expect(socket!.readyState).toBe(0);
    act(() => latest!.cancel());
    expect(socket!.sent).toEqual([]);
    socket!.open();
    socket!.receive(snapshot);
    expect(socket!.sent).toEqual([CANCEL]);
    expect(latest?.status).toBe("connecting");
    act(() => view.root.unmount());
  });

  test("a Cancel pressed in the reconnect gap goes out on the attach socket", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    first!.open();
    first!.drop();
    act(() => latest!.cancel());
    act(() => {
      vi.advanceTimersByTime(800);
    });
    const second = FakeWebSocket.sockets[1]!;
    expect(intent(second)).toBe("attach");
    second.open();
    expect(second.sent).toEqual([CANCEL]);
    expect(first!.sent).toEqual([]);
    act(() => view.root.unmount());
  });

  test("a sent Cancel goes out again after a drop until a terminal status, and never after one", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    first!.open();
    act(() => latest!.cancel());
    expect(first!.sent).toEqual([CANCEL]);
    // Dropped before the server answered: the next socket repeats it.
    first!.drop();
    act(() => {
      vi.advanceTimersByTime(800);
    });
    const second = FakeWebSocket.sockets[1]!;
    second.open();
    expect(second.sent).toEqual([CANCEL]);
    second.receive({ type: "status", status: "cancelled" });
    act(() => latest!.cancel());
    expect(second.sent).toEqual([CANCEL]);
    act(() => view.root.unmount());
  });
});
