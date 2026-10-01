import { getTempoSettings, getTempoToolConfig } from "../../tempoSettings.ts";
import {
  fetchWorklogs,
  type TempoWorklog,
} from "../../tools/tempo/tempoWorklogFetch.ts";
import { resolveJiraIssueInfos, jiraIssueUrl } from "../../jiraClient.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

const MAX_WORKLOGS = 500;
const OWN_DESCRIPTION_CHARS = 120;

/**
 * Tempo worklogs: submitted facts with CLAIMED dates (plan contract). The
 * worklog date is the claimed work date and may be logged later — facts carry
 * the claimed date; `createdAt` is not exposed by the v4 list shape we
 * consume, so late logging surfaces through delta `added` on later days.
 * Privacy: verbose descriptions are dropped for others' worklogs and bounded
 * for own ones; per-person hours never leave the facts layer as a report.
 */
export const tempoCollector: DaySourceCollector = {
  key: "tempo",
  label: "Tempo",
  readiness() {
    const settings = getTempoSettings();
    if (!settings.enabled)
      return {
        ready: false,
        reason: "disabled",
        detail: "Tempo integration is disabled",
      };
    if (!settings.refreshTokenConfigured)
      return {
        ready: false,
        reason: "unconfigured",
        detail: "Tempo is not connected",
      };
    return { ready: true };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const config = await getTempoToolConfig();
    const { worklogs } = await fetchWorklogs({
      apiBaseUrl: config.apiBaseUrl,
      accessToken: config.accessToken,
      from: ctx.date,
      to: ctx.date,
      maxResults: MAX_WORKLOGS,
    });
    ctx.cache.writeJson(ctx.date, "tempo-raw", { count: worklogs.length });
    const truncated = worklogs.length >= MAX_WORKLOGS;

    // Enrich issue ids → keys/projects when Jira is available; degrade to raw ids.
    const issueIds = [
      ...new Set(
        worklogs
          .map((w) => w.issue?.id)
          .filter(Boolean)
          .map(String),
      ),
    ];
    const issues = config.jira
      ? await resolveJiraIssueInfos(config.jira, issueIds)
      : new Map();

    const ownAccountId =
      ctx.identities.tempoAccountId || config.authorAccountId || "";
    const observedAt = new Date().toISOString();
    const facts: DaySourceFact[] = [];
    for (const worklog of worklogs) {
      const id = String(worklog.tempoWorklogId ?? worklog.id ?? "");
      if (!id) continue;
      const own = Boolean(
        ownAccountId && worklog.author?.accountId === ownAccountId,
      );
      const issue = worklog.issue?.id
        ? issues.get(String(worklog.issue.id))
        : undefined;
      facts.push({
        id: `tempo:${id}`,
        kind: "worklog",
        occurredAt: worklog.startDate
          ? `${worklog.startDate}T${worklog.startTime ?? "00:00:00"}`
          : null,
        observedAt,
        actor: worklog.author?.displayName ?? null,
        title: issue?.summary,
        links:
          issue?.key && config.jira
            ? [jiraIssueUrl(config.jira.jiraHost, issue.key)]
            : [],
        data: {
          issueId: worklog.issue?.id ? String(worklog.issue.id) : null,
          issueKey: issue?.key ?? null,
          projectKey: issue?.projectKey ?? null,
          seconds: worklog.timeSpentSeconds ?? null,
          startDate: worklog.startDate ?? null,
          startTime: worklog.startTime ?? null,
          activity: extractActivityKey(worklog),
          // Privacy: own descriptions bounded, others' dropped entirely.
          ...(own && worklog.description
            ? {
                description: worklog.description.slice(
                  0,
                  OWN_DESCRIPTION_CHARS,
                ),
              }
            : {}),
        },
        tags: ["worklog", ...(own ? ["own"] : [])],
      });
    }
    return {
      result: truncated ? "partial" : "complete",
      facts,
      completeness: {
        worklogs: facts.length,
        truncated,
        jiraEnrichment: Boolean(config.jira),
      },
    };
  },
};

function extractActivityKey(worklog: TempoWorklog): string | null {
  const attrs = worklog.attributes;
  const values = Array.isArray(attrs) ? attrs : (attrs?.values ?? []);
  for (const value of values) {
    if (value?.key === "_Account_") return value.value ?? null;
  }
  return null;
}
