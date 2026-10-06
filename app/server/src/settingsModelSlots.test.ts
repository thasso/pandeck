import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SDK_PROVIDER } from "@assistant/shared";

// Settings and the profile registry both resolve DATA_DIR at import time.
const tmp = mkdtempSync(join(tmpdir(), "settings-model-slots-test-"));
process.env.HOME = join(tmp, "home");
process.env.DATA_DIR = join(tmp, "data");

const { createCredentialProfile, setCredentialProfileEnabled } =
  await import("./credentialProfiles.ts");
const { getSettings, updateSettings } = await import("./settings.ts");
const {
  accountForSlot,
  listSettingsModelSlots,
  pinnedSlotsForProfile,
  resolveSlotAccount,
} = await import("./settingsModelSlots.ts");
const { clearProfilePins, credentialProfileUsage } =
  await import("./credentialProfileUsage.ts");

const dataDir = process.env.DATA_DIR;
let primaryOpenAiId: string;
let primaryClaudeId: string;

beforeEach(() => {
  rmSync(join(dataDir, "credential-profiles"), {
    recursive: true,
    force: true,
  });
  rmSync(join(dataDir, "settings"), { recursive: true, force: true });
  primaryOpenAiId = createCredentialProfile({ provider: "openai-codex" }).id;
  primaryClaudeId = createCredentialProfile({ provider: "claude" }).id;
});

/** Every `{ provider, modelId }` object reachable in the settings tree. */
function walkModelSlots(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) walkModelSlots(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  if (typeof record.provider === "string" && typeof record.modelId === "string")
    out.push(record);
  for (const item of Object.values(record)) walkModelSlots(item, out);
  return out;
}

test("the slot registry covers every configured model slot in settings", () => {
  const settings = getSettings();
  const enumerated = new Set(
    listSettingsModelSlots(settings).map((ref) => ref.slot),
  );
  const found = walkModelSlots(settings);
  assert.ok(found.length > 0, "settings carry model slots");
  const missing = found.filter((slot) => !enumerated.has(slot as never));
  assert.deepEqual(
    missing,
    [],
    "a settings block with provider/modelId has no slot descriptor — add one to listSettingsModelSlots",
  );
  assert.equal(
    enumerated.size,
    found.length,
    "no descriptor points at a non-slot object",
  );
  // Each descriptor must be addressable in the UI.
  for (const ref of listSettingsModelSlots(settings)) {
    assert.ok(
      ref.key && ref.label && ref.section,
      `slot ${ref.key} is fully described`,
    );
  }
});

test("an unpinned slot follows the automatic account for its provider", () => {
  const openai = accountForSlot({
    provider: "github-copilot",
    modelId: "gpt-4.1",
  });
  const claude = accountForSlot({
    provider: CLAUDE_SDK_PROVIDER,
    modelId: "sonnet",
  });
  assert.equal(openai, primaryOpenAiId);
  assert.equal(claude, primaryClaudeId);

  // Automatic selection follows the first ENABLED account of that provider.
  const second = createCredentialProfile({
    name: "Second OpenAI",
    provider: "openai-codex",
  });
  setCredentialProfileEnabled(primaryOpenAiId, false);
  assert.equal(
    accountForSlot({ provider: "github-copilot", modelId: "gpt-4.1" }),
    second.id,
  );
  setCredentialProfileEnabled(primaryOpenAiId, true);
});

test("a pinned account is used, and degrades to automatic when it cannot be", () => {
  const second = createCredentialProfile({
    name: "Second OpenAI",
    provider: "openai-codex",
  });
  const pinned = {
    provider: "github-copilot",
    modelId: "gpt-4.1",
    credentialProfileId: second.id,
  };

  assert.deepEqual(resolveSlotAccount(pinned), { profileId: second.id });

  setCredentialProfileEnabled(second.id, false);
  assert.deepEqual(resolveSlotAccount(pinned), {
    profileId: primaryOpenAiId,
    degraded: "disabled",
    pinnedProfileId: second.id,
  });

  assert.deepEqual(
    resolveSlotAccount({
      provider: "github-copilot",
      modelId: "gpt-4.1",
      credentialProfileId: "cp_gone",
    }),
    {
      profileId: primaryOpenAiId,
      degraded: "missing",
      pinnedProfileId: "cp_gone",
    },
  );
  // A Claude account cannot run a pi model (or the reverse).
  assert.deepEqual(
    resolveSlotAccount({
      provider: "github-copilot",
      modelId: "gpt-4.1",
      credentialProfileId: primaryClaudeId,
    }),
    {
      profileId: primaryOpenAiId,
      degraded: "provider-mismatch",
      pinnedProfileId: primaryClaudeId,
    },
  );
});

test("only valid pins are persisted", () => {
  const claude = createCredentialProfile({
    name: "Claude work",
    provider: "claude",
  });

  const saved = updateSettings({
    commitAgent: {
      provider: CLAUDE_SDK_PROVIDER,
      modelId: "sonnet",
      thinkingLevel: "off",
      credentialProfileId: claude.id,
    },
    sessionNaming: {
      enabled: true,
      provider: "github-copilot",
      modelId: "gpt-4.1",
      thinkingLevel: "off",
      credentialProfileId: "cp_unknown",
    },
    promptRefinement: {
      provider: "github-copilot",
      modelId: "gpt-4.1",
      thinkingLevel: "off",
      credentialProfileId: claude.id,
    },
  });

  assert.equal(
    saved.commitAgent.credentialProfileId,
    claude.id,
    "a valid pin is kept",
  );
  assert.equal(
    saved.sessionNaming.credentialProfileId,
    undefined,
    "an unknown account is dropped",
  );
  assert.equal(
    saved.promptRefinement.credentialProfileId,
    undefined,
    "a cross-provider pin is dropped",
  );
});

test("account usage reports pinned slots, and deleting an account clears them", async () => {
  const openai = createCredentialProfile({
    name: "Second OpenAI",
    provider: "openai-codex",
  });
  updateSettings({
    commitAgent: {
      provider: "github-copilot",
      modelId: "gpt-4.1",
      thinkingLevel: "off",
      credentialProfileId: openai.id,
    },
    worktrees: {
      ...getSettings().worktrees,
      namingAgent: {
        provider: "github-copilot",
        modelId: "gpt-4.1",
        thinkingLevel: "off",
        credentialProfileId: openai.id,
      },
    },
  });

  assert.deepEqual(
    pinnedSlotsForProfile(getSettings(), openai.id)
      .map((slot) => slot.key)
      .sort(),
    ["commitAgent", "worktrees.namingAgent"],
  );

  const usage = credentialProfileUsage({
    id: openai.id,
    provider: "openai-codex",
  });
  assert.equal(usage.pinnedSlots.length, 2);
  assert.equal(
    usage.automaticForProvider,
    undefined,
    "the first managed account is still automatic",
  );
  assert.equal(usage.boundSessionCount, 0);

  const primaryUsage = credentialProfileUsage({
    id: primaryOpenAiId,
    provider: "openai-codex",
  });
  assert.equal(primaryUsage.automaticForProvider, "openai-codex");
  assert.equal(
    primaryUsage.automaticFallback?.id,
    openai.id,
    "disabling the first account moves unpinned work to the next enabled account",
  );

  const cleared = await clearProfilePins(openai.id);
  assert.deepEqual(cleared.map((slot) => slot.key).sort(), [
    "commitAgent",
    "worktrees.namingAgent",
  ]);
  assert.equal(getSettings().commitAgent.credentialProfileId, undefined);
  assert.equal(
    getSettings().worktrees.namingAgent.credentialProfileId,
    undefined,
  );
});
