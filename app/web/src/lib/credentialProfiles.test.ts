// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountModelOption,
  CredentialProfileSummary,
  ModelOption,
} from "@assistant/shared";
import {
  automaticModels,
  automaticPreviewHint,
  isAutomaticModelOption,
  openAiProfileConnectionAction,
  orderCredentialProfilesByProvider,
  setCredentialProfileEnterprise,
  slotModelOptions,
} from "./credentialProfiles.ts";

describe("OpenAI profile connection action", () => {
  it("keeps a reconnect action available when local credentials look ready", () => {
    expect(openAiProfileConnectionAction("ready")).toEqual({
      label: "Reconnect",
      disabled: false,
    });
  });

  it("prevents duplicate clicks only while a login is active", () => {
    expect(openAiProfileConnectionAction("connecting")).toEqual({
      label: "Connecting…",
      disabled: true,
    });
    expect(openAiProfileConnectionAction("disconnected")).toEqual({
      label: "Connect",
      disabled: false,
    });
    expect(openAiProfileConnectionAction("error")).toEqual({
      label: "Connect",
      disabled: false,
    });
  });
});

describe("credential profile provider order", () => {
  it("groups Claude before OpenAI without changing registry order within a provider", () => {
    const profiles = [
      { id: "openai-primary", provider: "openai-codex" },
      { id: "claude-default", provider: "claude" },
      { id: "openai-secondary", provider: "openai-codex" },
      { id: "claude-work", provider: "claude" },
    ] as CredentialProfileSummary[];
    expect(
      orderCredentialProfilesByProvider(profiles).map((profile) => profile.id),
    ).toEqual([
      "claude-default",
      "claude-work",
      "openai-primary",
      "openai-secondary",
    ]);
  });
});

describe("Automatic model choices", () => {
  const sonnet = {
    provider: "claude-sdk",
    id: "sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    contextWindow: 200_000,
  } satisfies ModelOption;
  const opus = { ...sonnet, id: "opus", name: "Claude Opus" };
  const gpt = {
    ...sonnet,
    provider: "openai-codex",
    id: "gpt-6",
    name: "GPT-6",
  };
  const profile = (
    id: string,
    provider: CredentialProfileSummary["provider"],
    overrides: Partial<CredentialProfileSummary> = {},
  ) =>
    ({
      id,
      name: id,
      provider,
      enabled: true,
      enterprise: false,
      ...overrides,
    }) as CredentialProfileSummary;

  it("offers each model any enabled account offers, once", () => {
    const profiles = [
      profile("openai", "openai-codex"),
      profile("personal", "claude"),
      profile("work", "claude", { enterprise: true }),
      profile("off", "claude", { enabled: false }),
    ];
    const models = automaticModels(profiles, {
      openai: [gpt],
      personal: [sonnet],
      work: [sonnet, opus],
      off: [{ ...opus, id: "only-on-disabled" }],
    });
    expect(models.map((model) => `${model.provider}:${model.id}`)).toEqual([
      "claude-sdk:sonnet",
      "claude-sdk:opus",
      "openai-codex:gpt-6",
    ]);
  });

  it("offers only enterprise accounts' models when enterprise is required", () => {
    const profiles = [
      profile("personal", "claude"),
      profile("work", "claude", { enterprise: true }),
    ];
    const modelsByProfile = { personal: [sonnet, opus], work: [sonnet] };
    expect(
      automaticModels(profiles, modelsByProfile, {
        requiresEnterprise: true,
      }).map((model) => model.id),
    ).toEqual(["sonnet"]);
    expect(
      automaticModels([profile("personal", "claude")], modelsByProfile, {
        requiresEnterprise: true,
      }),
    ).toEqual([]);
  });

  it("puts Automatic first in a settings slot and keeps every explicit account choice", () => {
    const accountModels: AccountModelOption[] = [
      { ...sonnet, credentialProfileId: "personal", accountName: "Personal" },
      { ...sonnet, credentialProfileId: "work", accountName: "Work" },
      {
        ...opus,
        credentialProfileId: "old",
        accountName: "Old",
        accountDisabled: true,
      },
    ];
    const options = slotModelOptions(accountModels);
    const automatic = options.filter(isAutomaticModelOption);
    // A disabled account is listed only to keep a stale pin visible; it does
    // not make its model an Automatic choice.
    expect(automatic.map((model) => model.id)).toEqual(["sonnet"]);
    expect(automatic[0]).not.toHaveProperty("credentialProfileId");
    expect(options.slice(automatic.length)).toEqual(accountModels);
  });
});

