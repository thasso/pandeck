import assert from "node:assert/strict";
import { test } from "vitest";
import { redactSecrets } from "./secretRedaction.ts";
import { saveSettings } from "./settingsService.ts";

test("a stored secret is scrubbed in every form it travels in", async () => {
  await saveSettings({
    github: { token: "fixture-github-value-for-redaction" },
  });
  const stored = "fixture-github-value-for-redaction";
  for (const form of [
    stored,
    encodeURIComponent(stored),
    Buffer.from(stored).toString("base64"),
  ])
    assert.equal(redactSecrets(`got ${form} back`), "got [redacted] back");
});

test("a message truncated partway through a secret loses the fragment", async () => {
  await saveSettings({
    github: { token: "fixture-github-value-for-redaction" },
  });
  assert.equal(
    redactSecrets("HTTP 401: fixture-github-val"),
    "HTTP 401: [redacted]",
  );
});

test("auth header values and URL credentials are scrubbed without being stored", () => {
  assert.equal(
    redactSecrets("Authorization: Bearer fixture-header-value"),
    "Authorization: Bearer [redacted]",
  );
  assert.equal(
    redactSecrets("see https://u%3Ax:p%40ss@host/x"),
    "see https://[redacted]@host/x",
  );
});

test("URL credentials end at the last @ before the path", () => {
  assert.equal(
    redactSecrets("GET https://alice:head@tail@example.invalid/v1 failed"),
    "GET https://[redacted]@example.invalid/v1 failed",
  );
});
