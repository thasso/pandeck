/**
 * Fetches the Claude account's usage/rate-limit snapshot (Usage page) via a
 * minimal, throwaway Claude Agent SDK query.
 *
 * No model turn ever runs: the prompt is a streaming-input generator that
 * never yields, so the CLI subprocess starts and initializes without a
 * conversation turn (no tokens spent). We call the SDK's experimental
 * `usage_EXPERIMENTAL_…` control request as soon as the query exists, then
 * abort/close it.
 */
import { CWD } from "../config.ts";
import { packagedClaudeSdkOptions } from "../runtimeAssets.ts";
import {
  claudeProfileEnvironment,
  defaultClaudeProfileId,
} from "../credentialProfiles.ts";
import type {
  ClaudeUsageSnapshot,
  UsageBehaviorWindow,
  UsageGenericLimit,
  UsageModelScoped,
} from "@assistant/shared/usage";
import {
  CLAUDE_SDK_HARNESS_SETTINGS,
  claudeSdkModelId,
} from "./modelSettings.ts";
import {
  buildRealClaudeSdkSeam,
  type ClaudeSdkOptions,
  type ClaudeSdkSeam,
  type ClaudeSdkUserMessage,
} from "./sdkSeam.ts";

const ALL_NATIVE_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "TodoWrite",
  "NotebookRead",
  "NotebookEdit",
];

/** Test seam override; defaults to the real installed SDK. */
let seamFactory: () => Promise<ClaudeSdkSeam> = buildRealClaudeSdkSeam;

/** Inject a fake seam (tests only). */
export function setClaudeSdkUsageSeam(
  factory: () => Promise<ClaudeSdkSeam>,
): void {
  seamFactory = factory;
}

/** Never yields — keeps the query's stdin open with no turn to run. */
// eslint-disable-next-line require-yield -- parking forever IS the contract: the SDK needs an AsyncGenerator that never produces a turn.
async function* neverEndingPrompt(): AsyncGenerator<ClaudeSdkUserMessage> {
  await new Promise<never>(() => {});
}

function buildUsageQueryOptions(
  abortController: AbortController,
  credentialProfileId = defaultClaudeProfileId(),
): ClaudeSdkOptions {
  return {
    cwd: CWD,
    abortController,
    ...packagedClaudeSdkOptions(),
    env: claudeProfileEnvironment(credentialProfileId),
    model: claudeSdkModelId("haiku"),
    tools: [],
    disallowedTools: ALL_NATIVE_TOOLS,
    allowedTools: [],
    settingSources: [],
    settings: CLAUDE_SDK_HARNESS_SETTINGS,
    maxTurns: 1,
  } as ClaudeSdkOptions;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapLimitWindow(
  raw: unknown,
): { utilizationPct: number | null; resetsAt: string | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  return {
    utilizationPct: numberOrNull(w.utilization),
    resetsAt: stringOrNull(w.resets_at),
  };
}

function mapGenericLimits(raw: unknown): UsageGenericLimit[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): UsageGenericLimit[] => {
    if (!entry || typeof entry !== "object") return [];
    const l = entry as Record<string, unknown>;
    const scope =
      l.scope && typeof l.scope === "object"
        ? (l.scope as Record<string, unknown>)
        : null;
    const model =
      scope?.model && typeof scope.model === "object"
        ? (scope.model as Record<string, unknown>)
        : null;
    return [
      {
        kind: stringOrNull(l.kind) ?? "unknown",
        group: stringOrNull(l.group) ?? "unknown",
        percent: numberOrNull(l.percent),
        severity: stringOrNull(l.severity),
        resetsAt: stringOrNull(l.resets_at),
        scope: scope
          ? {
              modelDisplayName: stringOrNull(model?.display_name),
              surface: stringOrNull(scope.surface),
            }
          : null,
        isActive: l.is_active === true,
      },
    ];
  });
}

function mapExtraUsage(raw: unknown): ClaudeUsageSnapshot["extraUsage"] {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  return {
    enabled: e.is_enabled === true,
    monthlyLimit: numberOrNull(e.monthly_limit),
    usedCredits: numberOrNull(e.used_credits),
    utilizationPct: numberOrNull(e.utilization),
    currency: stringOrNull(e.currency),
    // `monthly_limit`/`used_credits` are minor units (cents); this is the divisor exponent.
    decimalPlaces: numberOrNull(e.decimal_places),
  };
}

