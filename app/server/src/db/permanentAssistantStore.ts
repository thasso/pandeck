import { getDb } from "./index.ts";

export type PermanentAssistantQueueStatus =
  "queued" | "working" | "completed" | "failed";
export interface PermanentAssistantQueueItem {
  id: number;
  dedupeKey: string;
  source: "web" | "slack";
  sourceMetadata: Record<string, unknown>;
  text: string;
  status: PermanentAssistantQueueStatus;
  attempts: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

type Row = {
  id: number;
  dedupe_key: string;
  source: "web" | "slack";
  source_metadata_json: string;
  text: string;
  status: PermanentAssistantQueueStatus;
  attempts: number;
  error: string | null;
  created_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
};
const map = (r: Row): PermanentAssistantQueueItem => ({
  id: r.id,
  dedupeKey: r.dedupe_key,
  source: r.source,
  sourceMetadata: JSON.parse(r.source_metadata_json),
  text: r.text,
  status: r.status,
  attempts: r.attempts,
  ...(r.error ? { error: r.error } : {}),
  createdAt: r.created_at_ms,
  ...(r.started_at_ms ? { startedAt: r.started_at_ms } : {}),
  ...(r.completed_at_ms ? { completedAt: r.completed_at_ms } : {}),
});

export const permanentAssistantStore = {
  sessionId(): string | undefined {
    return (
      (
        getDb()
          .prepare(
            "SELECT session_id FROM permanent_assistant_state WHERE singleton_id=1",
          )
          .get() as { session_id: string | null } | undefined
      )?.session_id ?? undefined
    );
  },
  setSessionId(sessionId: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO permanent_assistant_state(singleton_id,session_id,created_at_ms,updated_at_ms) VALUES(1,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET session_id=excluded.session_id,updated_at_ms=excluded.updated_at_ms",
      )
      .run(sessionId, now, now);
  },
  clearSessionId(): void {
    getDb()
      .prepare(
        "UPDATE permanent_assistant_state SET session_id=NULL, updated_at_ms=? WHERE singleton_id=1",
      )
      .run(Date.now());
  },
  find(dedupeKey: string): PermanentAssistantQueueItem | undefined {
    const row = getDb()
      .prepare("SELECT * FROM permanent_assistant_queue WHERE dedupe_key=?")
      .get(dedupeKey) as Row | undefined;
    return row ? map(row) : undefined;
  },
  enqueue(input: {
    dedupeKey: string;
    source: "web" | "slack";
    sourceMetadata?: Record<string, unknown>;
    text: string;
  }): PermanentAssistantQueueItem {
    const db = getDb();
    db.prepare(
      "INSERT OR IGNORE INTO permanent_assistant_queue(dedupe_key,source,source_metadata_json,text,created_at_ms) VALUES(?,?,?,?,?)",
    ).run(
      input.dedupeKey,
      input.source,
      JSON.stringify(input.sourceMetadata ?? {}),
      input.text,
      Date.now(),
    );
    return map(
      db
        .prepare("SELECT * FROM permanent_assistant_queue WHERE dedupe_key=?")
        .get(input.dedupeKey) as Row,
    );
  },
  next(): PermanentAssistantQueueItem | undefined {
    const row = getDb()
      .prepare(
        "SELECT * FROM permanent_assistant_queue WHERE status='queued' ORDER BY id LIMIT 1",
      )
      .get() as Row | undefined;
    return row ? map(row) : undefined;
  },
  mark(
    id: number,
    status: PermanentAssistantQueueStatus,
    error?: string,
  ): void {
    const now = Date.now();
    getDb()
      .prepare(
        "UPDATE permanent_assistant_queue SET status=?, attempts=attempts+CASE WHEN ?='working' THEN 1 ELSE 0 END, error=?, started_at_ms=CASE WHEN ?='working' THEN ? ELSE started_at_ms END, completed_at_ms=CASE WHEN ? IN ('completed','failed') THEN ? ELSE completed_at_ms END WHERE id=?",
      )
      .run(status, status, error ?? null, status, now, status, now, id);
  },
  recover(): void {
    getDb()
      .prepare(
        "UPDATE permanent_assistant_queue SET status='queued', error='Server restarted during processing' WHERE status='working'",
      )
      .run();
  },
};
