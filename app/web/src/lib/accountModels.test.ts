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
    enterprise: false,
    status: "ready",
  },
  {
    id: "default",
    name: "Default OpenAI",
    provider: "openai-codex",
    enabled: true,
    enterprise: false,
    status: "ready",
  },
  {
    id: "openai-work",
    name: "Work OpenAI",
    provider: "openai-codex",
    enabled: false,
    enterprise: false,
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
  it("explains a disabled or deleted pin and leaves the replacement to Automatic", () => {
    expect(
      accountPinWarning(profiles, { credentialProfileId: "openai-work" }),
    ).toBe("“Work OpenAI” is disabled — this runs on the automatic account.");
    expect(accountPinWarning(profiles, { credentialProfileId: "gone" })).toBe(
      "The pinned account no longer exists — this runs on the automatic account.",
    );
  });

  it("stays silent for an unpinned or healthy slot", () => {
    expect(accountPinWarning(profiles, {})).toBeUndefined();
    expect(
      accountPinWarning(profiles, { credentialProfileId: "default" }),
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
      },
    });
    expect(lines[0]).toContain("1 settings slot pinned to it falls back");
    expect(lines[0]).toContain("Commit agent");
    expect(lines[1]).toContain("3 existing sessions keep running on it");
    expect(lines).toHaveLength(2);
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
