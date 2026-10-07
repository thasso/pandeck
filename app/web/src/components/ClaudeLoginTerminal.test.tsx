// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import { mount } from "../test/mount.tsx";
import {
  claudeLoginAuthorizationUrl,
  ClaudeLoginTerminalView,
} from "./ClaudeLoginTerminal.tsx";

const profile = {
  id: "claude-default",
  name: "Claude personal",
  provider: "claude" as const,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  status: "ready" as const,
};

describe("ClaudeLoginTerminal", () => {
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

  test("portals the login dialog and submits a code without keeping it on screen", () => {
    const submit = vi.fn(() => true);
    const onClose = vi.fn();
    const view = mount(
      <ClaudeLoginTerminalView
        profile={profile}
        status="connecting"
        output="Starting Claude login…"
        error={undefined}
        submit={submit}
        cancel={() => true}
        onClose={onClose}
      />,
    );
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Connect Claude personal");
    const input = dialog.querySelector<HTMLInputElement>(
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
      dialog
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(submit).toHaveBeenCalledWith("preview-code");
    expect(input.value).toBe("");
    expect(dialog.textContent).toContain("Code submitted; waiting for Claude…");
    act(() =>
      dialog
        .querySelector<HTMLButtonElement>('[aria-label="Close Claude login"]')!
        .click(),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("a failed login keeps its output and error in the same dialog", () => {
    mount(
      <ClaudeLoginTerminalView
        profile={profile}
        status="error"
        output="Authorization failed."
        error="The authorization code expired."
        submit={() => false}
        cancel={() => false}
        onClose={() => {}}
      />,
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Authorization failed.");
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "The authorization code expired.",
    );
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
  });
});
