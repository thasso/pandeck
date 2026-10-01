import {
  getGithubDefaultOwner,
  getGithubToolConfig,
  isGithubConfigured,
} from "../../githubSettings.ts";
import {
  scanOrgEvents,
  type OrgEvent,
} from "../../tools/github/githubTools.ts";
import { eventHtmlLink } from "./githubLinks.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

const MAX_EVENTS_PER_SCAN = 900;

/**
 * GitHub org events. Semantics (plan contract): a lossy, capped feed —
 * the day snapshot is a cumulative UNION by event id (`accumulate`), events
 * are only ever added, and an absent event on re-scan means nothing. Coverage
 * flags say whether the scan reached past the window start (`exhausted`);
 * anything else is `partial`, which suppresses absence conclusions.
 */
export const githubEventsCollector: DaySourceCollector = {
  key: "github-events",
  label: "GitHub activity",
  readiness() {
    if (!isGithubConfigured())
      return {
        ready: false,
        reason: "unconfigured",
        detail: "GitHub is not configured",
      };
    if (!getGithubDefaultOwner())
      return {
        ready: false,
        reason: "unconfigured",
        detail: "No default GitHub owner/org configured",
      };
    return { ready: true };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const config = getGithubToolConfig();
    const org = getGithubDefaultOwner();
    const scan = await scanOrgEvents(config, org, {
      fromMs: ctx.window.startMs,
      toMs: ctx.window.endMs,
      maxEvents: MAX_EVENTS_PER_SCAN,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    ctx.cache.writeJson(ctx.date, "github-events-raw", {
      scanned: scan.scanned,
      inWindow: scan.inWindow.length,
      source: scan.source,
    });
    const observedAt = new Date().toISOString();
    const facts = scan.inWindow
      .filter((e) => e.id)
      .map((event) => toFact(event, observedAt));
    return {
      // Even an exhausted scan can have lost aged-out events earlier in the
      // day, so the union accumulates across runs; `exhausted` only means this
      // scan reached past the window start.
      result: scan.exhausted ? "complete" : "partial",
      facts,
      accumulate: true,
      completeness: {
        source: scan.source,
        eventsScanned: scan.scanned,
        exhausted: scan.exhausted,
        ...(scan.fallbackReason ? { fallbackReason: scan.fallbackReason } : {}),
      },
      ...(scan.exhausted
        ? {}
        : {
            notes: [
              "GitHub event feed did not reach the window start; coverage is partial and improves with re-runs.",
            ],
          }),
    };
  },
};

function toFact(event: OrgEvent, observedAt: string): DaySourceFact {
  const repo = event.repo?.name ?? null;
  const link = eventHtmlLink(repo, event);
  return {
    id: `gh:${event.id}`,
    kind:
      (event.type ?? "Event").replace(/Event$/, "").toLowerCase() || "event",
    occurredAt: event.created_at ?? null,
    observedAt,
    actor: event.actor?.login ?? null,
    ...(repo != null ? { title: repo } : {}),
    links: link ? [link] : [],
    data: {
      repo,
      type: event.type ?? null,
      action:
        typeof event.payload?.action === "string" ? event.payload.action : null,
      ref: typeof event.payload?.ref === "string" ? event.payload.ref : null,
      prNumber:
        typeof event.payload?.pull_request?.number === "number"
          ? event.payload.pull_request.number
          : null,
      issueNumber:
        typeof event.payload?.issue?.number === "number"
          ? event.payload.issue.number
          : null,
      commits: Array.isArray(event.payload?.commits)
        ? event.payload.commits.length
        : null,
    },
    tags: ["event"],
  };
}
