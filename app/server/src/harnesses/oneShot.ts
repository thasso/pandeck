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
 * engine exception drops its partial text and reports no new consumption.
 * Automatic account failures caused by limits or a dead login retry once on a
 * different account. Each measured attempt is recorded separately; returned
 * usage sums consumption, including any discarded first-attempt output.
 */
import {
  CLAUDE_SDK_PROVIDER,
  type Harness,
  type ThinkingLevel,
} from "@assistant/shared";
import type { AgentUsage } from "@assistant/shared/session";
import {
  OUTPUT_LIMIT_FAILURE,
  runClaudeSdkOneShot,
} from "../claudeSdk/oneShot.ts";
import type { ClaudeUsage } from "../claudeSdk/messageMapper.ts";
import type { AgentTool } from "../mcp/tool.ts";
import {
  findPiModelExact,
  runPiOneShot,
  selectPiModelWithFallback,
  type PiRegistryModel,
} from "../piSdk/oneShot.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  observeAccountHealth,
  reportAccountRunWorking,
  reportAccountRunFailure,
} from "../accountHealth.ts";
import { analyzeProviderError, runFailureFacts } from "../providerErrors.ts";
import { errorText } from "../errors.ts";
import {
  EnterpriseAccountRequiredError,
  resolveSlotAccount,
} from "../settingsModelSlots.ts";
import { credentialProfileById } from "../credentialProfiles.ts";
import type { RunFailureFacts } from "../session/adapters/contract.ts";
import { sourceRequiresEnterprise } from "../sessionEnterprise.ts";

export interface OneShotRequest {
  /** The configured model; its picker provider selects the harness. */
  model: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  /** Optional explicit slot pin. Unset selects an account for each run. */
  credentialProfileId?: string | undefined;
  /** Require an enterprise account for this automatically derived helper run. */
  requiresEnterprise?: boolean;
  /** Canonical sources of prompt/context; their true flag overrides caller false. */
  sourceSessionIds?: readonly string[];
  /**
   * What happens when the account does not offer the configured model.
   * `"helper"` (default) falls back to a cheap helper model; `"none"` refuses
   * with {@link NoHelperModelError}. Only pi accounts can lack a model.
   */
  modelFallback?: "helper" | "none";
  /** Message of the {@link NoHelperModelError}; only pi can lack a model. */
  noModelMessage?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  timeoutMessage: string;
  /** Explicit app-tool allowlist; built-in tools stay off on both engines. */
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
  failureStatus?: number;
  harness: Harness;
  /** Provider and model to record the run under. */
  recordedProvider: string;
  recordedModel: string;
}

type ResolvedOneShotRequest = OneShotRequest & { credentialProfileId: string };

type AttemptResult =
  | { run: EngineRun; failure?: RunFailureFacts }
  | { error: unknown; failure: RunFailureFacts; policyRejection?: true };

/** Run one helper prompt, retrying an automatic account once after a limit or dead login. */
export async function runOneShot(
  request: OneShotRequest,
): Promise<OneShotResult> {
  const requiresEnterprise = sourceRequiresEnterprise(
    [
      ...(request.sourceSessionIds ?? []),
      ...(request.record?.parentSessionId
        ? [request.record.parentSessionId]
        : []),
    ],
    request.requiresEnterprise,
  );
  // Freeze provenance before the picker or engine can yield to deletion/demotion.
  request = { ...request, requiresEnterprise };
  const { profileId } = await resolveSlotAccount({
    ...request.model,
    requiresEnterprise,
    thinkingLevel: request.thinkingLevel,
    ...(request.credentialProfileId !== undefined
      ? { credentialProfileId: request.credentialProfileId }
      : {}),
  });
  let attempt = await runAttempt({
    ...request,
    credentialProfileId: profileId,
  });
  let previousUsage: AgentUsage | undefined;
  const failure = attempt.failure;
  // A failed pin's automatic fallback is still explicit, never a retry license.
  if (
    !request.credentialProfileId?.trim() &&
    (failure?.kind === "quota" ||
      failure?.kind === "rate_limit" ||
      failure?.loginDeath)
  ) {
    const { pickAccount } = await import("../accountRouter.ts");
    // Failure to find a replacement must not obscure the original outcome.
    const next = await pickAccount({
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      excludeProfileIds: [profileId],
      requiresEnterprise,
      allowDisabledDefault: !requiresEnterprise,
    }).catch(() => null);
    if (
      next?.profileId &&
      next.profileId !== profileId &&
      (!requiresEnterprise || !next.degraded)
    ) {
      const replacement = await runAttempt({
        ...request,
        credentialProfileId: next.profileId,
      });
      // A candidate demoted after selection is unavailable, not a new run failure.
      if (!("error" in replacement && replacement.policyRejection)) {
        if ("run" in attempt) previousUsage = attempt.run.usage;
        attempt = replacement;
      }
    }
  }
  if ("error" in attempt) {
    // A replacement's unmeasured exception must not erase billed first-attempt usage.
    if (previousUsage && Object.keys(previousUsage).length)
      throw new OneShotError(errorText(attempt.error), previousUsage);
    throw attempt.error;
  }
  const { run } = attempt;
  const usage = previousUsage
    ? combinedUsage(previousUsage, run.usage)
    : run.usage;
  if (run.failure !== undefined && !run.text.trim())
    throw new OneShotError(run.failure, usage);
  return {
    text: run.text,
    usage,
    ...(run.failure !== undefined ? { failure: run.failure } : {}),
  };
}