describe("Automatic effort levels", () => {
  const lowOnly: ModelOption = {
    provider: "claude-sdk",
    id: "sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    supportedThinkingLevels: ["off", "low"],
    contextWindow: 200_000,
  };
  const highToo: ModelOption = {
    ...lowOnly,
    supportedThinkingLevels: ["high", "low", "xhigh"],
  };
  const account = (id: string, enterprise = false) =>
    ({
      id,
      name: id,
      provider: "claude",
      enabled: true,
      enterprise,
    }) as CredentialProfileSummary;

  it("offers every effort any contributing account can run, in ladder order", () => {
    const [merged] = automaticModels([account("a"), account("b")], {
      a: [lowOnly],
      b: [highToo],
    });
    expect(merged?.supportedThinkingLevels).toEqual([
      "off",
      "low",
      "high",
      "xhigh",
    ]);
  });

  it("merges only accounts Automatic may use", () => {
    const [merged] = automaticModels(
      [account("a", true), account("b")],
      { a: [lowOnly], b: [highToo] },
      { requiresEnterprise: true },
    );
    expect(merged?.supportedThinkingLevels).toEqual(["off", "low"]);
  });

  it("merges a slot's Automatic option the same way and leaves explicit options alone", () => {
    const explicit: AccountModelOption[] = [
      { ...lowOnly, credentialProfileId: "a", accountName: "A" },
      { ...highToo, credentialProfileId: "b", accountName: "B" },
      {
        ...lowOnly,
        supportedThinkingLevels: ["max"],
        credentialProfileId: "old",
        accountName: "Old",
        accountDisabled: true,
      },
    ];
    const options = slotModelOptions(explicit);
    const automatic = options.filter(isAutomaticModelOption);
    expect(automatic).toHaveLength(1);
    expect(automatic[0]?.supportedThinkingLevels).toEqual([
      "off",
      "low",
      "high",
      "xhigh",
    ]);
    expect(options.slice(1)).toEqual(explicit);
  });
});

describe("Automatic preview hint", () => {
  const profiles = [{ id: "work", name: "Work" }] as CredentialProfileSummary[];

  it("shows the limited fallback's time and optional model", () => {
    const hint = automaticPreviewHint(
      {
        profileId: "work",
        degraded: "no-eligible-account",
        limited: { until: Date.now() + 60_000, model: "opus" },
      },
      profiles,
      "claude-sdk",
    );
    expect(hint).toMatchObject({
      warning: true,
      text: expect.stringContaining("Limited until "),
    });
    expect(hint?.text).toContain("for opus");
    expect(hint?.text).toContain("“Work”");
  });

  it("names a clean pick and flags degraded ones", () => {
    expect(
      automaticPreviewHint({ profileId: "work" }, profiles, "claude-sdk"),
    ).toEqual({
      text: "Automatic runs this on “Work” right now.",
      warning: false,
    });
    expect(
      automaticPreviewHint(
        { profileId: "work", degraded: "no-eligible-account" },
        profiles,
        "claude-sdk",
      ),
    ).toMatchObject({
      warning: true,
      text: expect.stringContaining("(login, limits or model/effort)"),
    });
    expect(
      automaticPreviewHint(
        { profileId: null, degraded: "no-enabled-account" },
        profiles,
        "claude-sdk",
      )?.text,
    ).toBe("No enabled Claude account.");
    expect(
      automaticPreviewHint(
        { profileId: null, degraded: "no-enterprise-account" },
        profiles,
        "openai-codex",
      )?.text,
    ).toBe("No enabled enterprise OpenAI account.");
  });
});

describe("enterprise flag", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("patches only the enterprise flag of the account", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ profile: { id: "work", enterprise: true } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const profile = await setCredentialProfileEnterprise("work", true);
    expect(profile.enterprise).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(/\/api\/credential-profiles\/work$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ enterprise: true });
  });
});
