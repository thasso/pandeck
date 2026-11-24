/**
 * Curated model options (`docs/agent-harnesses.md`, models port): the Claude
 * SDK's fixed model list, resolvable without loading any engine SDK. Kept apart
 * from `models.ts`, which reaches pi's registry and loads the pi SDK, so list
 * and row projections can name a Claude model cheaply.
 */
import {
  harnessForModelProvider,
  type Harness,
  type ModelOption,
} from "@assistant/shared";
import { sessionAgent } from "../agents/sessionAgent.ts";
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

/**
 * An existing Claude session's pin, for every check that judges its account:
 * the concrete version its agent definition pinned, while the session is
 * still on that agent's alias (the rule its query open applies). Both fields
 * are the stored `pinnedModel` string: it is the effective pin and the
 * persisted one a legacy allowance may match (`claudeSdk/modelResolution.ts`).
 * Empty for any other session or model.
 */
export function sessionClaudePin(
  sessionId: string,
  provider: string,
  modelId: string,
): { pinnedModelId?: string; persistedPinnedModelId?: string } {
  if (harnessForModelProvider(provider) !== "claude-sdk") return {};
  const agent = sessionAgent(sessionId);
  if (
    !agent?.pinnedModel ||
    claudeSdkModelAlias(modelId) !== claudeSdkModelAlias(agent.model)
  )
    return {};
  return {
    pinnedModelId: agent.pinnedModel,
    persistedPinnedModelId: agent.pinnedModel,
  };
}
