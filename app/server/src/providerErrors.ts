import type { ProviderErrorInfo, ProviderErrorKind } from "@assistant/shared";
import {
  accountLimitModel,
  accountLimitMatches,
  isSubscriptionAccountModel,
} from "@assistant/shared/accountHealth";
import type { RunFailureFacts } from "./session/adapters/contract.ts";

export interface ProviderErrorContext {
  provider?: string;
  model?: string;
  api?: string;
  responseId?: string;
  authMode?: "subscription" | "api_key" | "unknown";
  statusCode?: number;
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

export function isLoginDeath(
  message: string | undefined,
  context: ProviderErrorContext = {},
): boolean {
  if (!message) return false;
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
  };
}

/**
 * The structured part of a classified failure, for consumers that must not
 * read the provider's prose (`delegationFailureNotice.ts`). The reset time is
 * passed on only for a usage or rate limit whose provider stated it as a field
 * (`resetAt`), never derived from a relative duration or from wording.
 */
export function runFailureFacts(info: ProviderErrorInfo): RunFailureFacts {
  const limited = info.kind === "quota" || info.kind === "rate_limit";
  const resetAtMs =
    limited && typeof info.resetAt === "number"
      ? info.resetAt * 1000
      : undefined;
  const limitModel = limited ? namedLimitModel(info) : undefined;
  return {
    kind: info.kind,
    ...(limitModel ? { limitModel } : {}),
    ...(info.kind === "auth" && isLoginDeath(info.rawMessage, info)
      ? { loginDeath: true }
      : {}),
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
  const status = context.statusCode ?? responseStatus(raw);
  const serverStatus = (status ?? 0) >= 500;
  const claudeUsageLimit =
    (isSubscriptionAccountModel("claude", context.provider) ||
      context.provider === "anthropic") &&
    CLAUDE_USAGE_LIMIT_RE.test(raw) &&
    !/rate.?limit|too many requests/i.test(raw);
  if (
    !loginDeath &&
    !serverStatus &&
    status !== 429 &&
    CONTENT_POLICY_RE.test(raw)
  ) {
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
    loginDeath ||
    (!serverStatus &&
      status !== 429 &&
      (AUTH_RE.test(raw) ||
        LOGIN_DEATH_RE.test(raw) ||
        REJECTED_CREDENTIAL_RE.test(raw)))
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
