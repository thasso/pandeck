// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import { mount } from "../test/mount.tsx";
import { settingsFixture } from "../../component-preview/fixtures/settings.ts";

/** Settings → OpenAI-compatible: one account card per endpoint (AC13). */

const llama = {
  id: "llama3",
  name: "Llama 3",
  input: ["text" as const],
  contextWindow: 128_000,
  maxTokens: 8192,
  reasoning: false,
};
const endpoint: CredentialProfileSummary = {
  id: "openai-compatible",
  name: "Team LLM",
  provider: "openai-compatible",
  enabled: true,
  enterprise: false,
  status: "ready",
  health: { state: "unknown", since: null },
  createdAt: 0,
  updatedAt: 0,
  endpoint: {
    baseUrl: "https://llm.example.invalid/v1",
    apiKeyConfigured: true,
    thinkingFormat: "none",
    models: [llama],
  },
};
const login: CredentialProfileSummary = {
  ...endpoint,
  id: "default",
  name: "Default OpenAI",
  provider: "openai-codex",
  endpoint: undefined,
} as unknown as CredentialProfileSummary;

const calls = vi.hoisted(() => ({
  saved: [] as unknown[],
  tested: [] as string[],
}));
vi.mock("../lib/credentialProfiles.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchCredentialProfiles: async () => [login, endpoint],
  saveCredentialProfileEndpoint: async (id: string, patch: unknown) => {
    calls.saved.push({ id, patch });
    return endpoint;
  },
  testCredentialProfileEndpoint: async (id: string) => {
    calls.tested.push(id);
    return {
      status: {
        ok: true,
        checkedAt: 1,
        message: "Found 1 model.",
        models: [llama],
      },
      profile: endpoint,
    };
  },
}));

const { SettingsPage } = await import("./SettingsPage.tsx");

const button = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );

it("lists each endpoint as an account card with its URL, key, models and Test", async () => {
  const view = mount(
    <SettingsPage
      {...({
        section: "openai-compatible",
        models: [],
        accountModels: [],
        credentialProfiles: [],
        projects: [],
        settings: settingsFixture,
        onUpdate: () => {},
      } as unknown as Parameters<typeof SettingsPage>[0])}
    />,
  );
  try {
    const root = view.container;
    await vi.waitFor(() => expect(root.textContent).toContain("Team LLM"));
    // Endpoint accounts only, added by name.
    expect(root.textContent).not.toContain("Default OpenAI");
    expect(button(root, "Add endpoint")).toBeTruthy();
    expect(
      root.querySelector('input[aria-label="Endpoint name"]'),
    ).toBeTruthy();
    // The card's own fields; the saved key is never echoed back.
    const url = root.querySelector<HTMLInputElement>(
      'input[aria-label="Base URL: Team LLM"]',
    );
    expect(url?.value).toBe("https://llm.example.invalid/v1");
    for (const input of root.querySelectorAll<HTMLInputElement>(
      'input[type="password"]',
    ))
      expect(input.value).toBe("");
    expect(button(root, "Remove key")).toBeTruthy();
    expect(root.textContent).toContain("Llama 3");
    expect(root.textContent).toContain("No plan limits");

    await act(async () => button(root, "Test")!.click());
    await vi.waitFor(() => expect(calls.tested).toEqual([endpoint.id]));
    await act(async () => button(root, "Save and discover models")!.click());
    await vi.waitFor(() =>
      expect(calls.saved).toEqual([
        {
          id: endpoint.id,
          patch: {
            baseUrl: "https://llm.example.invalid/v1",
            thinkingFormat: "none",
          },
        },
      ]),
    );
    expect(calls.tested).toEqual([endpoint.id, endpoint.id]);
  } finally {
    act(() => view.root.unmount());
  }
});
