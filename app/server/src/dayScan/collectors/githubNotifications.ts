import {
  getGithubToolConfig,
  isGithubConfigured,
} from "../../githubSettings.ts";
import { githubRequest, type GithubResponse } from "../../githubClient.ts";
import { notificationHtmlLink } from "./githubLinks.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

const MAX_NOTIFICATIONS = 200;

type NotificationThread = {
  id?: string;
  reason?: string;
  unread?: boolean;
  updated_at?: string;
  subject?: { title?: string; type?: string; url?: string | null };
  repository?: { full_name?: string; html_url?: string };
};

/**
 * GitHub notifications: ATTENTION STATE, not day events (plan contract). A
 * fact disappearing from this source means attention state changed (read/
 * dismissed), never that work completed — the digest must not treat
 * no-longer-observed here as anything but that. Facts carry unread state and
 * reason; review requests are the high-salience subset for "my work".
 */
export const githubNotificationsCollector: DaySourceCollector = {
  key: "github-notifications",
  label: "GitHub notifications",
  readiness() {
    return isGithubConfigured()
      ? { ready: true }
      : {
          ready: false,
          reason: "unconfigured",
          detail: "GitHub is not configured",
        };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const config = getGithubToolConfig();
    const threads: NotificationThread[] = [];
    let nextUrl: string | null = "/notifications";
    let query:
      Record<string, string | number | boolean | undefined> | undefined = {
      all: true,
      since: ctx.window.startIso,
      per_page: 100,
    };
    while (nextUrl && threads.length < MAX_NOTIFICATIONS) {
      const res: GithubResponse<NotificationThread[]> = await githubRequest<
        NotificationThread[]
      >(config, "GET", nextUrl, {
        ...(query !== undefined ? { query } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      query = undefined;
      threads.push(...(Array.isArray(res.data) ? res.data : []));
      nextUrl = res.nextUrl;
    }
    const truncated = nextUrl !== null && threads.length >= MAX_NOTIFICATIONS;
    const observedAt = new Date().toISOString();
    const facts: DaySourceFact[] = threads
      .filter((t) => t.id)
      .map((thread) => {
        const link = notificationHtmlLink(
          thread.subject?.url,
          thread.repository?.html_url,
        );
        return {
          id: `ghn:${thread.id}`,
          kind: "notification",
          occurredAt: thread.updated_at ?? null,
          observedAt,
          ...(thread.subject?.title !== undefined
            ? { title: thread.subject?.title }
            : {}),
          links: link ? [link] : [],
          data: {
            reason: thread.reason ?? null,
            unread: thread.unread ?? null,
            subjectType: thread.subject?.type ?? null,
            repo: thread.repository?.full_name ?? null,
          },
          tags: [
            "attention",
            ...(thread.reason === "review_requested"
              ? ["review-requested"]
              : []),
            ...(thread.unread ? ["unread"] : []),
          ],
        };
      });
    return {
      result: truncated ? "partial" : "complete",
      facts,
      completeness: { threads: facts.length, truncated },
      notes: [
        "Attention-state source: disappearance means read/dismissed, never completed work.",
      ],
    };
  },
};
