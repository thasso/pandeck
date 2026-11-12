// @vitest-environment jsdom
/**
 * The gateway page's accounts (Task-1402 B2) under `StrictMode`, as `main.tsx`
 * renders it: one Add click opens the login dialog and starts exactly one
 * login; Remove asks first and removes only on confirmation.
 */
import { act, StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mount } from "../test/mount.tsx";
import { GatewayApp } from "./GatewayApp.tsx";

const calls: { method: string; path: string; body?: unknown }[] = [];
let accounts: unknown[] = [];

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>((input, init) => {
  const url = new URL(String(input), "https://gateway.test");
  const method = init?.method ?? "GET";
  calls.push({
    method,
    path: url.pathname,
    ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
  });
  switch (url.pathname) {
    case "/api/me":
      return Promise.resolve(
        json(200, { userId: "u1", email: "p@example.org", label: "p" }),
      );
    case "/api/accounts":
      return Promise.resolve(json(200, { accounts }));
    case "/api/logins/start":
      return Promise.resolve(
        json(200, { loginId: "L1", accountId: "claude-new" }),
      );
    case "/api/logins/read":
      return Promise.resolve(
        json(200, { state: "running", output: "Starting…", cursor: 9 }),
      );
    case "/api/accounts/remove":
      accounts = [];
      return Promise.resolve(json(204));
    default:
      return Promise.resolve(json(404));
  }
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  );

async function render() {
  window.history.replaceState(null, "", "/");
  const view = mount();
  await act(async () => {
    view.render(
      <StrictMode>
        <GatewayApp reload={() => {}} />
      </StrictMode>,
    );
  });
  await act(async () => {});
  return view;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  accounts = [
    { id: "claude-a", provider: "claude", name: "Work", needsLogin: true },
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
  fetchMock.mockClear();
});

test("lists the user's accounts with their needs-login state", async () => {
  const view = await render();
  const text = document.body.textContent ?? "";
  expect(text).toContain("Work");
  expect(text).toContain("Needs login");
  expect(text).toContain("Claude");
  act(() => view.root.unmount());
});

test("one Add click opens the dialog and starts exactly one login, under StrictMode", async () => {
  const view = await render();
  expect(calls.some((c) => c.path === "/api/logins/start")).toBe(false);
  await act(async () => button("Add Claude account")!.click());
  await act(async () => {});
  expect(calls.filter((c) => c.path === "/api/logins/start")).toEqual([
    { method: "POST", path: "/api/logins/start", body: { kind: "claude" } },
  ]);
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe("Connect Claude");
  // While it runs the only way out is Cancel (B1.1); nothing cancelled yet.
  expect(button("Close Claude login")).toBeUndefined();
  expect(button("Cancel login")).toBeDefined();
  expect(calls.some((c) => c.path === "/api/logins/cancel")).toBe(false);
  act(() => view.root.unmount());
});

test("Log in on a listed account starts with its id", async () => {
  const view = await render();
  await act(async () => button("Log in Work")!.click());
  await act(async () => {});
  expect(calls.filter((c) => c.path === "/api/logins/start")).toEqual([
    {
      method: "POST",
      path: "/api/logins/start",
      body: { kind: "claude", accountId: "claude-a" },
    },
  ]);
  act(() => view.root.unmount());
});

test("Remove asks first and removes only on confirmation", async () => {
  const view = await render();
  await act(async () => button("Remove Work")!.click());
  expect(document.body.textContent).toContain("Remove Work?");
  expect(calls.some((c) => c.path === "/api/accounts/remove")).toBe(false);
  await act(async () => button("Remove")!.click());
  await act(async () => {});
  expect(calls.filter((c) => c.path === "/api/accounts/remove")).toEqual([
    {
      method: "POST",
      path: "/api/accounts/remove",
      body: { accountId: "claude-a" },
    },
  ]);
  expect(document.body.textContent).toContain("No accounts yet");
  act(() => view.root.unmount());
});
