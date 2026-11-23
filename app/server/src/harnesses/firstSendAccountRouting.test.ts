import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test, vi } from "vitest";
import type { Harness } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "first-send-account-router-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
vi.mock("../accountRouter.ts", () => ({ pickAccount: vi.fn() }));
const { pickAccount } = await import("../accountRouter.ts");
const { firstSendEngine } = await import("./firstSend.ts");
const {
  createCredentialProfile,
  patchCredentialProfile,
  setCredentialProfileEnabled,
} = await import("../credentialProfiles.ts");
const { resolveSessionAccount } = await import("../sessionAccount.ts");
const { resetClaudeAccountModelsForTests } =
  await import("./claudeAccountModels.ts");

beforeEach(() => vi.mocked(pickAccount).mockClear());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

for (const harness of ["pi", "claude-sdk"] as Harness[]) {
  const provider = harness === "pi" ? "openai-codex" : "claude";
  const modelProvider = harness === "pi" ? "openai-codex" : "claude-sdk";
  const modelId = harness === "pi" ? "gpt-6-luna" : "sonnet";
  const request = {
    type: "harnessSend" as const,
    harness,
    id: "start",
    agentType: "assistant" as const,
    text: "hello",
    modelProvider,
    modelId,
    thinkingLevel: "high" as const,
  };
  test(`${harness} automatic first send asks picker for model, effort and enterprise`, async () => {
    vi.mocked(pickAccount).mockResolvedValue({ profileId: "picked" });
    assert.deepEqual(
      await firstSendEngine(harness).account({
        ...request,
        requiresEnterprise: true,
      }),
      { profileId: "picked" },
    );
    assert.deepEqual(vi.mocked(pickAccount).mock.calls, [
      [
        {
          model: { provider: modelProvider, modelId },
          thinkingLevel: "high",
          requiresEnterprise: true,
        },
      ],
    ]);
  });
  test(`${harness} explicit account bypasses usage routing but enforces enterprise`, async () => {
    const personal = createCredentialProfile({ name: "Personal", provider });
    const explicit = { ...request, credentialProfileId: personal.id };
    assert.deepEqual(await firstSendEngine(harness).account(explicit), {
      profileId: personal.id,
    });
    assert.ok(
      "refusal" in
        (await firstSendEngine(harness).account({
          ...explicit,
          requiresEnterprise: true,
        })),
    );
    patchCredentialProfile(personal.id, { enterprise: true });
    assert.deepEqual(
      await firstSendEngine(harness).account({
        ...explicit,
        requiresEnterprise: true,
      }),
      { profileId: personal.id },
    );
    assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
    setCredentialProfileEnabled(personal.id, false);
    assert.ok("refusal" in (await firstSendEngine(harness).account(explicit)));
  });
  test(`${harness} no enterprise survivor refuses clearly without creating a session`, async () => {
    vi.mocked(pickAccount).mockResolvedValue({
      profileId: null,
      degraded: "no-enterprise-account",
    });
    const admission = await firstSendEngine(harness).account({
      ...request,
      requiresEnterprise: true,
    });
    assert.ok("refusal" in admission);
    assert.match(admission.refusal.message, /no enabled enterprise/i);
  });
  test(`${harness} rejects a mismatched model provider before picker`, async () => {
    const modelProvider = harness === "pi" ? "claude-sdk" : "openai-codex";
    assert.ok(
      "refusal" in
        (await firstSendEngine(harness).account({ ...request, modelProvider })),
    );
    assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
  });
}

test("a pi first send of an endpoint model binds its own account", async () => {
  const endpoint = createCredentialProfile({
    name: "Team LLM",
    provider: "openai-compatible",
  });
  const send = {
    type: "harnessSend" as const,
    harness: "pi" as const,
    id: "start",
    agentType: "assistant" as const,
    text: "hello",
    modelProvider: endpoint.id,
    modelId: "llama3",
    thinkingLevel: "off" as const,
  };
  // Only one account serves the model, so Automatic and an OpenAI pin both
  // mean it (rule P), without asking the router.
  assert.deepEqual(await firstSendEngine("pi").account(send), {
    profileId: endpoint.id,
  });
  assert.deepEqual(
    await firstSendEngine("pi").account({
      ...send,
      credentialProfileId: "default",
    }),
    { profileId: endpoint.id },
  );
  setCredentialProfileEnabled(endpoint.id, false);
  const refused = await firstSendEngine("pi").account({
    ...send,
    credentialProfileId: endpoint.id,
  });
  assert.ok("refusal" in refused);
  assert.ok("refusal" in (await firstSendEngine("pi").account(send)));
  assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
});

