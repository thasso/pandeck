// @vitest-environment jsdom
/**
 * The gateway page's Atlassian credential (Task-1405) over mocked props: its
 * states, a save sending the three fields with the token in a password field
 * emptied after success, Clear asking first, fixed texts for refusals.
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
    status: ready({ connected: false }),
    save: vi.fn(() =>
      Promise.resolve({
        connected: true,
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

test("not set, connected, a vault problem and a failed load each read as such", () => {
  const cases: [GatewayAtlassianProps["status"], string][] = [
    [ready({ connected: false }), "No Atlassian credential is set."],
    [
      ready({
        connected: true,
        site: "x.atlassian.net",
        email: "p@example.org",
      }),
      "Connectedas p@example.org on x.atlassian.net",
    ],
    [
      ready({ connected: false, problem: "vault_locked" }),
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

test("Save sends site, email and token; the token field is a password, emptied after success", async () => {
  const p = props();
  mount(<GatewayAtlassian {...p} />);
  expect(field("token").type).toBe("password");
  expect(field("token").autocomplete).toBe("off");
  await fill();
  await act(async () => button("Save credential")!.click());
  expect(p.save).toHaveBeenCalledWith({
    site: "x.atlassian.net",
    email: "p@example.org",
    token: "FAKE-API-TOKEN",
  });
  expect(field("token").value).toBe("");
  expect(document.body.innerHTML).not.toContain("FAKE-API-TOKEN");
});

test("Clear asks first", async () => {
  const p = props({
    status: ready({
      connected: true,
      site: "x.atlassian.net",
      email: "p@example.org",
    }),
  });
  mount(<GatewayAtlassian {...p} />);
  await act(async () => button("Clear")!.click());
  expect(p.clear).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Clear the Atlassian credential?",
  );
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
    (b) => b.textContent === "Clear",
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
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
    await fill();
    await act(async () => button("Save credential")!.click());
    expect(view.container.textContent).toContain(text);
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
  site: "x.atlassian.net",
  email: "p@example.org",
});

test("while a Save is pending, Clear cannot start", async () => {
  const saved = deferred<{ connected: boolean }>();
  const p = props({ status: CONNECTED, save: vi.fn(() => saved.promise) });
  mount(<GatewayAtlassian {...p} />);
  await fill();
  const save = button("Replace credential")!;
  await act(async () => {
    save.click();
    save.click();
  });
  expect(p.save).toHaveBeenCalledTimes(1);
  expect(button("Clear")!.disabled).toBe(true);
  await act(async () => saved.resolve({ connected: true }));
  expect(button("Clear")!.disabled).toBe(false);
});

test("while a Clear is pending, Save cannot start", async () => {
  const cleared = deferred<void>();
  const p = props({ status: CONNECTED, clear: vi.fn(() => cleared.promise) });
  mount(<GatewayAtlassian {...p} />);
  await fill();
  await act(async () => button("Clear")!.click());
  const confirm = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((b) => b.textContent === "Clear")!;
  await act(async () => confirm.click());
  expect(p.clear).toHaveBeenCalledOnce();
  expect(button("Replace credential")!.disabled).toBe(true);
  // Even a submit that reaches the form (Enter) sends nothing.
  await act(async () => {
    field("token").form!.requestSubmit();
  });
  expect(p.save).not.toHaveBeenCalled();
  await act(async () => cleared.resolve());
  expect(button("Replace credential")!.disabled).toBe(false);
});
