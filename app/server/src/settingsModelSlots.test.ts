import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { pickAccount } from "./accountRouter.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountProviderForModelProvider,
  CLAUDE_SDK_PROVIDER,
} from "@assistant/shared";

// Settings and the profile registry both resolve DATA_DIR at import time.
const tmp = mkdtempSync(join(tmpdir(), "settings-model-slots-test-"));
process.env.HOME = join(tmp, "home");
process.env.DATA_DIR = join(tmp, "data");

vi.mock("./accountRouter.ts", () => ({ pickAccount: vi.fn() }));

const {
  credentialProfileSummaryById,
  createCredentialProfile,
  patchCredentialProfile,
  ensureDefaultPiProfile,
  setCredentialProfileEnabled,
} = await import("./credentialProfiles.ts");
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

beforeEach(() => {
  vi.mocked(pickAccount).mockReset();
  vi.mocked(pickAccount).mockImplementation(async ({ model }) => ({
    profileId:
      model.provider === CLAUDE_SDK_PROVIDER ? "claude-default" : "default",
  }));
  rmSync(join(dataDir, "credential-profiles"), {
    recursive: true,
    force: true,
  });
  rmSync(join(dataDir, "settings"), { recursive: true, force: true });
  ensureDefaultPiProfile();
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

test("an unpinned slot delegates model and effort to the router", async () => {
  const openai = await accountForSlot({
    provider: "github-copilot",
    modelId: "gpt-4.1",
  });
  const claude = await accountForSlot({
    provider: CLAUDE_SDK_PROVIDER,
    modelId: "sonnet",
  });
  assert.equal(openai, "default");
  assert.equal(claude, "claude-default");

  // The router can select a different account per run, not registry order.
  const second = createCredentialProfile({
    name: "Second OpenAI",
    provider: "openai-codex",
  });
  vi.mocked(pickAccount).mockResolvedValueOnce({ profileId: second.id });
  assert.equal(
    await accountForSlot({
      provider: "github-copilot",
      modelId: "gpt-4.1",
      thinkingLevel: "low",
    }),
    second.id,
  );
  assert.deepEqual(vi.mocked(pickAccount).mock.calls.at(-1)?.[0], {
    model: { provider: "github-copilot", modelId: "gpt-4.1" },
    thinkingLevel: "low",
    requiresEnterprise: false,
    allowDisabledDefault: true,
  });
});

test("a pinned account is used, and degrades to automatic when it cannot be", async () => {
  const second = createCredentialProfile({
    name: "Second OpenAI",
    provider: "openai-codex",
  });
  const pinned = {
    provider: "github-copilot",
    modelId: "gpt-4.1",
    credentialProfileId: second.id,
  };

  assert.deepEqual(await resolveSlotAccount(pinned), { profileId: second.id });
  assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);

  setCredentialProfileEnabled(second.id, false);
  assert.deepEqual(await resolveSlotAccount(pinned), {
    profileId: "default",
    degraded: "disabled",
    pinnedProfileId: second.id,
  });

  assert.deepEqual(
    await resolveSlotAccount({
      provider: "github-copilot",
      modelId: "gpt-4.1",
      credentialProfileId: "cp_gone",
    }),
    { profileId: "default", degraded: "missing", pinnedProfileId: "cp_gone" },
  );
  // A Claude account cannot run a pi model (or the reverse).
  assert.deepEqual(
    await resolveSlotAccount({
      provider: "github-copilot",
      modelId: "gpt-4.1",
      credentialProfileId: "claude-default",
    }),
    {
      profileId: "default",
      degraded: "provider-mismatch",
      pinnedProfileId: "claude-default",
    },
  );
});

test("an enabled matching needs-login pin remains explicit instead of spending another account", async () => {
  const pinned = createCredentialProfile({ name: "Work", provider: "claude" });
  assert.equal(
    credentialProfileSummaryById(pinned.id)?.health.state,
    "needs-login",
  );
  assert.deepEqual(
    await resolveSlotAccount({
      provider: CLAUDE_SDK_PROVIDER,
      modelId: "sonnet",
      thinkingLevel: "high",
      credentialProfileId: pinned.id,
    }),
    { profileId: pinned.id },
  );
  assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
});

test("background slots retain disabled-default degradation and refuse an empty scope", async () => {
  vi.mocked(pickAccount).mockResolvedValueOnce({
    profileId: "default",
    degraded: "disabled-default",
  });
  assert.deepEqual(
    await resolveSlotAccount({ provider: "openai-codex", modelId: "gpt-test" }),
    {
      profileId: "default",
      degraded: "disabled-default",
    },
  );
  vi.mocked(pickAccount).mockResolvedValueOnce({
    profileId: null,
    degraded: "no-enabled-account",
  });
  await assert.rejects(
    accountForSlot({ provider: "openai-codex", modelId: "gpt-test" }),
    /No account/,
  );
});

test("enterprise helpers refuse personal explicit pins without automatic substitution", async () => {
  const personal = createCredentialProfile({
    name: "Personal",
    provider: "claude",
  });
  await assert.rejects(
    resolveSlotAccount({
      provider: CLAUDE_SDK_PROVIDER,
      modelId: "sonnet",
      credentialProfileId: personal.id,
      requiresEnterprise: true,
    }),
    /explicit account pin is personal/,
  );
  assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
});

test("enterprise Automatic refuses exhausted eligibility and disabled defaults", async () => {
  for (const degraded of [
    "no-eligible-account",
    "disabled-default",
    "no-enterprise-account",
  ] as const) {
    vi.mocked(pickAccount).mockResolvedValueOnce({
      profileId: "claude-default",
      degraded,
    });
    await assert.rejects(
      resolveSlotAccount({
        provider: CLAUDE_SDK_PROVIDER,
        modelId: "sonnet",
        requiresEnterprise: true,
      }),
      /requires an eligible enterprise account/,
    );
    assert.deepEqual(vi.mocked(pickAccount).mock.calls.at(-1)?.[0], {
      model: { provider: CLAUDE_SDK_PROVIDER, modelId: "sonnet" },
      requiresEnterprise: true,
      allowDisabledDefault: false,
    });
  }
});

test("an explicit enterprise needs-login pin remains explicit", async () => {
  const enterprise = createCredentialProfile({
    name: "Work",
    provider: "claude",
  });
  patchCredentialProfile(enterprise.id, { enterprise: true });
  assert.deepEqual(
    await resolveSlotAccount({
      provider: CLAUDE_SDK_PROVIDER,
      modelId: "sonnet",
      credentialProfileId: enterprise.id,
      requiresEnterprise: true,
    }),
    { profileId: enterprise.id },
  );
  assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
});

test("existing slot pins survive reads and unrelated writes until saved as Automatic", () => {
  const claude = createCredentialProfile({ name: "Work", provider: "claude" });
  const openai = createCredentialProfile({
    name: "Work",
    provider: "openai-codex",
  });
  const pinned = getSettings();
  for (const { slot } of listSettingsModelSlots(pinned))
    slot.credentialProfileId =
      accountProviderForModelProvider(slot.provider) === "claude"
        ? claude.id
        : openai.id;
  updateSettings(pinned);
  updateSettings({
    accountRouting: {
      fiveHourUsedThreshold: 85,
      weeklyUsedThreshold: 90,
      openAiResetAutoRedeemHours: 6,
    },
  });

  const retained = getSettings();
  const expected = listSettingsModelSlots(pinned);
  for (const { key, slot } of listSettingsModelSlots(retained))
    assert.deepEqual(slot, expected.find((ref) => ref.key === key)!.slot, key);

  const automatic = structuredClone(retained);
  for (const { slot } of listSettingsModelSlots(automatic))
    delete slot.credentialProfileId;
  const saved = updateSettings(automatic);
  for (const settings of [saved, getSettings()])
    for (const { key, slot } of listSettingsModelSlots(settings)) {
      assert.equal(Object.hasOwn(slot, "credentialProfileId"), false, key);
      const { credentialProfileId: _pin, ...before } = expected.find(
        (ref) => ref.key === key,
      )!.slot;
      assert.deepEqual(slot, before, key);
    }
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
  assert.equal(usage.boundSessionCount, 0);

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
