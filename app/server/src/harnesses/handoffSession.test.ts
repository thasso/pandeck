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
const { createCredentialProfile } = await import("../credentialProfiles.ts");

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
