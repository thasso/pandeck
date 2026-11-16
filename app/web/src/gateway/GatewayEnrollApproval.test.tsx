// @vitest-environment jsdom
/**
 * Approving a machine in the gateway page (Task-1410) against a mocked API:
 * the `#enroll=` code leaves the address before any request and waits in
 * `sessionStorage` across sign-in, reaches the gateway only in a POST body,
 * the dialog shows what to compare and what approving gives, and nothing is
 * decided without a click. Every value is fake.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GatewayApp } from "./GatewayApp.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = "BCDF-GHJK";
const STORAGE_KEY = "pandeck-gateway:enroll";
const ME = { userId: "u1", email: "person@example.org", label: "person" };

let root: Root | undefined;
let host: HTMLDivElement;
const fetchMock = vi.fn<typeof fetch>();
let signedIn = false;
let lookupAnswer: () => Response;
let decideAnswer: () => Response;

function answer(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Every request the page sent: its URL and body. */
const sent = () =>
  fetchMock.mock.calls.map(([input, init]) => ({
    url: String(input),
    body: typeof init?.body === "string" ? init.body : undefined,
    method: init?.method ?? "GET",
  }));

const decisions = () =>
  sent().filter((call) => call.url === "/api/enrollments/decide");

async function render(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  await act(async () => {
    root = createRoot(host);
    root.render(<GatewayApp reload={() => {}} />);
  });
  await act(async () => {});
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  );
const dialog = () => document.querySelector('[role="dialog"]');

