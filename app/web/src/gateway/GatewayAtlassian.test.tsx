// @vitest-environment jsdom
/**
 * The gateway page's Atlassian credential (Task-1405) over mocked props: its
 * states, Connect and Reconnect in a dialog sending the three fields with the
 * token in a password field dropped after success, a deployment's preset
 * replacing the site and email fields, Remove asking first, fixed texts for
 * refusals, and a save and a remove never overlapping.
 */
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
    ...over,
  };
}

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
