/**
 * Whether an existing session may be opened, by the engine that runs it.
 *   pnpm --filter @assistant/server test src/harnesses/availability.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "harness-availability-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { existingSessionRefusal } = await import("./availability.ts");
const settings = await import("../settings.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

function claudeEnabled(enabled: boolean): void {
  const real = settings.getSettings();
  vi.spyOn(settings, "getSettings").mockReturnValue({
    ...real,
    claudeSdk: { ...real.claudeSdk, enabled },
  });
}

test("a Claude session waits on the Claude SDK setting, whatever its persona", () => {
  claudeEnabled(false);
  assert.equal(
    existingSessionRefusal("claude-sdk", "workshop"),
    "Claude SDK is disabled in settings.",
  );
  claudeEnabled(true);
  assert.equal(existingSessionRefusal("claude-sdk", "workshop"), undefined);
});

test("a pi session waits on its persona, not on the Claude setting", () => {
  claudeEnabled(false);
  assert.equal(existingSessionRefusal("pi", "assistant"), undefined);
  assert.equal(
    existingSessionRefusal("pi", "retired-persona" as never),
    'The "retired-persona" agent is not available.',
  );
});