async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
  await act(async () => {});
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  sessionStorage.clear();
  signedIn = false;
  const now = Date.now();
  lookupAnswer = () =>
    answer(200, {
      name: "devbox-7",
      kind: "devbox",
      from: "100.64.0.7",
      createdAt: now - 2 * 60_000 - 5_000,
      expiresAt: now + 8 * 60_000 - 5_000,
    });
  decideAnswer = () => answer(204);
  fetchMock.mockImplementation((input) => {
    switch (String(input)) {
      case "/api/me":
        return Promise.resolve(
          signedIn ? answer(200, ME) : answer(401, { error: "signed_out" }),
        );
      case "/api/accounts":
        return Promise.resolve(answer(200, { accounts: [] }));
      case "/api/integrations/atlassian":
        return Promise.resolve(answer(200, { connected: false }));
      case "/api/clients":
        return Promise.resolve(answer(200, { clients: [] }));
      case "/api/enrollments/lookup":
        return Promise.resolve(lookupAnswer());
      case "/api/enrollments/decide":
        return Promise.resolve(decideAnswer());
      default:
        return Promise.resolve(answer(404, {}));
    }
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

test("signed out: the fragment is cleared before any request, the code waits in sessionStorage, nothing is looked up", async () => {
  // The fragment is cleared before the first fetch is even started.
  fetchMock.mockImplementationOnce(() => {
    expect(window.location.hash).toBe("");
    return Promise.resolve(answer(401, { error: "signed_out" }));
  });
  await render(`/?x=1#enroll=bcdf-ghjk`);
  expect(window.location.hash).toBe("");
  expect(window.location.pathname + window.location.search).toBe("/?x=1");
  expect(sessionStorage.getItem(STORAGE_KEY)).toBe(CODE);
  expect(sent().map((call) => call.url)).toEqual(["/api/me"]);
  for (const call of sent()) {
    expect(call.url).not.toContain("BCDF");
    expect(call.url.toUpperCase()).not.toContain("BCDFGHJK");
  }
  expect(host.textContent).toContain("A machine is waiting for your approval");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/auth/login");
  expect(dialog()).toBeNull();
});

test("after sign-in the stored code opens the dialog: code to compare, labelled claims, source, age, consequences; no decision without a click", async () => {
  sessionStorage.setItem(STORAGE_KEY, CODE);
  signedIn = true;
  await render("/");
  const lookups = sent().filter(
    (call) => call.url === "/api/enrollments/lookup",
  );
  expect(lookups).toEqual([
    {
      url: "/api/enrollments/lookup",
      method: "POST",
      body: JSON.stringify({ userCode: CODE }),
    },
  ]);
  for (const call of sent()) expect(call.url).not.toContain(CODE);
  const text = dialog()?.textContent ?? "";
  expect(text).toContain("Enroll devbox-7 for person@example.org?");
  expect(
    document.querySelector('[data-testid="enroll-code"]')?.textContent,
  ).toBe(CODE);
  expect(text).toContain("Compare it with the code on your machine");
  expect(text).toContain("Name, as reported");
  expect(text).toContain("Kind, as reported");
  expect(text).toContain("Devbox");
  expect(text).toContain("100.64.0.7");
  expect(text).toContain("2 minutes ago");
  expect(text).toContain("7 minutes");
  expect(text).toContain("Anyone can start a request");
  expect(text).toContain("it gets a certificate in your name");
  expect(decisions()).toEqual([]);

  await click("Approve");
  expect(decisions()).toEqual([
    {
      url: "/api/enrollments/decide",
      method: "POST",
      body: JSON.stringify({ userCode: CODE, approve: true }),
    },
  ]);
  expect(dialog()?.textContent).toContain("Approved.");
  expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  const listed = sent().filter((call) => call.url === "/api/clients").length;
  await click("Done");
  expect(dialog()).toBeNull();
  expect(sent().filter((call) => call.url === "/api/clients").length).toBe(
    listed + 1,
  );
  expect(decisions()).toHaveLength(1);
});

test("Deny sends approve false; closing the dialog decides nothing and forgets the code", async () => {
  sessionStorage.setItem(STORAGE_KEY, CODE);
  signedIn = true;
  await render("/");
  await click("Deny");
  expect(decisions().map((call) => call.body)).toEqual([
    JSON.stringify({ userCode: CODE, approve: false }),
  ]);
  expect(dialog()?.textContent).toContain("Denied.");
  await click("Done");
  act(() => root?.unmount());

  fetchMock.mockClear();
  sessionStorage.setItem(STORAGE_KEY, CODE);
  await render("/");
  expect(dialog()).not.toBeNull();
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(dialog()).toBeNull();
  expect(decisions()).toEqual([]);
  expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
});

test("a refused lookup shows a fixed sentence and forgets the code; a refused decision keeps the dialog", async () => {
  const cases: [number, string, string][] = [
    [404, "unknown_request", "unknown, already decided or expired"],
    [429, "rate_limited", "Too many enrollment lookups"],
    [503, "unavailable", "could not do this right now"],
  ];
  signedIn = true;
  for (const [status, error, text] of cases) {
    sessionStorage.setItem(STORAGE_KEY, CODE);
    lookupAnswer = () => answer(status, { error });
    await render("/");
    expect(dialog()?.textContent).toContain(text);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(button("Approve")).toBeUndefined();
    await click("Close");
    act(() => root?.unmount());
  }

  lookupAnswer = () =>
    answer(200, {
      name: "devbox-7",
      kind: "laptop",
      from: "100.64.0.7",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });
  decideAnswer = () => answer(409, { error: "limit_reached" });
  sessionStorage.setItem(STORAGE_KEY, CODE);
  await render("/");
  await click("Approve");
  expect(dialog()?.textContent).toContain("too many clients");
  expect(button("Approve")).toBeDefined();
});

test("a malformed enroll fragment is cleared and stored nowhere; another fragment is left alone", async () => {
  await render("/#enroll=%3Cb%3Eno%3C%2Fb%3E");
  expect(window.location.hash).toBe("");
  expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(host.textContent).not.toContain("A machine is waiting");
  act(() => root?.unmount());

  await render("/#section");
  expect(window.location.hash).toBe("#section");
});
