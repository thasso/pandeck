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
      runId: "run-1",
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
    expect(socket!.sent).toEqual([
      JSON.stringify({ type: "cancel", runId: "run-1" }),
    ]);
    act(() => view.root.unmount());
  });

  // C1 (rv-1402-b1-code-01): a Cancel pressed while no socket is open is
  // latched, not dropped. C3 (rv-1402-b1-code-02): it is latched to its run
  // and never replayed onto a later run of the same account.
  const cancelFor = (runId: string) =>
    JSON.stringify({ type: "cancel", runId });
  const snapshot = (
    runId: string,
    status = "connecting",
    startToken?: string,
  ) => ({
    type: "snapshot",
    profileId: "cp_fixture",
    runId,
    ...(startToken !== undefined ? { startToken } : {}),
    provider: "openai-codex",
    status,
    output: "",
    startedAt: 0,
  });
  const tokenOf = (socket: FakeWebSocket) =>
    new URL(socket.url).searchParams.get("startToken");
  /** Drops the socket and lets the hook open its attach socket. */
  const reconnect = (socket: FakeWebSocket) => {
    socket.drop();
    act(() => {
      vi.advanceTimersByTime(800);
    });
    const next = FakeWebSocket.sockets.at(-1)!;
    expect(intent(next)).toBe("attach");
    return next;
  };

  test("a Cancel pressed before the socket opens goes out with the start socket's run", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [socket] = FakeWebSocket.sockets;
    expect(socket!.readyState).toBe(0);
    act(() => latest!.cancel());
    socket!.open();
    expect(socket!.sent).toEqual([]);
    socket!.receive(snapshot("run-1"));
    expect(socket!.sent).toEqual([cancelFor("run-1")]);
    expect(latest?.status).toBe("connecting");
    act(() => view.root.unmount());
  });

  test("a Cancel pressed in the reconnect gap goes out on the attach socket for the same run", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    first!.open();
    first!.receive(snapshot("run-1"));
    first!.drop();
    act(() => latest!.cancel());
    act(() => {
      vi.advanceTimersByTime(800);
    });
    const second = FakeWebSocket.sockets[1]!;
    second.open();
    second.receive(snapshot("run-1"));
    expect(second.sent).toEqual([cancelFor("run-1")]);
    expect(first!.sent).toEqual([]);
    act(() => view.root.unmount());
  });

  test("a sent Cancel goes out again after a drop to the same run, until a terminal status", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    first!.open();
    first!.receive(snapshot("run-1"));
    act(() => latest!.cancel());
    expect(first!.sent).toEqual([cancelFor("run-1")]);
    // Dropped before the server answered: the same run gets it again.
    const second = reconnect(first!);
    second.open();
    second.receive(snapshot("run-1"));
    expect(second.sent).toEqual([cancelFor("run-1")]);
    second.receive({ type: "status", runId: "run-1", status: "cancelled" });
    act(() => latest!.cancel());
    expect(second.sent).toEqual([cancelFor("run-1")]);
    act(() => view.root.unmount());
  });

  test("C3: a Cancel for a run that ended offline is never replayed onto another viewer's new run", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    first!.open();
    first!.receive(snapshot("run-1"));
    act(() => latest!.cancel());
    expect(first!.sent).toEqual([cancelFor("run-1")]);
    // Run 1 ends while this browser is offline; another viewer starts run 2.
    const second = reconnect(first!);
    second.open();
    second.receive(snapshot("run-2"));
    expect(second.sent).toEqual([]);
    expect(latest?.status).toBe("connecting");
    // The latch is gone: a later reconnect to run 2 sends nothing either.
    const third = reconnect(second);
    third.open();
    third.receive(snapshot("run-2"));
    expect(third.sent).toEqual([]);
    act(() => view.root.unmount());
  });

  test("C3: a latched Cancel meeting its run already finished is dropped unsent", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    first!.open();
    first!.receive(snapshot("run-1"));
    first!.drop();
    act(() => latest!.cancel());
    act(() => {
      vi.advanceTimersByTime(800);
    });
    const second = FakeWebSocket.sockets[1]!;
    second.open();
    second.receive(snapshot("run-1", "cancelled"));
    expect(second.sent).toEqual([]);
    act(() => view.root.unmount());
  });

  test("C3: only the start socket names this mount's start token", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    expect(tokenOf(first!)).toMatch(/^[0-9a-f]{32}$/);
    const second = reconnect(first!);
    expect(tokenOf(second)).toBeNull();
    act(() => view.root.unmount());
    const other = mount(createElement(Probe, { profileId: "cp_fixture" }));
    expect(tokenOf(FakeWebSocket.sockets.at(-1)!)).not.toBe(tokenOf(first!));
    act(() => other.root.unmount());
  });

  test("C3: a Cancel whose start snapshot was lost never binds to another start's run", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    act(() => latest!.cancel());
    first!.open();
    // The start socket dies before its snapshot; another viewer's start made
    // run 2 meanwhile.
    const second = reconnect(first!);
    second.open();
    second.receive(snapshot("run-2", "connecting", "someone-elses-token"));
    expect(second.sent).toEqual([]);
    const third = reconnect(second);
    third.open();
    third.receive(snapshot("run-2", "connecting", "someone-elses-token"));
    expect(third.sent).toEqual([]);
    expect(first!.sent).toEqual([]);
    act(() => view.root.unmount());
  });

  test("C3: a Cancel whose start snapshot was lost still reaches the run this mount's start created", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    act(() => latest!.cancel());
    first!.open();
    const second = reconnect(first!);
    second.open();
    second.receive(snapshot("run-1", "connecting", tokenOf(first!)!));
    expect(second.sent).toEqual([cancelFor("run-1")]);
    act(() => view.root.unmount());
  });

  test("C3: a pre-open Cancel on a start that joined a running login reaches that run", () => {
    const view = mount(createElement(Probe, { profileId: "cp_fixture" }));
    const [first] = FakeWebSocket.sockets;
    act(() => latest!.cancel());
    first!.open();
    // Continue login: the start joined a run another start created.
    first!.receive(snapshot("run-9", "connecting", "someone-elses-token"));
    expect(first!.sent).toEqual([cancelFor("run-9")]);
    act(() => view.root.unmount());
  });
});
