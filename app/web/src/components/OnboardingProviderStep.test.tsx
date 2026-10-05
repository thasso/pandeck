// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import { mount } from "../test/mount.tsx";
import { OnboardingProviderStep } from "./OnboardingProviderStep.tsx";

const mocks = vi.hoisted(() => ({
  profiles: [] as CredentialProfileSummary[],
  begin: vi.fn(async () => {}),
  finish: vi.fn(async (_id: string) => {}),
  create: vi.fn(
    async (_name: string, _provider: string) =>
      ({
        id: "new-claude",
        name: "Claude",
        provider: "claude",
        enabled: true,
        status: "disconnected",
      }) as CredentialProfileSummary,
  ),
  loginOpenAi: vi.fn(async (_id: string) => {}),
}));
vi.mock("../lib/onboarding.ts", () => ({
  beginOnboarding: mocks.begin,
  finishOnboarding: mocks.finish,
}));
vi.mock("../lib/credentialProfiles.ts", () => ({
  fetchCredentialProfiles: async () => mocks.profiles,
  createCredentialProfile: mocks.create,
  startOpenAiProfileLogin: mocks.loginOpenAi,
}));
vi.mock("./ClaudeLoginTerminal.tsx", () => ({
  ClaudeLoginTerminal: ({ profile }: { profile: CredentialProfileSummary }) => (
    <div role="dialog">Sign in to {profile.name}</div>
  ),
}));

const profile = (
  id: string,
  provider: "claude" | "openai-codex",
  status: CredentialProfileSummary["status"],
): CredentialProfileSummary => ({
  id,
  name: id,
  provider,
  status,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
});
const button = (root: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`No button: ${text}`);
  return found;
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.profiles = [];
});

test("offers explicit Claude and OpenAI sign-in without showing protected defaults", async () => {
  mocks.profiles = [
    profile("default", "openai-codex", "ready"),
    profile("claude-default", "claude", "ready"),
  ];
  const view = mount(<OnboardingProviderStep onComplete={() => {}} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.textContent).toContain("Sign in with Claude");
  expect(view.container.textContent).toContain("Sign in with OpenAI");
  expect(view.container.textContent).not.toContain(
    "Continue a previous sign-in",
  );
  await act(async () => {
    button(view.container, "Sign in with Claude").click();
    await Promise.resolve();
  });
  expect(mocks.begin).toHaveBeenCalledOnce();
  expect(mocks.create).toHaveBeenCalledWith(undefined, "claude");
  expect(
    view.container.querySelector('[role="dialog"]')?.textContent,
  ).toContain("Sign in to Claude");
});

test("resumes a ready named account and finishes without exposing credentials", async () => {
  mocks.profiles = [
    profile("default", "openai-codex", "ready"),
    profile("my-openai", "openai-codex", "ready"),
  ];
  const onComplete = vi.fn();
  const view = mount(<OnboardingProviderStep onComplete={onComplete} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.textContent).toContain("Continue with my-openai");
  expect(view.container.textContent).not.toContain("Continue with default");
  await act(async () => {
    button(view.container, "Continue with my-openai").click();
    await Promise.resolve();
  });
  expect(mocks.finish).toHaveBeenCalledWith("my-openai");
  expect(mocks.create).not.toHaveBeenCalled();
  expect(onComplete).toHaveBeenCalledOnce();
});
