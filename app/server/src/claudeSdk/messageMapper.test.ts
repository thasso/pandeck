/**
 * Usage-aggregation tests for the Claude-SDK message mapper.
 *
 * Run through the server Vitest suite:
 *   npm -w @assistant/server run test -- src/claudeSdk/messageMapper.test.ts
 *
 * Covers the correctness of `mapResultEpochUsage`: session billing totals come
 * from the run's per-model `modelUsage` aggregate (which sums every internal
 * tool-loop request AND every model that ran), NOT the top-level `result.usage`
 * snapshot (final request, main model only).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  ClaudeAssistantMessage,
  ClaudeResultMessage,
} from "./messageMapper.ts";
import {
  assistantProviderError,
  claudeModelNotFound,
  mapResultEpochUsage,
  mapResultMeta,
  mapResultUsage,
  resultProviderError,
} from "./messageMapper.ts";
import {
  CLAUDE_REFUSAL_TEXTS,
  claudeRefusalMessages,
} from "../test/modelRefusalCaptures.ts";

function resultMessage(fields: Record<string, unknown>): ClaudeResultMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "s",
    ...fields,
  } as unknown as ClaudeResultMessage;
}

test("mapResultEpochUsage sums modelUsage across every model in the epoch", () => {
  // A turn where a helper/background model also ran: the top-level usage only
  // reflects the final main-model request, but modelUsage carries both.
  const message = resultMessage({
    usage: {
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 200,
    },
    modelUsage: {
      "claude-opus-5": {
        inputTokens: 1500,
        outputTokens: 300,
        cacheReadInputTokens: 4000,
        cacheCreationInputTokens: 800,
      },
      "claude-haiku-4-5": {
        inputTokens: 200,
        outputTokens: 40,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  });
  const usage = mapResultEpochUsage(message);
  assert.equal(usage.inputTokens, 1700, "input summed across both models");
  assert.equal(usage.outputTokens, 340, "output summed across both models");
  assert.equal(usage.cacheReadTokens, 4000, "cacheRead summed");
  assert.equal(usage.cacheWriteTokens, 800, "cacheWrite summed");
  // The top-level snapshot would have undercounted input to just 100.
  assert.equal(
    mapResultUsage(message).inputTokens,
    100,
    "top-level usage is the final-request snapshot",
  );
});

test("mapResultEpochUsage falls back to top-level usage when modelUsage is absent/empty", () => {
  const noMap = resultMessage({
    usage: {
      input_tokens: 120,
      output_tokens: 8,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
    },
  });
  const emptyMap = resultMessage({
    usage: {
      input_tokens: 120,
      output_tokens: 8,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
    },
    modelUsage: {},
  });
  for (const message of [noMap, emptyMap]) {
    const usage = mapResultEpochUsage(message);
    assert.equal(usage.inputTokens, 120, "falls back to top-level input");
    assert.equal(usage.outputTokens, 8, "falls back to top-level output");
    assert.equal(
      usage.cacheReadTokens,
      300,
      "falls back to top-level cacheRead",
    );
    assert.equal(
      usage.cacheWriteTokens,
      50,
      "falls back to top-level cacheWrite",
    );
  }
});

test("mapResultMeta takes the window from the selected model's entry, never the epoch's busiest", () => {
  // An epoch that ran Opus before switching to Sonnet: the running total
  // still leads with Opus.
  const message = resultMessage({
    total_cost_usd: 1.1,
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 100_000,
        outputTokens: 5_000,
        contextWindow: 1_000_000,
      },
      "claude-sonnet-5-5": {
        inputTokens: 1_000,
        outputTokens: 100,
        contextWindow: 200_000,
      },
      // A helper model: a distinct window shows which entry was read.
      "claude-haiku-5-5": {
        inputTokens: 50_000,
        outputTokens: 1_000,
        contextWindow: 300_000,
      },
    },
  });
  assert.deepEqual(mapResultMeta(message, "opus"), {
    cost: 1.1,
    contextWindow: 1_000_000,
  });
  assert.deepEqual(mapResultMeta(message, "sonnet"), {
    cost: 1.1,
    contextWindow: 200_000,
  });
  // A concrete id selects like its alias; a model with no entry learns none.
  assert.equal(
    mapResultMeta(message, "claude-haiku-5-5").contextWindow,
    300_000,
  );
  assert.deepEqual(mapResultMeta(message, "fable"), { cost: 1.1 });
});

test("the captured model refusal names its API error type and the model-not-found signal", () => {
  const { assistant, result } = claudeRefusalMessages("claude-mythos-5-2", "s");
  const failed = resultProviderError(result as ClaudeResultMessage);
  assert.deepEqual(failed, {
    reason: "HTTP 404",
    text: CLAUDE_REFUSAL_TEXTS[0],
    statusCode: 404,
    apiErrorType: "not_found_error",
  });
  assert.equal(claudeModelNotFound(failed!), true);
  const synthetic = assistantProviderError(assistant as ClaudeAssistantMessage);
  assert.deepEqual(synthetic, {
    kind: "model_not_found",
    text: CLAUDE_REFUSAL_TEXTS[0],
  });
  assert.equal(claudeModelNotFound({ reason: synthetic!.kind }), true);
});

test("only model_not_found or a 404 not_found_error is the model-not-found signal", () => {
  assert.equal(claudeModelNotFound({ reason: "model_not_found" }), true);
  assert.equal(
    claudeModelNotFound({ statusCode: 404, apiErrorType: "not_found_error" }),
    true,
  );
  assert.equal(
    claudeModelNotFound({ statusCode: 404, apiErrorType: "api_error" }),
    false,
  );
  assert.equal(claudeModelNotFound({ statusCode: 404 }), false);
  assert.equal(
    claudeModelNotFound({ statusCode: 401, apiErrorType: "not_found_error" }),
    false,
  );
  assert.equal(claudeModelNotFound({ reason: "rate_limit" }), false);
});
