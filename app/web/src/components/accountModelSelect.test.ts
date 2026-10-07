import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type {
  AccountModelOption,
  CredentialProfileSummary,
} from "@assistant/shared";
import { ModelSelect } from "./common/ModelThinkingSelect.tsx";
import { AgentModelFields } from "./AgentModelFields.tsx";
import { CredentialProfileCard } from "./SettingsPage.tsx";

const accountModels: AccountModelOption[] = [
  {
    provider: "github-copilot",
    id: "gpt-4.1",
    name: "GPT-4.1",
    reasoning: false,
    contextWindow: 128_000,
    credentialProfileId: "default",
    accountName: "Default OpenAI",
  },
  {
    provider: "github-copilot",
    id: "gpt-4.1",
    name: "GPT-4.1",
    reasoning: false,
    contextWindow: 128_000,
    credentialProfileId: "openai-work",
    accountName: "Work OpenAI",
  },
];

describe("account-aware model picker", () => {
  test("groups by account so the same model from two accounts is two choices", () => {
    const html = renderToStaticMarkup(
      createElement(ModelSelect, {
        models: accountModels,
        value: {
          provider: "github-copilot",
          id: "gpt-4.1",
          credentialProfileId: "openai-work",
        },
        variant: "field" as const,
        onChange: () => {},
      }),
    );
    // The trigger names the account, so the field reads as one combination.
    expect(html).toContain("Work OpenAI");
  });

  test("falls back to provider grouping for plain model options", () => {
    const html = renderToStaticMarkup(
      createElement(ModelSelect, {
        models: [
          {
            provider: "github-copilot",
            id: "gpt-4.1",
            name: "GPT-4.1",
            reasoning: false,
            contextWindow: 128_000,
          },
        ],
        value: { provider: "github-copilot", id: "gpt-4.1" },
        variant: "field" as const,
        onChange: () => {},
      }),
    );
    expect(html).toContain("GPT-4.1");
    expect(html).not.toContain("·");
  });

  test("shows the degraded-pin notice when the pinned account is gone", () => {
    const html = renderToStaticMarkup(
      createElement(AgentModelFields, {
        models: accountModels,
        provider: "github-copilot",
        modelId: "gpt-4.1",
        thinkingLevel: "off" as const,
        credentialProfileId: "openai-work",
        onChange: () => {},
      }),
    );
    // No profile list is provided by this context, so the pin reads as removed.
    expect(html).toContain("The pinned account no longer exists");
  });
});

describe("account page usage", () => {
  const profile = {
    id: "default",
    name: "Default OpenAI",
    provider: "openai-codex",
    enabled: true,
    status: "ready",
    usage: {
      pinnedSlots: [
        { key: "commitAgent", label: "Commit agent", section: "commit" },
      ],
      boundSessionCount: 2,
      automaticForProvider: "openai-codex",
      automaticFallback: { id: "openai-work", name: "Work OpenAI" },
    },
  } as CredentialProfileSummary;

  test("lists what depends on the account before it is disabled", () => {
    const html = renderToStaticMarkup(
      createElement(CredentialProfileCard, {
        profile,
        providerLabel: "OpenAI",
        connectionLabel: "Reconnect",
        onToggle: () => {},
        onConnect: () => {},
      }),
    );
    expect(html).toContain("Used by");
    expect(html).toContain("Commit agent");
    expect(html).toContain("2 bound sessions");
    expect(html).toContain("Automatic account for unpinned work");
    expect(html).toContain("Work OpenAI");
  });

  test("stays out of the way for an account nothing depends on", () => {
    const html = renderToStaticMarkup(
      createElement(CredentialProfileCard, {
        profile: {
          ...profile,
          usage: { pinnedSlots: [], boundSessionCount: 0 },
        },
        providerLabel: "OpenAI",
        connectionLabel: "Reconnect",
        onToggle: () => {},
        onConnect: () => {},
      }),
    );
    expect(html).not.toContain("Used by");
  });
});
