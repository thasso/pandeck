/**
 * One-shot helper runs on either harness (`docs/agent-harnesses.md`): a single
 * prompt, no persisted session, no tools unless the caller passes an explicit
 * allowlist. The model's picker provider selects the engine; callers never
 * branch on it.
 *
 * Both engines answer with the same {@link OneShotResult}. A run that failed
 * without writing anything throws {@link OneShotError}; a run that failed after
 * writing some text returns that text with {@link OneShotResult.failure} set,
 * and the caller decides whether partial output is usable. A timeout or an
 * engine exception throws a plain `Error`, drops any partial text and is not
 * recorded: the engine never reported what it consumed.
 */
import {
  CLAUDE_SDK_PROVIDER,
  type Harness,
  type ThinkingLevel,
} from "@assistant/shared";
import type { AgentUsage } from "@assistant/shared/session";
import { runClaudeSdkOneShot } from "../claudeSdk/oneShot.ts";
import type { ClaudeUsage } from "../claudeSdk/messageMapper.ts";
import type { AgentTool } from "../mcp/tool.ts";
import {
  findPiModelExact,
  runPiOneShot,
  selectPiModelWithFallback,
  type PiRegistryModel,
} from "../piSdk/oneShot.ts";
import { sessionStore } from "../db/sessionStore.ts";

export interface OneShotRequest {
  /** The configured model; its picker provider selects the harness. */
  model: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  /** The account the run authenticates as (`accountForSlot`). */
  credentialProfileId: string;
  /**
   * What happens when the account does not offer the configured model.
   * `"helper"` (default) falls back to a cheap helper model; `"none"` refuses
   * with {@link NoHelperModelError}. Only pi accounts can lack a model.
   */
  modelFallback?: "helper" | "none";
  /** Message of the {@link NoHelperModelError} thrown when no model can run. */
  noModelMessage: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  timeoutMessage: string;
  /** Explicit app-tool allowlist; built-in tools stay disabled on both engines. */
  tools?: AgentTool[];
  /** Claude only: model/tool turn cap when tools are enabled (pi has none). */
  maxTurns?: number;
  /** Binary documents for the single user turn. Claude only; pi refuses. */
  documents?: Array<{ mimeType: string; dataBase64: string }>;
  /** Record the run as an internal usage session under this purpose. */
  record?: { purpose: string; title: string; parentSessionId?: string };
}

export interface OneShotResult {
  text: string;
  usage: AgentUsage;
  /** The run ended in an error or was aborted after writing {@link text}. */
  failure?: string;
}

/** The run failed before it wrote anything. Carries what it consumed. */
export class OneShotError extends Error {
  readonly usage: AgentUsage;

  constructor(message: string, usage: AgentUsage) {
    super(message);
    this.name = "OneShotError";
    this.usage = usage;
  }
}

/** No model on the request's account can run it. */
export class NoHelperModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoHelperModelError";
  }
}

interface EngineRun extends OneShotResult {
  harness: Harness;
  /** Provider and model to record the run under. */
  recordedProvider: string;
  recordedModel: string;
}

/** Run one helper prompt on the engine the request's model belongs to. */
export async function runOneShot(
  request: OneShotRequest,
): Promise<OneShotResult> {
  const startedAt = Date.now();
  const run =
    request.model.provider === CLAUDE_SDK_PROVIDER
      ? await runOnClaude(request)
      : await runOnPi(request);
  if (request.record)
    sessionStore.createInternalUsageSession({
      purpose: request.record.purpose,
      title: request.record.title,
      harness: run.harness,
      provider: run.recordedProvider,
      model: run.recordedModel,
      thinkingLevel: request.thinkingLevel,
      ...(request.record.parentSessionId !== undefined
        ? { parentSessionId: request.record.parentSessionId }
        : {}),
      usage: run.usage,
      startedAt,
      completedAt: Date.now(),
    });
  if (run.failure !== undefined && !run.text.trim())
    throw new OneShotError(run.failure, run.usage);
  return {
    text: run.text,
    usage: run.usage,
    ...(run.failure !== undefined ? { failure: run.failure } : {}),
  };
}

async function runOnClaude(request: OneShotRequest): Promise<EngineRun> {
  const result = await runClaudeSdkOneShot({
    modelId: request.model.modelId,
    thinkingLevel: request.thinkingLevel,
    credentialProfileId: request.credentialProfileId,
    systemPrompt: request.systemPrompt,
    prompt: request.prompt,
    timeoutMs: request.timeoutMs,
    timeoutMessage: request.timeoutMessage,
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
    ...(request.documents ? { documents: request.documents } : {}),
  });
  return {
    harness: "claude-sdk",
    recordedProvider: "claude",
    recordedModel: request.model.modelId,
    text: result.text,
    usage: agentUsageFromClaude(result.usage),
    ...(result.failure !== undefined ? { failure: result.failure } : {}),
  };
}

async function runOnPi(request: OneShotRequest): Promise<EngineRun> {
  if (request.documents?.length)
    throw new Error("Document input needs a Claude model.");
  const model = await piModelFor(request);
  if (!model) throw new NoHelperModelError(request.noModelMessage);
  const result = await runPiOneShot({
    model,
    credentialProfileId: request.credentialProfileId,
    thinkingLevel: request.thinkingLevel,
    systemPrompt: request.systemPrompt,
    prompt: request.prompt,
    timeoutMs: request.timeoutMs,
    timeoutMessage: request.timeoutMessage,
    ...(request.tools ? { tools: request.tools } : {}),
  });
  return {
    harness: "pi",
    recordedProvider: "pi",
    recordedModel: model.id,
    text: result.text,
    usage: result.usage,
    ...(result.stopReason
      ? {
          failure:
            result.errorMessage?.trim() ||
            `The model stopped with ${result.stopReason}.`,
        }
      : {}),
  };
}

function piModelFor(
  request: OneShotRequest,
): Promise<PiRegistryModel | undefined> {
  const model = {
    provider: request.model.provider,
    modelId: request.model.modelId,
  };
  return request.modelFallback === "none"
    ? findPiModelExact(model, request.credentialProfileId)
    : selectPiModelWithFallback(model, request.credentialProfileId);
}

function agentUsageFromClaude(usage: ClaudeUsage): AgentUsage {
  return {
    ...(usage.inputTokens !== undefined
      ? { inputTokens: usage.inputTokens }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { outputTokens: usage.outputTokens }
      : {}),
    ...(usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: usage.cacheReadTokens }
      : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { cacheCreationTokens: usage.cacheWriteTokens }
      : {}),
  };
}
