/**
 * A session's engine bindings (`session_engine_binding`, migration 0102): which
 * harness, account, model and effort run it, and the engine's own id for it.
 *
 * Exactly one binding per session row is active. `session_index`'s six binding
 * columns (`harness`, `provider`, `provider_session_id`, `model`,
 * `thinking_level`, `credential_profile_id`) are that binding's PROJECTION:
 * only `sessionStore.upsert` and `sessionStore.switchCredentialProfile` write
 * them, and each calls {@link syncActiveBinding} in the same transaction, so
 * the two never disagree (`docs/session-runtime-switching.md` "Engine
 * bindings"). Nothing else writes this table.
 */
import type { Harness } from "@assistant/shared";
import { getDb } from "./index.ts";

/** One engine binding of a session. */
export interface SessionEngineBinding {
  sessionId: string;
  /** 1 for the session's first binding; each later one is the next integer. */
  seq: number;
  harness: Harness;
  credentialProfileId?: string;
  /** Model provider as the row stores it (`claude` for a Claude session). */
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  /**
   * The engine's own id for the session, never a path: pi's session id (its
   * transcript is derived from it, `piNativeFile`), Claude's SDK session id
   * (absent until its first query).
   */
  nativeSessionId?: string;
  /** The session log's seq cursor when this binding began (0 for the first). */
  startedSeq: number;
  /** The run that began this binding; absent for the first. */
  startedRunId?: string;
  createdAt: number;
  /** Absent while the binding is active. */
  endedAt?: number;
}

/** The projection fields a binding writer hands over, already merged. */
export interface ActiveBindingFields {
  harness: Harness;
  credentialProfileId: string | null;
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  /** The row's `provider_session_id`: Claude's native id (see {@link nativeSessionIdFor}). */
  providerSessionId: string | null;
}

interface DbBindingRow {
  session_id: string;
  seq: number;
  harness: Harness;
  credential_profile_id: string | null;
  provider: string | null;
  model: string | null;
  thinking_level: string | null;
  native_session_id: string | null;
  started_seq: number;
  started_run_id: string | null;
  created_at_ms: number;
  ended_at_ms: number | null;
}

function fromRow(row: DbBindingRow): SessionEngineBinding {
  return {
    sessionId: row.session_id,
    seq: row.seq,
    harness: row.harness,
    ...(row.credential_profile_id
      ? { credentialProfileId: row.credential_profile_id }
      : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}),
    ...(row.native_session_id
      ? { nativeSessionId: row.native_session_id }
      : {}),
    startedSeq: row.started_seq,
    ...(row.started_run_id ? { startedRunId: row.started_run_id } : {}),
    createdAt: row.created_at_ms,
    ...(row.ended_at_ms !== null ? { endedAt: row.ended_at_ms } : {}),
  };
}

/**
 * The engine's id the active binding stores. Claude's is the row's
 * `provider_session_id`. A pi session's is its app id: every build so far
 * opened the transcript the app id names, whatever an older row stored in
 * `provider_session_id`, and only the cross-harness switch creates a pi binding
 * with its own native id (design 20), writing that binding itself.
 */
export function nativeSessionIdFor(
  sessionId: string,
  fields: Pick<ActiveBindingFields, "harness" | "providerSessionId">,
): string | null {
  return NATIVE_SESSION_ID[fields.harness](sessionId, fields.providerSessionId);
}

const NATIVE_SESSION_ID: Record<
  Harness,
  (sessionId: string, providerSessionId: string | null) => string | null
> = {
  pi: (sessionId) => sessionId,
  "claude-sdk": (_sessionId, providerSessionId) => providerSessionId || null,
};

/**
 * Make the session's active binding carry `fields`: update it, or insert the
 * session's next binding when it has none (a new row). Call ONLY from the
 * `sessionStore` writers of the projection columns, inside their transaction.
 */
export function syncActiveBinding(
  sessionId: string,
  fields: ActiveBindingFields,
  createdAt: number,
): void {
  const db = getDb();
  const native = nativeSessionIdFor(sessionId, fields);
  const updated = db
    .prepare(
      `UPDATE session_engine_binding
          SET harness = ?, credential_profile_id = ?, provider = ?, model = ?,
              thinking_level = ?, native_session_id = ?
        WHERE session_id = ? AND ended_at_ms IS NULL`,
    )
    .run(
      fields.harness,
      fields.credentialProfileId,
      fields.provider,
      fields.model,
      fields.thinkingLevel,
      native,
      sessionId,
    );
  if (updated.changes > 0) return;
  db.prepare(
    `INSERT INTO session_engine_binding (
       session_id, seq, harness, credential_profile_id, provider, model,
       thinking_level, native_session_id, started_seq, started_run_id,
       created_at_ms, ended_at_ms
     )
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL
       FROM session_engine_binding WHERE session_id = ?`,
  ).run(
    sessionId,
    fields.harness,
    fields.credentialProfileId,
    fields.provider,
    fields.model,
    fields.thinkingLevel,
    native,
    createdAt,
    sessionId,
  );
}

/** Account-only write-through for the failover CAS. */
export function syncActiveBindingAccount(
  sessionId: string,
  credentialProfileId: string,
): void {
  getDb()
    .prepare(
      "UPDATE session_engine_binding SET credential_profile_id = ? WHERE session_id = ? AND ended_at_ms IS NULL",
    )
    .run(credentialProfileId, sessionId);
}

/** The session's active binding, tombstoned sessions included. */
export function activeBinding(
  sessionId: string,
): SessionEngineBinding | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM session_engine_binding WHERE session_id = ? AND ended_at_ms IS NULL",
    )
    .get(sessionId) as DbBindingRow | undefined;
  return row ? fromRow(row) : undefined;
}

/** Every binding of the session, oldest first. */
export function bindings(sessionId: string): SessionEngineBinding[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM session_engine_binding WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as unknown as DbBindingRow[]
  ).map(fromRow);
}
