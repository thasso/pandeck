import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  GATEWAY_REFUSAL_MARKER,
  refusalResponse,
  refusalText,
  type Refusal,
} from "./gateway/refusals.ts";
import {
  analyzeProviderError,
  isLoginDeath,
  loginEnded,
  providerErrorDisplayText,
  runFailureFacts,
  shouldSuppressProviderRetry,
} from "./providerErrors.ts";

test.each([
  "invalid_encrypted_content",
  "The encrypted content gAAAA could not be verified.",
  "Unable to decrypt the encrypted reasoning.",
  "The reasoning signature is invalid.",
])("explicit opaque-reasoning rejection is Codex-only: %s", (text) => {
  for (const provider of ["openai-codex", "openai", "claude-sdk"]) {
    const facts = runFailureFacts(
      analyzeProviderError(text, { provider, model: "gpt-5.5" }),
    );
    assert.equal(
      facts.encryptedReasoningRejected,
      provider === "openai-codex" ? true : undefined,
    );
  }
  assert.equal(
    runFailureFacts(
      analyzeProviderError("The encrypted reasoning is accepted", {
        provider: "openai-codex",
      }),
    ).encryptedReasoningRejected,
    undefined,
  );
});

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

test.each([
  "The request could not be processed",
  "Unauthorized",
  "OAuth token has expired",
  "content_policy",
  "provider server error",
])("Claude HTTP 429 remains a rate limit despite prose: %s", (text) => {
  for (const info of [
    analyzeProviderError(text, { provider: "claude-sdk", statusCode: 429 }),
    analyzeProviderError(`API Error: 429 ${text}`, { provider: "claude-sdk" }),
  ]) {
    assert.deepEqual(runFailureFacts(info), { kind: "rate_limit" });
  }
});

test.each([
  "Opus weekly limit reached ∙ resets Oct 20, 3pm",
  "You've hit your Opus limit · resets 3pm",
])("Claude CLI named quota uses only a matching model: %s", (raw) => {
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", undefined]) {
    const facts = runFailureFacts(
      analyzeProviderError(raw, {
        provider: "claude-sdk",
        ...(model === undefined ? {} : { model }),
      }),
    );
    assert.equal(facts.kind, "quota");
    assert.equal(
      facts.limitModel,
      model === "claude-opus-5-5" ? "opus" : undefined,
    );
    assert.equal(
      facts.resetAtMs,
      undefined,
      "human reset text is never parsed",
    );
  }
});

test("Claude's legacy pipe reset is epoch seconds, not a fallback or human date", () => {
  assert.deepEqual(
    runFailureFacts(
      analyzeProviderError("Claude AI usage limit reached|1900000000", {
        provider: "claude-sdk",
        model: "claude-opus-5-5",
      }),
    ),
    { kind: "quota", resetAtMs: 1900000000000 },
  );
});

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

