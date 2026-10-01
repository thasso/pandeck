/**
 * Approved peer runtimes: the small shared vocabulary for user-owned metadata
 * and when an approved row stops being usable ([Task-595](pa://task/595)).
 */
import { expect, test } from "vitest";
import type { AccountModelOption, PeerSpawnRuntime } from "./protocol.ts";
import {
  isPeerRuntimeRelativeCost,
  peerRuntimeDisplayName,
  peerRuntimeFamilyOf,
  peerRuntimeUnavailableReason,
} from "./peerRuntimes.ts";

const option = (
  patch: Partial<AccountModelOption> = {},
): AccountModelOption => ({
  provider: "claude-sdk",
  id: "opus",
  name: "Claude Opus",
  reasoning: true,
  supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
  contextWindow: 200_000,
  credentialProfileId: "acct-1",
  accountName: "Personal Claude",
  ...patch,
});

const row = (patch: Partial<PeerSpawnRuntime> = {}): PeerSpawnRuntime => ({
  id: "pr_1",
  relativeCost: "medium",
  credentialProfileId: "acct-1",
  provider: "claude-sdk",
  modelId: "opus",
  thinkingLevel: "medium",
  enabled: true,
  ...patch,
});

test("only the declared relative-cost labels are accepted", () => {
  expect(isPeerRuntimeRelativeCost("low")).toBe(true);
  expect(isPeerRuntimeRelativeCost("medium")).toBe(true);
  expect(isPeerRuntimeRelativeCost("high")).toBe(true);
  expect(isPeerRuntimeRelativeCost("unknown")).toBe(true);
  expect(isPeerRuntimeRelativeCost("free")).toBe(false);
});

test("family is inferred only where the mapping is unambiguous", () => {
  expect(peerRuntimeFamilyOf("claude-sdk", "opus")).toBe("claude");
  expect(peerRuntimeFamilyOf("openai-codex", "gpt-5.6-terra")).toBe("gpt");
  // A model whose id says nothing about its family stays unknown, even on a
  // provider that usually serves one family.
  expect(peerRuntimeFamilyOf("openai-codex", "internal-preview")).toBe(
    "unknown",
  );
});

test("an available row has no reason", () => {
  expect(peerRuntimeUnavailableReason(row(), [option()])).toBeUndefined();
});

test.each([
  [
    "a removed account",
    row({ credentialProfileId: "gone" }),
    [option()],
    /account is disabled, removed/i,
  ],
  [
    "a withdrawn model",
    row({ modelId: "opus" }),
    [option({ id: "sonnet", name: "Claude Sonnet" })],
    /no longer offers claude-sdk\/opus/i,
  ],
  [
    "a disabled account",
    row(),
    [option({ accountDisabled: true })],
    /is disabled/i,
  ],
  [
    "an unsupported thinking level",
    row({ thinkingLevel: "max" }),
    [option()],
    /does not support max thinking/i,
  ],
  [
    "a level this build does not know",
    row({ thinkingLevel: "maximum" }),
    [option()],
    /not a thinking level this build knows/i,
  ],
  [
    "no level at all",
    row({ thinkingLevel: "" }),
    [option()],
    /records no thinking level/i,
  ],
])("%s makes a row unavailable", (_label, runtime, options, expected) => {
  expect(peerRuntimeUnavailableReason(runtime, options)).toMatch(expected);
});

test("a row without a name describes itself by model and thinking level", () => {
  expect(peerRuntimeDisplayName(row())).toBe("opus · medium thinking");
  expect(peerRuntimeDisplayName(row({ name: "Reviewer" }))).toBe("Reviewer");
});
