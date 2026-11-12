// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GatewayApp } from "./GatewayApp.tsx";

/**
 * The gateway's page against its own API (Task-1402): what `/api/me` and the
 * callback's `?signin=` code show, and how sign-out asks.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement;
const fetchMock = vi.fn<typeof fetch>();

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function render(path: string, reload = () => {}): Promise<void> {
  window.history.replaceState(null, "", path);
  await act(async () => {
    root = createRoot(host);
    root.render(<GatewayApp reload={reload} />);
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

test("signed out: a sign-in link to the gateway's own login", async () => {
  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/me",
    expect.objectContaining({ credentials: "same-origin" }),
  );
  const link = host.querySelector("a");
  expect(link?.getAttribute("href")).toBe("/auth/login");
  expect(link?.textContent).toBe("Sign in");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("a fixed sentence per sign-in code, and for an unknown one", async () => {
  const expected: Record<string, string> = {
    denied: "This account may not use this gateway.",
    expired: "The sign-in took too long",
    failed: "The sign-in did not complete.",
    busy: "too many sign-ins",
    "<b>provider says no</b>": "The sign-in did not complete.",
  };
  for (const [code, text] of Object.entries(expected)) {
    fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
    await render(`/?signin=${encodeURIComponent(code)}`);
    expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain("provider says no");
    act(() => root?.unmount());
  }
});

test("signed in: the email, and sign-out posts with the header", async () => {
  fetchMock.mockResolvedValueOnce(
    answer(200, {
      userId: "u_abc",
      email: "person@example.org",
      label: "person@example.org",
    }),
  );
  const reload = vi.fn();
  await render("/", reload);
  expect(host.textContent).toContain("Signed in as person@example.org");
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Sign out",
  );
  await act(async () => button!.click());
  expect(fetchMock).toHaveBeenLastCalledWith("/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-gateway-ui": "1" },
  });
  expect(reload).toHaveBeenCalledOnce();
});

test("a 503 or a malformed answer shows the unavailable state", async () => {
  for (const response of [
    answer(503, { error: "unavailable" }),
    answer(200, { userId: 7 }),
  ]) {
    fetchMock.mockResolvedValueOnce(response);
    await render("/");
    expect(host.textContent).toContain("The gateway cannot answer right now.");
    expect(host.querySelector("a")).toBeNull();
    act(() => root?.unmount());
  }
});
