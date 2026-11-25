import {
  CLAUDE_SDK_PROVIDER,
  type ProviderErrorInfo,
  type ProviderErrorKind,
} from "@assistant/shared";
import {
  accountLimitModel,
  accountLimitMatches,
  isSubscriptionAccountModel,
} from "@assistant/shared/accountHealth";
import { isGatewayRefusal, isNeedsLoginRefusal } from "./gateway/refusals.ts";
import type { RunFailureFacts } from "./session/adapters/contract.ts";

export interface ProviderErrorContext {
  provider?: string;
  model?: string;
  api?: string;
  responseId?: string;
  authMode?: "subscription" | "api_key" | "unknown";
  statusCode?: number;
  /**
   * The harness saw a structured refusal (Claude: `stop_reason: "refusal"` or
   * `model_refusal_no_fallback`): a content refusal whatever its prose says.
   */
  structuredRefusal?: boolean;
  /** The structured refusal's category as the provider named it (`cyber`, …). */
  refusalCategory?: string;
  /**
   * The harness saw the provider's structured model-not-found signal (Claude:
   * `claudeSdk/messageMapper.ts` `claudeModelNotFound`): this account cannot
   * run the model, whatever its prose says.
   */
  modelUnavailable?: boolean;
}

function namedLimitModel(info: ProviderErrorInfo): string | undefined {
  if (!accountLimitModel(info.model)) return undefined;
  const generic =
    /^(?:usage|rate|plan|account|subscription|weekly|monthly|daily|model|your|this|the|organization|org)$/i;
  const forCap =
    /\b(?:limit|quota|cap)(?:\s+reached)?\s+(?:for|on)\s+(?:model\s+)?((?:(?:claude|codex|openai|anthropic)\s+)?[a-z0-9._-]+(?:\s+\d+(?:[.-]\d+)*)?)/i.exec(
      info.rawMessage,
    )?.[1];
  const candidates = [
    forCap,
    /\b(?:per[- ]model|model[- ]specific)\b/i.test(info.rawMessage)
      ? info.model
      : undefined,
    ...[
      ...info.rawMessage.matchAll(
        /\b([a-z0-9._-]+(?:\s+\d+(?:[.-]\d+)*)?)\s+(?:(?:usage|rate|weekly|monthly|daily)\s+)?(?:limit|quota|cap)\b/gi,
      ),
    ].map((match) => match[1]),
  ];
  const cap = candidates.find(
    (name) =>
      !!name && !generic.test(name) && accountLimitMatches(name, info.model),
  );
  return accountLimitModel(cap);
}

interface Classification {
  kind: ProviderErrorKind;
  title: string;
  summary: string;
  retryable?: boolean;
  detail: string;
}

const LOGIN_DEATH_RE =
  /\b401\b|\bunauthorized\b|authentication_error|invalid[ _]api[ _]key|please run \/login|not (?:logged|signed) in|oauth token (?:has (?:been )?)?(?:expired|revoked)|refresh[ _](?:token|credential)s? (?:is |was )?(?:invalid|expired|revoked|rejected)|no api key|invalid_grant/i;

const REJECTED_CREDENTIAL_RE =
  /\b(?:oauth[ _])?(?:access[ _]|refresh[ _])?(?:token|credential)s? (?:has (?:been )?|is |was )?(?:revoked|expired|rejected)\b/i;

/**
 * The text of a provider-shaped error body (`{ error: { message } }`) when the
 * credential gateway refused the request itself, else undefined.
 */
export function gatewayRefusalText(body: unknown): string | undefined {
  const error =
    body && typeof body === "object"
      ? (body as { error?: unknown }).error
      : undefined;
  const message =
    error && typeof error === "object"
      ? (error as { message?: unknown }).message
      : undefined;
  return typeof message === "string" && isGatewayRefusal(message)
    ? message
    : undefined;
}