/** A Claude account whose known listing lacks haiku. */
function entitlementFixture(): { privateId: string; teamId: string } {
  const team = createCredentialProfile({ name: "Team", provider: "claude" });
  const priv = createCredentialProfile({ name: "Private", provider: "claude" });
  resetClaudeAccountModelsForTests({
    read: async (id) =>
      id === priv.id
        ? ["claude-opus-5-5", "claude-sonnet-5-5"]
        : ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  });
  return { privateId: priv.id, teamId: team.id };
}

const entitledSend = {
  type: "harnessSend" as const,
  harness: "claude-sdk" as const,
  id: "entitled-start",
  agentType: "assistant" as const,
  text: "hello",
  modelProvider: "claude-sdk",
  modelId: "haiku",
  thinkingLevel: "high" as const,
};

test("an explicit Claude pin whose listing lacks the model refuses without a session", async () => {
  const { privateId, teamId } = entitlementFixture();
  try {
    const engine = firstSendEngine("claude-sdk");
    const admission = await engine.account({
      ...entitledSend,
      credentialProfileId: privateId,
    });
    assert.ok("refusal" in admission);
    assert.equal(admission.refusal.message, "Private can't run Claude Haiku.");
    assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
    // The model the session would be created with is checked again on the
    // resolved account before any worktree or session exists.
    const prepared = await engine.prepare(entitledSend, privateId);
    assert.ok("refusal" in prepared && !("create" in prepared));
    assert.equal(prepared.refusal.message, "Private can't run Claude Haiku.");
    assert.deepEqual(
      await engine.account({ ...entitledSend, credentialProfileId: teamId }),
      { profileId: teamId },
    );
    // Listed models on the same account still start.
    assert.deepEqual(
      await engine.account({
        ...entitledSend,
        modelId: "opus",
        credentialProfileId: privateId,
      }),
      { profileId: privateId },
    );
  } finally {
    setCredentialProfileEnabled(privateId, false);
    setCredentialProfileEnabled(teamId, false);
    resetClaudeAccountModelsForTests();
  }
});

test("another spelling or an older id of an unlisted model refuses the same way, at admission and at prepare", async () => {
  const { privateId, teamId } = entitlementFixture();
  try {
    const engine = firstSendEngine("claude-sdk");
    for (const modelId of ["HAIKU", "claude-haiku-4-5"]) {
      const send = { ...entitledSend, modelId };
      const admission = await engine.account({
        ...send,
        credentialProfileId: privateId,
      });
      assert.ok("refusal" in admission, `${modelId} pinned to Private`);
      assert.equal(
        admission.refusal.message,
        "Private can't run Claude Haiku.",
      );
      const prepared = await engine.prepare(send, privateId);
      assert.ok(
        "refusal" in prepared && !("create" in prepared),
        `${modelId} creates no session on Private`,
      );
      assert.deepEqual(
        await engine.account({ ...send, credentialProfileId: teamId }),
        { profileId: teamId },
      );
    }
    assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
  } finally {
    setCredentialProfileEnabled(privateId, false);
    setCredentialProfileEnabled(teamId, false);
    resetClaudeAccountModelsForTests();
  }
});

test("an inherited pin on an account lacking the model falls through to Automatic", async () => {
  const { privateId, teamId } = entitlementFixture();
  vi.mocked(pickAccount).mockResolvedValue({ profileId: teamId });
  try {
    assert.equal(
      await resolveSessionAccount(
        "claude-sdk",
        {
          credentialProfileId: privateId,
          modelProvider: "claude-sdk",
          modelId: "haiku",
        },
        { inheritedPin: true },
      ),
      teamId,
    );
    assert.equal(vi.mocked(pickAccount).mock.calls.length, 1);
    assert.equal(
      await resolveSessionAccount(
        "claude-sdk",
        {
          credentialProfileId: privateId,
          modelProvider: "claude-sdk",
          modelId: "opus",
        },
        { inheritedPin: true },
      ),
      privateId,
      "a listed model keeps the inherited pin",
    );
  } finally {
    setCredentialProfileEnabled(privateId, false);
    setCredentialProfileEnabled(teamId, false);
    resetClaudeAccountModelsForTests();
  }
});

test("Automatic with every Claude account lacking the model names the model", async () => {
  vi.mocked(pickAccount).mockResolvedValue({
    profileId: null,
    degraded: "model-unavailable",
  });
  const admission = await firstSendEngine("claude-sdk").account(entitledSend);
  assert.ok("refusal" in admission);
  assert.equal(
    admission.refusal.message,
    "No Claude account can run Claude Haiku.",
  );
});
