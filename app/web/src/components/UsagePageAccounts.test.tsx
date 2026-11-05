// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import { mount } from "../test/mount.tsx";

/** An endpoint has no plan, so the Usage page never lists it (AC15). */

const account = (
  id: string,
  name: string,
  provider: CredentialProfileSummary["provider"],
): CredentialProfileSummary => ({
  id,
  name,
  provider,
  enabled: true,
  enterprise: false,
  status: "ready",
  health: { state: "unknown", since: null },
  createdAt: 0,
  updatedAt: 0,
});

vi.mock("../lib/credentialProfiles.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchCredentialProfiles: async () => [
    account("claude-default", "Claude personal", "claude"),
    account("openai-compatible", "Team LLM", "openai-compatible"),
  ],
}));
const usage = vi.hoisted(() => ({ fetched: [] as string[] }));
vi.mock("../lib/usage.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchClaudeUsage: async (profileId?: string) => {
    usage.fetched.push(`claude:${profileId}`);
    throw new Error("offline");
  },
  fetchOpenAiUsage: async (profileId?: string) => {
    usage.fetched.push(`openai:${profileId}`);
    throw new Error("offline");
  },
}));

const { UsagePage } = await import("./UsagePage.tsx");

it("lists subscription accounts only, and fetches no usage for an endpoint", async () => {
  const view = mount(<UsagePage openAiResetAutoRedeemHours={0} />);
  try {
    await vi.waitFor(() =>
      expect(view.container.textContent).toContain("Claude personal"),
    );
    expect(view.container.textContent).not.toContain("Team LLM");
    expect(usage.fetched).toEqual(["claude:claude-default"]);
  } finally {
    act(() => view.root.unmount());
  }
});
