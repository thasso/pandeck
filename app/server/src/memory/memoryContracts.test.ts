/**
 * Task 93: shared memory validation/normalization contracts, exercised through
 * the server Vitest suite (the shared package has no test runner).
 *   pnpm --filter @assistant/server test src/memory/memoryContracts.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isValidIanaTimeZone,
  looksSecretLike,
  normalizeMemoryText,
  validateMemoryScope,
  validateMemoryTemporal,
  validateMemoryText,
} from "@assistant/shared";

test("timezone validation accepts IANA zones and rejects junk", () => {
  assert.ok(isValidIanaTimeZone("Europe/Berlin"));
  assert.ok(isValidIanaTimeZone("America/New_York"));
  assert.ok(!isValidIanaTimeZone("Mars/Phobos"));
  assert.ok(!isValidIanaTimeZone(""));
  assert.ok(!isValidIanaTimeZone(undefined));
});

test("text validation trims, bounds, and rejects secret-like input", () => {
  assert.equal(normalizeMemoryText("  a   b\n c "), "a b c");
  const ok = validateMemoryText("  Prefers dark mode ");
  assert.ok(ok.ok && ok.value === "Prefers dark mode");
  assert.ok(!validateMemoryText("a").ok, "too short rejected");
  assert.ok(!validateMemoryText("x".repeat(401)).ok, "too long rejected");
  assert.ok(!validateMemoryText(42).ok, "non-string rejected");
  assert.ok(looksSecretLike("api_key=abcdef123456"));
  assert.ok(looksSecretLike("ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234567890"));
  assert.ok(!looksSecretLike("Prefers TypeScript over JavaScript"));
  assert.ok(
    !validateMemoryText("token: sk-abcdef1234567890abcdef").ok,
    "secret-like rejected",
  );
});

test("scope validation enforces persona keys incl. personal-assistant and non-empty project", () => {
  assert.deepEqual(validateMemoryScope(undefined), { ok: true, value: {} });
  const pa = validateMemoryScope({
    persona: "personal-assistant",
    projectId: "acme",
  });
  assert.ok(
    pa.ok &&
      pa.value.persona === "personal-assistant" &&
      pa.value.projectId === "acme",
  );
  assert.ok(!validateMemoryScope({ persona: "bogus" }).ok);
  assert.ok(!validateMemoryScope({ projectId: "  " }).ok);
});

test("temporal validation enforces per-mode shape, window order, tz, and recurrence", () => {
  assert.deepEqual(validateMemoryTemporal(undefined), {
    ok: true,
    value: { mode: "persistent" },
  });
  assert.ok(
    !validateMemoryTemporal({ mode: "window" }).ok,
    "empty window rejected",
  );
  assert.ok(
    !validateMemoryTemporal({
      mode: "window",
      validFromMs: 100,
      validUntilMs: 50,
    }).ok,
    "reversed window rejected",
  );
  const win = validateMemoryTemporal({
    mode: "window",
    validFromMs: 100,
    validUntilMs: 200,
    timezone: "Europe/Berlin",
  });
  assert.ok(win.ok && win.value.validUntilMs === 200);
  assert.ok(
    !validateMemoryTemporal({
      mode: "window",
      validFromMs: 1,
      timezone: "Nowhere/Nope",
    }).ok,
    "bad tz rejected",
  );
  assert.ok(
    !validateMemoryTemporal({ mode: "recurring" }).ok,
    "missing recurrence rejected",
  );
  const rec = validateMemoryTemporal({
    mode: "recurring",
    recurrence: { kind: "weekly", weekdays: [3, 1, 1] },
  });
  assert.ok(rec.ok && rec.value.recurrence!.weekdays.join(",") === "1,3");
  assert.ok(
    !validateMemoryTemporal({
      mode: "recurring",
      recurrence: { kind: "weekly", weekdays: [9] },
    }).ok,
    "weekday out of range rejected",
  );
});
