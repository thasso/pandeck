import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test, vi } from "vitest";
import type { SyntheticToolHost } from "./hostSlashCommands.ts";

const tmp = mkdtempSync(join(tmpdir(), "host-compact-enterprise-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const { runCompactForHost } = await import("./hostSlashCommands.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { memoryScheduler } = await import("./memory/memoryScheduler.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const {
  createCredentialProfile,
  patchCredentialProfile,
  setCredentialProfileEnabled,
} = await import("./credentialProfiles.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => vi.restoreAllMocks());

function fakeHost(sessionId: string, credentialProfileId: string) {
  const compact = vi.fn(async (_instructions?: string) => ({
    kind: "compacted" as const,
    summary: "Summary",
    tokensBefore: 100,
  }));
  const error = vi.fn();
  const card = vi.fn();
  const host = {
    sessionId,
    credentialProfileId,
    kind: "assistant",
    beginSyntheticTool: () => ({
      toolId: "compact-tool",
      assistantId: "compact-assistant",
    }),
    updateSyntheticTool: () => {},
    finishSyntheticTool: error,
    finishSyntheticCard: card,
    compactContext: compact,
  } as unknown as SyntheticToolHost;
  return { host, compact, error, card };
}

for (const provider of ["openai-codex", "claude"] as const) {
  for (const missing of [false, true]) {
    test(`${provider} manual compaction refuses a ${missing ? "missing" : "demoted"} enterprise binding before memory flush or a model call`, async () => {
      const profile = createCredentialProfile({
        name: "Compact account",
        provider,
      });
      const id = `compact-refused-${provider}-${missing}`;
      const credentialProfileId = missing ? "gone-account" : profile.id;
      sessionStore.upsert({
        id,
        harness: provider === "claude" ? "claude-sdk" : "pi",
        agentType: "assistant",
        requiresEnterprise: true,
        credentialProfileId,
      });
      const flush = vi
        .spyOn(memoryScheduler, "flushBeforeReset")
        .mockResolvedValue();
      const fake = fakeHost(id, credentialProfileId);
      await runCompactForHost(fake.host, "Keep decisions");
      assert.equal(flush.mock.calls.length, 0);
      assert.equal(fake.compact.mock.calls.length, 0);
      assert.match(
        fake.error.mock.calls[0]?.[1],
        /requires an enterprise account/,
      );
      assert.equal(fake.error.mock.calls[0]?.[2], true);
      assert.equal(fake.card.mock.calls.length, 0);
    });
  }
  test(`${provider} disabled enterprise binding compacts, and admitted work may finish after demotion`, async () => {
    const profile = createCredentialProfile({
      name: "Disabled compact account",
      provider,
    });
    patchCredentialProfile(profile.id, { enterprise: true });
    setCredentialProfileEnabled(profile.id, false);
    const id = `compact-admitted-${provider}`;
    sessionStore.upsert({
      id,
      harness: provider === "claude" ? "claude-sdk" : "pi",
      agentType: "assistant",
      requiresEnterprise: true,
      credentialProfileId: profile.id,
    });
    const flush = vi
      .spyOn(memoryScheduler, "flushBeforeReset")
      .mockImplementation(async () => {
        patchCredentialProfile(profile.id, { enterprise: false });
      });
    const fake = fakeHost(id, profile.id);
    await runCompactForHost(fake.host, "Keep decisions");
    assert.deepEqual(fake.compact.mock.calls, [["Keep decisions"]]);
    assert.equal(fake.card.mock.calls.length, 1);
    assert.equal(fake.error.mock.calls.length, 0);
    await runCompactForHost(fake.host, "Refused");
    assert.equal(flush.mock.calls.length, 1);
    assert.equal(fake.compact.mock.calls.length, 1);
    assert.match(
      fake.error.mock.calls[0]?.[1],
      /requires an enterprise account/,
    );
  });
}

test("a real Claude host with a demoted enterprise account never opens a compaction query", async () => {
  const profile = createCredentialProfile({
    name: "Claude compact regression",
    provider: "claude",
  });
  const id = "claude-compact-refused";
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "assistant",
    requiresEnterprise: true,
    credentialProfileId: profile.id,
  });
  const seam = vi.fn(async () => {
    throw new Error("Refused compaction must not open the SDK");
  });
  const live = new ClaudeSdkSession(id, {
    agentType: "assistant",
    credentialProfileId: profile.id,
    providerSessionId: "11111111-2222-3333-4444-555555555555",
    seam,
  });
  const flush = vi
    .spyOn(memoryScheduler, "flushBeforeReset")
    .mockResolvedValue();
  const finish = vi.spyOn(live, "finishSyntheticTool");
  await runCompactForHost(live, "Keep decisions");
  assert.equal(flush.mock.calls.length, 0);
  assert.equal(seam.mock.calls.length, 0);
  assert.match(
    finish.mock.calls[0]?.[1] ?? "",
    /requires an enterprise account/,
  );
  assert.equal(finish.mock.calls[0]?.[2], true);
  assert.equal(live.isRunning, false);
});
