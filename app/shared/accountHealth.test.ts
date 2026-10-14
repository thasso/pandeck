import { expect, it } from "vitest";
import type { CredentialProfileSummary } from "./protocol.ts";
import {
  accountLoginAlerts,
  accountSettingsPath,
  isSubscriptionAccountModel,
} from "./accountHealth.ts";

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
      profile("a"),
    ]),
  ).toEqual([
    { profileId: "a", name: "a", provider: "claude" },
    { profileId: "z", name: "z", provider: "claude" },
  ]);
  expect(accountSettingsPath("claude")).toBe("/settings/claude-sdk");
  expect(accountSettingsPath("openai-codex")).toBe("/settings/openai");
});
