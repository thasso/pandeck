/**
 * READ-ONLY session metadata reads against ANY data directory, for the
 * measurement CLIs (`pnpm run measure:session`) that audit a data dir which may
 * not be the one this process configured.
 *
 * It exists so those tools do not open their own database or write SQL of their
 * own: this folder stays the only place that talks SQL. Unlike `sessionStore`,
 * it does NOT go through `getDb()` — that would run migrations against the
 * user's live database from a checkout — and it opens its own `readOnly`
 * handle, which it closes before returning. Only plain data leaves.
 *
 * Because it never migrates, it reads the SCHEMA IT FINDS: a directory that
 * predates a session-metadata migration is still answered, not crashed on (see
 * {@link scopeColumn}).
 */
import { sessionScopeOrFailClosed, type SessionScope } from "@assistant/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One session's metadata row, as plain values. Undefined when unknown. */
interface SessionSnapshotRow {
  id: string;
  title: string;
  harness: string;
  agentType: string;
  createdAtMs: number;
  updatedAtMs: number;
  messageCount: number;
  model?: string;
  provider?: string;
  providerSessionId?: string;
  thinkingLevel?: string;
  archived: boolean;
  deleted: boolean;
  /** Whose session this is; anything but `user` is refused by the callers. */
  scope: SessionScope;
}

/** The persisted usage totals row, as plain values. */
interface SessionSnapshotUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costMicros?: number;
  usageTurns: number;
  assistantTurns: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface SessionSnapshot {
  session: SessionSnapshotRow;
  usage?: SessionSnapshotUsage;
  /** The frozen prompt-condition JSON, verbatim. */
  promptConditionsJson?: string;
  /** The frozen library-skill name JSON, verbatim. */
  sessionSkillsJson?: string;
  /** The Task the session opened on (`session → context → task`). */
  attachedTaskId?: string;
}

function text(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

function n(value: unknown): number {
  return value == null ? 0 : Number(value);
}

/**
 * Which column carries a session's classification in THIS database, or
 * undefined when there is no `session_index` to read at all.
 *
 * A data directory that has not applied `0047_session_scope.sql` — an older
 * backup, another machine, a directory this build has never opened — still
 * holds the two-valued `visibility` column, and this module may not migrate it:
 * its whole point is reading someone else's data dir through a `readOnly`
 * handle. So the shape is probed and the legacy column read in place, with
 * `sessionScopeOrFailClosed` normalizing either one.
 */
function scopeColumn(db: DatabaseSync): "scope" | "visibility" | undefined {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(session_index)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  if (columns.has("scope")) return "scope";
  if (columns.has("visibility")) return "visibility";
  return undefined;
}

/**
 * Read one session's metadata, usage totals, frozen conditions and attached
 * Task from `<dataDir>/app.sqlite3`. Returns undefined when the database or the
 * session row does not exist; classification (deleted, scope) is reported on
 * the row for the caller to refuse on.
 */
export function readSessionSnapshot(
  dataDir: string,
  sessionId: string,
): SessionSnapshot | undefined {
  const dbPath = join(dataDir, "app.sqlite3");
  if (!existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // No session table at all (an empty or unrelated database): no session row,
    // which is a not-found rather than a failure to read.
    const scopeSource = scopeColumn(db);
    if (!scopeSource) return undefined;
    const row = db
      .prepare(
        `SELECT id, title, harness, agent_type, model, provider, provider_session_id,
                thinking_level, created_at_ms, updated_at_ms, archived_at_ms,
                deleted_at_ms, ${scopeSource} AS scope, message_count
           FROM session_index WHERE id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const usage = db
      .prepare("SELECT * FROM session_usage_totals WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    const conditions = db
      .prepare(
        "SELECT conditions_json FROM session_prompt_conditions WHERE session_id = ?",
      )
      .get(sessionId) as { conditions_json?: string } | undefined;
    const skillsTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_skills'",
      )
      .get();
    const skills = skillsTable
      ? (db
          .prepare("SELECT names_json FROM session_skills WHERE session_id = ?")
          .get(sessionId) as { names_json?: string } | undefined)
      : undefined;
    const task = db
      .prepare(
        `SELECT to_id FROM links
           WHERE from_type = 'session' AND from_id = ? AND relation = 'context'
             AND to_type = 'task'
           LIMIT 1`,
      )
      .get(sessionId) as { to_id?: string } | undefined;

    return {
      session: {
        id: String(row.id),
        title: text(row.title) ?? "",
        harness: text(row.harness) ?? "pi",
        agentType: text(row.agent_type) ?? "",
        createdAtMs: n(row.created_at_ms),
        updatedAtMs: n(row.updated_at_ms),
        messageCount: n(row.message_count),
        ...(text(row.model) ? { model: text(row.model)! } : {}),
        ...(text(row.provider) ? { provider: text(row.provider)! } : {}),
        ...(text(row.provider_session_id)
          ? { providerSessionId: text(row.provider_session_id)! }
          : {}),
        ...(text(row.thinking_level)
          ? { thinkingLevel: text(row.thinking_level)! }
          : {}),
        archived: row.archived_at_ms != null,
        deleted: row.deleted_at_ms != null,
        scope: sessionScopeOrFailClosed(text(row.scope)),
      },
      ...(usage
        ? {
            usage: {
              inputTokens: n(usage.input_tokens),
              outputTokens: n(usage.output_tokens),
              cacheReadTokens: n(usage.cache_read_tokens),
              cacheWriteTokens: n(usage.cache_write_tokens),
              reasoningTokens: n(usage.reasoning_tokens),
              totalTokens: n(usage.total_tokens),
              ...(usage.cost_micros != null
                ? { costMicros: n(usage.cost_micros) }
                : {}),
              usageTurns: n(usage.usage_turns),
              assistantTurns: n(usage.assistant_turns),
              ...(usage.context_tokens != null
                ? { contextTokens: n(usage.context_tokens) }
                : {}),
              ...(usage.context_window != null
                ? { contextWindow: n(usage.context_window) }
                : {}),
            },
          }
        : {}),
      ...(conditions?.conditions_json
        ? { promptConditionsJson: conditions.conditions_json }
        : {}),
      ...(skills?.names_json ? { sessionSkillsJson: skills.names_json } : {}),
      ...(task?.to_id ? { attachedTaskId: String(task.to_id) } : {}),
    };
  } finally {
    db.close();
  }
}
