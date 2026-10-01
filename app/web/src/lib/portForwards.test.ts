import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PortForwardTunnelStatus } from "@assistant/shared/portForwarding";

const listNativePortForwards =
  vi.fn<() => Promise<PortForwardTunnelStatus[]>>();
const startNativePortForward =
  vi.fn<(port: number) => Promise<PortForwardTunnelStatus>>();
const openNativePortForwardUrl = vi.fn<(url: string) => Promise<void>>();

vi.mock("./nativeShell.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nativeShell.ts")>()),
  listNativePortForwards: (...args: []) => listNativePortForwards(...args),
  startNativePortForward: (port: number) => startNativePortForward(port),
  openNativePortForwardUrl: (url: string) => openNativePortForwardUrl(url),
}));

const { openForwardedLink, startPortForward } =
  await import("./portForwards.ts");
const { getToasts, dismissToast } = await import("./toast.ts");
const { PortForwardCancelledError } = await import("./nativeShell.ts");

const status = (port: number): PortForwardTunnelStatus => ({
  port,
  localUrl: `http://localhost:${port}`,
  serverOrigin: "https://app.acme.test",
  activeConnections: 0,
  expiresAt: "2030-01-01T00:00:00.000Z",
});

beforeEach(() => {
  listNativePortForwards.mockReset();
  startNativePortForward.mockReset();
  openNativePortForwardUrl.mockReset();
  openNativePortForwardUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const toast of getToasts()) dismissToast(toast.id);
});

test("opens an active forward without starting it again", async () => {
  listNativePortForwards.mockResolvedValue([status(5173)]);
  await openForwardedLink({ port: 5173, localUrl: "http://localhost:5173/x" });
  expect(startNativePortForward).not.toHaveBeenCalled();
  expect(openNativePortForwardUrl).toHaveBeenCalledWith(
    "http://localhost:5173/x",
  );
  expect(getToasts()).toEqual([]);
});

test("starts an inactive forward, then opens it", async () => {
  listNativePortForwards.mockResolvedValue([]);
  startNativePortForward.mockResolvedValue(status(5173));
  await openForwardedLink({ port: 5173, localUrl: "http://localhost:5173/" });
  expect(startNativePortForward).toHaveBeenCalledWith(5173);
  expect(openNativePortForwardUrl).toHaveBeenCalledWith(
    "http://localhost:5173/",
  );
});

test("two clicks on one port share one native start", async () => {
  listNativePortForwards.mockResolvedValue([]);
  let settle: (value: PortForwardTunnelStatus) => void = () => {};
  startNativePortForward.mockReturnValue(
    new Promise<PortForwardTunnelStatus>((resolve) => {
      settle = resolve;
    }),
  );
  const first = openForwardedLink({
    port: 5173,
    localUrl: "http://localhost:5173/a",
  });
  const second = openForwardedLink({
    port: 5173,
    localUrl: "http://localhost:5173/b",
  });
  // Let both clicks reach the start; the second must join the first.
  await Promise.resolve();
  await Promise.resolve();
  settle(status(5173));
  await Promise.all([first, second]);
  expect(startNativePortForward).toHaveBeenCalledTimes(1);
  expect(openNativePortForwardUrl.mock.calls.map(([url]) => url)).toEqual([
    "http://localhost:5173/a",
    "http://localhost:5173/b",
  ]);

  // Once settled, the next start is a fresh one.
  startNativePortForward.mockResolvedValue(status(5173));
  await startPortForward(5173);
  expect(startNativePortForward).toHaveBeenCalledTimes(2);
});

test("the user's own Cancel in the consent dialog says nothing", async () => {
  listNativePortForwards.mockResolvedValue([]);
  startNativePortForward.mockRejectedValue(new PortForwardCancelledError());
  await openForwardedLink({ port: 5173, localUrl: "http://localhost:5173/" });
  expect(openNativePortForwardUrl).not.toHaveBeenCalled();
  expect(getToasts()).toEqual([]);
});

test("a failed start is a toast naming the address", async () => {
  listNativePortForwards.mockResolvedValue([]);
  startNativePortForward.mockRejectedValue(
    new Error("Could not listen on 127.0.0.1:5173: address in use"),
  );
  await openForwardedLink({ port: 5173, localUrl: "http://localhost:5173/" });
  expect(openNativePortForwardUrl).not.toHaveBeenCalled();
  expect(getToasts()).toMatchObject([
    {
      tone: "error",
      message:
        "localhost:5173: Could not listen on 127.0.0.1:5173: address in use",
      key: "port-forward-5173",
    },
  ]);

  // A repeat failure for the same port replaces the toast, never stacks it.
  await openForwardedLink({ port: 5173, localUrl: "http://localhost:5173/" });
  expect(getToasts()).toHaveLength(1);
});
