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
