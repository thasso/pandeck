// @vitest-environment jsdom
/**
 * The gateway page's Atlassian credential (Task-1405) over mocked props: its
 * states, Connect and Reconnect in a dialog sending the three fields with the
 * token in a password field dropped after success, a deployment's preset
 * replacing the site and email fields, Remove asking first, fixed texts for
 * refusals, and a save and a remove never overlapping. Where the gateway
 * signs in with Atlassian (Task-1411): no token form, the button starting the
 * sign-in once and handing its URL to `navigate`, the rows and actions per
 * stored kind, and the callback's fixed texts.
 */
import { GATEWAY_UI_ATLASSIAN_CONNECT_CODES } from "@assistant/shared/gatewayUi";
import { act } from "react";
import { expect, test, vi } from "vitest";
import { failed, loading, ready } from "../lib/loadState.ts";
import { mount } from "../test/mount.tsx";
import { GatewayApiError } from "./gatewayApi.ts";
import {
  GatewayAtlassian,
  type GatewayAtlassianProps,
} from "./GatewayAtlassian.tsx";

function props(over: Partial<GatewayAtlassianProps> = {}) {
  return {
    status: ready({ connected: false, connectWith: "token" as const }),
    save: vi.fn(() =>
      Promise.resolve({
        connected: true,
        connectWith: "token" as const,
        site: "x.atlassian.net",
        email: "p@example.org",
      }),
    ),
    clear: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() => Promise.resolve(AUTHORIZE)),
    navigate: vi.fn(),
    ...over,
  };
}

