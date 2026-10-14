/**
 * `generateSessionTitle`'s run contract: no usable model yields no title, any
 * other failure reaches the caller (which keeps a fallback title), and the run
 * is recorded against the session it names.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNamingSettings } from "@assistant/shared";
import { afterAll, beforeEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "session-naming-run-test-"));
process.env.ASSISTANT_CWD = tmp;

vi.mock("./harnesses/oneShot.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harnesses/oneShot.ts")>()),
  runOneShot: vi.fn(),
}));

const { NoHelperModelError, OneShotError, runOneShot } =
  await import("./harnesses/oneShot.ts");
const { generateSessionTitle } = await import("./sessionNaming.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { EnterpriseAccountRequiredError } =
  await import("./settingsModelSlots.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const settings: SessionNamingSettings = {
  enabled: true,
  provider: "claude-sdk",
  modelId: "haiku",
  thinkingLevel: "off",
};

beforeEach(() => {
  vi.mocked(runOneShot).mockReset();
});

test("a generated title is recorded against the session it names", async () => {
  vi.mocked(runOneShot).mockResolvedValue({
    text: "Fix login redirect",
    usage: {},
  });

  const title = await generateSessionTitle("fix the login redirect", settings, {
    parentSessionId: "parent-1",
  });

  assert.equal(title, "Fix login redirect");
  const request = vi.mocked(runOneShot).mock.calls[0]?.[0];
  assert.deepEqual(request?.record, {
    purpose: "title_generation",
    title: "Session title generation",
    parentSessionId: "parent-1",
  });
  assert.equal(
    request?.credentialProfileId,
    undefined,
    "Automatic stays unresolved until the run",
  );
});

test("no usable model yields no generated title", async () => {
  vi.mocked(runOneShot).mockRejectedValue(new NoHelperModelError("none"));

  assert.equal(await generateSessionTitle("prompt", settings), undefined);
});

test("enterprise source naming overrides explicit false and skips without an enterprise account", async () => {
  sessionStore.upsert({
    id: "enterprise-naming-source",
    harness: "claude-sdk",
    agentType: "developer",
    requiresEnterprise: true,
  });
  vi.mocked(runOneShot).mockRejectedValue(new EnterpriseAccountRequiredError());
  assert.equal(
    await generateSessionTitle("Enterprise source prompt", settings, {
      parentSessionId: "enterprise-naming-source",
      requiresEnterprise: false,
    }),
    undefined,
  );
  assert.equal(
    vi.mocked(runOneShot).mock.calls[0]?.[0].requiresEnterprise,
    true,
  );
});

test("a failed run reaches the caller", async () => {
  vi.mocked(runOneShot).mockRejectedValue(new OneShotError("boom", {}));

  await assert.rejects(
    () => generateSessionTitle("prompt", settings),
    OneShotError,
  );
});

test("naming disabled runs nothing", async () => {
  assert.equal(
    await generateSessionTitle("prompt", { ...settings, enabled: false }),
    undefined,
  );
  assert.equal(vi.mocked(runOneShot).mock.calls.length, 0);
});
