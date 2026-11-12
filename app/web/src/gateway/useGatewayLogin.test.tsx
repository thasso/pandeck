// @vitest-environment jsdom
/**
 * The gateway page's login hook (Task-1402 B2) over a fake `fetch` and fake
 * timers: reads by cursor, stops on a finished login and on Close, keeps its
 * state through a failed read, latches an early Cancel, and reports what the
 * gateway did not take.
 */
import { act, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mount } from "../test/mount.tsx";
import { useGatewayLogin, type GatewayLogin } from "./useGatewayLogin.ts";

type Handler = (init: RequestInit | undefined, url: URL) => Response;

const routes = new Map<string, Handler[]>();
const calls: { path: string; body?: unknown }[] = [];
const fetchMock = vi.fn<typeof fetch>((input, init) => {
  const url = new URL(String(input), "https://gateway.test");
  calls.push({
    path: url.pathname,
    ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
  });
  const queue = routes.get(url.pathname) ?? [];
  const next = queue.length > 1 ? queue.shift()! : queue[0];
  if (!next) return Promise.reject(new Error(`no route ${url.pathname}`));
  return Promise.resolve(next(init, url));
});

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers `path` with each handler in turn; the last one repeats. */
function route(path: string, ...handlers: Handler[]): void {
  routes.set(path, handlers);
}

const reads = () => calls.filter((c) => c.path === "/api/logins/read");

function harness(onChanged = vi.fn()) {
  const ref: { current: GatewayLogin | null } = { current: null };
  function Probe() {
    const login = useGatewayLogin(onChanged);
    useLayoutEffect(() => {
      ref.current = login;
    });
    return null;
  }
  mount(<Probe />);
  return { login: () => ref.current!, onChanged };
}

const flush = () => act(async () => {});
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  routes.clear();
  calls.length = 0;
  fetchMock.mockClear();
});

test("reads by cursor once a second, appends output, and stops when the login finished", async () => {
  route("/api/logins/start", () =>
    json(200, { loginId: "L1", accountId: "claude-a" }),
  );
  route(
    "/api/logins/read",
    () => json(200, { state: "running", output: "Hello ", cursor: 6 }),
    (_init, url) => {
      expect(url.searchParams.get("cursor")).toBe("6");
      return json(200, { state: "running", output: "world", cursor: 11 });
    },
    () => json(200, { state: "ready", output: "", cursor: 11 }),
  );
  const { login, onChanged } = harness();
  act(() =>
    login().open({ provider: "claude", accountName: "Work", name: "Work" }),
  );
  expect(login().dialog?.status).toBe("connecting");
  await flush();
  expect(calls[0]).toEqual({
    path: "/api/logins/start",
    body: { kind: "claude", name: "Work" },
  });
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(login().dialog?.output).toBe("Hello ");
  await tick(1_000);
  expect(login().dialog?.output).toBe("Hello world");
  await tick(1_000);
  expect(login().dialog?.status).toBe("ready");
  expect(onChanged).toHaveBeenCalledTimes(2);
  const done = reads().length;
  await tick(5_000);
  expect(reads().length).toBe(done);
});

test("a ChatGPT login shows its device once the gateway sends it", async () => {
  route("/api/logins/start", () =>
    json(200, { loginId: "L1", accountId: "codex-a" }),
  );
  route(
    "/api/logins/read",
    () => json(200, { state: "running", output: "", cursor: 0 }),
    () =>
      json(200, {
        state: "running",
        output: "",
        cursor: 0,
        device: {
          verificationUri: "https://auth.example/device",
          userCode: "ABCD-1234",
        },
      }),
  );
  const { login } = harness();
  act(() => login().open({ provider: "openai-codex", accountName: "OpenAI" }));
  await flush();
  expect(login().dialog?.device).toBeUndefined();
  await tick(1_000);
  expect(login().dialog?.device).toEqual({
    verificationUri: "https://auth.example/device",
    userCode: "ABCD-1234",
  });
});

