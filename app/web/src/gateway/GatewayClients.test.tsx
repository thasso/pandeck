// @vitest-environment jsdom
/**
 * The gateway page's clients (Task-1405) over mocked props: the list, a code
 * shown once and dropped on Done, every revoke asking first, a token shown
 * once, a replacement asking first, and fixed texts for each refusal.
 */
import { act } from "react";
import { expect, test, vi } from "vitest";
import type { GatewayUiClient } from "@assistant/shared/gatewayUi";
import { ready } from "../lib/loadState.ts";
import { mount } from "../test/mount.tsx";
import { GatewayApiError } from "./gatewayApi.ts";
import { GatewayClients, type GatewayClientsProps } from "./GatewayClients.tsx";

const LAPTOP: GatewayUiClient = {
  id: "c1",
  label: "Laptop",
  createdAt: Date.UTC(2026, 10, 1),
  mcpToken: false,
};
const DESKTOP: GatewayUiClient = {
  id: "c2",
  label: "Desktop",
  createdAt: Date.UTC(2026, 10, 2),
  mcpToken: true,
};

function props(over: Partial<GatewayClientsProps> = {}) {
  const base = {
    clients: ready([LAPTOP, DESKTOP]),
    createCode: vi.fn(() =>
      Promise.resolve({ code: "FAKE-CODE-1", validForSeconds: 900 }),
    ),
    revoke: vi.fn(() => Promise.resolve()),
    mintMcpToken: vi.fn(() => Promise.resolve({ token: "pgmcp_FAKE" })),
    revokeMcpToken: vi.fn(() => Promise.resolve()),
    reload: vi.fn(),
  };
  return { ...base, ...over };
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
}

async function typeLabel(text: string) {
  const input = document.querySelector<HTMLInputElement>(
    "#gateway-client-label",
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("lists the clients with their MCP token state, never a token", () => {
  const view = mount(<GatewayClients {...props()} />);
  const text = view.container.textContent ?? "";
  expect(text).toContain("Laptop");
  expect(text).toContain("Desktop");
  expect(text).toContain("MCP token");
  expect(view.container.querySelectorAll('[role="listitem"]')).toHaveLength(2);
});

test("a created code is shown once; Done drops it from the DOM and reloads", async () => {
  const p = props();
  mount(<GatewayClients {...p} />);
  await typeLabel("  Work laptop ");
  await click("Create enrollment code");
  expect(p.createCode).toHaveBeenCalledWith("Work laptop");
  expect(dialog()?.textContent).toContain("Valid for 15 minutes, once.");
  expect(
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Enrollment code"]',
    )?.value,
  ).toBe("FAKE-CODE-1");
  await click("Done");
  expect(document.body.innerHTML).not.toContain("FAKE-CODE-1");
  expect(p.reload).toHaveBeenCalledOnce();
});

test("revoking a client asks first, then sends its id only", async () => {
  const p = props();
  mount(<GatewayClients {...p} />);
  await click("Revoke Laptop");
  expect(p.revoke).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain("Revoke Laptop?");
  expect(dialog()?.textContent).toContain("must enroll again");
  await click("Revoke client");
  expect(p.revoke).toHaveBeenCalledWith("c1");
  expect(dialog()).toBeNull();
});

test("minting shows the token once; replacing an existing one asks first", async () => {
  const p = props();
  mount(<GatewayClients {...p} />);
  await click("Mint MCP token for Laptop");
  expect(p.mintMcpToken).toHaveBeenCalledWith("c1");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="MCP token"]')
      ?.value,
  ).toBe("pgmcp_FAKE");
  await click("Done");
  expect(document.body.innerHTML).not.toContain("pgmcp_FAKE");

  await click("Replace MCP token of Desktop");
  expect(p.mintMcpToken).toHaveBeenCalledTimes(1);
  expect(dialog()?.textContent).toContain("The current token stops working.");
  await click("Replace token");
  expect(p.mintMcpToken).toHaveBeenLastCalledWith("c2");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="MCP token"]')
      ?.value,
  ).toBe("pgmcp_FAKE");
  await click("Done");

  // With three actions, revoking the token sits in the row's menu.
  await click("Desktop actions");
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((node) => node.textContent?.includes("Revoke MCP token of Desktop"));
  await act(async () => item!.click());
  expect(p.revokeMcpToken).not.toHaveBeenCalled();
  await click("Revoke token");
  expect(p.revokeMcpToken).toHaveBeenCalledWith("c2");
});

test("each refusal shows its fixed text", async () => {
  const cases: [string, string][] = [
    ["limit_reached", "You have too many clients or unused codes."],
    ["signed_out", "Your session ended."],
    ["unavailable", "The gateway could not do this right now."],
  ];
  for (const [code, text] of cases) {
    const view = mount(
      <GatewayClients
        {...props({
          createCode: () =>
            Promise.reject(
              new GatewayApiError(409, code as GatewayApiError["code"]),
            ),
        })}
      />,
    );
    await typeLabel("x");
    await click("Create enrollment code");
    expect(view.container.textContent).toContain(text);
    act(() => view.root.unmount());
  }
  const view = mount(
    <GatewayClients
      {...props({
        revoke: () =>
          Promise.reject(new GatewayApiError(404, "unknown_client")),
      })}
    />,
  );
  await click("Revoke Laptop");
  await click("Revoke client");
  expect(dialog()?.textContent).toContain("This client is no longer enrolled.");
  act(() => view.root.unmount());
});

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

test("a repeated Mint click sends one mint; the client's actions wait for it", async () => {
  const minted = deferred<{ token: string }>();
  const p = props({ mintMcpToken: vi.fn(() => minted.promise) });
  mount(<GatewayClients {...p} />);
  const mint = button("Mint MCP token for Laptop")!;
  // Two clicks before any re-render, then a third once it rendered.
  await act(async () => {
    mint.click();
    mint.click();
  });
  await act(async () => button("Mint MCP token for Laptop")!.click());
  expect(p.mintMcpToken).toHaveBeenCalledTimes(1);
  expect(button("Mint MCP token for Laptop")!.disabled).toBe(true);
  expect(button("Revoke Laptop")!.disabled).toBe(true);
  // Another client is not held up.
  expect(button("Revoke Desktop")!.disabled).toBe(false);
  await act(async () => minted.resolve({ token: "pgmcp_ONCE" }));
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="MCP token"]')
      ?.value,
  ).toBe("pgmcp_ONCE");
  await click("Done");
  expect(button("Mint MCP token for Laptop")!.disabled).toBe(false);
  expect(button("Revoke Laptop")!.disabled).toBe(false);
});

test("a confirmed revoke holds the client's actions until it settles", async () => {
  const revoked = deferred<void>();
  const p = props({ revoke: vi.fn(() => revoked.promise) });
  mount(<GatewayClients {...p} />);
  await click("Revoke Laptop");
  const confirm = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((b) => b.textContent === "Revoke client")!;
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(p.revoke).toHaveBeenCalledTimes(1);
  expect(button("Mint MCP token for Laptop")!.disabled).toBe(true);
  await act(async () => revoked.resolve());
  expect(button("Mint MCP token for Laptop")!.disabled).toBe(false);
});
