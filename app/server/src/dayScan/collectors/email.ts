import {
  ensureGoogleAccessToken,
  isGoogleConfigured,
} from "../../googleSettings.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
const MAX_PER_QUERY = 30;
const SUBJECT_CHARS = 140;

export type EmailSignalKind =
  "email-sent" | "email-starred" | "email-action" | "email-followup";

interface GmailListPage {
  messages?: Array<{ id?: string; threadId?: string }>;
}
interface GmailMetaMessage {
  id?: string;
  threadId?: string;
  internalDate?: string;
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}

async function gmailGet<T>(
  path: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<T> {
  const url = path.startsWith("http")
    ? path
    : `${GMAIL_API_BASE}${path.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok)
    throw new Error(`Gmail HTTP ${res.status} for ${path.slice(0, 60)}`);
  return (await res.json()) as T;
}

function header(message: GmailMetaMessage, name: string): string {
  const value = (message.payload?.headers ?? []).find(
    (h) => (h.name ?? "").toLowerCase() === name.toLowerCase(),
  )?.value;
  return (value ?? "").trim();
}

const TAGS: Record<EmailSignalKind, string[]> = {
  "email-sent": ["own"],
  "email-starred": ["starred", "attention"],
  "email-action": ["action-needed", "attention"],
  "email-followup": ["follow-up", "attention"],
};

const LABEL: Record<EmailSignalKind, string> = {
  "email-sent": "Sent",
  "email-starred": "Starred",
  "email-action": "Action needed",
  "email-followup": "Follow-up",
};

/**
 * A Gmail message → one PRIVACY-SAFE fact (plan § Privacy & retention). Built
 * from HEADERS ONLY (subject + the single counterparty), never the body — the
 * collector requests `format=metadata`, so raw mailbox content is never
 * ingested. The subject is a bounded normalized label (like a Jira summary);
 * the counterparty is one actor name, not a participant list.
 */
export function emailFact(
  kind: EmailSignalKind,
  message: GmailMetaMessage,
  observedAt: string,
): DaySourceFact | null {
  const id = message.id;
  if (!id) return null;
  const subject =
    header(message, "Subject").slice(0, SUBJECT_CHARS) || "(no subject)";
  const counterparty =
    kind === "email-sent" ? header(message, "To") : header(message, "From");
  const occurredAt = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : null;
  return {
    id: `${kind}:${id}`,
    kind,
    occurredAt,
    observedAt,
    actor: counterparty || null,
    title: `${LABEL[kind]}: ${subject}`,
    links: [`https://mail.google.com/mail/u/0/#all/${id}`],
    data: { threadId: message.threadId ?? null, subject },
    tags: TAGS[kind],
  };
}

function gmailDate(iso: string): string {
  return iso.replace(/-/g, "/");
}

interface QuerySpec {
  kind: EmailSignalKind;
  query: string;
}

/**
 * Narrow email signals (plan phase 8, privacy-gated): sent mail, starred /
 * action-needed messages, and meeting follow-ups — NEVER raw mailbox ingestion.
 * Uses Gmail search (`messages.list`) with targeted queries and fetches only
 * message HEADERS (`format=metadata`). Only metadata is committed (subject +
 * counterparty + permalink); bodies are never fetched or committed. A soft
 * per-query failure degrades to `partial` rather than failing the source.
 */
export const emailCollector: DaySourceCollector = {
  key: "email",
  label: "Email",
  readiness() {
    return isGoogleConfigured()
      ? { ready: true }
      : {
          ready: false,
          reason: "unconfigured",
          detail: "Google Workspace is not connected",
        };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const accessToken = await ensureGoogleAccessToken();
    const observedAt = new Date().toISOString();
    const from = gmailDate(ctx.date);
    const to = gmailDate(nextIsoDate(ctx.date));
    const dayScope = `after:${from} before:${to}`;

    // Narrow queries only — no bare mailbox listing. Starred/action-needed are a
    // standing attention list, so they are not day-scoped.
    const specs: QuerySpec[] = [
      { kind: "email-sent", query: `in:sent ${dayScope}` },
      { kind: "email-starred", query: `is:starred in:inbox` },
      { kind: "email-action", query: `is:important is:unread in:inbox` },
      {
        kind: "email-followup",
        query: `${dayScope} (subject:"follow up" OR subject:"follow-up" OR subject:"action items" OR subject:"meeting notes" OR subject:"minutes")`,
      },
    ];

    const facts: DaySourceFact[] = [];
    const seen = new Set<string>();
    let partial = false;
    for (const spec of specs) {
      try {
        const page = await gmailGet<GmailListPage>(
          `messages?q=${encodeURIComponent(spec.query)}&maxResults=${MAX_PER_QUERY}`,
          accessToken,
          ctx.signal,
        );
        const ids = (page.messages ?? [])
          .map((m) => m.id)
          .filter((id): id is string => Boolean(id))
          .slice(0, MAX_PER_QUERY);
        for (const id of ids) {
          const meta = await gmailGet<GmailMetaMessage>(
            `messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
            accessToken,
            ctx.signal,
          );
          const fact = emailFact(spec.kind, meta, observedAt);
          if (fact && !seen.has(fact.id)) {
            seen.add(fact.id);
            facts.push(fact);
          }
        }
      } catch {
        partial = true;
      }
    }

    ctx.cache.writeJson(ctx.date, "email-raw", {
      facts: facts.length,
      partial,
    });
    return {
      result: partial ? "partial" : "complete",
      facts,
      completeness: { signals: facts.length },
      ...(partial
        ? {
            notes: [
              "Some email signal queries failed (e.g. missing Gmail scope); coverage is partial.",
            ],
          }
        : {}),
    };
  },
};

function nextIsoDate(date: string): string {
  const d = new Date(Date.parse(`${date}T12:00:00Z`) + 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
