/**
 * Model-refusal captures for Task-1483 (C1), copied byte for byte from the
 * sanitized outputs of the user's 2026-11-25 live runs
 * (pa://knowledge/plans/pandeck/task-1483/evidence-c1-refusal-captures-2026-11-25.md):
 * Claude Agent SDK 0.3.329 on an account without the model, and pi-ai 1.6.0's
 * `openai-codex` provider on both ChatGPT accounts. Model ids and provider
 * wording only: no account, token or credential.
 */
import type { ClaudeSdkMessage } from "../claudeSdk/sdkSeam.ts";

/** The refused Claude runs: the unentitled id, then an invented one. */
export const CLAUDE_REFUSED_MODELS = [
  "claude-mythos-5-2",
  "claude-nonexistent-0",
] as const;

/** Each refused run's synthetic assistant text, as captured. */
export const CLAUDE_REFUSAL_TEXTS = [
  "There's an issue with the selected model (claude-mythos-5-2). It may not exist or you may not have access to it.",
  "There's an issue with the selected model (claude-nonexistent-0). It may not exist or you may not have access to it.",
] as const;

/** What the SDK iterator threw after each refused run's result. */
export const CLAUDE_REFUSAL_THROWN = [
  "Claude Code returned an error result: There's an issue with the selected model (claude-mythos-5-2). It may not exist or you may not have access to it.",
  "Claude Code returned an error result: There's an issue with the selected model (claude-nonexistent-0). It may not exist or you may not have access to it.",
] as const;

/** The refused runs' synthetic assistant fields, as captured. */
const CLAUDE_REFUSAL_ASSISTANT = {
  error: "model_not_found",
  model: "<synthetic>",
  stop_reason: "stop_sequence",
} as const;

/** The first refused run's `result` message, every captured field. */
export const CLAUDE_REFUSAL_RESULT = {
  duration_api_ms: 0,
  stop_reason: "stop_sequence",
  total_cost_usd: 0,
  terminal_reason: "api_error",
  fast_mode_state: "off",
  fast_mode_disabled_reason: "sdk_opt_in_required",
  subagent_stats: {
    spawned: 0,
    requested: {
      background: 0,
      foreground: 0,
      unset: 0,
    },
    started_in_background: 0,
    max_depth: 0,
    spawned_by_subagents: 0,
    completed: 0,
    failed: 0,
    killed: {
      parent: 0,
      user: 0,
      system: 0,
    },
    refused: {
      depth_limit: 0,
      concurrency_limit: 0,
      budget: 0,
    },
    by_type: {},
  },
  safety_stops: 0,
  is_error: true,
  num_turns: 1,
  subtype: "success",
  api_error_status: 404,
  api_error_type: "not_found_error",
  result:
    "There's an issue with the selected model (claude-mythos-5-2). It may not exist or you may not have access to it.",
  type: "result",
  duration_ms: 1036,
  queued_turn_count: 0,
  result_index: 0,
  model_usage_since_last_result: {},
} as const;

/** pi's `errorMessage` for the two refused Codex runs, identical on both accounts. */
export const CODEX_REFUSAL_MESSAGES = [
  "Codex error: The 'gpt-4o' model is not supported when using Codex with a ChatGPT account.",
  "Codex error: The 'gpt-nonexistent-0' model is not supported when using Codex with a ChatGPT account.",
] as const;

/** The Codex ids those messages were captured for. */
export const CODEX_REFUSED_MODELS = ["gpt-4o", "gpt-nonexistent-0"] as const;

/**
 * The captured Claude refusal sentence for another model id: the measured
 * wording with only the id replaced (checked against both captures).
 */
export function claudeRefusalText(modelId: string): string {
  return CLAUDE_REFUSAL_TEXTS[0].replace(CLAUDE_REFUSED_MODELS[0], modelId);
}

/** The captured Codex refusal for another model id, only the id replaced. */
export function codexRefusalText(modelId: string): string {
  return CODEX_REFUSAL_MESSAGES[0].replace(
    `'${CODEX_REFUSED_MODELS[0]}'`,
    `'${modelId}'`,
  );
}

/** What the SDK iterator throws after a refusal of `modelId`. */
export function claudeRefusalThrown(modelId: string): string {
  return CLAUDE_REFUSAL_THROWN[0].replace(CLAUDE_REFUSED_MODELS[0], modelId);
}

/**
 * A refused Claude run as the SDK yields it, in the SDK's message shape: the
 * synthetic assistant message, then the result, with the captured fields and
 * only the model id replaced.
 */
export function claudeRefusalMessages(
  modelId: string,
  sessionId: string,
): { assistant: ClaudeSdkMessage; result: ClaudeSdkMessage } {
  const text = claudeRefusalText(modelId);
  return {
    assistant: {
      type: "assistant",
      uuid: `refusal-${modelId}`,
      session_id: sessionId,
      parent_tool_use_id: null,
      error: CLAUDE_REFUSAL_ASSISTANT.error,
      message: {
        id: `refusal-message-${modelId}`,
        role: "assistant",
        model: CLAUDE_REFUSAL_ASSISTANT.model,
        stop_reason: CLAUDE_REFUSAL_ASSISTANT.stop_reason,
        content: [{ type: "text", text }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } as unknown as ClaudeSdkMessage,
    result: {
      ...CLAUDE_REFUSAL_RESULT,
      session_id: sessionId,
      result: text,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    } as unknown as ClaudeSdkMessage,
  };
}
