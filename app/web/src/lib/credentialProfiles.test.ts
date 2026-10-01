import { describe, expect, it } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import {
  openAiProfileConnectionAction,
  orderCredentialProfilesByProvider,
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
