import { describe, expect, it } from "vitest";
import type { CredentialProfileSummary, ModelOption } from "@assistant/shared";
import {
  accountModelOptions,
  accountPinWarning,
  disableAccountImpact,
} from "./credentialProfiles.ts";

const profiles = [
  {
    id: "claude-default",
    name: "Default Claude",
    provider: "claude",
    enabled: true,
    status: "ready",
  },
  {
    id: "default",
    name: "Default OpenAI",
    provider: "openai-codex",
    enabled: true,
    status: "ready",
  },
  {
    id: "openai-work",
    name: "Work OpenAI",
    provider: "openai-codex",
    enabled: false,
    status: "ready",
  },
] as CredentialProfileSummary[];

const model = (provider: string, id: string): ModelOption => ({
  provider,
  id,
  name: id,
  reasoning: false,
  contextWindow: 1000,
});
const modelsByProfile = {
  "claude-default": [model("claude-sdk", "sonnet")],
  default: [model("github-copilot", "gpt-4.1")],
  "openai-work": [model("github-copilot", "gpt-4.1")],
};

describe("settings account/model combinations", () => {
  it("offers each enabled account's models, Claude first, tagged with the owning account", () => {
    expect(
      accountModelOptions(profiles, modelsByProfile).map(
        (m) => `${m.credentialProfileId}/${m.id}`,
      ),
    ).toEqual(["claude-default/sonnet", "default/gpt-4.1"]);
    expect(accountModelOptions(profiles, modelsByProfile)[0]?.accountName).toBe(
      "Default Claude",
    );
  });

  it("keeps a disabled account visible only while a slot still pins it", () => {
    const pinned = accountModelOptions(
      profiles,
      modelsByProfile,
      "openai-work",
    );
    const disabled = pinned.find(
      (m) => m.credentialProfileId === "openai-work",
    );
    expect(disabled?.accountDisabled).toBe(true);
    expect(
      accountModelOptions(profiles, modelsByProfile).some(
        (m) => m.credentialProfileId === "openai-work",
      ),
    ).toBe(false);
  });

  it("skips an account with no projected models rather than offering an empty group", () => {
    expect(accountModelOptions(profiles, { default: [] })).toEqual([]);
  });
});

describe("degraded account pins", () => {
  it("explains a disabled or deleted pin and names the account that runs instead", () => {
    expect(
      accountPinWarning(profiles, {
        provider: "github-copilot",
        credentialProfileId: "openai-work",
      }),
    ).toBe("“Work OpenAI” is disabled — this runs on “Default OpenAI”.");
    expect(
      accountPinWarning(profiles, {
        provider: "claude-sdk",
        credentialProfileId: "gone",
      }),
    ).toBe(
      "The pinned account no longer exists — this runs on “Default Claude”.",
    );
  });

  it("stays silent for an unpinned or healthy slot", () => {
    expect(
      accountPinWarning(profiles, { provider: "github-copilot" }),
    ).toBeUndefined();
    expect(
      accountPinWarning(profiles, {
        provider: "github-copilot",
        credentialProfileId: "default",
      }),
    ).toBeUndefined();
  });
});

describe("disable impact", () => {
  it("separates what moves from what keeps running", () => {
    const lines = disableAccountImpact({
      ...profiles[1]!,
      usage: {
        pinnedSlots: [
          { key: "commitAgent", label: "Commit agent", section: "commit" },
        ],
        boundSessionCount: 3,
        automaticForProvider: "openai-codex",
        automaticFallback: { id: "openai-work", name: "Work OpenAI" },
      },
    });
    expect(lines[0]).toContain("1 settings slot pinned to it falls back");
    expect(lines[0]).toContain("Commit agent");
    expect(lines[1]).toContain("moves to “Work OpenAI”");
    expect(lines[2]).toContain("3 existing sessions keep running on it");
  });

  it("reports nothing when disabling changes nothing", () => {
    expect(
      disableAccountImpact({
        ...profiles[2]!,
        usage: { pinnedSlots: [], boundSessionCount: 0 },
      }),
    ).toEqual([]);
    expect(disableAccountImpact(profiles[2]!)).toEqual([]);
  });
});
