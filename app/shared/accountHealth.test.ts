import { expect, it } from "vitest";
import type { CredentialProfileSummary } from "./protocol.ts";
import {
  accountLoginAlerts,
  accountLimitMatches,
  accountLimitModel,
  accountSettingsPath,
  isSubscriptionAccountModel,
} from "./accountHealth.ts";

it.each([
  ["Mythos", "claude-mythos-1", true],
  ["Claude Mythos", "claude-mythos-1", true],
  ["Opus", "claude-opus-5-5", true],
  ["Codex Spark", "gpt-5-3-codex-spark", true],
  ["mythos-1", "claude-mythos-2", false],
  ["opus", "claude-sonnet-5-5", false],
  ["son", "claude-sonnet-5-5", false],
  ["5", "claude-opus-5-5", false],
  ["5.5", "claude-opus-5-5", false],
  ["Claude 5.5", "claude-opus-5-5", false],
] as const)(
  "cap %s matches model %s by word subset: %s",
  (cap, model, expected) => {
    expect(accountLimitMatches(cap, model)).toBe(expected);
  },
);

it.each(["5", "5.5", "5-5", "Claude 5.5", "OpenAI 5"])(
  "rejects a numeric-only cap after normalization: %s",
  (cap) => expect(accountLimitModel(cap)).toBeUndefined(),
);

it("attributes only each account's own subscription model provider", () => {
  expect(isSubscriptionAccountModel("claude", "claude-sdk")).toBe(true);
  expect(isSubscriptionAccountModel("openai-codex", "openai-codex")).toBe(true);
  for (const provider of [
    "github-copilot",
    "openai-compatible",
    "anthropic",
    undefined,
  ]) {
    expect(isSubscriptionAccountModel("openai-codex", provider)).toBe(false);
    expect(isSubscriptionAccountModel("claude", provider)).toBe(false);
  }
});

it("projects only enabled dead logins in stable id order without setup or reasons", () => {
  const profile = (
    id: string,
    enabled = true,
    state: CredentialProfileSummary["health"]["state"] = "needs-login",
  ): CredentialProfileSummary => ({
    id,
    name: id,
    provider: "claude",
    enabled,
    enterprise: false,
    createdAt: 1,
    updatedAt: 1,
    status: "ready",
    health: { state, since: 1, reason: "safe reason" },
    error: "not part of the alert",
  });
  expect(
    accountLoginAlerts([
      profile("z"),
      profile("b", false),
      profile("c", true, "unknown"),
      profile("d", true, "ok"),
      profile("limited", true, "limited"),
      profile("a"),
    ]),
  ).toEqual([
    { profileId: "a", name: "a", provider: "claude" },
    { profileId: "z", name: "z", provider: "claude" },
  ]);
  expect(accountSettingsPath("claude")).toBe("/settings/claude-sdk");
  expect(accountSettingsPath("openai-codex")).toBe("/settings/openai");
});
