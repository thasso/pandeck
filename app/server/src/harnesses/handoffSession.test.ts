/**
 * `handoffEngine`: each engine's account and model checks for the session a
 * review handoff opens, and the worktree it creates the session in.
 *   pnpm --filter @assistant/server test src/harnesses/handoffSession.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "harness-handoff-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { handoffEngine } = await import("./handoffSession.ts");
const create = await import("./create.ts");
const settings = await import("../settings.ts");
const { createCredentialProfile, patchCredentialProfile } =
  await import("../credentialProfiles.ts");
const models = await import("./models.ts");
const router = await import("../accountRouter.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const worktree = { id: "wt-1", path: "/work/tree" };

function claudeEnabled(enabled: boolean): void {
  const real = settings.getSettings();
  vi.spyOn(settings, "getSettings").mockReturnValue({
    ...real,
    claudeSdk: { ...real.claudeSdk, enabled },
  });
}

test("only pi asks the connection to guard the persona", () => {
  assert.equal(handoffEngine("pi").guardsPersona, true);
  assert.equal(handoffEngine("claude-sdk").guardsPersona, false);
});

test("a Claude handoff is refused while the SDK is off or on another account", async () => {
  const created = vi.spyOn(create, "createSession");
  claudeEnabled(false);
  await assert.rejects(
    handoffEngine("claude-sdk").create({ agentType: "developer" }, worktree),
    /Claude SDK sessions are disabled\./,
  );
  claudeEnabled(true);
  const openAi = createCredentialProfile({
    name: "Not Claude",
    provider: "openai-codex",
  });
  await assert.rejects(
    handoffEngine("claude-sdk").create(
      { agentType: "developer", credentialProfileId: openAi.id },
      worktree,
    ),
    /Select an enabled Claude credential profile\./,
  );
  assert.equal(created.mock.calls.length, 0);
});

test("a Claude handoff is created in the worktree on its account", async () => {
  claudeEnabled(true);
  const claude = createCredentialProfile({
    name: "Claude",
    provider: "claude",
  });
  const created = vi
    .spyOn(create, "createSession")
    .mockResolvedValue({ sessionId: "claude-handoff" } as never);
  await handoffEngine("claude-sdk").create(
    {
      agentType: "developer",
      credentialProfileId: claude.id,
      modelId: "opus",
      mode: "plan",
    },
    worktree,
  );
  assert.deepEqual(created.mock.calls[0]?.[0], {
    harness: "claude-sdk",
    agentType: "developer",
    modelId: "opus",
    thinkingLevel: undefined,
    mode: "plan",
    worktree,
    credentialProfileId: claude.id,
  });
});

test("a pi handoff is refused on another account or for a model it lacks", async () => {
  const created = vi.spyOn(create, "createSession");
  const claude = createCredentialProfile({
    name: "Claude 2",
    provider: "claude",
  });
  await assert.rejects(
    handoffEngine("pi").create(
      { agentType: "developer", credentialProfileId: claude.id },
      worktree,
    ),
    /Select an enabled OpenAI credential profile\./,
  );
  const openAi = createCredentialProfile({
    name: "OpenAI",
    provider: "openai-codex",
  });
  await assert.rejects(
    handoffEngine("pi").create(
      {
        agentType: "developer",
        credentialProfileId: openAi.id,
        modelProvider: "openai-codex",
        modelId: "no-such-model",
      },
      worktree,
    ),
    /Model openai-codex\/no-such-model is not available\./,
  );
  assert.equal(created.mock.calls.length, 0);
});

test("an automatic pi handoff runs on the picked account's exact model", async () => {
  const picked = createCredentialProfile({
    name: "Picked OpenAI",
    provider: "openai-codex",
  });
  const selection = vi
    .spyOn(router, "pickAccount")
    .mockResolvedValue({ profileId: picked.id });
  const model = { provider: "openai-codex", id: "gpt-test" };
  const lookup = vi
    .spyOn(models, "piModelForAccount")
    .mockResolvedValue(model as never);
  const created = vi
    .spyOn(create, "createSession")
    .mockResolvedValue({ sessionId: "pi-handoff" } as never);
  await handoffEngine("pi").create(
    {
      agentType: "developer",
      modelProvider: "openai-codex",
      modelId: "gpt-test",
      thinkingLevel: "low",
    },
    worktree,
  );
  const profileId = picked.id;
  assert.deepEqual(selection.mock.calls, [
    [
      {
        model: { provider: "openai-codex", modelId: "gpt-test" },
        thinkingLevel: "low",
      },
    ],
  ]);
  assert.deepEqual(lookup.mock.calls[0], [
    profileId,
    "openai-codex",
    "gpt-test",
  ]);
  assert.deepEqual(created.mock.calls[0]?.[0], {
    harness: "pi",
    agentType: "developer",
    model,
    thinkingLevel: "low",
    mode: undefined,
    worktree,
    credentialProfileId: profileId,
  });
});

test("handoff enterprise choice is passed to routing and durable creation; personal pin is refused", async () => {
  claudeEnabled(true);
  const profile = createCredentialProfile({
    name: "Enterprise handoff",
    provider: "claude",
  });
  const created = vi
    .spyOn(create, "createSession")
    .mockResolvedValue({ sessionId: "enterprise-handoff" } as never);
  await assert.rejects(
    handoffEngine("claude-sdk").create(
      {
        agentType: "assistant",
        credentialProfileId: profile.id,
        requiresEnterprise: true,
      },
      worktree,
    ),
    /requires an enterprise account/,
  );
  assert.equal(created.mock.calls.length, 0);
  patchCredentialProfile(profile.id, { enterprise: true });
  const selection = vi
    .spyOn(router, "pickAccount")
    .mockResolvedValue({ profileId: profile.id });
  await handoffEngine("claude-sdk").create(
    { agentType: "assistant", modelId: "sonnet", requiresEnterprise: true },
    worktree,
  );
  assert.deepEqual(selection.mock.calls, [
    [
      {
        model: { provider: "claude-sdk", modelId: "sonnet" },
        requiresEnterprise: true,
      },
    ],
  ]);
  assert.equal(created.mock.calls[0]?.[0].requiresEnterprise, true);
});

test("a Claude handoff without a named account uses the account picker", async () => {
  claudeEnabled(true);
  const picked = createCredentialProfile({
    name: "Picked Claude",
    provider: "claude",
  });
  const selection = vi
    .spyOn(router, "pickAccount")
    .mockResolvedValue({ profileId: picked.id });
  const created = vi
    .spyOn(create, "createSession")
    .mockResolvedValue({ sessionId: "claude-default" } as never);
  await handoffEngine("claude-sdk").create(
    { agentType: "assistant" },
    worktree,
  );
  assert.equal(
    (created.mock.calls[0]?.[0] as { credentialProfileId?: string } | undefined)
      ?.credentialProfileId,
    picked.id,
  );
  assert.deepEqual(selection.mock.calls, [
    [{ model: { provider: "claude-sdk", modelId: "sonnet" } }],
  ]);
});
