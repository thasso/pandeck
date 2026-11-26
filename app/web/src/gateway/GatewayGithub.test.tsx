// @vitest-environment jsdom
/**
 * The gateway page's GitHub connection (Task-1445) over mocked props: nothing
 * where the gateway does not offer GitHub, Connect GitHub starting once and
 * handing its URL to `navigate`, the connected row with and without the
 * login, a fixed text per stored problem and per callback code, Disconnect
 * asking first in a dialog naming Authorized GitHub Apps, and "Check
 * repository access": one `owner/repo` checked with the gateway's rules,
 * answered with only the repository and the token's expiry, or a fixed text
 * per refusal.
 */
import {
  GATEWAY_UI_GITHUB_CONNECT_CODES,
  GATEWAY_UI_GITHUB_PROBLEMS,
  type GatewayUiGithubCheck,
} from "@assistant/shared/gatewayUi";
import { act } from "react";
import { expect, test, vi } from "vitest";
import { failed, loading, ready } from "../lib/loadState.ts";
import { mount } from "../test/mount.tsx";
import { GatewayApiError } from "./gatewayApi.ts";
import { GatewayGithub, type GatewayGithubProps } from "./GatewayGithub.tsx";

/** A synthetic authorize URL; the page only hands it to `navigate`. */
const AUTHORIZE =
  "https://github.com/login/oauth/authorize?client_id=FAKE_CLIENT&state=FAKE_STATE";

const NOT_CONNECTED = { offered: true, connected: false };
const CONNECTED = { offered: true, connected: true, login: "fake-login" };

/** 14:05 local time, as the card shows it. */
const EXPIRES_AT = new Date(2026, 10, 25, 14, 5).getTime();
const CHECKED = { repository: "fake-owner/fake-repo", expiresAt: EXPIRES_AT };

function props(over: Partial<GatewayGithubProps> = {}) {
  return {
    status: ready(NOT_CONNECTED),
    clear: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() => Promise.resolve(AUTHORIZE)),
    check: vi.fn(() => Promise.resolve<GatewayUiGithubCheck>(CHECKED)),
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

const MENU = "More actions for the GitHub connection";

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

/** A promise and the function settling it, for holding a call open. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const repositoryField = () =>
  document.querySelector<HTMLInputElement>("#gateway-github-repository")!;

/** Types `value` into the repository field and submits the check. */
async function checkRepository(value: string) {
  const input = repositoryField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Check")!.click());
}

test("nothing shows where GitHub is not offered, nor before the status is known", () => {
  for (const status of [
    ready({ offered: false, connected: false }),
    loading<{ offered: boolean; connected: boolean }>(),
  ]) {
    const view = mount(<GatewayGithub {...props({ status })} />);
    expect(view.container.innerHTML).toBe("");
    act(() => view.root.unmount());
  }
});

test("a failed load shows its own text in the section", () => {
  mount(<GatewayGithub {...props({ status: failed("unavailable") })} />);
  expect(document.querySelector('section[aria-label="GitHub"]')).not.toBeNull();
  expect(text()).toContain("The GitHub connection could not be loaded.");
});

test("not connected: Connect GitHub starts once, stays busy and hands the URL to navigate", async () => {
  const start = held<string>();
  const p = props({ connect: vi.fn(() => start.promise) });
  mount(<GatewayGithub {...p} />);
  expect(text()).toContain("GitHub is not connected.");
  await act(async () => button("Connect GitHub")!.click());
  expect(button("Connect GitHub")!.disabled).toBe(true);
  await act(async () => button("Connect GitHub")!.click());
  expect(p.connect).toHaveBeenCalledTimes(1);
  await act(async () => start.resolve(AUTHORIZE));
  expect(p.navigate).toHaveBeenCalledTimes(1);
  expect(p.navigate).toHaveBeenCalledWith(AUTHORIZE);
  // The browser is leaving: the button does not come back.
  expect(button("Connect GitHub")!.disabled).toBe(true);
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
    [new Error("network"), "Connect GitHub could not start. Try again."],
  ];
  for (const [err, note] of cases) {
    const p = props({ connect: vi.fn(() => Promise.reject(err)) });
    const view = mount(<GatewayGithub {...p} />);
    await act(async () => button("Connect GitHub")!.click());
    expect(text()).toContain(note);
    expect(p.navigate).not.toHaveBeenCalled();
    expect(button("Connect GitHub")!.disabled).toBe(false);
    act(() => view.root.unmount());
  }
});

test("connected reads as the login, or as your GitHub account without one", () => {
  const view = mount(
    <GatewayGithub {...props({ status: ready(CONNECTED) })} />,
  );
  expect(text()).toContain("Connected as fake-login");
  expect(button("Connect GitHub")).toBeUndefined();
  act(() => view.root.unmount());
  mount(
    <GatewayGithub
      {...props({ status: ready({ offered: true, connected: true }) })}
    />,
  );
  expect(text()).toContain("Connected as your GitHub account");
});

