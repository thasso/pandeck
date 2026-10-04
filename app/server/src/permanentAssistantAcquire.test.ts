/**
 * The Personal Assistant singleton is created once however many callers ask
 * for it at the same time.
 *   pnpm --filter @assistant/server test src/permanentAssistantAcquire.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "permanent-assistant-acquire-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({
    claudeSdk: { enabled: true },
    permanentAssistant: { provider: "claude-sdk", modelId: "sonnet" },
  }),
);

const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { permanentAssistantSessionId } = await import("./permanentAssistant.ts");
const { permanentAssistantStore } =
  await import("./db/permanentAssistantStore.ts");
const { getSettings } = await import("./settings.ts");
const { permanentAssistantProfileInstructions } =
  await import("./permanentAssistantProfile.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("concurrent callers share one new singleton, and it is the one bound", async () => {
  const acquire = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockImplementation((id: string) => ({ id, sessionId: id }) as never);

  const [first, second] = await Promise.all([
    permanentAssistantSessionId(),
    permanentAssistantSessionId(),
  ]);

  assert.equal(acquire.mock.calls.length, 1);
  assert.equal(first, second);
  assert.equal(permanentAssistantStore.sessionId(), first);
  assert.deepEqual(acquire.mock.calls[0]?.[1], {
    agentType: "personal-assistant",
    credentialProfileId: acquire.mock.calls[0]?.[1]?.credentialProfileId,
    modelId: "sonnet",
    thinkingLevel: getSettings().permanentAssistant.thinkingLevel,
    additionalSystemPrompt: permanentAssistantProfileInstructions(
      getSettings().permanentAssistant,
    ),
  });
});
