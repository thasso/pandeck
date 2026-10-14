import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  analyzeProviderError,
  providerErrorDisplayText,
  runFailureFacts,
  shouldSuppressProviderRetry,
} from "./providerErrors.ts";

const CODEX = { provider: "openai-codex", model: "gpt-6.1-sol" };

for (const text of [
  "OAuth token has been revoked",
  "access token expired",
  "refresh credential rejected",
  "credential was revoked",
]) {
  test(`Claude 403 requires explicit rejection: ${text}`, () => {
    const claude = analyzeProviderError(text, {
      provider: "anthropic",
      statusCode: 403,
    });
    assert.equal(runFailureFacts(claude).loginDeath, true);
    const codex = analyzeProviderError(text, { ...CODEX, statusCode: 403 });
    assert.equal(runFailureFacts(codex).loginDeath, undefined);
    const server = analyzeProviderError(text, {
      provider: "anthropic",
      statusCode: 503,
    });
    assert.equal(server.kind, "server");
    assert.equal(runFailureFacts(server).loginDeath, undefined);
  });
}

for (const text of [
  "Unauthorized",
  "authentication_error",
  "permission denied",
  "permission_error",
]) {
  test(`generic Claude 403 does not kill login: ${text}`, () => {
    assert.equal(
      runFailureFacts(
        analyzeProviderError(text, { provider: "anthropic", statusCode: 403 }),
      ).loginDeath,
      undefined,
    );
  });
}

test("structured Claude status overrides a conflicting text wrapper", () => {
  const info = analyzeProviderError("API Error: 401 Unauthorized", {
    provider: "anthropic",
    statusCode: 503,
  });
  assert.equal(info.statusCode, 503);
  assert.equal(info.kind, "server");
  assert.equal(runFailureFacts(info).loginDeath, undefined);
});

test.each([
  "Unauthorized",
  "authentication_error",
  "OAuth token has expired",
  "refresh credential rejected",
  "Invalid API key · Please run /login",
  "invalid_grant",
  "401 Unauthorized",
])("Codex prose without a known HTTP status never kills login: %s", (raw) => {
  const info = analyzeProviderError(raw, CODEX);
  assert.equal(info.kind, "auth");
  assert.equal(runFailureFacts(info).loginDeath, undefined);
});

test.each([401, 403, 503])(
  "a preserved Codex status %i overrides its wording",
  (statusCode) => {
    const info = analyzeProviderError("Unauthorized", { ...CODEX, statusCode });
    assert.equal(runFailureFacts(info).loginDeath === true, statusCode === 401);
  },
);

describe("content policy refusals", () => {
  test("a Codex cybersecurity flag is a non-retryable refusal, not unknown", () => {
    const info = analyzeProviderError(
      "Codex error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.",
      CODEX,
    );
    assert.equal(info.kind, "content_policy");
    assert.equal(shouldSuppressProviderRetry(info), true);
    assert.match(
      providerErrorDisplayText(info),
      /^Provider refused the content \(openai-codex\/gpt-6\.1-sol\): The provider's safety filter flagged/,
    );
    assert.match(
      providerErrorDisplayText(info),
      /Provider message: Codex error: This content was flagged/,
      "the provider's own reason travels with the display text",
    );
  });

  test("usage-policy and content-filter refusals classify the same way", () => {
    for (const raw of [
      "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
      '400 {"error":{"code":"invalid_prompt","message":"Invalid prompt"}}',
      "The response was filtered due to the prompt triggering the content_filter policy.",
    ]) {
      assert.equal(analyzeProviderError(raw).kind, "content_policy", raw);
    }
  });
});

describe("unclassified errors", () => {
  test("show the provider's own message instead of a generic summary", () => {
    const info = analyzeProviderError("Codex error: something new", CODEX);
    assert.equal(info.kind, "unknown");
    assert.equal(
      providerErrorDisplayText(info),
      "Provider error (openai-codex/gpt-6.1-sol): Codex error: something new",
    );
  });

  test("truncate a long provider message", () => {
    const text = providerErrorDisplayText(
      analyzeProviderError(`odd failure ${"x".repeat(1000)}`),
    );
    assert.ok(text.length < 450);
    assert.ok(text.endsWith("…"));
  });
});
