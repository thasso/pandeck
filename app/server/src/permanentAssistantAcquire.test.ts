/**
 * The Personal Assistant singleton is created once however many callers ask
 * for it at the same time.
 *   pnpm --filter @assistant/server test src/permanentAssistantAcquire.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

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
const { permanentAssistantSessionId, rotatePermanentAssistantSession } =
  await import("./permanentAssistant.ts");
const create = await import("./harnesses/create.ts");
const { permanentAssistantStore } =
  await import("./db/permanentAssistantStore.ts");
const { getSettings } = await import("./settings.ts");
const { permanentAssistantProfileInstructions } =
  await import("./permanentAssistantProfile.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  permanentAssistantStore.clearSessionId();
});

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

test("a rotation retires a creation under way: the new profile's singleton is bound", async () => {
  let finishOld!: () => void;
  const created: string[] = [];
  vi.spyOn(create, "createSession").mockImplementation(async () => {
    const id = `assistant-${created.length + 1}`;
    created.push(id);
    // The first creation is still under way when the profile rotates.
    if (created.length === 1)
      await new Promise<void>((resolve) => (finishOld = resolve));
    return { id, sessionId: id } as never;
  });

  const old = permanentAssistantSessionId();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rotatePermanentAssistantSession();
  const current = permanentAssistantSessionId();
  finishOld();

  assert.equal(await current, "assistant-2");
  // The old caller is answered by the current singleton too, not by the one
  // its retired creation made.
  assert.equal(await old, "assistant-2");
  assert.equal(permanentAssistantStore.sessionId(), "assistant-2");
  assert.deepEqual(created, ["assistant-1", "assistant-2"]);
});