export function isLoginDeath(
  message: string | undefined,
  context: ProviderErrorContext = {},
): boolean {
  if (!message) return false;
  // The credential gateway's own refusal says nothing about the login, whatever
  // status carries it: the Claude engine passes a 401 lease refusal's status.
  if (isGatewayRefusal(message)) return false;
  const status = context.statusCode ?? responseStatus(message);
  const codex =
    isSubscriptionAccountModel("openai-codex", context.provider) ||
    context.api === "openai-codex-responses" ||
    /^Codex error:/i.test(message) ||
    /OpenAI Codex token refresh failed/i.test(message);
  // Codex SSE drops HTTP status. Its bare auth prose cannot prove a dead login.
  if (codex && status === undefined) return false;
  // A known response status takes precedence over conflicting provider prose.
  if (status === 403) {
    const claude =
      context.provider === "anthropic" ||
      isSubscriptionAccountModel("claude", context.provider) ||
      (!context.provider &&
        !/^Codex error:/i.test(message) &&
        !/token refresh failed\s*\(/i.test(message) &&
        /API Error:\s*403\b/i.test(message));
    return claude && REJECTED_CREDENTIAL_RE.test(message);
  }
  if (status)
    return (
      status === 401 ||
      (status === 400 &&
        (/invalid_grant/i.test(message) ||
          (codex && REJECTED_CREDENTIAL_RE.test(message))))
    );
  return LOGIN_DEATH_RE.test(message) || REJECTED_CREDENTIAL_RE.test(message);
}

function responseStatus(message: string): number | undefined {
  const wrapped =
    /token refresh failed\s*\((\d{3})\)/i.exec(message)?.[1] ??
    /API Error:\s*(\d{3})\b/i.exec(message)?.[1] ??
    /^(\d{3}):\s*/.exec(message)?.[1];
  return (
    parseCodexError(message)?.statusCode ??
    (wrapped ? Number(wrapped) : undefined)
  );
}

/**
 * OpenAI Codex refusing a model the account cannot use, exactly as pi-ai 1.6.0
 * reports it (Task-1483 C1 capture): the WHOLE message, the id captured. A
 * sentence quoted inside a longer message never matches.
 */
const CODEX_MODEL_UNAVAILABLE_RE =
  /^(?:Codex error: )?The '([^'\s]{1,200})' model is not supported when using Codex with a ChatGPT account\.$/;
/**
 * The Claude CLI's wording for its `model_not_found` failure (Agent SDK
 * 0.3.329 capture), whole, the id captured. Its only known wrapper is the SDK
 * iterator's rethrow. A fallback: the Claude harness passes the structured
 * signal (`modelUnavailable`).
 */
const CLAUDE_MODEL_UNAVAILABLE_RE =
  /^(?:Claude Code returned an error result: )?There's an issue with the selected model \(([^()\s]{1,200})\)\. It may not exist or you may not have access to it\.$/;

/**
 * The model id a provider's own model-unavailable wording names, matched
 * against the whole trimmed message and only for the provider that wrote it;
 * undefined when the message is not that wording.
 */
function modelUnavailableNamedId(
  raw: string,
  provider: string | undefined,
): string | undefined {
  const text = raw.trim();
  if (provider === "openai-codex")
    return CODEX_MODEL_UNAVAILABLE_RE.exec(text)?.[1];
  if (provider === "anthropic" || provider === CLAUDE_SDK_PROVIDER)
    return CLAUDE_MODEL_UNAVAILABLE_RE.exec(text)?.[1];
  return undefined;
}

/** OpenAI Codex's cybersecurity flag, by its wording or its error code. */
const CYBER_REFUSAL_RE =
  /flagged for possible cybersecurity risk|cyber_policy/i;
const CONTENT_POLICY_RE =
  /flagged for possible cybersecurity risk|flagged as potentially violating|violat\w* (our |the )?usage polic|content[_ ]policy|content[_ ]filter|invalid_prompt|cyber_policy/i;
