/**
 * SQL facade for pull-request cards (`pullRequestCards.ts` owns the domain).
 * One row per card: `card_json`/`context_json` are the record, the other
 * columns are what reads select by and are rewritten from the card on every
 * write. `seq` is insertion order, which is what "oldest first" means here.
 */
import type { PullRequestCard } from "@assistant/shared";
import { getDb } from "./index.ts";

/** A stored card and its server-only context, exactly as it was written. */
export interface StoredPullRequestCard {
  card: PullRequestCard;
  context: unknown;
}

/**
 * The fields a session's list row is decided from, read out of the card JSON
 * by SQLite (`json_extract` with several paths answers one JSON array) so a
 * list build never parses a whole card.
 */
export type PullRequestCardSummaryRow = Pick<
  PullRequestCard,
  | "sessionId"
  | "status"
  | "createdAt"
  | "number"
  | "ci"
  | "review"
  | "conflicts"
  | "draft"
>;

/** What the Pull Requests inventory joins a provider pull request on. */
export interface PullRequestCardLinkRow {
  sessionId: string;
  provider?: NonNullable<PullRequestCard["provider"]>;
  number?: number;
  url?: string;
  taskId?: string;
}

const RECORD = "SELECT card_json, context_json FROM pull_request_cards";
const SUMMARY = `SELECT session_id, status, created_at_ms,
  json_extract(card_json, '$.number', '$.ci', '$.review', '$.conflicts', '$.draft') AS fields
  FROM pull_request_cards`;

/**
 * Every statement a request, watcher or list path issues, by name — exported so
 * the query-plan test explains the EXACT SQL this facade runs.
 */
