import {
  getSlackDaySignalConfig,
  type SlackDaySignalConfig,
} from "../../slackSettings.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

const MAX_PER_QUERY = 50;
const MAX_SAVED = 25;

interface SearchMatch {
  ts?: string;
  channel?: { id?: string; name?: string };
  permalink?: string;
}
interface SearchResponse {
  ok?: boolean;
  error?: string;
  messages?: {
    matches?: SearchMatch[];
    paging?: { pages?: number; page?: number };
  };
}
interface AuthTestResponse {
  ok?: boolean;
  user?: string;
  user_id?: string;
}
interface StarsResponse {
  ok?: boolean;
  items?: Array<{
    type?: string;
    channel?: string;
    date_create?: number;
    message?: { ts?: string; permalink?: string };
    file?: { id?: string; permalink?: string; name?: string };
  }>;
}

async function slackCall<T>(
  method: string,
  params: Record<string, string | number | undefined>,
  token: string,
  signal?: AbortSignal,
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== "") body.set(key, String(value));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "personal-assistant-day-scan/1.0",
    },
    body,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status} for ${method}`);
  const json = (await res.json()) as T & { ok?: boolean; error?: string };
  if (json.ok === false)
    throw new Error(`Slack ${method} error: ${json.error ?? "unknown"}`);
  return json;
}

function permalink(
  config: SlackDaySignalConfig,
  channelId: string | undefined,
  ts: string | undefined,
): string | undefined {
  if (!config.workspaceHost || !channelId || !ts) return undefined;
  return `https://${config.workspaceHost}/archives/${channelId}/p${ts.replace(".", "")}`;
}

function channelLabel(name: string | undefined): string {
  return name ? `#${name}` : "a conversation";
}

/**
 * A search match → one PRIVACY-SAFE fact. Per the plan § Privacy & retention,
 * committed facts are metadata only: channel id/name, permalink, timestamp, and
 * the signal KIND. Message BODY text is never committed (treated like meeting/
 * email body text) — the fact title is a synthesized label, not content.
 */
export function slackMessageFact(
  kind: "slack-mention" | "slack-own",
  config: SlackDaySignalConfig,
  match: SearchMatch,
  observedAt: string,
): DaySourceFact | null {
  const ts = match.ts;
  const channelId = match.channel?.id;
  if (!ts || !channelId) return null;
  const link = match.permalink ?? permalink(config, channelId, ts);
  const label = channelLabel(match.channel?.name);
  return {
    id: `${kind}:${channelId}:${ts}`,
    kind,
    occurredAt: new Date(Number(ts) * 1000).toISOString(),
    observedAt,
    title:
      kind === "slack-mention"
        ? `Mentioned in ${label}`
        : `You posted in ${label}`,
    links: link ? [link] : [],
    data: { channelId, channelName: match.channel?.name ?? null, ts },
    tags: kind === "slack-mention" ? ["mention", "attention"] : ["own"],
  };
}

function buildOnQuery(prefix: string, date: string): string {
  return `${prefix} on:${date}`.trim();
}

/**
 * Narrow Slack signals (plan phase 8, privacy-gated): mentions, own-authored
 * messages, and saved items — never channel archives. Uses `search.messages`
 * (which returns only matching messages, not history) and `stars.list`. Only
 * metadata is committed; no message bodies. A soft failure of any single query
 * degrades to `partial` rather than failing the whole source.
 */
export const slackCollector: DaySourceCollector = {
  key: "slack",
  label: "Slack",
  readiness() {
    return getSlackDaySignalConfig()
      ? { ready: true }
      : {
          ready: false,
          reason: "unconfigured",
          detail: "Slack is not connected",
        };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const config = getSlackDaySignalConfig();
    if (!config) throw new Error("Slack is not connected");
    const observedAt = new Date().toISOString();
    const facts: DaySourceFact[] = [];
    const seen = new Set<string>();
    const push = (fact: DaySourceFact | null) => {
      if (fact && !seen.has(fact.id)) {
        seen.add(fact.id);
        facts.push(fact);
      }
    };
    let partial = false;
    let username = "";
    try {
      const auth = await slackCall<AuthTestResponse>(
        "auth.test",
        {},
        config.token,
        ctx.signal,
      );
      username = auth.user ?? "";
    } catch {
      partial = true;
    }

    // Own-authored messages today.
    try {
      const own = await slackCall<SearchResponse>(
        "search.messages",
        {
          query: buildOnQuery("from:me", ctx.date),
          count: MAX_PER_QUERY,
          sort: "timestamp",
          sort_dir: "desc",
        },
        config.token,
        ctx.signal,
      );
      for (const match of own.messages?.matches ?? [])
        push(slackMessageFact("slack-own", config, match, observedAt));
    } catch {
      partial = true;
    }

    // Mentions today (best-effort; requires resolving the own username).
    if (username) {
      try {
        const mentions = await slackCall<SearchResponse>(
          "search.messages",
          {
            query: buildOnQuery(`@${username}`, ctx.date),
            count: MAX_PER_QUERY,
            sort: "timestamp",
            sort_dir: "desc",
          },
          config.token,
          ctx.signal,
        );
        for (const match of mentions.messages?.matches ?? [])
          push(slackMessageFact("slack-mention", config, match, observedAt));
      } catch {
        partial = true;
      }
    } else {
      partial = true;
    }

    // Saved items (the standing "come back to this" list), bounded + most recent first.
    try {
      const stars = await slackCall<StarsResponse>(
        "stars.list",
        { count: MAX_SAVED },
        config.token,
        ctx.signal,
      );
      const items = (stars.items ?? [])
        .filter((item) => item.type === "message" || item.type === "file")
        .sort((a, b) => (b.date_create ?? 0) - (a.date_create ?? 0))
        .slice(0, MAX_SAVED);
      for (const item of items) {
        const ts = item.message?.ts;
        const fileId = item.file?.id;
        const link =
          item.message?.permalink ??
          item.file?.permalink ??
          permalink(config, item.channel, ts);
        const id = ts
          ? `slack-saved:${item.channel}:${ts}`
          : fileId
            ? `slack-saved:file:${fileId}`
            : null;
        if (!id) continue;
        push({
          id,
          kind: "slack-saved",
          occurredAt: item.date_create
            ? new Date(item.date_create * 1000).toISOString()
            : null,
          observedAt,
          title: item.file?.name
            ? `Saved file: ${item.file.name}`
            : `Saved item in ${channelLabel(undefined)}`,
          links: link ? [link] : [],
          data: {
            channelId: item.channel ?? null,
            itemType: item.type ?? null,
          },
          tags: ["saved", "attention"],
        });
      }
    } catch {
      partial = true;
    }

    ctx.cache.writeJson(ctx.date, "slack-raw", {
      facts: facts.length,
      partial,
    });
    return {
      result: partial ? "partial" : "complete",
      facts,
      completeness: {
        signals: facts.length,
        mentionsResolvable: Boolean(username),
      },
      ...(partial
        ? {
            notes: [
              "Some Slack signal queries failed or the own-username was unresolved; coverage is partial.",
            ],
          }
        : {}),
    };
  },
};
