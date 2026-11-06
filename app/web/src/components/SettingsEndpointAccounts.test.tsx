// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
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
  usage: {
    pinnedSlots: [
      { key: "sessionNaming", label: "Session naming", section: "naming" },
    ],
    boundSessionCount: 0,
  },
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
  confirmations: [] as Array<{ body?: string }>,
  saveError: null as string | null,
  legacyUrl: null as string | null,
}));
beforeEach(() => {
  calls.saved = [];
  calls.tested = [];
  calls.confirmations = [];
  calls.saveError = null;
  calls.legacyUrl = null;
});
vi.mock("./common/dialogs.tsx", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDialogs: () => ({
    confirm: async (options: { body?: string }) => {
      calls.confirmations.push(options);
      return false;
    },
  }),
}));
vi.mock("../lib/credentialProfiles.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchCredentialProfiles: async () => [
    login,
    calls.legacyUrl
      ? {
          ...endpoint,
          endpoint: { ...endpoint.endpoint!, baseUrl: calls.legacyUrl },
        }
      : endpoint,
  ],
  saveCredentialProfileEndpoint: async (id: string, patch: unknown) => {
    calls.saved.push({ id, patch });
    if (calls.saveError) throw new Error(calls.saveError);
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

async function mountSettings() {
  let view!: ReturnType<typeof mount>;
  await act(async () => {
    view = mount(
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
  });
  return view;
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("refuses a changed invalid URL before saving or discovering", async () => {
  const { container: root } = await mountSettings();
  await vi.waitFor(() => expect(root.textContent).toContain("Team LLM"));
  const url = root.querySelector<HTMLInputElement>(
    'input[aria-label="Base URL: Team LLM"]',
  )!;
  await enter(url, "https://user@llm.example.invalid/v1");
  await act(async () => button(root, "Save and discover models")!.click());
  expect(root.textContent).toContain("without userinfo, a query or a fragment");
  expect(calls.saved).toEqual([]);
  expect(calls.tested).toEqual([]);
});

it("allows unchanged legacy URLs, including normalized form echoes", async () => {
  calls.legacyUrl = "https://llm.example.invalid/v1?legacy=1";
  const { container: root } = await mountSettings();
  await vi.waitFor(() => expect(root.textContent).toContain("Team LLM"));
  const url = root.querySelector<HTMLInputElement>(
    'input[aria-label="Base URL: Team LLM"]',
  )!;
  await enter(url, ` ${calls.legacyUrl}/ `);
  await act(async () => button(root, "Save and discover models")!.click());
  await vi.waitFor(() => expect(calls.saved).toHaveLength(1));
  expect(calls.tested).toEqual([endpoint.id]);
});

it("submits an exact legacy key re-entry and omits blank keys", async () => {
  const { container: root } = await mountSettings();
  await vi.waitFor(() => expect(root.textContent).toContain("Team LLM"));
  const keyInput = root.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  const syntheticLegacyKey = " legacy key value ";
  await enter(keyInput, syntheticLegacyKey);
  await act(async () => button(root, "Save and discover models")!.click());
  await vi.waitFor(() => expect(calls.saved.length).toBe(1));
  const submittedKey = (calls.saved[0] as { patch: { apiKey?: string } }).patch
    .apiKey;
  expect(submittedKey === syntheticLegacyKey).toBe(true);

  await enter(keyInput, "   ");
  await act(async () => button(root, "Save and discover models")!.click());
  await vi.waitFor(() => expect(calls.saved.length).toBe(2));
  const blankPatch = (calls.saved[1] as { patch: { apiKey?: string } }).patch;
  expect(Object.hasOwn(blankPatch, "apiKey")).toBe(false);
});

it("shows key-safe server validation errors without discovery", async () => {
  calls.saveError =
    "API key must contain 1 to 8192 visible ASCII characters (0x21 to 0x7e), without spaces or control characters.";
  const { container: root } = await mountSettings();
  await vi.waitFor(() => expect(root.textContent).toContain("Team LLM"));
  await enter(
    root.querySelector<HTMLInputElement>('input[type="password"]')!,
    "fake invalid key",
  );
  await act(async () => button(root, "Save and discover models")!.click());
  await vi.waitFor(() => expect(root.textContent).toContain("visible ASCII"));
  expect(root.textContent).not.toContain("fake invalid key");
  expect(calls.tested).toEqual([]);
});

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
    await act(async () =>
      root
        .querySelector<HTMLButtonElement>('button[title="Delete profile"]')!
        .click(),
    );
    expect(calls.confirmations[0]?.body).toContain("Session naming");
    expect(calls.confirmations[0]?.body).toContain(
      "cannot automatically move to another account",
    );
    expect(calls.confirmations[0]?.body).not.toContain(
      "returns to the automatic",
    );
  } finally {
    act(() => view.root.unmount());
  }
});