test("Connect again on a stored connection starts the connect", async () => {
  const p = props({ status: ready(CONNECTED) });
  mount(<GatewayGithub {...p} />);
  await choose("Connect again");
  expect(p.connect).toHaveBeenCalledTimes(1);
  expect(p.navigate).toHaveBeenCalledWith(AUTHORIZE);
});

test.each([...GATEWAY_UI_GITHUB_PROBLEMS])(
  "the %s problem shows its fixed text and stays removable",
  async (problem) => {
    mount(
      <GatewayGithub
        {...props({ status: ready({ ...NOT_CONNECTED, problem }) })}
      />,
    );
    expect(text()).toContain("Unavailable");
    expect(text()).not.toContain("GitHub is not connected.");
    expect(text()).toMatch(
      /vault is locked|vault did not answer|cannot be read|no longer accepts/,
    );
    expect(await itemDisabled("Disconnect")).toBe(false);
  },
);

/** One fixed text per callback code; the Record in the component is typed. */
const CALLBACK_TEXT: [string, RegExp][] = [
  ["rejected", /GitHub did not accept the connection/],
  ["unreachable", /GitHub could not be reached/],
  ["not_configured", /not set up to finish GitHub connections/],
  ["vault_locked", /vault is locked, so the connection could not be kept/],
  ["vault_unavailable", /may not have been kept/],
  ["busy", /Another change to this connection was still running/],
  ["signed_out", /session ended before GitHub answered/],
  ["expired", /took too long or was started in another browser/],
  ["failed", /Connecting GitHub did not finish/],
  ["denied", /Access was not granted on GitHub's page/],
];

test("the callback table covers every fixed code", () => {
  expect(CALLBACK_TEXT.map(([code]) => code).sort()).toEqual(
    [...GATEWAY_UI_GITHUB_CONNECT_CODES].sort(),
  );
});

test.each(CALLBACK_TEXT)(
  "the %s callback shows its fixed text, and a stored connection still reads connected",
  (code, note) => {
    mount(
      <GatewayGithub
        {...props({
          status: ready(CONNECTED),
          callback: code as (typeof GATEWAY_UI_GITHUB_CONNECT_CODES)[number],
        })}
      />,
    );
    expect(text()).toMatch(note);
    expect(text()).toContain("Connected as fake-login");
  },
);

test("the callback's note stays until the user acts", async () => {
  mount(<GatewayGithub {...props({ callback: "denied" })} />);
  expect(text()).toContain("Access was not granted");
  await act(async () => button("Connect GitHub")!.click());
  expect(text()).not.toContain("Access was not granted");
});

test("Disconnect asks first, names Authorized GitHub Apps, and clears only after confirming", async () => {
  const p = props({ status: ready(CONNECTED) });
  mount(<GatewayGithub {...p} />);
  await choose("Disconnect");
  expect(p.clear).not.toHaveBeenCalled();
  const dialog = () => document.querySelector('[role="dialog"]');
  expect(dialog()?.textContent).toContain("Disconnect GitHub?");
  expect(dialog()?.textContent).toContain(
    "Disconnecting deletes the gateway's GitHub sign-in. The app stays under GitHub Settings → Applications → Authorized GitHub Apps until you revoke it there.",
  );
  await act(async () => dialogButton("Cancel")!.click());
  expect(dialog()).toBeNull();
  expect(p.clear).not.toHaveBeenCalled();
  await choose("Disconnect");
  await act(async () => dialogButton("Disconnect")!.click());
  expect(p.clear).toHaveBeenCalledOnce();
  expect(dialog()).toBeNull();
});

test("a refused Disconnect shows its fixed text in the dialog", async () => {
  const p = props({
    status: ready(CONNECTED),
    clear: vi.fn(() =>
      Promise.reject(new GatewayApiError(409, "integration_busy")),
    ),
  });
  mount(<GatewayGithub {...p} />);
  await choose("Disconnect");
  await act(async () => dialogButton("Disconnect")!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Another change to this connection is still running. Try again.",
  );
});

test("while a Disconnect runs no connect starts; while a start runs Disconnect cannot", async () => {
  const removing = held<void>();
  const p = props({
    status: ready(CONNECTED),
    clear: vi.fn(() => removing.promise),
  });
  const view = mount(<GatewayGithub {...p} />);
  await choose("Disconnect");
  await act(async () => dialogButton("Disconnect")!.click());
  expect(dialogButton("Disconnect")!.disabled).toBe(true);
  expect(await itemDisabled("Connect again")).toBe(true);
  expect(p.connect).not.toHaveBeenCalled();
  await act(async () => removing.resolve());
  act(() => view.root.unmount());

  const starting = held<string>();
  const q = props({
    status: ready(CONNECTED),
    connect: vi.fn(() => starting.promise),
  });
  mount(<GatewayGithub {...q} />);
  await choose("Connect again");
  expect(await itemDisabled("Disconnect")).toBe(true);
  expect(await itemDisabled("Connect again")).toBe(true);
  expect(q.clear).not.toHaveBeenCalled();
});

test("Back from GitHub into the cached page abandons the start; the controls work again", async () => {
  mount(<GatewayGithub {...props()} />);
  await act(async () => button("Connect GitHub")!.click());
  expect(button("Connect GitHub")!.disabled).toBe(true);
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  await act(async () => window.dispatchEvent(event));
  expect(button("Connect GitHub")!.disabled).toBe(false);
});

// --- Check repository access --------------------------------------------------

test("a check sends exactly owner and repo and shows only the repository and the expiry as HH:MM", async () => {
  const p = props({
    status: ready(CONNECTED),
    // An answer carrying more than the wire allows still shows only its two.
    check: vi.fn(() =>
      Promise.resolve({
        ...CHECKED,
        token: "fake-t1445-leak-sentinel",
      } as GatewayUiGithubCheck),
    ),
  });
  mount(<GatewayGithub {...p} />);
  expect(text()).toContain("Check repository access");
  await checkRepository("  fake-owner/fake-repo ");
  expect(p.check).toHaveBeenCalledExactlyOnceWith({
    owner: "fake-owner",
    repo: "fake-repo",
  });
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    "Read access to fake-owner/fake-repo works; token valid until 14:05",
  );
  expect(text()).not.toContain("fake-t1445-leak-sentinel");
});

