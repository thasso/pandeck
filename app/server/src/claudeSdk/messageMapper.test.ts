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
import type { ClaudeResultMessage } from "./messageMapper.ts";
import { mapResultEpochUsage, mapResultUsage } from "./messageMapper.ts";

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