function mapModelScoped(raw: unknown): UsageModelScoped[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): UsageModelScoped[] => {
    if (!entry || typeof entry !== "object") return [];
    const m = entry as Record<string, unknown>;
    return [
      {
        modelDisplayName: stringOrNull(m.display_name),
        utilizationPct: numberOrNull(m.utilization),
        resetsAt: stringOrNull(m.resets_at),
      },
    ];
  });
}

function mapBehaviorWindow(raw: unknown): UsageBehaviorWindow {
  const w =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const behaviors = Array.isArray(w.behaviors)
    ? w.behaviors.flatMap((b): UsageBehaviorWindow["behaviors"] => {
        if (!b || typeof b !== "object") return [];
        const item = b as Record<string, unknown>;
        return [
          {
            key: stringOrNull(item.key) ?? "unknown",
            pct: numberOrNull(item.pct) ?? 0,
            count: numberOrNull(item.count) ?? 0,
          },
        ];
      })
    : [];
  const contributors: UsageBehaviorWindow["topContributors"] = [];
  const collect = (
    key: "agents" | "skills" | "plugins" | "mcp_servers",
    kind: UsageBehaviorWindow["topContributors"][number]["kind"],
  ) => {
    const list = w[key];
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const name = stringOrNull(row.name);
      const pct = numberOrNull(row.pct);
      if (name && pct !== null) contributors.push({ name, pct, kind });
    }
  };
  collect("agents", "agent");
  collect("skills", "skill");
  collect("plugins", "plugin");
  collect("mcp_servers", "mcp_server");
  contributors.sort((a, b) => b.pct - a.pct);
  return {
    requestCount: numberOrNull(w.request_count) ?? 0,
    sessionCount: numberOrNull(w.session_count) ?? 0,
    behaviors,
    topContributors: contributors.slice(0, 8),
  };
}

/** Maps the raw (loosely-typed, experimental-shape) control response to our stable wire type. */
export function mapClaudeUsageResponse(
  raw: Record<string, unknown>,
): ClaudeUsageSnapshot {
  const rateLimits =
    raw.rate_limits && typeof raw.rate_limits === "object"
      ? (raw.rate_limits as Record<string, unknown>)
      : null;
  const session =
    raw.session && typeof raw.session === "object"
      ? (raw.session as Record<string, unknown>)
      : {};
  const behaviorsRaw =
    raw.behaviors && typeof raw.behaviors === "object"
      ? (raw.behaviors as Record<string, unknown>)
      : null;
  return {
    fetchedAt: Date.now(),
    subscriptionType: stringOrNull(raw.subscription_type),
    rateLimitsAvailable: raw.rate_limits_available === true,
    fiveHour: rateLimits ? mapLimitWindow(rateLimits.five_hour) : null,
    weekly: rateLimits ? mapLimitWindow(rateLimits.seven_day) : null,
    limits: rateLimits ? mapGenericLimits(rateLimits.limits) : [],
    modelScoped: rateLimits ? mapModelScoped(rateLimits.model_scoped) : [],
    extraUsage: rateLimits ? mapExtraUsage(rateLimits.extra_usage) : null,
    session: {
      totalCostUsd: numberOrNull(session.total_cost_usd) ?? 0,
      totalApiDurationMs: numberOrNull(session.total_api_duration_ms) ?? 0,
      totalDurationMs: numberOrNull(session.total_duration_ms) ?? 0,
    },
    behaviors: behaviorsRaw
      ? {
          day: mapBehaviorWindow(behaviorsRaw.day),
          week: mapBehaviorWindow(behaviorsRaw.week),
        }
      : null,
  };
}

/**
 * Fetches the Claude account usage/rate-limit snapshot. Throws on timeout,
 * abort, or if the connected CLI does not expose the control request (older
 * bundled version, or a fake test seam).
 */
export async function fetchClaudeSdkUsage(
  timeoutMs = 20_000,
  credentialProfileId?: string,
): Promise<ClaudeUsageSnapshot> {
  const seam = await seamFactory();
  const abortController = new AbortController();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  const query = seam.query({
    prompt: neverEndingPrompt(),
    options: buildUsageQueryOptions(abortController, credentialProfileId),
  });
  try {
    if (!query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) {
      throw new Error(
        "The connected Claude Code CLI does not support the usage control request.",
      );
    }
    const raw =
      await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    return mapClaudeUsageResponse(raw);
  } catch (err) {
    if (timedOut) throw new Error("Fetching Claude usage timed out.");
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    abortController.abort();
    query.close?.();
  }
}
