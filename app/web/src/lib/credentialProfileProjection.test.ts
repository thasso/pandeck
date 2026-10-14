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
  enterprise: false,
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
  profiles: CredentialProfileSummary[] = [profile],
): CredentialProfileProjection {
  return {
    profiles,
    modelsByProfile: Object.fromEntries(profiles.map((p) => [p.id, models])),
  };
}

const explicit = (profileId: string) => ({
  profileId,
  requiresEnterprise: false,
});
const automatic = { profileId: null, requiresEnterprise: false };

describe("credential profile projection admission", () => {
  it("blocks quietly until data exists because the quick start owns narration", () => {
    expect(credentialProfileProjectionBlocksSend(loading())).toBe(true);
    expect(
      credentialProfileProjectionBlocksSend(failed("network failed")),
    ).toBe(true);
    expect(
      credentialProfileProjectionBlockReason(
        loading(),
        explicit(profile.id),
        undefined,
      ),
    ).toBeUndefined();
  });

  it("allows retained cache data after a refresh failure", () => {
    const load = failed("network failed", projection());
    expect(credentialProfileProjectionBlocksSend(load)).toBe(false);
    expect(
      credentialProfileProjectionBlockReason(
        load,
        explicit(profile.id),
        [model],
        model,
      ),
    ).toBeUndefined();
  });

  it("requires the selected profile and a non-empty authoritative model projection", () => {
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        explicit("missing"),
        undefined,
      ),
    ).toMatch(/no longer exists.*choose another account or automatic/i);
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection([])),
        explicit(profile.id),
        [],
      ),
    ).toMatch(/no visible models/i);
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        explicit(profile.id),
        [model],
        model,
      ),
    ).toBeUndefined();
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        explicit(profile.id),
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
        explicit(profile.id),
        [model],
        hidden,
        true,
      ),
    ).toBeUndefined();
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection([])),
        explicit(profile.id),
        [],
        hidden,
        true,
      ),
    ).toBeUndefined();
    // The account is still the draft's to pick.
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        explicit("missing"),
        [model],
        hidden,
        true,
      ),
    ).toMatch(/no longer exists/i);
  });

  it("lets Automatic start with no account picked while any account is enabled", () => {
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        automatic,
        [model],
        model,
      ),
    ).toBeUndefined();
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection([model], [{ ...profile, enabled: false }])),
        automatic,
        [],
      ),
    ).toMatch(/no provider account is enabled/i);
  });

  it("never lets a session that requires enterprise start without an enterprise account", () => {
    const required = { profileId: null, requiresEnterprise: true };
    // A regular account is enabled and offers the model, but it cannot run an
    // enterprise-only session: the send is blocked with a reason, not rerouted.
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        required,
        [model],
        model,
      ),
    ).toMatch(/no enabled account is marked enterprise/i);
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection()),
        { profileId: profile.id, requiresEnterprise: true },
        [model],
        model,
      ),
    ).toMatch(/no enabled account is marked enterprise/i);
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection([model], [{ ...profile, enterprise: true }])),
        required,
        [model],
        model,
      ),
    ).toBeUndefined();
  });

  it("refuses an explicit pick that stopped being usable instead of swapping it", () => {
    const work = { ...profile, id: "work", name: "Work", enterprise: true };
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection([model], [{ ...profile, enabled: false }, work])),
        explicit(profile.id),
        [model],
        model,
      ),
    ).toBe("“Claude work” is disabled. Choose another account or Automatic.");
    expect(
      credentialProfileProjectionBlockReason(
        ready(projection([model], [profile, work])),
        { profileId: profile.id, requiresEnterprise: true },
        [model],
        model,
      ),
    ).toBe(
      "“Claude work” is not an enterprise account. Choose an enterprise account or Automatic.",
    );
  });
});