test("a repository that is not owner/repo under the gateway's rules is refused on the page", async () => {
  const p = props({ status: ready(CONNECTED) });
  mount(<GatewayGithub {...p} />);
  for (const value of [
    "",
    "fake-owner",
    "fake-owner/fake-repo/extra",
    "fake owner/fake-repo",
    "fake-owner/..",
    "fake_owner/fake-repo",
  ]) {
    await checkRepository(value);
    expect(text(), value).toContain("Enter the repository as owner/repo.");
  }
  expect(p.check).not.toHaveBeenCalled();
});

/** One fixed text per check refusal (plan §5). */
const CHECK_REFUSAL: [GatewayApiError | Error, string][] = [
  [
    new GatewayApiError(409, "integration_sign_in_required"),
    "Connect GitHub first, then check again.",
  ],
  [
    new GatewayApiError(403, "integration_denied"),
    "GitHub grants you no read access to this repository: you have no access to it, or the gateway's GitHub app is not installed there.",
  ],
  [
    new GatewayApiError(422, "integration_rejected"),
    "GitHub no longer accepts your connection. Connect GitHub again.",
  ],
  [
    new GatewayApiError(400, "integration_invalid"),
    "Enter the repository as owner/repo.",
  ],
  [
    new GatewayApiError(400, "bad_request"),
    "Enter the repository as owner/repo.",
  ],
  [
    new GatewayApiError(503, "vault_locked"),
    "The gateway's vault is locked. Ask its operator to unlock it.",
  ],
  [
    new GatewayApiError(503, "vault_unavailable"),
    "The gateway's vault did not answer, so access could not be checked. Try again.",
  ],
  [
    new GatewayApiError(409, "integration_busy"),
    "A check is still running. Wait for it, then try again.",
  ],
  [
    new GatewayApiError(401, "signed_out"),
    "Your session ended. Reload the page and sign in again.",
  ],
  [
    new GatewayApiError(503, "unavailable"),
    "Access could not be checked. Try again.",
  ],
  [new Error("network"), "Access could not be checked. Try again."],
];

test.each(CHECK_REFUSAL)(
  "a check refused %s shows its fixed text on the card",
  async (err, note) => {
    const p = props({ check: vi.fn(() => Promise.reject(err)) });
    mount(<GatewayGithub {...p} />);
    await checkRepository("fake-owner/fake-repo");
    expect(
      document.querySelector('section[aria-label="GitHub"]')?.textContent,
    ).toContain(note);
    expect(document.querySelector('[role="status"]')).toBeNull();
    // The button works again.
    expect(button("Check")!.disabled).toBe(false);
  },
);

test("while a check runs a second one sends nothing; its answer replaces the last", async () => {
  const running = held<GatewayUiGithubCheck>();
  const p = props({
    status: ready(CONNECTED),
    check: vi
      .fn<GatewayGithubProps["check"]>()
      .mockImplementationOnce(() =>
        Promise.reject(new GatewayApiError(403, "integration_denied")),
      )
      .mockImplementationOnce(() => running.promise),
  });
  mount(<GatewayGithub {...p} />);
  await checkRepository("fake-owner/fake-repo");
  expect(text()).toContain("GitHub grants you no read access");
  await checkRepository("fake-owner/fake-repo");
  expect(button("Check")!.disabled).toBe(true);
  await act(async () => button("Check")!.click());
  expect(p.check).toHaveBeenCalledTimes(2);
  await act(async () => running.resolve(CHECKED));
  expect(text()).not.toContain("GitHub grants you no read access");
  expect(text()).toContain("Read access to fake-owner/fake-repo works");
});
