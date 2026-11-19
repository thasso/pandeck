// @vitest-environment jsdom
/**
 * The gateway page's Slack connection (Task-1453) over mocked props: nothing
 * where the gateway does not offer Slack, the button starting the sign-in
 * once and handing its URL to `navigate`, the connected row with and without
 * the workspace's name, a fixed text per stored problem and per callback
 * code, Disconnect asking first, and a start and a Disconnect never
 * overlapping.
 */
import {
  GATEWAY_UI_SLACK_CONNECT_CODES,
  GATEWAY_UI_SLACK_PROBLEMS,
} from "@assistant/shared/gatewayUi";
import { act } from "react";
import { expect, test, vi } from "vitest";
import { failed, loading, ready } from "../lib/loadState.ts";
import { mount } from "../test/mount.tsx";
import { GatewayApiError } from "./gatewayApi.ts";
import { GatewaySlack, type GatewaySlackProps } from "./GatewaySlack.tsx";

/** A synthetic authorize URL; the page only hands it to `navigate`. */
const AUTHORIZE =
  "https://slack.com/oauth/v2/authorize?client_id=FAKE_CLIENT&state=FAKE_STATE";

const NOT_CONNECTED = { offered: true, connected: false };
const CONNECTED = { offered: true, connected: true, teamName: "Fake Team" };

