// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import { mount } from "../test/mount.tsx";
import {
  AccountLoginDialogView,
  claudeLoginAuthorizationUrl,
  type AccountLoginDialogViewProps,
} from "./AccountLoginDialogView.tsx";

const claude: AccountLoginDialogViewProps = {
  provider: "claude",
  accountName: "Claude personal",
  status: "connecting",
  output: "Starting Claude login…",
  submit: () => true,
  cancel: () => {},
  onClose: () => {},
};
const openAi: AccountLoginDialogViewProps = {
  provider: "openai-codex",
  accountName: "OpenAI work",
  status: "connecting",
  output: "",
  cancel: () => {},
  onClose: () => {},
};
const DEVICE = {
  verificationUri: "https://auth.example/device",
  userCode: "ABCD-1234",
};

function dialog(props: AccountLoginDialogViewProps) {
  const view = mount(<AccountLoginDialogView {...props} />);
  // A ui/dialog portals itself out of its host.
  expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  const node = document.querySelector<HTMLElement>(
    `[role="dialog"][aria-label="Connect ${props.accountName}"]`,
  )!;
  expect(node).not.toBeNull();
  const button = (label: string) =>
    [...node.querySelectorAll("button")].find(
      (b) => b.textContent === label || b.getAttribute("aria-label") === label,
    );
  return { view, node, button };
}

describe("Claude", () => {
  test("extracts the official authorization URL from streamed CLI output", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
    expect(
      claudeLoginAuthorizationUrl(
        `Opening browser…\nIf it did not open, visit: ${url}\nPaste code here > `,
      ),
    ).toBe(url);
  });

  test("does not turn unrelated terminal URLs into the authorization action", () => {
    expect(
      claudeLoginAuthorizationUrl("See https://example.com/help"),
    ).toBeUndefined();
  });

  test("submits a pasted code without keeping it on screen, and closes without cancelling", () => {
    const submit = vi.fn(() => true);
    const cancel = vi.fn();
    const onClose = vi.fn();
    const { node, button, view } = dialog({
      ...claude,
      submit,
      cancel,
      onClose,
    });
    const input = node.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, " preview-code ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      node
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(submit).toHaveBeenCalledWith("preview-code");
    expect(input.value).toBe("");
    expect(node.textContent).toContain("Code submitted; waiting for Claude…");
    expect(node.textContent).toContain("Pandeck forwards it");
    act(() => button("Close Claude login")!.click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    act(() => button("Cancel login")!.click());
    expect(cancel).toHaveBeenCalledOnce();
    act(() => view.root.unmount());
  });

  test("a failed login keeps its output and error in the same dialog", () => {
    const { node, button, view } = dialog({
      ...claude,
      status: "error",
      output: "Authorization failed.",
      error: "The authorization code expired.",
    });
    expect(node.textContent).toContain("Authorization failed.");
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "The authorization code expired.",
    );
    expect(node.querySelector('input[type="password"]')).toBeNull();
    expect(button("Cancel login")).toBeUndefined();
    act(() => view.root.unmount());
  });
});

describe("OpenAI", () => {
  test("shows a spinner until the device code arrives, with Cancel", () => {
    const { node, button, view } = dialog(openAi);
    expect(node.textContent).toContain("Starting the OpenAI sign-in…");
    expect(node.querySelector("a")).toBeNull();
    expect(button("Cancel login")).toBeDefined();
    expect(node.querySelector('input[type="password"]')).toBeNull();
    act(() => view.root.unmount());
  });

  test("shows the verification link and one-time code; Cancel and Close are separate", () => {
    const cancel = vi.fn();
    const onClose = vi.fn();
    const { node, button, view } = dialog({
      ...openAi,
      device: DEVICE,
      cancel,
      onClose,
    });
    expect(node.textContent).toContain("ABCD-1234");
    expect(
      node.querySelectorAll(`a[href="${DEVICE.verificationUri}"]`).length,
    ).toBeGreaterThan(0);
    act(() => button("Cancel login")!.click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    act(() => button("Close")!.click());
    expect(onClose).toHaveBeenCalledOnce();
    act(() => view.root.unmount());
  });

  test.each([
    ["cancelled", undefined, "Login cancelled.", "Close"],
    ["error", "The provider refused.", "The provider refused.", "Close"],
    ["ready", undefined, "OpenAI is connected for this account.", "Done"],
  ] as const)(
    "a %s login hides the code and Cancel",
    (status, error, text, close) => {
      const { node, button, view } = dialog({
        ...openAi,
        status,
        device: DEVICE,
        ...(error ? { error } : {}),
      });
      expect(node.textContent).toContain(text);
      expect(node.textContent).not.toContain("ABCD-1234");
      expect(button("Cancel login")).toBeUndefined();
      expect(button(close)).toBeDefined();
      act(() => view.root.unmount());
    },
  );

  test("C4: an unconfirmed early Cancel asks for Cancel again while the login runs, and Cancel stays enabled", () => {
    const cancel = vi.fn();
    const { node, button, view } = dialog({
      ...openAi,
      device: DEVICE,
      cancelUnconfirmed: true,
      cancel,
    });
    expect(node.querySelector('[role="status"]')?.textContent).toBe(
      "Cancel not confirmed. Press Cancel again to stop this login.",
    );
    expect(node.textContent).not.toContain("Login cancelled.");
    expect(button("Cancel login")?.disabled).toBe(false);
    act(() => button("Cancel login")!.click());
    expect(cancel).toHaveBeenCalledOnce();
    act(() => view.root.unmount());
  });

  test("C4: the notice shows only while the login runs", () => {
    const { node, view } = dialog({
      ...openAi,
      status: "cancelled",
      cancelUnconfirmed: true,
    });
    expect(node.textContent).not.toContain("Cancel not confirmed");
    act(() => view.root.unmount());
  });
});