test("a failed read keeps the last state and tries again", async () => {
  route("/api/logins/start", () =>
    json(200, { loginId: "L1", accountId: "claude-a" }),
  );
  route(
    "/api/logins/read",
    () => json(200, { state: "running", output: "kept", cursor: 4 }),
    () => json(503, { error: "unavailable" }),
    () => json(200, { state: "running", output: "+more", cursor: 9 }),
  );
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  await flush();
  await tick(1_000);
  expect(login().dialog?.status).toBe("connecting");
  expect(login().dialog?.output).toBe("kept");
  await tick(1_000);
  expect(login().dialog?.output).toBe("kept+more");
});

test("Close stops reading and sends no cancel", async () => {
  route("/api/logins/start", () =>
    json(200, { loginId: "L1", accountId: "claude-a" }),
  );
  route("/api/logins/read", () =>
    json(200, { state: "running", output: "", cursor: 0 }),
  );
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  await flush();
  act(() => login().close());
  expect(login().dialog).toBeNull();
  const before = reads().length;
  await tick(5_000);
  expect(reads().length).toBe(before);
  expect(calls.some((c) => c.path === "/api/logins/cancel")).toBe(false);
});

test("a Cancel before the start answered is sent once the id is known", async () => {
  let answerStart!: () => void;
  const started = new Promise<void>((resolve) => (answerStart = resolve));
  fetchMock.mockImplementationOnce(async (input, init) => {
    calls.push({
      path: String(input),
      body: JSON.parse(String(init!.body)) as unknown,
    });
    await started;
    return json(200, { loginId: "L1", accountId: "claude-a" });
  });
  route("/api/logins/cancel", () => json(204));
  route("/api/logins/read", () =>
    json(200, { state: "running", output: "", cursor: 0 }),
  );
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  act(() => login().cancel());
  expect(calls.some((c) => c.path === "/api/logins/cancel")).toBe(false);
  answerStart();
  await flush();
  expect(calls.filter((c) => c.path === "/api/logins/cancel")).toEqual([
    { path: "/api/logins/cancel", body: { loginId: "L1" } },
  ]);
  expect(login().dialog?.cancelUnconfirmed).toBe(false);
});

test("a cancel the gateway did not take shows cancelUnconfirmed, not cancelled", async () => {
  route("/api/logins/start", () =>
    json(200, { loginId: "L1", accountId: "claude-a" }),
  );
  route("/api/logins/read", () =>
    json(200, { state: "running", output: "", cursor: 0 }),
  );
  route("/api/logins/cancel", () => json(503, { error: "unavailable" }));
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  await flush();
  act(() => login().cancel());
  await flush();
  expect(login().dialog?.status).toBe("connecting");
  expect(login().dialog?.cancelUnconfirmed).toBe(true);
});

test("submit answers whether the gateway took the code", async () => {
  route("/api/logins/start", () =>
    json(200, { loginId: "L1", accountId: "claude-a" }),
  );
  route("/api/logins/read", () =>
    json(200, { state: "running", output: "", cursor: 0 }),
  );
  route(
    "/api/logins/input",
    () => json(204),
    () => json(404, { error: "unknown_login" }),
  );
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  await flush();
  await expect(login().submit("code-1")).resolves.toBe(true);
  await expect(login().submit("code-2")).resolves.toBe(false);
  expect(calls.filter((c) => c.path === "/api/logins/input")).toEqual([
    { path: "/api/logins/input", body: { loginId: "L1", text: "code-1" } },
    { path: "/api/logins/input", body: { loginId: "L1", text: "code-2" } },
  ]);
});

