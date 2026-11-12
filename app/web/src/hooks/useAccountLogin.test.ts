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
});