/** A synthetic authorize URL; the page only hands it to `navigate`. */
const AUTHORIZE =
  "https://auth.atlassian.com/authorize?client_id=FAKE_CLIENT&state=FAKE_STATE";

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  );
const dialogButton = (label: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((b) => b.textContent === label);
const field = (id: string) =>
  document.querySelector<HTMLInputElement>(`#gateway-atlassian-${id}`)!;

async function type(id: string, text: string) {
  const input = field(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function fill() {
  await type("site", "x.atlassian.net");
  await type("email", "p@example.org");
  await type("token", "FAKE-API-TOKEN");
}

const MENU = "More actions for the Jira credential";

/** Opens the credential's ⋯ menu and answers its item `label`. */
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

test("not set, connected, a vault problem and a failed load each read as such", () => {
  const cases: [GatewayAtlassianProps["status"], string][] = [
    [
      ready({ connected: false, connectWith: "token" as const }),
      "No Atlassian credential yet.",
    ],
    [
      ready({
        connected: true,
        connectWith: "token" as const,
        site: "x.atlassian.net",
        email: "p@example.org",
        displayName: "P",
      }),
      "Pp@example.org · x.atlassian.netConnected",
    ],
    [
      ready({
        connected: false,
        problem: "vault_locked",
        connectWith: "token" as const,
      }),
      "The gateway's vault is locked",
    ],
    [failed("unavailable"), "The Jira credential could not be loaded."],
  ];
  for (const [status, text] of cases) {
    const view = mount(<GatewayAtlassian {...props({ status })} />);
    expect(view.container.textContent).toContain(text);
    act(() => view.root.unmount());
  }
  const view = mount(<GatewayAtlassian {...props({ status: loading() })} />);
  expect(view.container.textContent).not.toContain("No Atlassian");
});

test("Connect opens a dialog that sends site, email and token; the token is a password, dropped after success", async () => {
  const p = props();
  mount(<GatewayAtlassian {...p} />);
  expect(document.querySelector("#gateway-atlassian-token")).toBeNull();
  await act(async () => button("Connect")!.click());
  expect(field("token").type).toBe("password");
  expect(field("token").autocomplete).toBe("off");
  await fill();
  await act(async () => dialogButton("Connect")!.click());
  expect(p.save).toHaveBeenCalledWith({
    site: "x.atlassian.net",
    email: "p@example.org",
    token: "FAKE-API-TOKEN",
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.innerHTML).not.toContain("FAKE-API-TOKEN");
});

test("Reconnect starts from the stored site and email; a preset hides its fields and is what a save sends", async () => {
  const p = props({ status: CONNECTED });
  const view = mount(<GatewayAtlassian {...p} />);
  await choose("Reconnect");
  expect(field("site").value).toBe("x.atlassian.net");
  expect(field("email").value).toBe("p@example.org");
  act(() => view.root.unmount());

  const preset = props({
    status: ready({
      connected: false,
      connectWith: "token" as const,
      preset: { site: "fixed.atlassian.net", email: "me@example.org" },
    }),
  });
  mount(<GatewayAtlassian {...preset} />);
  await act(async () => button("Connect")!.click());
  expect(document.querySelector("#gateway-atlassian-site")).toBeNull();
  expect(document.querySelector("#gateway-atlassian-email")).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "For me@example.org on fixed.atlassian.net.",
  );
  await type("token", "FAKE-API-TOKEN");
  await act(async () => dialogButton("Connect")!.click());
  expect(preset.save).toHaveBeenCalledWith({
    site: "fixed.atlassian.net",
    email: "me@example.org",
    token: "FAKE-API-TOKEN",
  });
});

test("Remove asks first", async () => {
  const p = props({ status: CONNECTED });
  mount(<GatewayAtlassian {...p} />);
  await choose("Remove credential");
  expect(p.clear).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Remove the Atlassian credential?",
  );
  await act(async () => dialogButton("Remove")!.click());
  expect(p.clear).toHaveBeenCalledOnce();
});

test("each refusal shows its fixed text and keeps the token to retry", async () => {
  const cases: [string, string][] = [
    ["integration_invalid", "The site, email or API token is not valid."],
    ["integration_rejected", "Atlassian rejected this email and API token."],
    ["integration_unreachable", "Atlassian could not be reached"],
    ["vault_locked", "The gateway's vault is locked."],
    ["vault_unavailable", "The gateway's vault did not answer."],
    ["tools_unavailable", "This gateway does not run the Jira tools."],
    [
      "integration_busy",
      "Another change to this credential is still running. Try again.",
    ],
    ["unavailable", "The credential could not be saved."],
  ];
  for (const [code, text] of cases) {
    const view = mount(
      <GatewayAtlassian
        {...props({
          save: () =>
            Promise.reject(
              new GatewayApiError(400, code as GatewayApiError["code"]),
            ),
        })}
      />,
    );
    await act(async () => button("Connect")!.click());
    await fill();
    await act(async () => dialogButton("Connect")!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      text,
    );
    expect(field("token").value).toBe("FAKE-API-TOKEN");
    act(() => view.root.unmount());
  }
});

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

const CONNECTED = ready({
  connected: true,
  connectWith: "token" as const,
  site: "x.atlassian.net",
  email: "p@example.org",
});

test("while a Save is pending, a second submit sends nothing and Remove cannot start", async () => {
  const saved = deferred<{ connected: boolean; connectWith: "token" }>();
  const p = props({ status: CONNECTED, save: vi.fn(() => saved.promise) });
  mount(<GatewayAtlassian {...p} />);
  await choose("Reconnect");
  await type("token", "FAKE-API-TOKEN");
  const save = dialogButton("Reconnect")!;
  await act(async () => {
    save.click();
    save.click();
  });
  expect(p.save).toHaveBeenCalledTimes(1);
  expect(await itemDisabled("Remove credential")).toBe(true);
  await act(async () =>
    saved.resolve({ connected: true, connectWith: "token" as const }),
  );
  expect(await itemDisabled("Remove credential")).toBe(false);
});

test("while a Remove is pending, Reconnect cannot start", async () => {
  const cleared = deferred<void>();
  const p = props({ status: CONNECTED, clear: vi.fn(() => cleared.promise) });
  mount(<GatewayAtlassian {...p} />);
  await choose("Remove credential");
  const confirm = dialogButton("Remove")!;
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(p.clear).toHaveBeenCalledOnce();
  expect(await itemDisabled("Reconnect")).toBe(true);
  await act(async () => cleared.resolve());
  expect(await itemDisabled("Reconnect")).toBe(false);
});

// --- Sign in with Atlassian (Task-1411, AC8) ---------------------------------

const OAUTH = {
  connected: true,
  kind: "oauth" as const,
  site: "x.atlassian.net",
  connectWith: "oauth" as const,
};

const text = () => document.body.textContent ?? "";
const inputs = () => document.querySelectorAll("input").length;

test("signing in with Atlassian: no record shows the button, never a token form", async () => {
  const p = props({
    status: ready({ connected: false, connectWith: "oauth" }),
  });
  mount(<GatewayAtlassian {...p} />);
  expect(text()).toContain("No Atlassian credential yet.");
  expect(button("Connect")).toBeUndefined();
  expect(button("Sign in with Atlassian")).toBeDefined();
  expect(inputs()).toBe(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("the button starts the sign-in once, stays busy and hands the answered URL to navigate", async () => {
  let answer!: (url: string) => void;
  const connect = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  );
  const p = props({
    status: ready({ connected: false, connectWith: "oauth" }),
    connect,
  });
  mount(<GatewayAtlassian {...p} />);
  await act(async () => button("Sign in with Atlassian")!.click());
  expect(button("Sign in with Atlassian")!.disabled).toBe(true);
  await act(async () => button("Sign in with Atlassian")!.click());
  expect(connect).toHaveBeenCalledTimes(1);
  await act(async () => answer(AUTHORIZE));
  expect(p.navigate).toHaveBeenCalledTimes(1);
  expect(p.navigate).toHaveBeenCalledWith(AUTHORIZE);
  // The browser is leaving: the button does not come back.
  expect(button("Sign in with Atlassian")!.disabled).toBe(true);
});

test("a refused start shows its fixed text in the section and the button again", async () => {
  const p = props({
    status: ready({ connected: false, connectWith: "oauth" }),
    connect: vi.fn(() =>
      Promise.reject(new GatewayApiError(503, "unavailable")),
    ),
  });
  mount(<GatewayAtlassian {...p} />);
  await act(async () => button("Sign in with Atlassian")!.click());
  expect(text()).toContain(
    "The gateway has too many sign-ins in progress. Try again in a few minutes.",
  );
  expect(p.navigate).not.toHaveBeenCalled();
  expect(button("Sign in with Atlassian")!.disabled).toBe(false);
});

test("an OAuth record reads Signed in with Atlassian with its site; Sign in again starts the sign-in", async () => {
  const p = props({ status: ready(OAUTH) });
  mount(<GatewayAtlassian {...p} />);
  expect(text()).toContain("Signed in with Atlassian");
  expect(text()).toContain("x.atlassian.net");
  expect(text()).toContain("Connected");
  expect(inputs()).toBe(0);
  expect(await itemDisabled("Remove credential")).toBe(false);
  await choose("Sign in again");
  expect(p.connect).toHaveBeenCalledTimes(1);
  expect(p.navigate).toHaveBeenCalledWith(AUTHORIZE);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("a rejected OAuth record says to sign in again and stays removable", async () => {
  const p = props({
    status: ready({
      connected: false,
      kind: "oauth",
      problem: "rejected",
      connectWith: "oauth",
    }),
  });
  mount(<GatewayAtlassian {...p} />);
  expect(text()).toContain(
    "Atlassian no longer accepts this sign-in. Sign in with Atlassian again.",
  );
  await choose("Remove credential");
  await act(async () => dialogButton("Remove")!.click());
  expect(p.clear).toHaveBeenCalledTimes(1);
});

test("a token record on a sign-in gateway reads API token and offers Sign in with Atlassian", async () => {
  const p = props({
    status: ready({
      connected: true,
      kind: "token",
      site: "x.atlassian.net",
      email: "p@example.org",
      connectWith: "oauth",
    }),
  });
  mount(<GatewayAtlassian {...p} />);
  expect(text()).toContain("API token");
  expect(text()).toContain("p@example.org · x.atlassian.net");
  const item = await menuItem("Sign in with Atlassian");
  expect(
    [...document.querySelectorAll('[role="menuitem"]')].some(
      (node) => node.textContent === "Reconnect",
    ),
  ).toBe(false);
  await act(async () => item.click());
  expect(p.connect).toHaveBeenCalledTimes(1);
  expect(inputs()).toBe(0);
});

test("a token gateway labels a token record API token and keeps Reconnect with the form", async () => {
  const p = props({
    status: ready({
      connected: true,
      kind: "token",
      site: "x.atlassian.net",
      email: "p@example.org",
      displayName: "P",
      connectWith: "token",
    }),
  });
  mount(<GatewayAtlassian {...p} />);
  expect(text()).toContain("API tokenp@example.org · x.atlassian.net");
  await choose("Reconnect");
  expect(field("token").type).toBe("password");
  expect(p.connect).not.toHaveBeenCalled();
});

test("the callback's code shows its fixed text until the user acts", async () => {
  const p = props({
    status: ready({ connected: false, connectWith: "oauth" }),
    callback: "site_ambiguous",
  });
  mount(<GatewayAtlassian {...p} />);
  const note =
    "Your Atlassian sign-in includes more than one Jira site and this gateway names none. Ask its operator to set the site.";
  expect(text()).toContain(note);
  await act(async () => button("Sign in with Atlassian")!.click());
  expect(text()).not.toContain(note);
});

test("a denied new sign-in leaves a stored token connected and says nothing else", () => {
  const p = props({
    status: ready({
      connected: true,
      kind: "token",
      site: "x.atlassian.net",
      email: "p@example.org",
      connectWith: "oauth",
    }),
    callback: "denied",
  });
  mount(<GatewayAtlassian {...p} />);
  expect(text()).toContain("Access was not granted on Atlassian's page");
  expect(text()).toContain("Connected");
  expect(text()).not.toMatch(/not connected/i);
});

test.each([...GATEWAY_UI_ATLASSIAN_CONNECT_CODES])(
  "the %s callback text does not claim a stored sign-in is gone",
  (code) => {
    mount(
      <GatewayAtlassian {...props({ status: ready(OAUTH), callback: code })} />,
    );
    expect(text()).toContain("Connected");
    expect(text()).not.toMatch(/not connected/i);
  },
);

/** A `pageshow`; jsdom has no `PageTransitionEvent`. */
async function pageshow(persisted: boolean) {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  await act(async () => window.dispatchEvent(event));
}

test("Back from Atlassian into the cached page abandons the start; the controls work again", async () => {
  const p = props({
    status: ready({ connected: false, connectWith: "oauth" }),
  });
  mount(<GatewayAtlassian {...p} />);
  await act(async () => button("Sign in with Atlassian")!.click());
  expect(p.navigate).toHaveBeenCalledWith(AUTHORIZE);
  expect(button("Sign in with Atlassian")!.disabled).toBe(true);
  // An ordinary load's pageshow is not a return: the start stays.
  await pageshow(false);
  expect(button("Sign in with Atlassian")!.disabled).toBe(true);
  const before = text();
  await pageshow(true);
  expect(button("Sign in with Atlassian")!.disabled).toBe(false);
  // The user went back by choice: no note.
  expect(text()).toBe(before);
  await act(async () => button("Sign in with Atlassian")!.click());
  expect(p.connect).toHaveBeenCalledTimes(2);
});

test("Back from Atlassian frees a stored record's actions too", async () => {
  const p = props({ status: ready(OAUTH) });
  mount(<GatewayAtlassian {...p} />);
  await choose("Sign in again");
  expect(p.navigate).toHaveBeenCalledTimes(1);
  expect(await itemDisabled("Remove credential")).toBe(true);
  expect(await itemDisabled("Sign in again")).toBe(true);
  await pageshow(false);
  expect(await itemDisabled("Remove credential")).toBe(true);
  await pageshow(true);
  expect(await itemDisabled("Remove credential")).toBe(false);
  expect(await itemDisabled("Sign in again")).toBe(false);
});

test("a page refusal of a new API token reads as such", async () => {
  const p = props({
    save: vi.fn(() =>
      Promise.reject(new GatewayApiError(409, "integration_sign_in_required")),
    ),
  });
  mount(<GatewayAtlassian {...p} />);
  await act(async () => button("Connect")!.click());
  await fill();
  await act(async () => dialogButton("Connect")!.click());
  expect(text()).toContain(
    "This gateway connects Jira only with Sign in with Atlassian.",
  );
});
