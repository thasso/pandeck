/**
 * Boot wiring of scheduled prompts (`docs/schedules.md`, "Admission and crash
 * safety"). `index.ts` binds a port on import, so, like
 * `peerPromptWiring.test.ts`, this asserts the wiring from its source text:
 * recovery runs after the peer-prompt recovery offers and before the clock,
 * the clock's claims wake their target, and the module that registers the
 * admission resolver is loaded by the delivery lanes the server builds.
 *   pnpm --filter @assistant/server test src/schedules/scheduledPromptWiring.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(SRC_ROOT, file), "utf8");

test("boot recovers scheduled prompts after peer recovery and before the clock", () => {
  const source = read("index.ts");
  const at = (step: string) => {
    const index = source.indexOf(`bootStep("${step}"`);
    assert.ok(index >= 0, `boot step "${step}" exists`);
    return index;
  };
  const peer = at("peer-prompt recovery offers");
  const recovery = at("scheduled-prompt recovery");
  const clock = at("schedule clock");
  assert.ok(peer < recovery, "recovery runs after the peer recovery offers");
  assert.ok(recovery < clock, "recovery runs before the clock starts");
  assert.match(
    source.slice(recovery, clock),
    /recoverScheduledPromptsOnBoot\(offerOnBoot\)/,
  );
  assert.match(
    source.slice(clock, clock + 200),
    /startScheduleClock\(\{\s*claimed:\s*\(target\)\s*=>\s*offerDelivery\(target\)/,
    "a claim wakes its target's lanes",
  );
});

test("the delivery lanes load the module that registers the admission resolver", () => {
  assert.match(
    read("sessionDeliveryLanes.ts"),
    /import\s*\{[^}]*\bdeliverScheduledPrompts\b[^}]*\}\s*from\s*"\.\/schedules\/scheduledPrompts\.ts"/,
  );
  assert.match(
    read("schedules/scheduledPrompts.ts"),
    /^scheduleStore\.setAdmissionResolver\(resolveScheduledAdmission\);$/m,
    "registered at module load, not on first delivery",
  );
});
