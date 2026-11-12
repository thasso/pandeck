// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
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
const CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
const CLAUDE_OUTPUT = `Opening browser…\nIf it did not open, visit: ${CLAUDE_URL}\nPaste code here > `;

/** jsdom has no clipboard, like a page served over plain http. */
function withClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}
afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

function pressEscape(node: HTMLElement) {
  act(() => {
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

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
  const input = (label: string) =>
    node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  return { view, node, button, input };
}

describe("Claude", () => {
  test("extracts the official authorization URL from streamed CLI output", () => {
    expect(claudeLoginAuthorizationUrl(CLAUDE_OUTPUT)).toBe(CLAUDE_URL);
  });

  test("does not turn unrelated terminal URLs into the authorization action", () => {
    expect(
      claudeLoginAuthorizationUrl("See https://example.com/help"),
    ).toBeUndefined();
  });

  test("shows a spinner, not the CLI output, until the authorization URL appears", () => {
    const { node, input, view } = dialog({
      ...claude,
      output: "Some CLI banner\nLoading…",
    });
    expect(node.querySelector('[role="status"]')?.textContent).toBe(
      "Starting Claude login…",
    );
    expect(node.textContent).not.toContain("Some CLI banner");
    expect(node.querySelector("pre")).toBeNull();
    expect(input("Claude authorization link")).toBeNull();
    expect(node.querySelector('input[type="password"]')).not.toBeNull();
    act(() => view.root.unmount());
  });

  test("shows the authorization link and its URL as selectable text, never the CLI output", () => {
    const { node, input, view } = dialog({ ...claude, output: CLAUDE_OUTPUT });
    expect(node.textContent).not.toContain("Opening browser");
    expect(node.textContent).not.toContain("Paste code here");
    expect(node.textContent).not.toContain("Starting Claude login…");
    expect(node.querySelector(`a[href="${CLAUDE_URL}"]`)?.textContent).toBe(
      "Open Claude authorization ",
    );
    const field = input("Claude authorization link")!;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe(CLAUDE_URL);
    act(() => view.root.unmount());
  });

  test("submits a pasted code without keeping it on screen; Cancel cancels", () => {
    const submit = vi.fn(() => true);
    const cancel = vi.fn();
    const onClose = vi.fn();
    const { node, button, view } = dialog({
      ...claude,
      output: CLAUDE_OUTPUT,
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
    act(() => button("Cancel login")!.click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    act(() => view.root.unmount());
  });

  test("a failed login shows its error, not the CLI output", () => {
    const { node, button, view } = dialog({
      ...claude,
      status: "error",
      output: `Authorization failed.\n${CLAUDE_URL}`,
      error: "The authorization code expired.",
    });
    expect(node.textContent).not.toContain("Authorization failed.");
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "The authorization code expired.",
    );
    expect(node.querySelector('input[type="password"]')).toBeNull();
    expect(node.querySelector("input")).toBeNull();
    expect(button("Cancel login")).toBeUndefined();
    expect(button("Close")).toBeDefined();
    act(() => view.root.unmount());
  });
});

describe("copying the login link", () => {
  test.each([
    ["Claude", { ...claude, output: CLAUDE_OUTPUT }, CLAUDE_URL],
    ["OpenAI", { ...openAi, device: DEVICE }, DEVICE.verificationUri],
  ] as const)(
    "%s: Copy link writes the URL and confirms in place for two seconds",
    async (_provider, props, url) => {
      vi.useFakeTimers();
      const writeText = vi.fn(() => Promise.resolve());
      withClipboard(writeText);
      const { button, view } = dialog(props);
      await act(async () => button("Copy link")!.click());
      expect(writeText).toHaveBeenCalledWith(url);
      expect(button("Copy link")).toBeUndefined();
      expect(button("Link copied")).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(1999);
      });
      expect(button("Link copied")).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(button("Copy link")).toBeDefined();
      act(() => view.root.unmount());
    },
  );

  test.each([
    ["rejects", () => Promise.reject(new Error("denied"))],
    [
      "throws",
      (): Promise<void> => {
        throw new Error("denied");
      },
    ],
  ] as const)(
    "a write that %s does not throw and shows no confirmation",
    async (_how, refuse) => {
      const writeText = vi.fn(refuse);
      withClipboard(writeText);
      const { button, view } = dialog({ ...openAi, device: DEVICE });
      await act(async () => button("Copy link")!.click());
      expect(writeText).toHaveBeenCalledOnce();
      expect(button("Link copied")).toBeUndefined();
      expect(button("Copy link")).toBeDefined();
      act(() => view.root.unmount());
    },
  );

  test.each([
    [
      "Claude",
      { ...claude, output: CLAUDE_OUTPUT },
      "Claude authorization link",
    ],
    ["OpenAI", { ...openAi, device: DEVICE }, "OpenAI sign-in link"],
  ] as const)(
    "%s: without a clipboard (plain http) the button is hidden and the URL stays selectable",
    (_provider, props, label) => {
      expect(navigator.clipboard).toBeUndefined();
      const { button, input, view } = dialog(props);
      expect(button("Copy link")).toBeUndefined();
      expect(input(label)?.readOnly).toBe(true);
      act(() => view.root.unmount());
    },
  );
});

describe("closing", () => {
  test.each([
    ["Claude", { ...claude, output: CLAUDE_OUTPUT }],
    ["OpenAI", { ...openAi, device: DEVICE }],
  ] as const)(
    "%s: a running login offers only Cancel; no X, no Close, Escape does nothing",
    (_provider, props) => {
      const onClose = vi.fn();
      const { node, button, view } = dialog({ ...props, onClose });
      const labels = [...node.querySelectorAll("button")].map(
        (b) => b.getAttribute("aria-label") ?? b.textContent,
      );
      expect(labels.filter((l) => /close/i.test(l ?? ""))).toEqual([]);
      expect(button("Cancel login")).toBeDefined();
      expect(button("Close")).toBeUndefined();
      pressEscape(node);
      expect(onClose).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      act(() => view.root.unmount());
    },
  );

  test("a pressed Cancel shows Close even before the host reports it, so an unconfirmed cancel cannot trap the user", () => {
    const cancel = vi.fn();
    const onClose = vi.fn();
    const { node, button, view } = dialog({
      ...openAi,
      device: DEVICE,
      cancel,
      onClose,
    });
    act(() => button("Cancel login")!.click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    // The host has not said it is cancelling this run: nothing else changes.
    expect(node.textContent).not.toContain("Cancelling…");
    expect(node.textContent).toContain("ABCD-1234");
    expect(button("Cancel login")?.disabled).toBe(false);
    pressEscape(node);
    expect(onClose).toHaveBeenCalledOnce();
    act(() => button("Close")!.click());
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => view.root.unmount());
  });

  test("cancelling the shown run shows Cancelling…, disables Cancel and keeps Close", () => {
    const onClose = vi.fn();
    const { node, button, view } = dialog({
      ...openAi,
      device: DEVICE,
      onClose,
    });
    act(() => button("Cancel login")!.click());
    view.render(
      <AccountLoginDialogView
        {...openAi}
        device={DEVICE}
        onClose={onClose}
        cancelling
      />,
    );
    expect(node.querySelector('[role="status"]')?.textContent).toBe(
      "Cancelling…",
    );
    expect(node.textContent).not.toContain("ABCD-1234");
    expect(button("Cancel login")?.disabled).toBe(true);
    act(() => button("Close")!.click());
    expect(onClose).toHaveBeenCalledOnce();
    act(() => view.root.unmount());
  });

  test.each([
    ["Claude", { ...claude, output: CLAUDE_OUTPUT }],
    ["OpenAI", { ...openAi, device: DEVICE }],
  ] as const)(
    "%s: a run cancelled by this dialog's Cancel closes it once, without a cancelled screen",
    (_provider, props) => {
      const onClose = vi.fn();
      const { node, view } = dialog({ ...props, onClose, cancelling: true });
      expect(onClose).not.toHaveBeenCalled();
      view.render(
        <AccountLoginDialogView
          {...props}
          onClose={onClose}
          status="cancelled"
          cancelledHere
          error="The login was cancelled."
        />,
      );
      expect(onClose).toHaveBeenCalledOnce();
      expect(node.textContent).not.toContain("The login was cancelled.");
      expect(node.textContent).not.toContain("Login cancelled.");
      // A host re-render before it unmounts does not close twice.
      view.render(
        <AccountLoginDialogView
          {...props}
          onClose={() => onClose()}
          status="cancelled"
          cancelledHere
        />,
      );
      expect(onClose).toHaveBeenCalledOnce();
      act(() => view.root.unmount());
    },
  );

  test("a cancelled run the host does not attribute to this dialog keeps its notice and Close, even after a press", () => {
    const onClose = vi.fn();
    const { node, button, view } = dialog({
      ...openAi,
      device: DEVICE,
      onClose,
    });
    act(() => button("Cancel login")!.click());
    view.render(
      <AccountLoginDialogView
        {...openAi}
        device={DEVICE}
        onClose={onClose}
        status="cancelled"
        error="This login was started again elsewhere."
      />,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(node.textContent).toContain(
      "This login was started again elsewhere.",
    );
    expect(button("Close")).toBeDefined();
    act(() => view.root.unmount());
  });

  test("C4 after a press: the unconfirmed notice wins over Cancelling…, Cancel is enabled again and Close stays", () => {
    const cancel = vi.fn();
    const { node, button, view } = dialog({
      ...openAi,
      device: DEVICE,
      cancel,
    });
    act(() => button("Cancel login")!.click());
    view.render(
      <AccountLoginDialogView
        {...openAi}
        device={DEVICE}
        cancel={cancel}
        cancelling
        cancelUnconfirmed
      />,
    );
    expect(node.textContent).not.toContain("Cancelling…");
    expect(node.textContent).toContain(
      "Cancel not confirmed. Press Cancel again to stop this login.",
    );
    expect(node.textContent).toContain("ABCD-1234");
    expect(button("Cancel login")?.disabled).toBe(false);
    expect(button("Close")).toBeDefined();
    act(() => button("Cancel login")!.click());
    expect(cancel).toHaveBeenCalledTimes(2);
    act(() => view.root.unmount());
  });

  test.each([
    ["cancelled", "Close"],
    ["error", "Close"],
    ["ready", "Done"],
  ] as const)("a %s login offers %s, and Escape closes it", (status, close) => {
    const onClose = vi.fn();
    const { node, button, view } = dialog({ ...claude, status, onClose });
    expect(button("Cancel login")).toBeUndefined();
    act(() => button(close)!.click());
    expect(onClose).toHaveBeenCalledOnce();
    pressEscape(node);
    expect(onClose).toHaveBeenCalledTimes(2);
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

  test("shows the verification link, its URL as selectable text and the one-time code", () => {
    const { node, input, view } = dialog({ ...openAi, device: DEVICE });
    expect(node.textContent).toContain("ABCD-1234");
    expect(
      node.querySelector(`a[href="${DEVICE.verificationUri}"]`)?.textContent,
    ).toBe("Open OpenAI sign-in ");
    expect(input("OpenAI sign-in link")?.value).toBe(DEVICE.verificationUri);
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
