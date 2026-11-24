/**
 * A session's engine bindings (`session_engine_binding`, migration 0102): which
 * harness, account, model and effort run it, and the engine's own id for it.
 *
 * Exactly one binding per session row is active. `session_index`'s six binding
 * columns (`harness`, `provider`, `provider_session_id`, `model`,
 * `thinking_level`, `credential_profile_id`) are that binding's PROJECTION:
 * only `sessionStore.upsert`, `sessionStore.switchCredentialProfile` and
 * `sessionStore.switchEngineBinding` write them, each with this table in the
 * same transaction, so the two never disagree
 * (`docs/session-runtime-switching.md` "Engine bindings"). Nothing else writes
 * this table, except {@link stampBindingRun} naming the run that began it.
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
  /**
   * The earlier binding whose native session this one continues (a return
   * that reopened it); absent for a fresh native session and every first
   * binding. Recorded from what the switch's open did, never inferred from
   * equal native ids: a pi return whose transcript was gone shares the id but
   * starts over.
   */
  resumedSeq?: number;
  /**
   * The session usage this binding's engine counts on top of: what the
   * session had used when the switch committed, less what the engine's own
   * native counter already held (a return's record). Present only on a binding
   * whose engine reports its running native total (Claude); its totals are
   * written over this base (`sessionStore.replaceEngineUsage`).
   */
  usageBase?: UsageCounters;
  createdAt: number;
  /** Absent while the binding is active. */
  endedAt?: number;
}

/** The additive part of a session's usage totals. */
export interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costMicros?: number;
  usageTurns: number;
  assistantTurns: number;
}

const COUNTERS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
  "usageTurns",
  "assistantTurns",
] as const;

/**
 * `a` plus or minus `b`, field by field. A difference never goes below 0: a
 * native counter holding more than the session counted (usage the session
 * never saw) leaves nothing, not a negative base.
 */
export function combineUsage(
  a: UsageCounters,
  b: UsageCounters,
  sign: 1 | -1,
): UsageCounters {
  const out = {} as UsageCounters;
  for (const key of COUNTERS) out[key] = Math.max(0, a[key] + sign * b[key]);
  if (a.costMicros !== undefined || b.costMicros !== undefined)
    out.costMicros = Math.max(
      0,
      (a.costMicros ?? 0) + sign * (b.costMicros ?? 0),
    );
  return out;
}

/** A stored base's counters; an unreadable one reads as none. */
function parseUsageBase(json: string | null): UsageCounters | undefined {
  if (json === null) return undefined;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const out = {} as UsageCounters;
    for (const key of COUNTERS) {
      const n = value[key];
      if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
      out[key] = n;
    }
    if (typeof value.costMicros === "number") out.costMicros = value.costMicros;
    return out;
  } catch {
    return undefined;
  }
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
  resumed_seq: number | null;
  usage_base: string | null;
  created_at_ms: number;
  ended_at_ms: number | null;
}

function withUsageBase(usageBase: UsageCounters | undefined): {
  usageBase?: UsageCounters;
} {
  return usageBase ? { usageBase } : {};
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
    ...(row.resumed_seq !== null ? { resumedSeq: row.resumed_seq } : {}),
    ...withUsageBase(parseUsageBase(row.usage_base)),
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

/**
 * End the active binding `expectSeq` and start the session's next one on
 * `fields`, its native id `nativeSessionId` (none for a fresh Claude binding)
 * and `resumedSeq`, the earlier binding whose native session it reopened,
 * with `usageBase` ({@link SessionEngineBinding.usageBase}). Call ONLY from `sessionStore.switchEngineBinding`, inside its transaction.
 * Throws when `expectSeq` is not the active binding.
 */
export function startNextBinding(
  sessionId: string,
  expectSeq: number,
  fields: ActiveBindingFields,
  nativeSessionId: string | null,
  startedSeq: number,
  resumedSeq: number | null,
  usageBase: UsageCounters | null,
  at: number,
): void {
  const db = getDb();
  const ended = db
    .prepare(
      `UPDATE session_engine_binding SET ended_at_ms = ?
        WHERE session_id = ? AND seq = ? AND ended_at_ms IS NULL`,
    )
    .run(at, sessionId, expectSeq);
  if (ended.changes !== 1)
    throw new Error("The session's engine changed while it switched.");
  db.prepare(
    `INSERT INTO session_engine_binding (
       session_id, seq, harness, credential_profile_id, provider, model,
       thinking_level, native_session_id, started_seq, started_run_id,
       resumed_seq, usage_base, created_at_ms, ended_at_ms
     )
     SELECT ?, MAX(seq) + 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL
       FROM session_engine_binding WHERE session_id = ?`,
  ).run(
    sessionId,
    fields.harness,
    fields.credentialProfileId,
    fields.provider,
    fields.model,
    fields.thinkingLevel,
    nativeSessionId,
    startedSeq,
    resumedSeq,
    usageBase ? JSON.stringify(usageBase) : null,
    at,
    sessionId,
  );
}

/**
 * Name the run that began the active binding: the first run a switched-to
 * engine starts. A first binding, and one already stamped, stay as they are.
 */
export function stampBindingRun(sessionId: string, runId: string): void {
  getDb()
    .prepare(
      `UPDATE session_engine_binding SET started_run_id = ?
        WHERE session_id = ? AND ended_at_ms IS NULL AND seq > 1
          AND started_run_id IS NULL`,
    )
    .run(runId, sessionId);
}
