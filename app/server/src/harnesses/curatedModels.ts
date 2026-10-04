/**
 * Curated model options (`docs/agent-harnesses.md`, models port): the Claude
 * SDK's fixed model list, resolvable without loading any engine SDK. Kept apart
 * from `models.ts`, which reaches pi's registry and loads the pi SDK, so list
 * and row projections can name a Claude model cheaply.
 */
import type { Harness, ModelOption } from "@assistant/shared";
import {
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
