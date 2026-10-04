/**
 * Curated model options (`docs/agent-harnesses.md`, models port): the Claude
 * SDK's fixed model list, resolvable without loading any engine SDK. Kept apart
 * from `models.ts`, which reaches pi's registry and loads the pi SDK, so list
 * and row projections can name a Claude model cheaply.
 */
import type { Harness, ModelOption } from "@assistant/shared";
import {
  CLAUDE_SDK_MODELS,
  claudeSdkModelAlias,
  claudeSdkModelOption,
  knownClaudeSdkModelAlias,
} from "../claudeSdk/modelSettings.ts";

/**
 * The curated option for a model id, for a harness with a curated list (the
 * Claude SDK); undefined otherwise or when the id is unknown. A Claude row's
 * stored `provider` is the account kind (`claude`), so it resolves by alias.
 */
export function curatedModelOption(
  harness: Harness,
  modelId: string,
): ModelOption | undefined {
  if (harness !== "claude-sdk") return undefined;
  const alias = knownClaudeSdkModelAlias(modelId);
  return alias ? claudeSdkModelOption(alias) : undefined;
}

/** The Claude SDK alias a model id runs as; an unknown id runs as the default. */
export function claudeModelAlias(
  id: string | undefined,
): ReturnType<typeof claudeSdkModelAlias> {
  return claudeSdkModelAlias(id);
}

/** Every model id the Claude SDK's curated list offers. */
export function curatedClaudeModelIds(): string[] {
  return CLAUDE_SDK_MODELS.map((model) => model.id);
}
