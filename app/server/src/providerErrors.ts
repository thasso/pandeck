import type { ProviderErrorInfo, ProviderErrorKind } from "@assistant/shared";

export interface ProviderErrorContext {
  provider?: string;
  model?: string;
  api?: string;
  responseId?: string;
  authMode?: "subscription" | "api_key" | "unknown";
}

interface Classification {
  kind: ProviderErrorKind;
  title: string;
  summary: string;
  retryable?: boolean;
  detail: string;
}

const CONTENT_POLICY_RE =
  /flagged for possible cybersecurity risk|flagged as potentially violating|violat\w* (our |the )?usage polic|content[_ ]policy|content[_ ]filter|invalid_prompt|cyber_policy/i;
const QUOTA_RE =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage limit|plan limit|subscription limit|subscription.*(expired|inactive|required|quota|limit)|available balance|insufficient[_ -]?quota|out of budget|quota exceeded|credit balance|billing|payment required|spend(ing)? limit|exceeded your current quota/i;
const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b|retry after/i;
const TIMEOUT_RE =
  /timed? out|timeout|idle timeout|deadline exceeded|aborted due to timeout/i;
const AUTH_RE =
  /unauthorized|forbidden|invalid api key|invalid_api_key|permission denied|authentication|auth.*failed|401|403/i;
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
  const classification = classify(raw, codex);
  const providerValue = cleanOptional(context.provider);
  const modelValue = cleanOptional(context.model);
  const apiValue = cleanOptional(context.api);
  const responseIdValue = cleanOptional(context.responseId);
  return {
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
    ...codex,
  };
}

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
  parsed?: Partial<ProviderErrorInfo>,
): Classification {
  if (CONTENT_POLICY_RE.test(raw)) {
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
  if (parsed?.kind === "quota" || QUOTA_RE.test(raw)) {
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
  if (AUTH_RE.test(raw)) {
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
  if (RATE_LIMIT_RE.test(raw)) {
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
  if (TIMEOUT_RE.test(raw)) {
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
  if (SERVER_RE.test(raw)) {
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