export const PULL_REQUEST_CARD_SQL = {
  byId: `${RECORD} WHERE id = ?`,
  bySession: `${RECORD} WHERE session_id = ? ORDER BY seq`,
  byStatus: `${RECORD} WHERE status = ? ORDER BY seq`,
  byWorktree: `${RECORD} WHERE worktree_id = ? ORDER BY seq`,
  sessionsWithStatus:
    "SELECT DISTINCT session_id FROM pull_request_cards WHERE status = ?",
  sessionHasStatus:
    "SELECT 1 FROM pull_request_cards WHERE session_id = ? AND status = ? LIMIT 1",
  summariesForSession: `${SUMMARY} WHERE session_id = ? ORDER BY seq`,
  insert: `INSERT OR IGNORE INTO pull_request_cards
    (id, session_id, status, worktree_id, created_at_ms, updated_at_ms, card_json, context_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  update: `UPDATE pull_request_cards SET session_id = ?, status = ?, worktree_id = ?,
    created_at_ms = ?, updated_at_ms = ?, card_json = ?, context_json = ? WHERE id = ?`,
} as const;

/**
 * Whole-table reads, each for a caller that genuinely spans every card: the
 * session-list index's FIRST build (later writes refresh one session), the
 * inventory's pull-request join, and boot's interrupted-action sweep.
 */
const FULL_SCAN_SQL = {
  summaries: `${SUMMARY} ORDER BY seq`,
  links: `SELECT session_id,
    json_extract(card_json, '$.provider', '$.number', '$.url', '$.linkedTask.id') AS fields
    FROM pull_request_cards ORDER BY seq`,
  busy: `${RECORD} WHERE json_extract(card_json, '$.busyAction') IS NOT NULL ORDER BY seq`,
} as const;

interface RecordRow {
  card_json: string;
  context_json: string;
}

interface SummaryRow {
  session_id: string;
  status: string;
  created_at_ms: number;
  fields: string;
}

const record = (row: RecordRow): StoredPullRequestCard => ({
  card: JSON.parse(row.card_json) as PullRequestCard,
  context: JSON.parse(row.context_json) as unknown,
});

const records = (rows: unknown[]): StoredPullRequestCard[] =>
  (rows as RecordRow[]).map(record);

/**
 * `{ key: value }` when the path was present, `{}` when `json_extract` reported
 * it missing (JSON `null`) — so a row carries exactly the fields the card has.
 */
const field = <K extends string, T>(
  key: K,
  value: T | null,
): { [P in K]?: T } =>
  (value === null ? {} : { [key]: value }) as { [P in K]?: T };

function summaryRow(row: SummaryRow): PullRequestCardSummaryRow {
  const [number, ci, review, conflicts, draft] = JSON.parse(row.fields) as [
    number | null,
    NonNullable<PullRequestCard["ci"]> | null,
    NonNullable<PullRequestCard["review"]> | null,
    boolean | null,
    boolean | null,
  ];
  return {
    sessionId: row.session_id,
    status: row.status as PullRequestCard["status"],
    createdAt: row.created_at_ms,
    ...field("number", number),
    ...field("ci", ci),
    ...field("review", review),
    ...field("conflicts", conflicts),
    ...field("draft", draft),
  };
}

/** A legacy card may lack a number; a column never learns more than the card says. */
const millis = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function columns(card: PullRequestCard) {
  return [
    card.sessionId,
    String(card.status),
    card.worktreeId ?? null,
    millis(card.createdAt),
    millis(card.updatedAt),
  ] as const;
}

export const pullRequestCardStore = {
  get(id: string): StoredPullRequestCard | undefined {
    const row = getDb().prepare(PULL_REQUEST_CARD_SQL.byId).get(id) as
      RecordRow | undefined;
    return row ? record(row) : undefined;
  },

  /** Append a card; `false` when its id is already stored (the first one stays). */
  insert(stored: StoredPullRequestCard): boolean {
    const [sessionId, status, worktreeId, createdAt, updatedAt] = columns(
      stored.card,
    );
    const result = getDb()
      .prepare(PULL_REQUEST_CARD_SQL.insert)
      .run(
        stored.card.id,
        sessionId,
        status,
        worktreeId,
        createdAt,
        updatedAt,
        JSON.stringify(stored.card),
        JSON.stringify(stored.context),
      );
    return Number(result.changes) > 0;
  },

  /** Replace one stored card (and its context) in place, keeping its position. */
  update(stored: StoredPullRequestCard): void {
    getDb()
      .prepare(PULL_REQUEST_CARD_SQL.update)
      .run(
        ...columns(stored.card),
        JSON.stringify(stored.card),
        JSON.stringify(stored.context),
        stored.card.id,
      );
  },

  forSession(sessionId: string): StoredPullRequestCard[] {
    return records(
      getDb().prepare(PULL_REQUEST_CARD_SQL.bySession).all(sessionId),
    );
  },

  withStatus(status: PullRequestCard["status"]): StoredPullRequestCard[] {
    return records(getDb().prepare(PULL_REQUEST_CARD_SQL.byStatus).all(status));
  },

  forWorktree(worktreeId: string): StoredPullRequestCard[] {
    return records(
      getDb().prepare(PULL_REQUEST_CARD_SQL.byWorktree).all(worktreeId),
    );
  },

  sessionsWithStatus(status: PullRequestCard["status"]): Set<string> {
    const rows = getDb()
      .prepare(PULL_REQUEST_CARD_SQL.sessionsWithStatus)
      .all(status) as Array<{ session_id: string }>;
    return new Set(rows.map((row) => row.session_id));
  },

  sessionHasStatus(
    sessionId: string,
    status: PullRequestCard["status"],
  ): boolean {
    return (
      getDb()
        .prepare(PULL_REQUEST_CARD_SQL.sessionHasStatus)
        .get(sessionId, status) !== undefined
    );
  },

  /** One session's summary fields, oldest first. */
  summariesForSession(sessionId: string): PullRequestCardSummaryRow[] {
    return (
      getDb()
        .prepare(PULL_REQUEST_CARD_SQL.summariesForSession)
        .all(sessionId) as unknown as SummaryRow[]
    ).map(summaryRow);
  },

  /** Every card's summary fields, oldest first — the index's first build only. */
  allSummaries(): PullRequestCardSummaryRow[] {
    return (
      getDb().prepare(FULL_SCAN_SQL.summaries).all() as unknown as SummaryRow[]
    ).map(summaryRow);
  },

  /** Every card's pull-request identity, oldest first. */
  links(): PullRequestCardLinkRow[] {
    const rows = getDb().prepare(FULL_SCAN_SQL.links).all() as Array<{
      session_id: string;
      fields: string;
    }>;
    return rows.map((row) => {
      const [provider, number, url, taskId] = JSON.parse(row.fields) as [
        NonNullable<PullRequestCard["provider"]> | null,
        number | null,
        string | null,
        string | null,
      ];
      return {
        sessionId: row.session_id,
        ...field("provider", provider),
        ...field("number", number),
        ...field("url", url),
        ...field("taskId", taskId),
      };
    });
  },

  /** Cards still claiming an action in flight (boot reconciliation). */
  withBusyAction(): StoredPullRequestCard[] {
    return records(getDb().prepare(FULL_SCAN_SQL.busy).all());
  },

  /**
   * The connection, and `PRAGMA data_version`, which moves when ANOTHER
   * connection commits — what a memo of this table must be keyed on besides
   * this process's own writes.
   */
  foreignWriteStamp(): { db: object; dataVersion: number } {
    const db = getDb();
    const row = db.prepare("PRAGMA data_version").get() as {
      data_version: number;
    };
    return { db, dataVersion: row.data_version };
  },

  /** Test seam: drop every card. */
  clear(): void {
    getDb().exec("DELETE FROM pull_request_cards");
  },
};