function props(over: Partial<GatewaySlackProps> = {}) {
  return {
    status: ready(NOT_CONNECTED),
    clear: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() => Promise.resolve(AUTHORIZE)),
    navigate: vi.fn(),
    ...over,
  };
}

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  );
const dialogButton = (label: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((b) => b.textContent === label);

const MENU = "More actions for the Slack connection";

/** Opens the connection's ⋯ menu and answers its item `label`. */
async function menuItem(label: string): Promise<HTMLElement> {
  await act(async () => button(MENU)!.click());
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((node) => node.textContent === label);
  expect(item, label).toBeDefined();
  return item!;
}

async function choose(label: string) {
  const item = await menuItem(label);
  await act(async () => item.click());
}

/** Whether the menu item `label` is disabled; closes the menu again. */
async function itemDisabled(label: string): Promise<boolean> {
  const item = await menuItem(label);
  const disabled =
    item.getAttribute("aria-disabled") === "true" ||
    item.hasAttribute("data-disabled");
  await act(async () => button(MENU)!.click());
  return disabled;
}

/** A promise and the function settling it, for holding a write open. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("nothing shows where Slack is not offered, nor before the status is known", () => {
  for (const status of [
    ready({ offered: false, connected: false }),
    loading<{ offered: boolean; connected: boolean }>(),
  ]) {
    const view = mount(<GatewaySlack {...props({ status })} />);
    expect(view.container.innerHTML).toBe("");
    act(() => view.root.unmount());
  }
});

test("a failed load shows its own text in the section", () => {
  mount(<GatewaySlack {...props({ status: failed("unavailable") })} />);
  expect(document.querySelector('section[aria-label="Slack"]')).not.toBeNull();
  expect(text()).toContain("The Slack connection could not be loaded.");
});

test("not connected: the button starts the sign-in once, stays busy and hands the URL to navigate", async () => {
  const start = held<string>();
  const p = props({ connect: vi.fn(() => start.promise) });
  mount(<GatewaySlack {...p} />);
  expect(text()).toContain("No Slack connection yet.");
  expect(document.querySelectorAll("input")).toHaveLength(0);
  await act(async () => button("Sign in with Slack")!.click());
  expect(button("Sign in with Slack")!.disabled).toBe(true);
  await act(async () => button("Sign in with Slack")!.click());
  expect(p.connect).toHaveBeenCalledTimes(1);
  await act(async () => start.resolve(AUTHORIZE));
  expect(p.navigate).toHaveBeenCalledTimes(1);
  expect(p.navigate).toHaveBeenCalledWith(AUTHORIZE);
  // The browser is leaving: the button does not come back.
  expect(button("Sign in with Slack")!.disabled).toBe(true);
});

test("a refused start shows its fixed text and the button again", async () => {
  const cases: [unknown, string][] = [
    [
      new GatewayApiError(503, "unavailable"),
      "The gateway has too many sign-ins in progress. Try again in a few minutes.",
    ],
    [
      new GatewayApiError(401, "signed_out"),
      "Your session ended. Reload the page and sign in again.",
    ],
    [new Error("network"), "Sign in with Slack could not start. Try again."],
  ];
  for (const [err, note] of cases) {
    const p = props({ connect: vi.fn(() => Promise.reject(err)) });
    const view = mount(<GatewaySlack {...p} />);
    await act(async () => button("Sign in with Slack")!.click());
    expect(text()).toContain(note);
    expect(p.navigate).not.toHaveBeenCalled();
    expect(button("Sign in with Slack")!.disabled).toBe(false);
    act(() => view.root.unmount());
  }
});

test("connected reads as the workspace's name, or as your Slack workspace without one", async () => {
  const view = mount(<GatewaySlack {...props({ status: ready(CONNECTED) })} />);
  expect(text()).toContain("Connected to Fake Team");
  expect(text()).toContain("Connected");
  expect(button("Sign in with Slack")).toBeUndefined();
  act(() => view.root.unmount());
  mount(
    <GatewaySlack
      {...props({ status: ready({ offered: true, connected: true }) })}
    />,
  );
  expect(text()).toContain("Connected to your Slack workspace");
});

test("Sign in again on a stored connection starts the sign-in", async () => {
  const p = props({ status: ready(CONNECTED) });
  mount(<GatewaySlack {...p} />);
  await choose("Sign in again");
  expect(p.connect).toHaveBeenCalledTimes(1);
  expect(p.navigate).toHaveBeenCalledWith(AUTHORIZE);
});

test.each([...GATEWAY_UI_SLACK_PROBLEMS])(
  "the %s problem shows its fixed text and stays removable",
  async (problem) => {
    mount(
      <GatewaySlack
        {...props({ status: ready({ ...NOT_CONNECTED, problem }) })}
      />,
    );
    expect(text()).toContain("Unavailable");
    expect(text()).not.toContain("No Slack connection yet.");
    expect(text()).toMatch(
      /vault is locked|vault did not answer|cannot be read|no longer accepts/,
    );
    expect(await itemDisabled("Disconnect")).toBe(false);
  },
);

/** One fixed text per callback code; the Record in the component is typed. */
const CALLBACK_TEXT: [string, RegExp][] = [
  ["rejected", /Slack did not accept the sign-in/],
  ["unreachable", /Slack could not be reached/],
  ["team_mismatch", /different Slack workspace than this gateway's/],
  ["not_configured", /not set up to finish Slack sign-ins/],
  ["vault_locked", /vault is locked, so the sign-in could not be kept/],
  ["vault_unavailable", /may not have been kept/],
  ["busy", /Another change to this connection was still running/],
  ["tools_unavailable", /does not run the Slack tools/],
  ["signed_out", /session ended before Slack answered/],
  ["expired", /took too long or was started in another browser/],
  ["failed", /The sign-in with Slack did not finish/],
  ["denied", /Access was not granted on Slack's page/],
];

test("the callback table covers every fixed code", () => {
  expect(CALLBACK_TEXT.map(([code]) => code).sort()).toEqual(
    [...GATEWAY_UI_SLACK_CONNECT_CODES].sort(),
  );
});

test.each(CALLBACK_TEXT)(
  "the %s callback shows its fixed text, and a stored connection still reads connected",
  (code, note) => {
    mount(
      <GatewaySlack
        {...props({
          status: ready(CONNECTED),
          callback: code as (typeof GATEWAY_UI_SLACK_CONNECT_CODES)[number],
        })}
      />,
    );
    expect(text()).toMatch(note);
    expect(text()).toContain("Connected to Fake Team");
  },
);

test("the callback's note stays until the user acts", async () => {
  mount(<GatewaySlack {...props({ callback: "team_mismatch" })} />);
  expect(text()).toContain("different Slack workspace");
  await act(async () => button("Sign in with Slack")!.click());
  expect(text()).not.toContain("different Slack workspace");
});

test("Disconnect asks first and clears only after confirming", async () => {
  const p = props({ status: ready(CONNECTED) });
  mount(<GatewaySlack {...p} />);
  await choose("Disconnect");
  expect(p.clear).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Disconnect Slack?",
  );
  await act(async () => dialogButton("Cancel")!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(p.clear).not.toHaveBeenCalled();
  await choose("Disconnect");
  await act(async () => dialogButton("Disconnect")!.click());
  expect(p.clear).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("a refused Disconnect shows its fixed text in the dialog", async () => {
  const p = props({
    status: ready(CONNECTED),
    clear: vi.fn(() =>
      Promise.reject(new GatewayApiError(409, "integration_busy")),
    ),
  });
  mount(<GatewaySlack {...p} />);
  await choose("Disconnect");
  await act(async () => dialogButton("Disconnect")!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Another change to this connection is still running. Try again.",
  );
});

test("while a Disconnect runs no sign-in starts; while a start runs Disconnect cannot", async () => {
  const removing = held<void>();
  const p = props({
    status: ready(CONNECTED),
    clear: vi.fn(() => removing.promise),
  });
  const view = mount(<GatewaySlack {...p} />);
  await choose("Disconnect");
  await act(async () => dialogButton("Disconnect")!.click());
  expect(dialogButton("Disconnect")!.disabled).toBe(true);
  expect(await itemDisabled("Sign in again")).toBe(true);
  expect(p.connect).not.toHaveBeenCalled();
  await act(async () => removing.resolve());
  act(() => view.root.unmount());

  const starting = held<string>();
  const q = props({
    status: ready(CONNECTED),
    connect: vi.fn(() => starting.promise),
  });
  mount(<GatewaySlack {...q} />);
  await choose("Sign in again");
  expect(await itemDisabled("Disconnect")).toBe(true);
  expect(await itemDisabled("Sign in again")).toBe(true);
  expect(q.clear).not.toHaveBeenCalled();
});

test("Back from Slack into the cached page abandons the start; the controls work again", async () => {
  const p = props();
  mount(<GatewaySlack {...p} />);
  await act(async () => button("Sign in with Slack")!.click());
  expect(button("Sign in with Slack")!.disabled).toBe(true);
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  await act(async () => window.dispatchEvent(event));
  expect(button("Sign in with Slack")!.disabled).toBe(false);
});