/** Health and accounting belong to each attempt, including discarded partial output. */
async function runAttempt(
  request: ResolvedOneShotRequest,
): Promise<AttemptResult> {
  const startedAt = Date.now();
  const observation = observeAccountHealth(request.credentialProfileId);
  let healthModelProvider = request.model.provider;
  let run: EngineRun;
  try {
    assertCurrentEnterpriseAccount(request);
    run =
      request.model.provider === CLAUDE_SDK_PROVIDER
        ? await runOnClaude(request)
        : await runOnPi(request, (provider) => {
            healthModelProvider = provider;
          });
  } catch (err) {
    const message = errorText(err);
    const statusCode =
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      typeof err.status === "number"
        ? err.status
        : undefined;
    const failure = runFailureFacts(
      analyzeProviderError(message, {
        provider: healthModelProvider,
        ...(statusCode !== undefined ? { statusCode } : {}),
      }),
    );
    if (err instanceof EnterpriseAccountRequiredError)
      return { error: err, failure, policyRejection: true };
    reportAccountRunFailure(
      request.credentialProfileId,
      failure,
      healthModelProvider,
      observation,
    );
    return { error: err, failure };
  }
  // Classify the engine's status-bearing failure before wrapping it for callers.
  const failure =
    run.failure !== undefined
      ? runFailureFacts(
          analyzeProviderError(run.failure, {
            provider: healthModelProvider,
            ...(run.failureStatus !== undefined
              ? { statusCode: run.failureStatus }
              : {}),
          }),
        )
      : undefined;
  if (failure)
    reportAccountRunFailure(
      request.credentialProfileId,
      failure,
      healthModelProvider,
      observation,
    );
  else
    reportAccountRunWorking(
      request.credentialProfileId,
      healthModelProvider,
      observation,
    );
  if (request.record)
    sessionStore.createInternalUsageSession({
      purpose: request.record.purpose,
      title: request.record.title,
      harness: run.harness,
      provider: run.recordedProvider,
      model: run.recordedModel,
      thinkingLevel: request.thinkingLevel,
      requiresEnterprise: request.requiresEnterprise === true,
      ...(request.record.parentSessionId !== undefined
        ? { parentSessionId: request.record.parentSessionId }
        : {}),
      usage: run.usage,
      startedAt,
      completedAt: Date.now(),
    });
  return { run, ...(failure ? { failure } : {}) };
}

async function runOnClaude(
  request: ResolvedOneShotRequest,
): Promise<EngineRun> {
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
    ...(result.failureStatus !== undefined
      ? { failureStatus: result.failureStatus }
      : {}),
  };
}

async function runOnPi(
  request: ResolvedOneShotRequest,
  onModel: (provider: string) => void,
): Promise<EngineRun> {
  if (request.documents?.length)
    throw new Error("Document input needs a Claude model.");
  const model = await piModelFor(request);
  assertCurrentEnterpriseAccount(request);
  if (!model)
    throw new NoHelperModelError(
      request.noModelMessage ?? "No model is available for this helper run.",
    );
  onModel(model.provider);
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
            (result.stopReason === "length"
              ? OUTPUT_LIMIT_FAILURE
              : `The model stopped with ${result.stopReason}.`),
        }
      : {}),
  };
}

function assertCurrentEnterpriseAccount(request: ResolvedOneShotRequest): void {
  if (
    request.requiresEnterprise &&
    !credentialProfileById(request.credentialProfileId)?.enterprise
  )
    throw new EnterpriseAccountRequiredError();
}

function piModelFor(
  request: ResolvedOneShotRequest,
): Promise<PiRegistryModel | undefined> {
  const model = {
    provider: request.model.provider,
    modelId: request.model.modelId,
  };
  return request.modelFallback === "none"
    ? findPiModelExact(model, request.credentialProfileId)
    : selectPiModelWithFallback(model, request.credentialProfileId);
}

/** Sum consumption, but keep the final attempt's context snapshots. */
function combinedUsage(first: AgentUsage, last: AgentUsage): AgentUsage {
  const usage = { ...last };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "costUSD",
  ] as const) {
    if (first[key] !== undefined || last[key] !== undefined)
      usage[key] = (first[key] ?? 0) + (last[key] ?? 0);
  }
  return usage;
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
