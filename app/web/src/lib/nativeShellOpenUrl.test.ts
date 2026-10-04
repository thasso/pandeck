// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { onNativeOpenUrl } from "./nativeShell.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const stops: (() => void)[] = [];

beforeEach(() => {
  document.documentElement.setAttribute("data-native-shell", "ios");
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  delete window.__TAURI__;
  document.documentElement.removeAttribute("data-native-shell");
});

function bridge() {
  const registration = deferred<() => void>();
  let wake!: (message: { payload: unknown }) => void;
  const listen = vi.fn((_event: string, callback: typeof wake) => {
    wake = callback;
    return registration.promise;
  });
  const peek = vi.fn(async (): Promise<unknown> => ({ target: null }));
  const acknowledge = vi.fn(async (_target: string): Promise<unknown> => ({
    target: null,
  }));
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    expect(command).toBe("take_pending_open_url");
    return typeof args?.acknowledgedTarget === "string"
      ? acknowledge(args.acknowledgedTarget)
      : peek();
  });
  const unlisten = vi.fn();
  window.__TAURI__ = { event: { listen }, core: { invoke } };
  const handler = vi.fn();
  const stop = onNativeOpenUrl(handler);
  stops.push(stop);
  return {
    registration,
    listen,
    invoke,
    peek,
    acknowledge,
    unlisten,
    handler,
    stop,
    wake: (payload: unknown) => wake({ payload }),
  };
}

test("waits for listener registration before reading a cold-start tap", async () => {
  const b = bridge();
  b.peek.mockResolvedValueOnce({ target: "/sessions/cold" });
  expect(b.listen).toHaveBeenCalledWith(
    "assistant://open-url",
    expect.any(Function),
  );
  expect(b.invoke).not.toHaveBeenCalled();
  b.wake("/sessions/cold");
  expect(b.invoke).not.toHaveBeenCalled();
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() =>
    expect(b.acknowledge).toHaveBeenCalledWith("/sessions/cold"),
  );
  expect(b.handler).toHaveBeenCalledExactlyOnceWith("/sessions/cold");
  expect(b.invoke.mock.calls).toEqual([
    ["take_pending_open_url", undefined],
    ["take_pending_open_url", { acknowledgedTarget: "/sessions/cold" }],
  ]);
});

test("live taps use the parked target rather than an old event payload", async () => {
  const b = bridge();
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() => expect(b.peek).toHaveBeenCalledOnce());
  b.peek.mockResolvedValueOnce({ target: "/sessions/newest" });
  b.wake("/sessions/older-event");
  await vi.waitFor(() =>
    expect(b.acknowledge).toHaveBeenCalledWith("/sessions/newest"),
  );
  expect(b.handler).toHaveBeenCalledExactlyOnceWith("/sessions/newest");
});

test("serializes drains so an older reply cannot overwrite a newer tap", async () => {
  const b = bridge();
  const first = deferred<{ target: string }>();
  b.peek.mockReturnValueOnce(first.promise);
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() => expect(b.peek).toHaveBeenCalledOnce());
  b.peek.mockResolvedValueOnce({ target: "/sessions/newest" });
  b.wake("/sessions/new");
  b.wake("/sessions/newest");
  expect(b.peek).toHaveBeenCalledOnce();
  first.resolve({ target: "/sessions/old" });
  await vi.waitFor(() => expect(b.handler).toHaveBeenCalledTimes(2));
  expect(b.handler.mock.calls).toEqual([
    ["/sessions/old"],
    ["/sessions/newest"],
  ]);
  expect(b.acknowledge.mock.calls).toEqual([
    ["/sessions/old"],
    ["/sessions/newest"],
  ]);
  expect(b.peek).toHaveBeenCalledTimes(2);
});

