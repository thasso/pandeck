import { describe, expect, it } from "vitest";
import type { CredentialProfileSummary, ModelOption } from "@assistant/shared";
import {
  credentialProfileProjectionBlockReason,
  credentialProfileProjectionBlocksSend,
} from "./credentialProfileProjection.ts";
import { failed, loading, ready } from "./loadState.ts";
import type { CredentialProfileProjection } from "./credentialProfiles.ts";

const profile: CredentialProfileSummary = {
  id: "claude-work",
  name: "Claude work",
  provider: "claude",
  enabled: true,
  status: "ready",
  health: { state: "unknown", since: null },
  createdAt: 1,
  updatedAt: 1,
};
const model: ModelOption = {
  provider: "claude-sdk",
  id: "sonnet",
  name: "Claude Sonnet",
  reasoning: true,
  supportedThinkingLevels: ["low"],
  contextWindow: 200_000,
};

function projection(
  models: ModelOption[] = [model],
): CredentialProfileProjection {
  return { profiles: [profile], modelsByProfile: { [profile.id]: models } };
}

describe("credential profile projection admission", () => {
  it("blocks quietly until data exists because the quick start owns narration", () => {
    expect(credentialProfileProjectionBlocksSend(loading())).toBe(true);
    expect(
      credentialProfileProjectionBlocksSend(failed("network failed")),
    ).toBe(true);
    expect(
      credentialProfileProjectionBlockReason(loading(), profile.id, undefined),
    ).toBeUndefined();
  });

  it("allows retained cache data after a refresh failure", () => {
    const load = failed("network failed", projection());
    expect(credentialProfileProjectionBlocksSend(load)).toBe(false);
    expect(
      credentialProfileProjectionBlockReason(load, profile.id, [model], model),
    ).toBeUndefined();
  });

  it("requires the selected profile and a non-empty authoritative model projection", () => {
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        "missing",
        undefined,
      ),
    ).toMatch(/select/i);
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection([])),
        profile.id,
        [],
      ),
    ).toMatch(/no visible models/i);
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        profile.id,
        [model],
        model,
      ),
    ).toBeUndefined();
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        profile.id,
        [model],
        { provider: "openai-codex", id: "other" },
      ),
    ).toMatch(/select a model/i);
  });

  it("leaves a staged agent's model to the server, hidden from the pickers or not", () => {
    const hidden = { provider: "claude-sdk", id: "haiku" };
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        profile.id,
        [model],
        hidden,
        true,
      ),
    ).toBeUndefined();
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection([])),
        profile.id,
        [],
        hidden,
        true,
      ),
    ).toBeUndefined();
    // The account is still the draft's to pick.
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        "missing",
        [model],
        hidden,
        true,
      ),
    ).toMatch(/select a credential profile/i);
  });
});