describe("credential gateway refusals (C16)", () => {
  const unreachable: Refusal = {
    case: "unreachable",
    upstream: "Anthropic",
    reason: "ECONNREFUSED",
  };
  const refusals: Refusal[] = [
    { case: "unknown-lease" },
    { case: "revoked-lease", reason: "profile-removed" },
    { case: "revoked-lease", reason: "account-switch" },
    { case: "revoked-lease", reason: "session-ended" },
    { case: "forbidden" },
    { case: "unknown-prefix" },
    { case: "websocket" },
    { case: "credential", problem: "missing" },
    { case: "credential", problem: "unreadable" },
    { case: "credential", problem: "malformed" },
    { case: "needs-login", name: "Work Claude" },
    unreachable,
    { case: "unreachable", upstream: "ChatGPT", reason: "connection failed" },
  ];
  const CLAUDE_401 = { provider: "anthropic", statusCode: 401 };

  /** The shapes the spike saw engines report a gateway 401 in. */
  function renderings(text: string, claudeBody: string) {
    return [
      analyzeProviderError(
        `Failed to authenticate. API Error: 401 ${text}`,
        CLAUDE_401,
      ),
      analyzeProviderError(
        `Failed to authenticate. API Error: 401 ${claudeBody}`,
        CLAUDE_401,
      ),
      analyzeProviderError(text, { ...CODEX, statusCode: 401 }),
    ];
  }

  test.each(refusals.map((refusal) => [refusalText(refusal), refusal]))(
    "a marked refusal is never a dead login: %s",
    (text, refusal) => {
      const [claude, claudeBody, codex] = renderings(
        text,
        refusalResponse(refusal, "claude").body,
      );
      for (const info of [claude!, claudeBody!, codex!]) {
        // Directly too: the Claude engine passes the 401 as `statusCode`.
        assert.equal(isLoginDeath(info.rawMessage, info), false);
        assert.equal(runFailureFacts(info).loginDeath, undefined);
        assert.ok(
          !["auth", "quota", "content_policy"].includes(info.kind),
          `${info.rawMessage} classified as ${info.kind}`,
        );
      }
      assert.ok(providerErrorDisplayText(claude!).includes(text));
    },
  );

  test("an unreachable upstream is a retryable server error", () => {
    const info = analyzeProviderError(
      `API Error: 502 ${refusalText(unreachable)}`,
      { provider: "anthropic", statusCode: 502 },
    );
    assert.equal(info.kind, "server");
    assert.equal(info.retryable, true);
  });

  test.each(refusals.map((refusal) => [refusalText(refusal), refusal]))(
    "the same text without the marker is classified as before: %s",
    (text, refusal) => {
      const unmark = (value: string) =>
        value.replaceAll(GATEWAY_REFUSAL_MARKER, "spike gateway:");
      for (const info of renderings(
        unmark(text),
        unmark(refusalResponse(refusal, "claude").body),
      )) {
        assert.equal(info.kind, "auth", info.rawMessage);
        assert.equal(runFailureFacts(info).loginDeath, true, info.rawMessage);
      }
      assert.equal(
        analyzeProviderError(`API Error: 502 ${unmark(text)}`, {
          provider: "anthropic",
          statusCode: 502,
        }).kind,
        "server",
      );
    },
  );
});

describe("1368 AC9: a gateway-served login ends only on the gateway's needs-login", () => {
  const CLAUDE_401 = { provider: "anthropic", statusCode: 401 };
  const facts = {
    "401": runFailureFacts(
      analyzeProviderError(
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
        CLAUDE_401,
      ),
    ),
    "needs-login refusal": runFailureFacts(
      analyzeProviderError(
        `API Error: 401 ${refusalText({ case: "needs-login", name: "Work" })}`,
        CLAUDE_401,
      ),
    ),
    "other refusal": runFailureFacts(
      analyzeProviderError(
        `API Error: 401 ${refusalText({ case: "unknown-lease" })}`,
        CLAUDE_401,
      ),
    ),
  };

  test("only the needs-login refusal carries gatewayNeedsLogin", () => {
    assert.equal(facts["401"].gatewayNeedsLogin, undefined);
    assert.equal(facts["401"].loginDeath, true);
    assert.equal(facts["needs-login refusal"].gatewayNeedsLogin, true);
    assert.equal(facts["needs-login refusal"].loginDeath, undefined);
    assert.equal(facts["other refusal"].gatewayNeedsLogin, undefined);
    // Codex's shape too.
    assert.equal(
      runFailureFacts(
        analyzeProviderError(
          refusalText({ case: "needs-login", name: "Codex" }),
          { ...CODEX, statusCode: 401 },
        ),
      ).gatewayNeedsLogin,
      true,
    );
  });

  test.each([
    ["401", true, false],
    ["401", false, true],
    ["needs-login refusal", true, true],
    ["needs-login refusal", false, false],
    ["other refusal", true, false],
    ["other refusal", false, false],
  ] as const)("%s, served %s: login ended %s", (kind, served, ended) => {
    assert.equal(loginEnded(facts[kind], served), ended);
  });

  test("no facts end no login", () => {
    assert.equal(loginEnded(undefined, true), false);
    assert.equal(loginEnded(undefined, false), false);
  });
});