test("acknowledges only after navigation and waits before the next drain", async () => {
  const b = bridge();
  const ack = deferred<unknown>();
  b.peek.mockResolvedValueOnce({ target: "/sessions/first" });
  b.acknowledge.mockImplementationOnce((target) => {
    expect(b.handler).toHaveBeenCalledWith(target);
    return ack.promise;
  });
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() => expect(b.acknowledge).toHaveBeenCalledOnce());
  b.peek.mockResolvedValueOnce({ target: "/sessions/next" });
  b.wake("/sessions/next");
  expect(b.peek).toHaveBeenCalledOnce();
  ack.resolve({ target: null });
  await vi.waitFor(() =>
    expect(b.handler).toHaveBeenCalledWith("/sessions/next"),
  );
});

test("does not consume a target after teardown during registration", async () => {
  const b = bridge();
  b.stop();
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() => expect(b.unlisten).toHaveBeenCalledOnce());
  expect(b.invoke).not.toHaveBeenCalled();
  expect(b.handler).not.toHaveBeenCalled();
});

test("an abandoned in-flight reply remains parked for the remounted page", async () => {
  const b = bridge();
  const reply = deferred<{ target: string }>();
  b.peek.mockReturnValueOnce(reply.promise);
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() => expect(b.peek).toHaveBeenCalledOnce());
  b.stop();
  reply.resolve({ target: "/sessions/retained" });
  await reply.promise;
  expect(b.handler).not.toHaveBeenCalled();
  expect(b.acknowledge).not.toHaveBeenCalled();

  const next = bridge();
  next.peek.mockResolvedValueOnce({ target: "/sessions/retained" });
  next.registration.resolve(next.unlisten);
  await vi.waitFor(() =>
    expect(next.acknowledge).toHaveBeenCalledWith("/sessions/retained"),
  );
  expect(next.handler).toHaveBeenCalledWith("/sessions/retained");
});

test("failed registration leaves the target in the shell", async () => {
  const b = bridge();
  b.registration.reject(new Error("bridge unavailable"));
  await b.registration.promise.catch(() => {});
  expect(b.invoke).not.toHaveBeenCalled();
});

test("ignores malformed wake-ups and already acknowledged modern targets", async () => {
  const b = bridge();
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() => expect(b.peek).toHaveBeenCalledOnce());
  b.wake({ target: "/sessions/no" });
  expect(b.peek).toHaveBeenCalledOnce();
  b.wake("/sessions/already-acknowledged");
  await vi.waitFor(() => expect(b.peek).toHaveBeenCalledTimes(2));
  expect(b.handler).not.toHaveBeenCalled();
});

test("old installed shells still deliver cold-start string targets", async () => {
  const b = bridge();
  b.peek.mockResolvedValueOnce("/sessions/legacy-cold");
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() =>
    expect(b.handler).toHaveBeenCalledWith("/sessions/legacy-cold"),
  );
  expect(b.acknowledge).not.toHaveBeenCalled();
});

test("old installed shells still deliver live targets from events", async () => {
  const b = bridge();
  b.peek.mockResolvedValue(null);
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() => expect(b.peek).toHaveBeenCalledOnce());
  b.wake("/sessions/legacy-live");
  await vi.waitFor(() =>
    expect(b.handler).toHaveBeenCalledWith("/sessions/legacy-live"),
  );
  expect(b.acknowledge).not.toHaveBeenCalled();
});

test("a failed IPC does not mistake a modern wake-up for a legacy target", async () => {
  const b = bridge();
  b.peek.mockRejectedValue(new Error("bridge unavailable"));
  b.registration.resolve(b.unlisten);
  await vi.waitFor(() => expect(b.peek).toHaveBeenCalledOnce());
  b.wake("/sessions/stale");
  await vi.waitFor(() => expect(b.peek).toHaveBeenCalledTimes(2));
  expect(b.handler).not.toHaveBeenCalled();
});

test("ordinary browsers neither listen nor invoke", () => {
  document.documentElement.removeAttribute("data-native-shell");
  const b = bridge();
  b.stop();
  expect(b.listen).not.toHaveBeenCalled();
  expect(b.invoke).not.toHaveBeenCalled();
});
