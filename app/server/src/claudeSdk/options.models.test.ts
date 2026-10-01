/**
 * Model-catalog and thinking-mapping tests for the Claude-SDK options.
 *
 * Run through the server Vitest suite:
 *   npm -w @assistant/server run test -- src/claudeSdk/options.models.test.ts
 *
 * Covers the curated model list (aliases → concrete `--model` ids), and the
 * Fable-specific thinking policy: Fable's thinking is always on, so it must use
 * adaptive thinking (never `disabled`, never a fixed `budgetTokens`) and its
 * picker levels must exclude `off`.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { buildClaudeSdkQueryOptions } from "./options.ts";
import {
  CLAUDE_SDK_MODELS,
  claudeSdkModelAlias,
  claudeSdkModelId,
  knownClaudeSdkModelAlias,
  reasoningToThinking,
} from "./modelSettings.ts";

test("curated model ids map aliases to concrete --model strings", () => {
  assert.equal(
    claudeSdkModelId("opus"),
    "claude-opus-5-5",
    "opus points at the current generation",
  );
  assert.equal(
    claudeSdkModelId("sonnet"),
    "claude-sonnet-5",
    "sonnet points at the current generation",
  );
  assert.equal(claudeSdkModelId("haiku"), "claude-haiku-4-5");
  assert.equal(claudeSdkModelId("fable"), "claude-fable-5-1");
});

test("alias normalization distinguishes recognized models from configuration fallbacks", () => {
  // Recognition is substring-based, so pin its breadth across BOTH Fable wire
  // generations — a narrowing to an exact-id check would strand one. This says
  // nothing about the store: a session persists the `fable` alias, never a wire
  // id. 5.1 is what assistant messages report after the switch. 5 still has to
  // resolve because a wire id also arrives as free-form configuration
  // (`settings.modelId`, client `setModel`), and that path runs through
  // `claudeSdkModelAlias`, whose Sonnet fallback WOULD rewrite the selection —
  // unlike reconciliation here, which simply skips an unrecognized id.
  assert.equal(knownClaudeSdkModelAlias("claude-fable-5-1"), "fable");
  assert.equal(knownClaudeSdkModelAlias("claude-fable-5"), "fable");
  assert.equal(knownClaudeSdkModelAlias("fable"), "fable");
  assert.equal(knownClaudeSdkModelAlias("claude-sonnet-5"), "sonnet");
  // The wire id the CLI reports back is normalized to the curated alias, so
  // reconciliation recognizes a session that ran on Opus 5.5 or on the 1M
  // variant, not just the plain id.
  assert.equal(knownClaudeSdkModelAlias("claude-opus-5-5"), "opus");
  assert.equal(knownClaudeSdkModelAlias("claude-opus-5-5[1m]"), "opus");
  assert.equal(
    knownClaudeSdkModelAlias("<synthetic>"),
    undefined,
    "provider sentinels are not real models",
  );
  assert.equal(knownClaudeSdkModelAlias(undefined), undefined);
  assert.equal(
    claudeSdkModelAlias("claude-fable-5"),
    "fable",
    "a configured pre-switch wire id resolves instead of falling back to sonnet",
  );
  assert.equal(
    claudeSdkModelAlias(undefined),
    "sonnet",
    "configuration input still defaults to sonnet",
  );
});

test("fable omits the off thinking level and has a 1M window", () => {
  const fable = CLAUDE_SDK_MODELS.find((m) => m.id === "fable");
  assert.ok(fable, "fable is in the curated list");
  assert.ok(
    !fable!.supportedThinkingLevels?.includes("off"),
    "fable does not offer disabled thinking",
  );
  assert.equal(fable!.contextWindow, 1_000_000);
});

test("adaptive models stream summarized thinking, never budget tokens", () => {
  for (const model of ["opus", "sonnet", "fable"] as const) {
    const high = reasoningToThinking("high", model);
    assert.deepEqual(
      high,
      { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      `${model} high`,
    );
    assert.deepEqual(
      reasoningToThinking("medium", model).thinking,
      { type: "adaptive", display: "summarized" },
      `${model} medium`,
    );
  }
});

test("opus/sonnet honor off as disabled; fable can never disable", () => {
  assert.deepEqual(reasoningToThinking("off", "opus"), {
    thinking: { type: "disabled" },
  });
  assert.deepEqual(reasoningToThinking("off", "sonnet"), {
    thinking: { type: "disabled" },
  });
  // Fable's off falls back to lowest-effort adaptive (disabled is a 400 there).
  assert.deepEqual(reasoningToThinking("off", "fable"), {
    thinking: { type: "adaptive", display: "summarized" },
    effort: "low",
  });
});

test("haiku 4.5 stays on manual budget tokens with no effort", () => {
  // Haiku predates adaptive and rejects `effort`; it must use enabled+budget.
  assert.deepEqual(reasoningToThinking("high", "haiku"), {
    thinking: { type: "enabled", budgetTokens: 16_384, display: "summarized" },
  });
  assert.equal(
    reasoningToThinking("high", "haiku").effort,
    undefined,
    "no effort param for haiku",
  );
  assert.deepEqual(reasoningToThinking("off", "haiku"), {
    thinking: { type: "disabled" },
  });
});

test("query options for fable resolve to the concrete model and adaptive thinking", () => {
  const opts = buildClaudeSdkQueryOptions({
    cwd: "/tmp",
    abortController: new AbortController(),
    modelId: "fable",
    thinkingLevel: "medium",
    agentType: "workshop",
  });
  assert.equal(opts.model, "claude-fable-5-1");
  assert.deepEqual(opts.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(opts.effort, "medium");
});
