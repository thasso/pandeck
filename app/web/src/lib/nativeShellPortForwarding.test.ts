// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import {
  forwardsLoopbackLinks,
  listNativePortForwards,
  openNativePortForwardUrl,
  PortForwardCancelledError,
  PortForwardRevokeError,
  startNativePortForward,
  stopNativePortForward,
  supportsNativePortForwarding,
} from "./nativeShell.ts";

const grant = {
  id: "grant_public_id",
  token: "abcdefghijklmnopqrstuvwxyzABCDEFG_123456789",
  port: 8080,
  expiresAt: "2030-01-01T00:00:00.000Z",
  expiresAtMs: 1_893_456_000_000,
};
const status = {
  port: 8080,
  localUrl: "http://localhost:8080",
  serverOrigin: "https://app.acme.test",
  activeConnections: 0,
  expiresAt: grant.expiresAt,
};

beforeEach(() => {
  document.documentElement.setAttribute("data-native-shell", "macos");
  window.__ASSISTANT_TOKEN__ = "long-lived-browser-token";
  vi.restoreAllMocks();
});

test("mints a scoped grant and gives only that grant to the native command", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(JSON.stringify(grant), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const invoke = vi.fn(async (command: string) => {
    if (command === "start_port_forward") return status;
    if (command === "list_port_forwards") return [status];
    if (command === "stop_port_forward") return { grantId: grant.id };
    throw new Error(`unexpected command ${command}`);
  });
  window.__TAURI__ = { core: { invoke } };

  expect(supportsNativePortForwarding()).toBe(true);
  await expect(startNativePortForward(8080)).resolves.toEqual(status);
  expect(invoke).toHaveBeenCalledWith("start_port_forward", { grant });
  await expect(listNativePortForwards()).resolves.toEqual([status]);
  await expect(stopNativePortForward(8080)).resolves.toBeUndefined();

  const mint = fetchMock.mock.calls[0];
  expect(mint?.[1]).toMatchObject({
    method: "POST",
    headers: expect.objectContaining({
      "x-assistant-token": "long-lived-browser-token",
    }),
  });
  expect(JSON.parse(String(mint?.[1]?.body))).toEqual({ port: 8080 });
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
});

test("rejects an invalid port before minting or invoking", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  const invoke = vi.fn();
  window.__TAURI__ = { core: { invoke } };

  await expect(startNativePortForward(80)).rejects.toThrow(
    "Port must be an integer",
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

test("opens only a forwardable localhost URL through the narrow command", async () => {
  const invoke = vi.fn(async () => undefined);
  window.__TAURI__ = { core: { invoke } };

  await expect(
    openNativePortForwardUrl("http://127.0.0.1:8080/app?x=1#f"),
  ).resolves.toBeUndefined();
  expect(invoke).toHaveBeenCalledWith("open_port_forward_url", {
    url: "http://localhost:8080/app?x=1#f",
  });

  for (const url of [
    "https://app.acme.test/",
    "http://localhost/",
    "http://localhost:80/",
    "file:///etc/passwd",
    "/api/files/x",
  ]) {
    await expect(openNativePortForwardUrl(url)).rejects.toThrow(
      "Not a forwardable localhost URL.",
    );
  }
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("refuses to open or start outside the macOS shell", async () => {
  document.documentElement.setAttribute("data-native-shell", "ios");
  await expect(
    openNativePortForwardUrl("http://localhost:8080/"),
  ).rejects.toThrow("requires the macOS native shell");
  document.documentElement.removeAttribute("data-native-shell");
  expect(supportsNativePortForwarding()).toBe(false);
  await expect(startNativePortForward(8080)).rejects.toThrow(
    "requires the macOS native shell",
  );
});

test("forwards localhost links only in the macOS shell served from elsewhere", () => {
  vi.stubEnv("VITE_SERVER_ORIGIN", "app.acme.test");
  try {
    expect(forwardsLoopbackLinks()).toBe(true);
    document.documentElement.setAttribute("data-native-shell", "ios");
    expect(forwardsLoopbackLinks()).toBe(false);
    document.documentElement.removeAttribute("data-native-shell");
    expect(forwardsLoopbackLinks()).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
  // Served from loopback, the link already works as written.
  document.documentElement.setAttribute("data-native-shell", "macos");
  vi.stubEnv("VITE_SERVER_ORIGIN", "127.0.0.1:8787");
  try {
    expect(forwardsLoopbackLinks()).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a Cancel in the consent dialog is a typed rejection and revokes the grant", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(JSON.stringify(grant), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  // The shell rejects with a tagged object, not an Error.
  const invoke = vi.fn().mockRejectedValue({ kind: "cancelled" });
  window.__TAURI__ = { core: { invoke } };

  await expect(startNativePortForward(8080)).rejects.toBeInstanceOf(
    PortForwardCancelledError,
  );
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
});

test("a failed start carries the shell's message as an ordinary error", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(JSON.stringify(grant), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  window.__TAURI__ = {
    core: {
      invoke: vi.fn().mockRejectedValue({
        kind: "failed",
        message: "Could not listen on 127.0.0.1:8080",
      }),
    },
  };
  const failure: unknown = await startNativePortForward(8080).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(PortForwardCancelledError);
  expect((failure as Error).message).toBe("Could not listen on 127.0.0.1:8080");
});

test("a stop whose revocation fails still stopped the listener, and says so", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(null, { status: 503 }),
  );
  const invoke = vi.fn(async () => ({ grantId: grant.id }));
  window.__TAURI__ = { core: { invoke } };

  const failure: unknown = await stopNativePortForward(8080).catch(
    (error: unknown) => error,
  );
  expect(invoke).toHaveBeenCalledWith("stop_port_forward", { port: 8080 });
  expect(failure).toBeInstanceOf(PortForwardRevokeError);
  expect((failure as PortForwardRevokeError).port).toBe(8080);
});