test("each reason becomes the page's own text; a refused start says why", async () => {
  route("/api/logins/start", () =>
    json(200, { loginId: "L1", accountId: "claude-a" }),
  );
  route("/api/logins/read", () =>
    json(200, {
      state: "cancelled",
      reason: "superseded",
      output: "",
      cursor: 0,
    }),
  );
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  await flush();
  expect(login().dialog?.status).toBe("cancelled");
  expect(login().dialog?.error).toBe("This login was started again elsewhere.");

  route("/api/logins/start", () => json(503, { error: "login_unavailable" }));
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  await flush();
  expect(login().dialog?.status).toBe("error");
  expect(login().dialog?.error).toBe(
    "The gateway is running as many logins as it can. Try again in a moment.",
  );
});

/** A start the test answers later, recorded like any other call. */
function heldStart(): () => void {
  let answerStart!: () => void;
  const started = new Promise<void>((resolve) => (answerStart = resolve));
  fetchMock.mockImplementationOnce(async (input, init) => {
    calls.push({
      path: String(input),
      body: JSON.parse(String(init!.body)) as unknown,
    });
    await started;
    return json(200, { loginId: "L1", accountId: "claude-a" });
  });
  return answerStart;
}

test("a Cancel before the start answered is still sent after a Close (review C4)", async () => {
  const answerStart = heldStart();
  route("/api/logins/cancel", () => json(204));
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  act(() => login().cancel());
  act(() => login().close());
  answerStart();
  await flush();
  expect(calls.filter((c) => c.path === "/api/logins/cancel")).toEqual([
    { path: "/api/logins/cancel", body: { loginId: "L1" } },
  ]);
  expect(login().dialog).toBeNull();
});

test("a Close alone before the start answered sends no cancel", async () => {
  const answerStart = heldStart();
  route("/api/logins/cancel", () => json(204));
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  act(() => login().close());
  answerStart();
  await flush();
  expect(calls.some((c) => c.path === "/api/logins/cancel")).toBe(false);
});

test("this dialog's Cancel shows cancelling, and its login ending cancelled sets cancelledHere (B1.1 props)", async () => {
  route("/api/logins/start", () =>
    json(200, { loginId: "L1", accountId: "claude-a" }),
  );
  route(
    "/api/logins/read",
    () => json(200, { state: "running", output: "", cursor: 0 }),
    () => json(200, { state: "running", output: "", cursor: 0 }),
    () => json(200, { state: "cancelled", output: "", cursor: 0 }),
  );
  route("/api/logins/cancel", () => json(204));
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  await flush();
  expect(login().dialog?.cancelling).toBe(false);
  act(() => login().cancel());
  await flush();
  expect(login().dialog?.cancelling).toBe(true);
  expect(login().dialog?.cancelledHere).toBe(false);
  await tick(1_000);
  await tick(1_000);
  expect(login().dialog?.status).toBe("cancelled");
  expect(login().dialog?.cancelling).toBe(false);
  expect(login().dialog?.cancelledHere).toBe(true);
});

test("a login cancelled elsewhere is not cancelledHere; a refused cancel is not cancelling", async () => {
  route("/api/logins/start", () =>
    json(200, { loginId: "L1", accountId: "claude-a" }),
  );
  route(
    "/api/logins/read",
    () => json(200, { state: "running", output: "", cursor: 0 }),
    () =>
      json(200, {
        state: "cancelled",
        reason: "superseded",
        output: "",
        cursor: 0,
      }),
  );
  route("/api/logins/cancel", () => json(503, { error: "unavailable" }));
  const { login } = harness();
  act(() => login().open({ provider: "claude", accountName: "Claude" }));
  await flush();
  act(() => login().cancel());
  await flush();
  expect(login().dialog?.cancelling).toBe(false);
  expect(login().dialog?.cancelUnconfirmed).toBe(true);
  await tick(1_000);
  expect(login().dialog?.status).toBe("cancelled");
  expect(login().dialog?.cancelledHere).toBe(false);
  expect(login().dialog?.error).toBe("This login was started again elsewhere.");
});