const QUOTA_RE =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage limit|plan limit|subscription limit|subscription.*(expired|inactive|required|quota|limit)|available balance|insufficient[_ -]?quota|out of budget|quota exceeded|credit balance|billing|payment required|spend(ing)? limit|exceeded your current quota/i;
// Claude Code 2.1.296 renders rejected limits as "You've hit your <name> · resets …".
const CLAUDE_USAGE_LIMIT_RE =
  /\b(?:session|weekly|monthly|daily|usage)\s+limit\s+reached\b|\b(?:you['’]ve|you have)\s+hit\s+your\s+[^·∙\n]*\blimit\b/i;
const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b|retry after/i;
const TIMEOUT_RE =
  /timed? out|timeout|idle timeout|deadline exceeded|aborted due to timeout/i;
const AUTH_RE =
  /forbidden|permission denied|authentication|auth.*failed|\b403\b|token refresh failed/i;
const SERVER_RE =
  /overloaded|provider.?returned.?error|\b500\b|\b502\b|\b503\b|\b504\b|service.?unavailable|server.?error|internal.?error/i;
const NETWORK_RE =
  /network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|http2 request did not get a response|terminated|stream ended/i;

export function analyzeProviderError(
  rawMessage: string,
  context: ProviderErrorContext = {},
): ProviderErrorInfo {
  const raw = rawMessage.trim() || "Unknown provider error";
  const codex = parseCodexError(raw);
  // This pipe suffix carries epoch seconds, unlike human "resets …" text.
  const claudeResetAt = numberValue(
    /\bClaude AI usage limit reached\|(\d+)$/.exec(raw)?.[1],
  );
  const classification = classify(raw, codex, context);
  const statusCode = context.statusCode ?? responseStatus(raw);
  const providerValue = cleanOptional(context.provider);
  const modelValue = cleanOptional(context.model);
  const apiValue = cleanOptional(context.api);
  const responseIdValue = cleanOptional(context.responseId);
  const refusalCategory =
    classification.kind === "content_policy"
      ? refusalCategoryOf(raw, context)
      : undefined;
  return {
    ...codex,
    ...(claudeResetAt !== undefined ? { resetAt: claudeResetAt } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    kind: classification.kind,
    title: classification.title,
    summary: classification.summary,
    rawMessage: raw,
    ...(classification.retryable !== undefined
      ? { retryable: classification.retryable }
      : {}),
    ...(providerValue !== undefined ? { provider: providerValue } : {}),
    ...(modelValue !== undefined ? { model: modelValue } : {}),
    ...(apiValue !== undefined ? { api: apiValue } : {}),
    ...(responseIdValue !== undefined ? { responseId: responseIdValue } : {}),
    authMode: context.authMode ?? "unknown",
    detail: classification.detail,
    ...(refusalCategory !== undefined ? { refusalCategory } : {}),
  };
}

/**
 * A content refusal's category: the structured one the harness passed, else
 * `cyber` for OpenAI's cybersecurity flag. Any other refusal has none.
 */
function refusalCategoryOf(
  raw: string,
  context: ProviderErrorContext,
): string | undefined {
  const structured = context.refusalCategory?.trim().toLowerCase();
  if (structured && /^[a-z0-9_-]{1,40}$/.test(structured)) return structured;
  // A structured refusal names its category or has none: its prose is the
  // model's own text, which may mention anything.
  if (context.structuredRefusal === true) return undefined;
  return CYBER_REFUSAL_RE.test(raw) ? "cyber" : undefined;
}

/**
 * The structured part of a classified failure, for consumers that must not
 * read the provider's prose (`delegationFailureNotice.ts`). The reset time is
 * passed on only for a usage or rate limit whose provider stated it as a field
 * (`resetAt`), never derived from a relative duration or from wording.
 */
/**
 * The facts of a run PA itself refused before any provider call: never
 * re-analyzed from its text, and `kind: "unknown"` keeps every kind-keyed
 * consumer inert even where it ignores the marker.
 */
export function localPolicyRunFailure(): RunFailureFacts {
  return { kind: "unknown", localPolicy: true };
}

export function runFailureFacts(
  info: ProviderErrorInfo,
  options: {
    /**
     * The concrete model id the harness actually ran (Claude: the query's
     * resolved id, never the alias). Without it a `model_unavailable` failure
     * records no model: nothing would say which one was refused.
     */
    executingModelId?: string;
  } = {},
): RunFailureFacts {
  const unavailableModelId = refusedModelId(info, options.executingModelId);
  const limited = info.kind === "quota" || info.kind === "rate_limit";
  const resetAtMs =
    limited && typeof info.resetAt === "number"
      ? info.resetAt * 1000
      : undefined;
  const limitModel = limited ? namedLimitModel(info) : undefined;
  return {
    kind: info.kind,
    ...(isSubscriptionAccountModel("openai-codex", info.provider) &&
    /invalid[_ -]encrypted[_ -]content|encrypted.{0,160}(?:cannot|could not|unable to|failed to).{0,20}(?:decrypt|verif|validat)|(?:cannot|could not|unable to|failed to).{0,20}(?:decrypt|verif|validat).{0,160}encrypted|reasoning.{0,30}signature.{0,30}invalid/i.test(
      info.rawMessage,
    )
      ? { encryptedReasoningRejected: true as const }
      : {}),
    ...(limitModel ? { limitModel } : {}),
    ...(info.kind === "auth" && isLoginDeath(info.rawMessage, info)
      ? { loginDeath: true }
      : {}),
    ...(isNeedsLoginRefusal(info.rawMessage)
      ? { gatewayNeedsLogin: true as const }
      : {}),
    ...(info.kind === "content_policy" && info.refusalCategory === "cyber"
      ? { cyberRefusal: true as const }
      : {}),
    ...(unavailableModelId !== undefined ? { unavailableModelId } : {}),
    // Checked after the conversion: seconds that look fine can still overflow
    // into a number no `Date` represents.
    ...(resetAtMs !== undefined &&
    Number.isFinite(resetAtMs) &&
    resetAtMs > 0 &&
    resetAtMs <= MAX_DATE_MS
      ? { resetAtMs }
      : {}),
  };
}

/**
 * The executing id of a `model_unavailable` failure, when the provider's
 * wording names no id or exactly that one. A message naming another model
 * (a quoted id the run never executed) marks nothing.
 */
function refusedModelId(
  info: ProviderErrorInfo,
  executingModelId: string | undefined,
): string | undefined {
  const executing = executingModelId?.trim();
  if (info.kind !== "model_unavailable" || !executing) return undefined;
  const named = modelUnavailableNamedId(info.rawMessage, info.provider);
  return named === undefined || named === executing ? executing : undefined;
}

/**
 * Whether a failed run ended its account's login. For an account the gateway
 * serves (`gatewayLink.ts` `gatewayServesProfile`), only the gateway's
 * needs-login refusal does: it renews the login itself, so a 401 after its
 * renewal is transient. Any other account keeps the dead-login evidence.
 */
export function loginEnded(
  facts: RunFailureFacts | undefined,
  gatewayServed: boolean,
): boolean {
  return gatewayServed
    ? facts?.gatewayNeedsLogin === true
    : facts?.loginDeath === true;
}

/** The largest instant a JavaScript `Date` represents. */
const MAX_DATE_MS = 8.64e15;

const RAW_DISPLAY_LIMIT = 400;

export function providerErrorDisplayText(info: ProviderErrorInfo): string {
  const model =
    [info.provider, info.model].filter(Boolean).join("/") || "selected model";
  // An unclassified summary says nothing on its own, and a refusal's reason
  // decides what to do next, so both show what the provider actually said.
  const text =
    info.kind === "unknown"
      ? truncate(info.rawMessage)
      : info.kind === "content_policy"
        ? `${info.summary} Provider message: ${truncate(info.rawMessage)}`
        : info.summary;
  return `${info.title} (${model}): ${text}`;
}

function truncate(text: string): string {
  return text.length > RAW_DISPLAY_LIMIT
    ? `${text.slice(0, RAW_DISPLAY_LIMIT - 1)}…`
    : text;
}

export function shouldSuppressProviderRetry(
  info: ProviderErrorInfo | undefined,
): boolean {
  return Boolean(info && info.retryable === false);
}

function classify(
  raw: string,
  parsed: Partial<ProviderErrorInfo> | undefined,
  context: ProviderErrorContext,
): Classification {
  const loginDeath = isLoginDeath(raw, context);
  // A gateway refusal is never a content, quota or auth verdict on the account:
  // it falls to its status class, or to `unknown`, which shows its text.
  const gatewayRefusal = isGatewayRefusal(raw);
  const status = context.statusCode ?? responseStatus(raw);
  const serverStatus = (status ?? 0) >= 500;
  const claudeUsageLimit =
    (isSubscriptionAccountModel("claude", context.provider) ||
      context.provider === "anthropic") &&
    CLAUDE_USAGE_LIMIT_RE.test(raw) &&
    !/rate.?limit|too many requests/i.test(raw);
  // The provider cannot run this model for this account. Only its structured
  // signal or its exact wording says so, and never against a gateway refusal
  // (its own 404 included), a content refusal, a status that names another
  // fault, or dead-login wording.
  if (
    !gatewayRefusal &&
    context.structuredRefusal !== true &&
    !loginDeath &&
    !serverStatus &&
    status !== 401 &&
    status !== 403 &&
    status !== 429 &&
    (context.modelUnavailable === true ||
      modelUnavailableNamedId(raw, context.provider) !== undefined)
  )
    return {
      kind: "model_unavailable",
      title: "Model not available on this account",
      summary:
        "The provider says this account can't run this model: it may not exist, or the account isn't entitled to it.",
      retryable: false,
      detail:
        "Pick another model, or run this one on an account that offers it.",
    };
  const contentRefusal =
    context.structuredRefusal === true ||
    (!gatewayRefusal &&
      !loginDeath &&
      !serverStatus &&
      status !== 429 &&
      CONTENT_POLICY_RE.test(raw));
  if (contentRefusal && refusalCategoryOf(raw, context) === "cyber")
    return {
      kind: "content_policy",
      title: "Provider flagged possible cybersecurity risk",
      summary:
        "The provider flagged this conversation for possible cybersecurity risk, so sending it again on the same account will likely be refused again.",
      retryable: false,
      detail:
        "A session on a personal subscription account moves to an eligible enterprise account automatically when one is available, and its transcript notes the move; with none, enable one and send again. If it was already on an enterprise account, narrow the request or hand the work to a fresh session.",
    };
  if (contentRefusal) {
    return {
      kind: "content_policy",
      title: "Provider refused the content",
      summary:
        "The provider's safety filter flagged this conversation. Every retry resends the same context, so it will likely be refused again.",
      retryable: false,
      detail:
        "Start a fresh session with a short handoff that leaves out the flagged material, or switch to a different model/provider.",
    };
  }
  if (
    !gatewayRefusal &&
    !loginDeath &&
    !serverStatus &&
    (parsed?.kind === "quota" || QUOTA_RE.test(raw) || claudeUsageLimit)
  ) {
    const reset = parsed?.resetInSeconds
      ? ` Resets ${formatDuration(parsed.resetInSeconds)} from the error timestamp.`
      : "";
    return {
      kind: "quota",
      title: "Model usage limit reached",
      summary: `The provider reported a subscription, quota, balance, or billing limit.${reset}`,
      retryable: false,
      detail:
        "Immediate retries are unlikely to help. Switch model/provider, wait for the provider reset window, or update the subscription/billing state.",
    };
  }
  if (
    !gatewayRefusal &&
    (loginDeath ||
      (!serverStatus &&
        status !== 429 &&
        (AUTH_RE.test(raw) ||
          LOGIN_DEATH_RE.test(raw) ||
          REJECTED_CREDENTIAL_RE.test(raw))))
  ) {
    return {
      kind: "auth",
      title: "Model authentication failed",
      summary:
        "The provider rejected the configured credentials or account access.",
      retryable: false,
      detail:
        "Refresh login credentials or choose a model/provider with valid authentication before retrying.",
    };
  }
  if (!serverStatus && (status === 429 || RATE_LIMIT_RE.test(raw))) {
    return {
      kind: "rate_limit",
      title: "Provider rate limit hit",
      summary:
        "The provider asked us to slow down or rejected the request as too frequent.",
      retryable: true,
      detail:
        "A delayed retry may work unless the message also mentions a daily/monthly quota or billing limit.",
    };
  }
  if (!serverStatus && TIMEOUT_RE.test(raw)) {
    return {
      kind: "timeout",
      title: "Provider request timed out",
      summary:
        "The model provider did not return a response before the request timeout.",
      retryable: true,
      detail:
        "This can be transient, caused by provider overload, networking, or a long-running request. Retrying or switching model may help.",
    };
  }
  if (serverStatus || SERVER_RE.test(raw)) {
    return {
      kind: "server",
      title: "Provider service error",
      summary: "The model provider returned a server-side failure.",
      retryable: true,
      detail: "This is usually transient; a delayed retry may help.",
    };
  }
  if (NETWORK_RE.test(raw)) {
    return {
      kind: "network",
      title: "Provider connection failed",
      summary:
        "The connection to the model provider failed before the response completed.",
      retryable: true,
      detail:
        "This is usually transient; check connectivity or retry after a short delay.",
    };
  }
  return {
    kind: "unknown",
    title: "Provider error",
    summary:
      "The model provider returned an error that could not be classified.",
    // `retryable` omitted: unclassified, so neither safe nor unsafe to retry.
    detail:
      "Review the raw provider message. If it mentions quota, billing, or subscription limits, retries should be avoided.",
  };
}

function parseCodexError(raw: string): Partial<ProviderErrorInfo> | undefined {
  if (!/^Codex error:/i.test(raw)) return undefined;
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) return undefined;
  try {
    const payload = JSON.parse(raw.slice(jsonStart)) as {
      error?: {
        type?: unknown;
        message?: unknown;
        plan_type?: unknown;
        resets_at?: unknown;
        resets_in_seconds?: unknown;
      };
      status_code?: unknown;
      headers?: Record<string, unknown>;
    };
    const headers = payload.headers ?? {};
    const errorType = stringValue(payload.error?.type);
    const statusCode = numberValue(payload.status_code);
    const planType =
      stringValue(payload.error?.plan_type) ??
      stringValue(headers["X-Codex-Plan-Type"]);
    const limitType = stringValue(headers["X-Codex-Rate-Limit-Reached-Type"]);
    const activeLimit = stringValue(headers["X-Codex-Active-Limit"]);
    const primaryUsed = numberValue(headers["X-Codex-Primary-Used-Percent"]);
    const secondaryUsed = numberValue(
      headers["X-Codex-Secondary-Used-Percent"],
    );
    const primaryWindow = numberValue(
      headers["X-Codex-Primary-Window-Minutes"],
    );
    const secondaryWindow = numberValue(
      headers["X-Codex-Secondary-Window-Minutes"],
    );
    const primaryResetAt = numberValue(headers["X-Codex-Primary-Reset-At"]);
    const secondaryResetAt = numberValue(headers["X-Codex-Secondary-Reset-At"]);
    const resetAt =
      numberValue(payload.error?.resets_at) ??
      secondaryResetAt ??
      primaryResetAt;
    const resetInSeconds =
      numberValue(payload.error?.resets_in_seconds) ??
      numberValue(headers["X-Codex-Secondary-Reset-After-Seconds"]) ??
      numberValue(headers["X-Codex-Primary-Reset-After-Seconds"]);
    const facts = [
      fact("Status", statusCode ? `${statusCode}` : undefined),
      fact("Plan", planType),
      fact("Limit", limitType),
      fact("Active limit", activeLimit),
      fact(
        "Primary used",
        primaryUsed !== undefined
          ? `${primaryUsed}%${primaryWindow ? ` / ${primaryWindow}m` : ""}`
          : undefined,
      ),
      fact(
        "Secondary used",
        secondaryUsed !== undefined
          ? `${secondaryUsed}%${secondaryWindow ? ` / ${secondaryWindow}m` : ""}`
          : undefined,
      ),
      fact(
        "Primary reset",
        primaryResetAt ? formatEpochSeconds(primaryResetAt) : undefined,
      ),
      fact(
        "Secondary reset",
        secondaryResetAt ? formatEpochSeconds(secondaryResetAt) : undefined,
      ),
    ].filter((item): item is { label: string; value: string } => Boolean(item));
    return {
      ...(errorType === "usage_limit_reached" || statusCode === 429
        ? { kind: "quota" }
        : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(planType !== undefined ? { planType } : {}),
      ...(limitType !== undefined ? { limitType } : {}),
      ...(activeLimit !== undefined ? { activeLimit } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
      ...(resetInSeconds !== undefined ? { resetInSeconds } : {}),
      facts,
    };
  } catch {
    return undefined;
  }
}

function fact(
  label: string,
  value: string | undefined,
): { label: string; value: string } | undefined {
  return value ? { label, value } : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))
    return Number(value);
  return undefined;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `in ${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

function formatEpochSeconds(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

function cleanOptional(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}
