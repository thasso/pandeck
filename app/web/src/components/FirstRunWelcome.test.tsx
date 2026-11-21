// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import { firstAccountSteps } from "../lib/firstRun.ts";
import { stubMatchMedia } from "../test/matchMedia.ts";
import { mount } from "../test/mount.tsx";
import { FirstRunWelcome } from "./FirstRunWelcome.tsx";

stubMatchMedia();

const pendingClaude: CredentialProfileSummary = {
  id: "cp_claude",
  name: "Claude",
  provider: "claude",
  enabled: true,
  enterprise: false,
  status: "connecting",
  health: { state: "unknown", since: null },
  createdAt: 1,
  updatedAt: 1,
};

describe("FirstRunWelcome", () => {
  it("greets as an assistant message and offers every first account kind", () => {
    const onStep = vi.fn();
    const { container } = mount(
      <FirstRunWelcome
        assistantName="Larry"
        steps={firstAccountSteps([], {})}
        busyKind={null}
        error={null}
        onStep={onStep}
      />,
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "Welcome to Pandeck",
    );
    const greeting = container.querySelector('[data-role="assistant"]');
    expect(greeting?.textContent).toContain("I’m Larry,");
    expect(container.querySelector("h2")?.textContent).toBe(
      "Connect your first AI account",
    );
    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "Sign in: Claude",
      "Sign in: OpenAI",
      "Set up: OpenAI-compatible endpoint",
    ]);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Sign in: OpenAI"]')
        ?.click(),
    );
    expect(onStep).toHaveBeenCalledWith({
      kind: "openai-codex",
      action: "create",
    });
  });

  it("continues an earlier account, and holds the other rows while one runs", () => {
    const { container } = mount(
      <FirstRunWelcome
        assistantName="Ada"
        steps={firstAccountSteps([pendingClaude], {})}
        busyKind="claude"
        error="The account could not be created."
        onStep={() => {}}
      />,
    );
    expect(container.textContent).toContain("I’m Ada,");
    expect(container.textContent).toContain(
      "“Claude” is still waiting for its sign-in.",
    );
    const claude = container.querySelector<HTMLButtonElement>(
      '[aria-label="Continue sign-in: Claude"]',
    );
    expect(claude?.getAttribute("aria-busy")).toBe("true");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Sign in: OpenAI"]',
      )?.disabled,
    ).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The account could not be created.",
    );
  });
});
