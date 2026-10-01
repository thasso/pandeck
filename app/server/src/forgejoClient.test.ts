/**
 * Base-URL normalization for the Forgejo client: user-entered instance URLs may
 * carry trailing slashes or a redundant /api/v1 suffix, and must normalize to a
 * bare origin so `forgejoRequest` can append `/api/v1<path>` exactly once.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeForgejoBaseUrl } from "./forgejoClient.ts";

test("trims whitespace and trailing slashes", () => {
  assert.equal(
    normalizeForgejoBaseUrl("  https://git.example.com/  "),
    "https://git.example.com",
  );
  assert.equal(
    normalizeForgejoBaseUrl("https://git.example.com///"),
    "https://git.example.com",
  );
});

test("strips a redundant trailing /api/v1", () => {
  assert.equal(
    normalizeForgejoBaseUrl("https://git.example.com/api/v1"),
    "https://git.example.com",
  );
  assert.equal(
    normalizeForgejoBaseUrl("https://git.example.com/api/v1/"),
    "https://git.example.com",
  );
});

test("leaves a clean base URL untouched and handles empty input", () => {
  assert.equal(
    normalizeForgejoBaseUrl("https://git.example.com"),
    "https://git.example.com",
  );
  assert.equal(normalizeForgejoBaseUrl(""), "");
});
