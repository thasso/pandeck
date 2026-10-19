/**
 * The single source of truth for session METADATA.
 *
 * Everything the app needs to list, route, badge, and bill a session lives here,
 * in SQLite (`session_index` + `session_links` + `session_usage_totals` +
 * `session_prompt_conditions` + `session_skills` + `session_agent` +
 * `session_worktree_ack`). The
 * per-session conversation content stays in its log files (`sessions/<id>/
 * native.jsonl` for pi, `claude-sdk/<id>.json` for the SDK); this store never
 * holds file paths — a session id is the only durable locator, and concrete
 * paths are derived on demand (see `sessionStorage.ts`).
 *
 * This module is the ONLY place that talks SQL for session metadata. Consumers
 * use the exported {@link sessionStore} façade so the backing store can be
 * swapped later without touching call sites. Writes are synchronous (node:sqlite
 * + WAL), so metadata is durable the instant a call returns — no in-memory write
 * buffer to lose on Ctrl-C or a dev reload.
 */
import {
  type AgentType,
  DEFAULT_SESSION_SCOPE,
  sessionModeOrDefault,
  sessionScopeOrFailClosed,
  type Harness,
  type SessionForkOrigin,
  type SessionInterruptedRun,
  type SessionMode,
  type SessionOutcomeAttention,
  type SessionOutcomeKind,
  type SessionScope,
  type SettableSpawnOwnership,
  type SpawnOwnership,
} from "@assistant/shared";
import type { AgentUsage } from "@assistant/shared/session";
import { randomUUID } from "node:crypto";
import { getDb } from "./index.ts";

/**
 * Receives the ids of sessions whose LIVENESS may have changed: archived or
 * unarchived, settled or unsettled, a raised outcome, a tombstone, a new row.
 * Initiative summaries list a member Task's sessions only while they are live
 * (`initiativeStore`), so every such write reports here once it has landed.
 * `activity` distinguishes new sessions, turn starts and outcomes from human
 * acknowledgement or removal, which must not wake a settled Initiative.
 */
type SessionLivenessListener = (ids: readonly string[], activity: boolean) => void;

const livenessListeners = new Set<SessionLivenessListener>();

function subscribeLiveness(listener: SessionLivenessListener): () => void {
  livenessListeners.add(listener);
  return () => livenessListeners.delete(listener);
}

function noteLiveness(ids: readonly string[], activity = false): void {
  if (!ids.length) return;
  for (const listener of livenessListeners) {
    try {
      listener(ids, activity);
    } catch {
      // A listener cannot make an already durable session write fail.
    }
  }
}

/** Failure text is a sidebar label, not a log: keep it short enough to render. */
const MAX_RUN_FAILURE_CHARS = 240;

type SessionUsageSource =
  "provider_reported" | "imported" | "estimated" | "manual";

/** Canonical, minimal metadata record for one session. */
/** What boot learned about an interrupted turn, beside its timestamp. */
type InterruptedRunDetail = Omit<SessionInterruptedRun, "at">;

export interface SessionMeta {
  id: string;
  /** Whose session this is; only `user` rows reach a default projection. */
  scope: SessionScope;
  purpose: string;
  harness: Harness;
  agentType: AgentType;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Provider family (e.g. `anthropic`, `openai`, `claude`). */
  provider?: string;
  /** Provider-native resume handle (an id, never a path). */
  providerSessionId?: string;
  model?: string;
  thinkingLevel?: string;
  /** Current account; only live failover may replace an existing binding. */
  credentialProfileId?: string;
  /** Only enterprise accounts may run this session. Immutable after insertion. */
  requiresEnterprise?: boolean;
  /** Per-turn Build/Plan tool policy. */
  mode?: SessionMode;
  archivedAt?: number;
  /**
   * When the user last settled this session out of the Sessions inbox working
   * set. Independent of `archivedAt`: settled rows stay in the ordinary list.
   *
   * On its own this does NOT mean the session is still settled: an outcome
   * raised after it ({@link outcomeAttention}) is unacknowledged attention, and
   * `sessions.ts` is the one place that combines the two into the row's
   * `settledAt`.
   */
  settledAt?: number;
  /** Where the user dragged this session in the Sessions inbox (0075). */
  inboxPosition?: number;
  /**
   * Durable attention state, absent until this session's first outcome. Only a
   * directly owned session raises revisions ({@link recordSessionOutcome}).
   */
  outcomeAttention?: SessionOutcomeAttention;
  /** The last run failure, cleared the moment a new run starts. */
  lastError?: { at: number; message: string };
  /**
   * When a turn was cut off mid-flight by the process dying. NOT a failure: the
   * work is waiting to be continued. Cleared the moment a new run starts.
   */
  interruptedRunAt?: number;
  /** What boot learned about that turn; absent for a mark that predates it. */
  interruptedRunDetail?: InterruptedRunDetail;
  readAt: number;
  forkOrigin?: SessionForkOrigin;
  forkAutoRenamePending: boolean;
  deletedAt?: number;
}

/**
 * Fields a live session writes as it is created/updated. Only the identity
 * (`id`, `harness`, `agentType`) is required; every other field is MERGED —
 * omitting one preserves the stored value rather than nulling it. This is the
 * key contract that lets, say, a title refresh not wipe the model, and a learned
 * provider binding not wipe the title.
 */
interface SessionUpsert {
  id: string;
  harness: Harness;
  agentType: AgentType;
  /**
   * Set on the FIRST write of a session that is not the user's, before anything
   * live can observe it (`claimScope` is the gate that enforces the ordering).
   * INSERT-ONLY: on an existing row the stored scope wins, whatever this says,
   * and a row that never states one is the user's.
   */
  scope?: SessionScope;
  purpose?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount?: number;
  provider?: string;
  providerSessionId?: string;
  model?: string;
  thinkingLevel?: string;
  credentialProfileId?: string;
  requiresEnterprise?: boolean;
  mode?: SessionMode;
  forkOrigin?: SessionForkOrigin;
  forkAutoRenamePending?: boolean;
}

interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costMicros?: number;
  currency: string;
  usageTurns: number;
  assistantTurns: number;
  contextTokens?: number;
  contextWindow?: number;
  usageSource: SessionUsageSource;
  updatedAt: number;
}

/* --------------------------------- rows ---------------------------------- */

interface DbSessionRow {
  id: string;
  scope: string;
  purpose: string;
  harness: Harness;
  agent_type: AgentType;
  title: string;
  created_at_ms: number;
  updated_at_ms: number;
  message_count: number;
  provider: string | null;
  provider_session_id: string | null;
  model: string | null;
  thinking_level: string | null;
  credential_profile_id: string | null;
  requires_enterprise: number;
  mode: string;
  archived_at_ms: number | null;
  settled_at_ms: number | null;
  inbox_position: number | null;
  attention_revision: number;
  attention_settled_revision: number;
  attention_kind: string | null;
  attention_at_ms: number | null;
  last_error_at_ms: number | null;
  last_error_text: string | null;
  interrupted_run_at_ms: number | null;
  interrupted_run_json: string | null;
  read_at_ms: number;
  fork_origin_json: string | null;
  fork_auto_rename_pending: number;
  deleted_at_ms: number | null;
}

function fromRow(row: DbSessionRow): SessionMeta {
  const forkOriginValue = parseForkOrigin(row.fork_origin_json);
  const attentionValue = attentionFromRow(row);
  return {
    id: row.id,
    // Fail closed: a scope this build does not know is never the user's.
    scope: sessionScopeOrFailClosed(row.scope),
    purpose: row.purpose,
    harness: row.harness,
    agentType: row.agent_type,
    title: row.title,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    messageCount: row.message_count,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.provider_session_id
      ? { providerSessionId: row.provider_session_id }
      : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}),
    ...(row.credential_profile_id
      ? { credentialProfileId: row.credential_profile_id }
      : {}),
    ...(row.requires_enterprise ? { requiresEnterprise: true } : {}),
    mode: sessionModeOrDefault(row.mode),
    ...(row.archived_at_ms !== null ? { archivedAt: row.archived_at_ms } : {}),
    ...(row.settled_at_ms !== null ? { settledAt: row.settled_at_ms } : {}),
    ...(row.inbox_position !== null
      ? { inboxPosition: row.inbox_position }
      : {}),
    ...(attentionValue !== undefined
      ? { outcomeAttention: attentionValue }
      : {}),
    ...(row.last_error_at_ms !== null && row.last_error_text
      ? {
          lastError: { at: row.last_error_at_ms, message: row.last_error_text },
        }
      : {}),
    ...interruptedRunFields(row),
    readAt: row.read_at_ms,
    ...(parseForkOrigin(row.fork_origin_json)
      ? {
          ...(forkOriginValue !== undefined
            ? { forkOrigin: forkOriginValue }
            : {}),
        }
      : {}),
    forkAutoRenamePending: Boolean(row.fork_auto_rename_pending),
    ...(row.deleted_at_ms !== null ? { deletedAt: row.deleted_at_ms } : {}),
  };
}

/**
 * Attention state, or `undefined` while no outcome has ever been raised —
 * revision 0 is "nothing has happened yet", which is not the same claim as
 * "completed at time 0". A row whose kind this build cannot read is treated as
 * a completion: the revision is real, so dropping it would silently un-wake a
 * session, and `completed` is the weaker of the two things it could say.
 */
function attentionFromRow(
  row: DbSessionRow,
): SessionOutcomeAttention | undefined {
  if (row.attention_revision <= 0) return undefined;
  return {
    revision: row.attention_revision,
    settledRevision: row.attention_settled_revision,
    kind: row.attention_kind === "failed" ? "failed" : "completed",
    at: row.attention_at_ms ?? row.updated_at_ms,
  };
}

function interruptedRunFields(
  row: DbSessionRow,
): Pick<SessionMeta, "interruptedRunAt" | "interruptedRunDetail"> {
  if (row.interrupted_run_at_ms === null) return {};
  const detail = parseInterruptedRunDetail(row.interrupted_run_json);
  return {
    interruptedRunAt: row.interrupted_run_at_ms,
    ...(detail ? { interruptedRunDetail: detail } : {}),
  };
}

/** Keeps only well-typed fields: an unreadable detail is an absent one. */
function parseInterruptedRunDetail(
  raw: string | null,
): InterruptedRunDetail | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as Record<string, unknown>;
  const cause = value.cause as Record<string, unknown> | undefined;
  return {
    ...(cause &&
    (cause.kind === "crash" || cause.kind === "restart") &&
    typeof cause.detail === "string"
      ? { cause: { kind: cause.kind, detail: cause.detail } }
      : {}),
    ...(typeof value.promptKept === "boolean"
      ? { promptKept: value.promptKept }
      : {}),
    ...(typeof value.modelSteps === "number"
      ? { modelSteps: value.modelSteps }
      : {}),
  };
}

function parseForkOrigin(raw: string | null): SessionForkOrigin | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SessionForkOrigin;
  } catch {
    return undefined;
  }
}

function rawRow(id: string): DbSessionRow | undefined {
  return getDb().prepare("SELECT * FROM session_index WHERE id = ?").get(id) as
    DbSessionRow | undefined;
}

/* --------------------------------- writes -------------------------------- */

const insertColumns =
  "id, scope, purpose, harness, agent_type, title, created_at_ms, updated_at_ms, " +
  "message_count, provider, provider_session_id, model, thinking_level, credential_profile_id, requires_enterprise, mode, fork_origin_json, fork_auto_rename_pending";

// A full-row write. We compute the merged values in TS (see `upsert`), so ON
// CONFLICT can set every column unconditionally without ever nulling a field the
// caller didn't touch. read_at_ms / archived_at_ms / settled_at_ms /
// inbox_position / attention_* / last_error_* / deleted_at_ms are managed by
// their own methods and intentionally excluded here so a metadata refresh never
// disturbs read/archive/settlement/inbox order/attention/failure/tombstone
// state.
const upsertSql = `
  INSERT INTO session_index (${insertColumns})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    scope = excluded.scope,
    purpose = excluded.purpose,
    harness = excluded.harness,
    agent_type = excluded.agent_type,
    title = excluded.title,
    created_at_ms = excluded.created_at_ms,
    updated_at_ms = excluded.updated_at_ms,
    message_count = excluded.message_count,
    provider = excluded.provider,
    provider_session_id = excluded.provider_session_id,
    model = excluded.model,
    thinking_level = excluded.thinking_level,
    credential_profile_id = excluded.credential_profile_id,
    requires_enterprise = excluded.requires_enterprise,
    mode = excluded.mode,
    fork_origin_json = excluded.fork_origin_json,
    fork_auto_rename_pending = excluded.fork_auto_rename_pending
  WHERE session_index.deleted_at_ms IS NULL
`;

/** Insert-or-merge a metadata record. Omitted fields preserve stored values. */
function upsert(input: SessionUpsert): boolean {
  try {
    const prev = rawRow(input.id);
    if (prev?.deleted_at_ms) return false; // never resurrect a removed session
    const now = Date.now();
    const pick = <T>(
      next: T | undefined,
      existing: T | null | undefined,
      fallback: T,
    ): T => (next !== undefined ? next : (existing ?? fallback));
    const forkOriginJson =
      input.forkOrigin !== undefined
        ? JSON.stringify(input.forkOrigin)
        : (prev?.fork_origin_json ?? null);
    getDb()
      .prepare(upsertSql)
      .run(
        input.id,
        // Scope is INSERT-ONLY, like createdAt: the
        // first stored value owns the row for its life. A later write can never
        // reclassify a session — not by stating a different scope, and not by
        // omitting one — because the access policy built on it (Task-477) would
        // otherwise be one stray metadata refresh away from being wrong.
        prev
          ? sessionScopeOrFailClosed(prev.scope)
          : (input.scope ?? DEFAULT_SESSION_SCOPE),
        pick(input.purpose, prev?.purpose, "chat"),
        input.harness,
        input.agentType,
        pick(input.title, prev?.title, "New chat"),
        // createdAt is insert-only: the first stored value always wins so an update
        // can never move a session's creation time.
        prev?.created_at_ms ?? input.createdAt ?? now,
        pick(input.updatedAt, prev?.updated_at_ms, now),
        pick(input.messageCount, prev?.message_count, 0),
        input.provider !== undefined
          ? input.provider
          : (prev?.provider ?? null),
        input.providerSessionId !== undefined
          ? input.providerSessionId
          : (prev?.provider_session_id ?? null),
        input.model !== undefined ? input.model : (prev?.model ?? null),
        input.thinkingLevel !== undefined
          ? input.thinkingLevel
          : (prev?.thinking_level ?? null),
        // Ordinary metadata refreshes cannot change the current binding.
        // Live failover uses switchCredentialProfile's compare-and-set.
        prev?.credential_profile_id ?? input.credentialProfileId ?? null,
        prev?.requires_enterprise ?? (input.requiresEnterprise ? 1 : 0),
        sessionModeOrDefault(input.mode ?? prev?.mode),
        forkOriginJson,
        (input.forkAutoRenamePending ?? Boolean(prev?.fork_auto_rename_pending))
          ? 1
          : 0,
      );
    if (!prev) noteLiveness([input.id], true);
    return true;
  } catch (err) {
    console.warn(
      "sessionStore.upsert failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Live failover only: refuse a stale binding or a session deleted during the move. */
function switchCredentialProfile(
  id: string,
  previous: string,
  next: string,
): void {
  const result = getDb()
    .prepare(
      "UPDATE session_index SET credential_profile_id = ? WHERE id = ? AND credential_profile_id = ? AND deleted_at_ms IS NULL",
    )
    .run(next, id, previous);
  if (result.changes !== 1)
    throw new Error(
      "The session's account changed or the session was deleted during the switch.",
    );
}

/**
 * Tombstone a session and say what the row was, THROWING on a failed write:
 * for a caller whose other writes in the same transaction must not outlive a
 * session that stayed live (`backgroundWorkStore.deleteOwnerSession`).
 */
function markDeleted(
  id: string,
  ts = Date.now(),
): "deleted" | "already-deleted" | "missing" {
  const result = getDb()
    .prepare(
      "UPDATE session_index SET deleted_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
    )
    .run(ts, id);
  if (result.changes > 0) {
    noteLiveness([id]);
    return "deleted";
  }
  return getDb().prepare("SELECT 1 FROM session_index WHERE id = ?").get(id)
    ? "already-deleted"
    : "missing";
}

/** Tombstone a session so a late in-flight upsert cannot resurrect it. */
function remove(id: string, ts = Date.now()): void {
  try {
    markDeleted(id, ts);
  } catch {
    // best-effort; a failed tombstone only leaves a stale row, not corruption.
  }
}

function markRead(id: string, ts: number): boolean {
  try {
    const result = getDb()
      .prepare(
        "UPDATE session_index SET read_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL AND read_at_ms < ?",
      )
      .run(ts, id, ts);
    return result.changes > 0;
  } catch {
    return false;
  }
}

function getReadAt(id: string): number {
  const row = getDb()
    .prepare("SELECT read_at_ms FROM session_index WHERE id = ?")
    .get(id) as { read_at_ms: number } | undefined;
  return row?.read_at_ms ?? 0;
}

function setArchived(id: string, archived: boolean, ts = Date.now()): void {
  try {
    getDb()
      .prepare(
        "UPDATE session_index SET archived_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
      )
      .run(archived ? ts : null, id);
    if (archived) markReadThrough(id);
    noteLiveness([id]);
  } catch {
    // best-effort mirror
  }
}

/** How many ids one `IN (…)` list carries; well under SQLite's variable limit. */
const ARCHIVE_BATCH_CHUNK = 500;

/**
 * Archive every one of `ids` whose DURABLE eligibility for automatic retention
 * still holds, in ONE transaction, and answer the ids actually changed.
 *
 * The caller (`sessionRetention.ts`) has already chosen the ids from the live
 * projection; this is the store's own recheck of everything it can see —
 * user scope, live row, not yet archived, settled no later than
 * `settledBefore`, and no outcome revision beyond the acknowledged one — so a
 * row that was woken or archived between the read and the write is skipped
 * rather than archived twice or out of policy. Like {@link setArchived}, the
 * read mark advances through the row's latest update: a shelved session is
 * read by definition.
 *
 * One commit for the whole sweep, whatever its size, is what makes the legacy
 * backfill (thousands of settled rows on the first boot after this rule ships)
 * one write rather than one per row. A failure writes NOTHING and answers no
 * ids; the sweep retries later.
 */
function archiveSettledBatch(
  ids: readonly string[],
  settledBefore: number,
  ts = Date.now(),
): string[] {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return [];
  const db = getDb();
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    return [];
  }
  const archived: string[] = [];
  try {
    for (let i = 0; i < distinct.length; i += ARCHIVE_BATCH_CHUNK) {
      const chunk = distinct.slice(i, i + ARCHIVE_BATCH_CHUNK);
      const rows = db
        .prepare(
          `UPDATE session_index
              SET archived_at_ms = ?,
                  read_at_ms = MAX(read_at_ms, updated_at_ms)
            WHERE id IN (${chunk.map(() => "?").join(", ")})
              AND scope = ?
              AND deleted_at_ms IS NULL
              AND archived_at_ms IS NULL
              AND settled_at_ms IS NOT NULL
              AND settled_at_ms <= ?
              AND attention_revision <= attention_settled_revision
        RETURNING id`,
        )
        .all(
          ...([ts, ...chunk, DEFAULT_SESSION_SCOPE, settledBefore] as never[]),
        ) as Array<{ id: string }>;
      for (const row of rows) archived.push(row.id);
    }
    db.exec("COMMIT");
    noteLiveness(archived);
    return archived;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    console.warn(
      "sessionStore.archiveSettledBatch failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Putting a session down MARKS IT READ. Archived and settled both mean "I am
 * finished with this for now", which cannot be true of a response you have not
 * seen — an unread marker on a shelf row is a contradiction the user can only
 * clear by opening a session they deliberately put away.
 */
function markReadThrough(id: string): void {
  getDb()
    .prepare(
      "UPDATE session_index SET read_at_ms = updated_at_ms WHERE id = ? AND deleted_at_ms IS NULL AND read_at_ms < updated_at_ms",
    )
    .run(id);
}

/**
 * Move the session's activity timestamp forward, never backward. Submitting a
 * prompt is an update to the session even though nothing has been produced yet,
 * so the inbox must re-sort on it rather than waiting for the turn to end.
 */
function touch(id: string, ts = Date.now()): void {
  try {
    const result = getDb()
      .prepare(
        "UPDATE session_index SET updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL AND updated_at_ms < ?",
      )
      .run(ts, id, ts);
    if (result.changes > 0) noteLiveness([id], true);
  } catch {
    // best-effort mirror
  }
}

/**
 * Move a session out of (`settled`) or back into the Sessions inbox working
 * set. Returns true when a live row actually changed, so callers can tell a
 * real transition apart from a no-op on an unknown/tombstoned id.
 *
 * `throughRevision` is what the settler had SEEN. It is clamped to the stored
 * revision — acknowledging the future is meaningless — and a lower value leaves
 * the newer outcome unacknowledged, so the row keeps its attention and stays in
 * the working set even though this call succeeded. Omitting it acknowledges the
 * current revision, which only a server-side settlement may assume.
 *
 * The acknowledged revision only ever moves FORWARD (`MAX`). Two tabs settle
 * the same session out of order all the time — the second click can carry the
 * older observation — and letting it win would resurrect an outcome the user
 * has already acknowledged from the other tab.
 *
 * Unsettling deliberately leaves the acknowledged revision where it is: it adds
 * the session back to the visible set without pretending its past outcomes were
 * never seen, so the NEXT outcome is what raises attention again.
 */
function setSettled(
  id: string,
  settled: boolean,
  ts = Date.now(),
  throughRevision?: number,
): boolean {
  try {
    const db = getDb();
    if (!settled) {
      const unsettled =
        db
          .prepare(
            "UPDATE session_index SET settled_at_ms = NULL WHERE id = ? AND deleted_at_ms IS NULL",
          )
          .run(id).changes > 0;
      if (unsettled) noteLiveness([id]);
      return unsettled;
    }
    const result =
      throughRevision === undefined
        ? db
            .prepare(
              `UPDATE session_index
                  SET settled_at_ms = ?, attention_settled_revision = attention_revision
                WHERE id = ? AND deleted_at_ms IS NULL`,
            )
            .run(ts, id)
        : db
            .prepare(
              `UPDATE session_index
                  SET settled_at_ms = ?,
                      attention_settled_revision = MAX(
                        attention_settled_revision,
                        MIN(attention_revision, ?)
                      )
                WHERE id = ? AND deleted_at_ms IS NULL`,
            )
            .run(ts, Math.max(0, Math.trunc(throughRevision)), id);
    if (result.changes > 0) {
      markReadThrough(id);
      noteLiveness([id]);
    }
    return result.changes > 0;
  } catch {
    return false;
  }
}

/**
 * Raise a new attention revision because a directly owned session's run ENDED.
 * Returns the new revision, or `undefined` when there was no live row to move.
 *
 * The bump is the only thing that can take a settled session back out of the
 * shelf, and it is unconditional on the current settlement: a session nobody
 * settled still records its outcome, so the next Settle has an exact revision
 * to acknowledge instead of a moving target. Ownership is decided by the caller
 * ({@link isDirectlyOwnedSession}) — this store never classifies a spawn.
 */
function recordSessionOutcome(
  id: string,
  kind: SessionOutcomeKind,
  ts = Date.now(),
): number | undefined {
  try {
    const row = getDb()
      .prepare(
        `UPDATE session_index
            SET attention_revision = attention_revision + 1,
                attention_kind = ?,
                attention_at_ms = ?
          WHERE id = ? AND deleted_at_ms IS NULL
      RETURNING attention_revision AS revision`,
      )
      .get(kind, ts, id) as { revision: number } | undefined;
    if (row) noteLiveness([id], true);
    return row?.revision;
  } catch {
    return undefined;
  }
}

/**
 * Record that the user accepted running this session in the app CWD after its
 * worktree disappeared (Task 321). The acknowledged WORKTREE id is stored, so
 * the answer applies to that worktree only — the session store never judges
 * whether it is still relevant (see `worktrees/sessionCwd.ts`). Keyed by session
 * id alone, independent of whether a metadata row exists.
 */
function acknowledgeMissingWorktree(
  id: string,
  worktreeId: string,
  ts = Date.now(),
): void {
  try {
    getDb()
      .prepare(
        "INSERT INTO session_worktree_ack (session_id, worktree_id, acknowledged_at_ms) VALUES (?, ?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET worktree_id = excluded.worktree_id, acknowledged_at_ms = excluded.acknowledged_at_ms",
      )
      .run(id, worktreeId, ts);
  } catch (err) {
    console.warn(
      "sessionStore.acknowledgeMissingWorktree failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The worktree id acknowledged as gone for this session, if any. */
function worktreeMissingAck(id: string): string | undefined {
  try {
    const row = getDb()
      .prepare(
        "SELECT worktree_id FROM session_worktree_ack WHERE session_id = ?",
      )
      .get(id) as { worktree_id: string } | undefined;
    return row?.worktree_id;
  } catch {
    return undefined;
  }
}

/**
 * Every acknowledgement in one scan, for the session-list build (which must
 * never do a per-row store read).
 */
function worktreeMissingAckBySession(): Map<string, string> {
  try {
    const rows = getDb()
      .prepare("SELECT session_id, worktree_id FROM session_worktree_ack")
      .all() as Array<{ session_id: string; worktree_id: string }>;
    return new Map(rows.map((r) => [r.session_id, r.worktree_id]));
  } catch {
    return new Map();
  }
}

/**
 * Settle a coordinator together with the peers it still owns, in ONE
 * transaction: the coordinator through `throughRevision` (clamped and
 * monotonic exactly as {@link setSettled}), every peer through its CURRENT
 * revision — the server-side privilege the user's acknowledgement of the
 * coordinator grants. Returns false and writes NOTHING when any row cannot be
 * updated (tombstoned, DB trouble): the caller has told every one of these
 * sessions it may leave, and a coordinator put down while a peer stayed up is
 * the partial state a Settle promises not to produce.
 */
function settleWithPeers(
  id: string,
  throughRevision: number,
  peerIds: readonly string[],
  ts = Date.now(),
): boolean {
  const db = getDb();
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    return false;
  }
  try {
    const owner = db
      .prepare(
        `UPDATE session_index
            SET settled_at_ms = ?,
                attention_settled_revision = MAX(
                  attention_settled_revision,
                  MIN(attention_revision, ?)
                )
          WHERE id = ? AND deleted_at_ms IS NULL`,
      )
      .run(ts, Math.max(0, Math.trunc(throughRevision)), id);
    if (owner.changes === 0) throw new Error("owner row not updated");
    // A peer already down keeps the time it was put down: the cascade also
    // reaches settled peers kept in the fold by live work below them, and
    // re-stamping one would lift it to the top of the Settled shelf. "Down"
    // is the effective answer `isSettled` gives — a stored stamp under an
    // outcome still open is not one, and is renewed.
    const peer = db.prepare(
      `UPDATE session_index
          SET settled_at_ms = CASE
                WHEN settled_at_ms IS NOT NULL
                 AND attention_revision <= attention_settled_revision
                THEN settled_at_ms ELSE ? END,
              attention_settled_revision = attention_revision
        WHERE id = ? AND deleted_at_ms IS NULL`,
    );
    for (const peerId of peerIds)
      if (peer.run(ts, peerId).changes === 0)
        throw new Error("peer row not updated");
    for (const settledId of [id, ...peerIds]) markReadThrough(settledId);
    db.exec("COMMIT");
    noteLiveness([id, ...peerIds]);
    return true;
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    return false;
  }
}

/**
 * Whether the session is settled RIGHT NOW: put down by the user, and no
 * outcome raised since. The same conjunction the list projection applies, so a
 * caller never has to combine the two halves itself.
 */
function isSettled(id: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT settled_at_ms, attention_revision, attention_settled_revision
         FROM session_index WHERE id = ?`,
    )
    .get(id) as
    | {
        settled_at_ms: number | null;
        attention_revision: number;
        attention_settled_revision: number;
      }
    | undefined;
  if (!row || row.settled_at_ms == null) return false;
  return row.attention_revision <= row.attention_settled_revision;
}

/**
 * Record the last run failure so a failed session is visible in the Sessions
 * inbox without opening it. The message is bounded here (not at the call site)
 * so no caller can persist a whole stack trace into the list projection.
 */
function recordRunFailure(id: string, message: string, ts = Date.now()): void {
  try {
    const text = message
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_RUN_FAILURE_CHARS);
    getDb()
      .prepare(
        "UPDATE session_index SET last_error_at_ms = ?, last_error_text = ? WHERE id = ? AND deleted_at_ms IS NULL",
      )
      .run(ts, text || "The agent run failed.", id);
  } catch {
    // best-effort mirror
  }
}

/**
 * Record that this session holds a turn the process died inside. Written by boot
 * recovery from the session log's own run markers, never from a live run: while
 * the server is up an interrupted turn is not a thing that can be observed, only
 * a thing that is discovered afterwards.
 */
function recordInterruptedRun(
  id: string,
  ts: number,
  detail: InterruptedRunDetail = {},
): void {
  try {
    getDb()
      .prepare(
        "UPDATE session_index SET interrupted_run_at_ms = ?, interrupted_run_json = ? WHERE id = ? AND deleted_at_ms IS NULL",
      )
      .run(ts, JSON.stringify(detail), id);
  } catch {
    // best-effort mirror
  }
}

/**
 * Clear it on the NEXT RUN START rather than on a successful one. By the time a
 * run starts the user is looking at the session, and a continuation that fails
 * on its own terms has `last_error_*` to say so — leaving both badges up would
 * describe the same event twice.
 */
function clearInterruptedRun(id: string): void {
  try {
    getDb()
      .prepare(
        "UPDATE session_index SET interrupted_run_at_ms = NULL, interrupted_run_json = NULL WHERE id = ? AND deleted_at_ms IS NULL",
      )
      .run(id);
  } catch {
    // best-effort mirror
  }
}

function clearRunFailure(id: string): void {
  try {
    getDb()
      .prepare(
        "UPDATE session_index SET last_error_at_ms = NULL, last_error_text = NULL WHERE id = ? AND deleted_at_ms IS NULL",
      )
      .run(id);
  } catch {
    // best-effort mirror
  }
}

/** What the clicked row showed as its failure (`dismissSessionFailure`). */
interface ObservedRunFailure {
  /** `lastError.at`; undefined when the row showed no error record. */
  errorAt: number | undefined;
  /** `outcomeAttention.revision`; 0 when the row carried none. */
  outcomeRevision: number;
}

/**
 * `dismissed`: written. `unchanged`: the row holds no failure any more (another
 * tab dismissed it, a run start cleared it). `stale`: it holds a failure the
 * click did not observe, so nothing was written. `failed`: no live row, or DB
 * trouble.
 */
type RunFailureDismissal = "dismissed" | "unchanged" | "stale" | "failed";

/** The row's latest outcome is a failure no Settle has acknowledged. */
const PENDING_FAILED_OUTCOME =
  "(attention_kind = 'failed' AND attention_revision > attention_settled_revision)";

/**
 * Dismiss the failure the user saw on a session's row, WITHOUT settling it.
 * ONE guarded statement, so the observation and the write cannot be split by
 * a run outcome landing in between.
 *
 * It matches only when `last_error_at_ms` and `attention_revision` are still
 * exactly what the row showed: every directly owned failure raises a revision,
 * and a coordinator-owned one (no revision) is told apart by its timestamp.
 * That pair is the whole identity — a coordinator-owned peer that failed again
 * in the same millisecond, raising no revision, is indistinguishable, an
 * accepted residual.
 *
 * It clears the error record and acknowledges the latest outcome ONLY when that
 * is a pending FAILURE, so a completion is never acknowledged by it. A pending
 * outcome is what withholds a stored `settled_at_ms` ({@link isSettled}), so
 * acknowledging it would put the session back on the shelf under that OLD
 * stamp, retention-eligible at once; the stamp is cleared with it, keeping the
 * session as unsettled as it already was. A stamp that still holds (no pending
 * outcome) is never touched. Read state, queued work and peers are untouched.
 */
function dismissRunFailure(
  id: string,
  observed: ObservedRunFailure,
): RunFailureDismissal {
  try {
    const db = getDb();
    const written = db
      .prepare(
        `UPDATE session_index
            SET last_error_at_ms = NULL,
                last_error_text = NULL,
                settled_at_ms = CASE WHEN ${PENDING_FAILED_OUTCOME}
                  THEN NULL ELSE settled_at_ms END,
                attention_settled_revision = CASE WHEN ${PENDING_FAILED_OUTCOME}
                  THEN attention_revision ELSE attention_settled_revision END
          WHERE id = ? AND deleted_at_ms IS NULL
            AND attention_revision = ?
            AND last_error_at_ms IS ?
            AND (last_error_at_ms IS NOT NULL OR ${PENDING_FAILED_OUTCOME})
      RETURNING id`,
      )
      .get(id, observed.outcomeRevision, observed.errorAt ?? null);
    if (written) {
      noteLiveness([id]);
      return "dismissed";
    }
    const row = db
      .prepare(
        `SELECT last_error_at_ms IS NOT NULL OR ${PENDING_FAILED_OUTCOME} AS holds
           FROM session_index WHERE id = ? AND deleted_at_ms IS NULL`,
      )
      .get(id) as { holds: number } | undefined;
    if (!row) return "failed";
    return row.holds ? "stale" : "unchanged";
  } catch {
    return "failed";
  }
}

function isArchived(id: string): boolean {
  const row = getDb()
    .prepare("SELECT archived_at_ms FROM session_index WHERE id = ?")
    .get(id) as { archived_at_ms: number | null } | undefined;
  return row?.archived_at_ms != null;
}

function updateStats(
  id: string,
  stats: { messageCount?: number; updatedAt?: number },
): void {
  try {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (stats.messageCount !== undefined) {
      sets.push("message_count = ?");
      params.push(stats.messageCount);
    }
    if (stats.updatedAt !== undefined) {
      sets.push("updated_at_ms = ?");
      params.push(stats.updatedAt);
    }
    if (sets.length === 0) return;
    params.push(id);
    getDb()
      .prepare(
        `UPDATE session_index SET ${sets.join(", ")} WHERE id = ? AND deleted_at_ms IS NULL`,
      )
      .run(...(params as never[]));
  } catch {
    // best-effort mirror
  }
}

/* ---------------------------- prompt conditions --------------------------- */

/**
 * Freeze the session-start prompt conditions (Task 287), or return the ones
 * already frozen. INSERT-ONLY: the first write wins for the life of the
 * session, so a later gate change or reopen cannot move the assembled system
 * prompt and bust the provider's cache prefix. The payload is opaque JSON here;
 * `promptConditions.ts` owns its shape.
 *
 * Falls back to the caller's own text if the write fails: an unwritable
 * condition record must degrade to a recomputed prompt, never block a session.
 */
function freezePromptConditions(
  id: string,
  conditionsJson: string,
  ts = Date.now(),
): string {
  try {
    getDb()
      .prepare(
        "INSERT INTO session_prompt_conditions (session_id, conditions_json, created_at_ms) " +
          "VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING",
      )
      .run(id, conditionsJson, ts);
    return getPromptConditions(id) ?? conditionsJson;
  } catch (err) {
    console.warn(
      "sessionStore.freezePromptConditions failed:",
      err instanceof Error ? err.message : String(err),
    );
    return conditionsJson;
  }
}

/** The frozen prompt-condition JSON for a session, if it has one. */
function getPromptConditions(id: string): string | undefined {
  try {
    const row = getDb()
      .prepare(
        "SELECT conditions_json FROM session_prompt_conditions WHERE session_id = ?",
      )
      .get(id) as { conditions_json: string } | undefined;
    return row?.conditions_json;
  } catch {
    return undefined;
  }
}

/* ------------------------------ session skills ---------------------------- */

/**
 * Freeze the resolved library-skill name list, or return the row that already
 * won. The payload stays opaque here; `sessionSkills.ts` owns validation.
 */
function freezeSkills(id: string, namesJson: string, ts = Date.now()): string {
  try {
    getDb()
      .prepare(
        "INSERT INTO session_skills (session_id, names_json, created_at_ms) " +
          "VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING",
      )
      .run(id, namesJson, ts);
    return getSkills(id) ?? namesJson;
  } catch (err) {
    console.warn(
      "sessionStore.freezeSkills failed:",
      err instanceof Error ? err.message : String(err),
    );
    return namesJson;
  }
}

/** Remove a session's frozen library-skill list when its source is removed. */
function deleteSkills(id: string): void {
  try {
    getDb().prepare("DELETE FROM session_skills WHERE session_id = ?").run(id);
  } catch (err) {
    console.warn(
      "sessionStore.deleteSkills failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The frozen library-skill JSON for a session, if it has one. */
function getSkills(id: string): string | undefined {
  try {
    const row = getDb()
      .prepare("SELECT names_json FROM session_skills WHERE session_id = ?")
      .get(id) as { names_json: string } | undefined;
    return row?.names_json;
  } catch {
    return undefined;
  }
}

/* ------------------------------ session agent ----------------------------- */

/**
 * Freeze the agent definition a session was spawned from, or return the row
 * that already won. The payload stays opaque here; `agents/sessionAgent.ts`
 * owns its shape and validation.
 */
function freezeAgent(
  id: string,
  definitionJson: string,
  ts = Date.now(),
): string | undefined {
  getDb()
    .prepare(
      "INSERT INTO session_agent (session_id, definition_json, created_at_ms) " +
        "VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING",
    )
    .run(id, definitionJson, ts);
  return getAgent(id);
}

/** The frozen agent definition JSON for a session, if it was spawned from one. */
function getAgent(id: string): string | undefined {
  const row = getDb()
    .prepare("SELECT definition_json FROM session_agent WHERE session_id = ?")
    .get(id) as { definition_json: string } | undefined;
  return row?.definition_json;
}

/* --------------------------------- reads --------------------------------- */

function get(id: string): SessionMeta | undefined {
  const row = rawRow(id);
  return row && row.deleted_at_ms === null ? fromRow(row) : undefined;
}

/**
 * Read a metadata record even when it is tombstoned. Cross-session inspection
 * tools need to tell "deleted" apart from "never existed" so a copied id of a
 * removed session produces an actionable outcome instead of a bare not-found.
 */
function getIncludingDeleted(id: string): SessionMeta | undefined {
  const row = rawRow(id);
  return row ? fromRow(row) : undefined;
}

/**
 * Which scopes a read covers. Omitting it is the DEFAULT PROJECTION: `user`
 * rows only. Seeing anything else is an explicit act — `"all"` is for the few
 * reads that are about session rows as such (id reconciliation, credential
 * bookkeeping), never for something the user is shown.
 */
interface SessionScopeFilter {
  scopes?: readonly SessionScope[] | "all";
}

function scopeClause(
  filter: SessionScopeFilter,
  clauses: string[],
  params: unknown[],
): void {
  const scopes = filter.scopes ?? [DEFAULT_SESSION_SCOPE];
  if (scopes === "all") return;
  // An empty scope list asks for nothing, and says so in SQL rather than
  // degrading into "no filter".
  if (scopes.length === 0) {
    clauses.push("0");
    return;
  }
  clauses.push(`scope IN (${scopes.map(() => "?").join(", ")})`);
  params.push(...scopes);
}

/**
 * Every listable metadata record, newest first. `excludeArchived` is the
 * DEFAULT PROJECTION's shape (`session_index_scope_unarchived_updated_idx`):
 * the sidebar list is rebuilt up to ~4 times a second and serialized on every
 * connect, so it must scale with the ACTIVE rows, not with the archive that
 * automatic retention (`sessionRetention.ts`) grows behind them. `ids` bounds
 * the read to known rows by primary key, for a one-row list refresh.
 */
function list(
  opts: SessionScopeFilter & {
    includeDeleted?: boolean;
    excludeArchived?: boolean;
    ids?: readonly string[];
  } = {},
): SessionMeta[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    clauses.push(`id IN (${opts.ids.map(() => "?").join(", ")})`);
    params.push(...opts.ids);
  }
  scopeClause(opts, clauses, params);
  if (!opts.includeDeleted) clauses.push("deleted_at_ms IS NULL");
  if (opts.excludeArchived) clauses.push("archived_at_ms IS NULL");
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM session_index ${where} ORDER BY updated_at_ms DESC`)
    .all(...(params as never[])) as unknown as DbSessionRow[];
  return rows.map(fromRow);
}

/**
 * Whether each of `candidateIds` may appear in a DEFAULT projection, for the
 * live in-memory sources that merge into the session list (the pi store, the
 * Claude SDK store). Those know nothing about scope, so without this a running
 * `internal`/`subagent` session would ride into the sidebar past the store's
 * own `WHERE scope = 'user'`.
 *
 * The same gate answers for ARCHIVE state, since the default projection reads
 * unarchived rows only ({@link list} with `excludeArchived`): a live runtime
 * whose row is archived would otherwise be reintroduced as a live-only row the
 * moment the store query stopped returning it. `includeArchived` is the
 * on-demand archive view, where the store rows already cover those ids.
 *
 * Bounded by the caller's ids — the list is rebuilt up to ~4 times a second, and
 * a scan of every internal usage stub ever recorded would cost more than the
 * whole rest of the rebuild — and keyed by the primary key.
 *
 * FAILS CLOSED, twice over: an id whose row cannot be read is excluded, and a
 * failed read excludes EVERY candidate. Only the live sources go through this,
 * so the worst case is that a not-yet-persisted session is missing from the
 * list until the store answers again, never that a hidden session is shown. An
 * id with NO row at all is allowed, which is what {@link claimScope} makes safe:
 * a scope is persisted before anything live can observe the session.
 */
function liveDefaultScopeGate(
  candidateIds: Iterable<string>,
  opts: { includeArchived?: boolean } = {},
): (id: string) => boolean {
  const ids = [...new Set(candidateIds)];
  if (ids.length === 0) return () => true;
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, scope, archived_at_ms FROM session_index
           WHERE id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(...(ids as never[])) as Array<{
      id: string;
      scope: string;
      archived_at_ms: number | null;
    }>;
    const outside = new Set(
      rows
        .filter(
          (row) =>
            sessionScopeOrFailClosed(row.scope) !== "user" ||
            (!opts.includeArchived && row.archived_at_ms !== null),
        )
        .map((row) => row.id),
    );
    return (id: string) => !outside.has(id);
  } catch (err) {
    console.warn(
      "sessionStore.liveDefaultScopeGate failed; hiding live-only rows:",
      err instanceof Error ? err.message : String(err),
    );
    return () => false;
  }
}

/**
 * The write-side half of the scope contract: claim `id` for `scope` BEFORE the
 * session can be registered in any live registry.
 *
 * Persisting the row first is what lets every default projection treat a live
 * session with no row as the user's. So this either writes that row (a session
 * nothing has persisted yet) or checks the stored scope against the claim, and
 * THROWS on a mismatch: registering a subagent session through a path that
 * declares no scope is a bug that must surface at the registration, not as a
 * subagent conversation appearing in the user's sidebar.
 */
function claimScope(input: {
  id: string;
  harness: Harness;
  agentType: AgentType;
  scope?: SessionScope;
  requiresEnterprise?: boolean;
}): void {
  const scope = input.scope ?? DEFAULT_SESSION_SCOPE;
  const prev = rawRow(input.id);
  if (prev) {
    const stored = sessionScopeOrFailClosed(prev.scope);
    if (stored !== scope)
      throw new Error(
        `Session ${input.id} is persisted as ${stored} and cannot be registered as ${scope}.`,
      );
    if (input.requiresEnterprise && !prev.requires_enterprise)
      throw new Error(
        `Session ${input.id} is not persisted as requiring an enterprise account.`,
      );
    return;
  }
  if (scope === DEFAULT_SESSION_SCOPE && !input.requiresEnterprise) return; // ordinary user sessions need no claim
  const stored = upsert({
    id: input.id,
    harness: input.harness,
    agentType: input.agentType,
    scope,
    ...(input.requiresEnterprise ? { requiresEnterprise: true } : {}),
  });
  if (!stored)
    throw new Error(
      `Session ${input.id} could not be persisted as ${scope}; refusing to register it live.`,
    );
}

/**
 * The persisted usage totals of one session, or undefined when it never
 * recorded a usage-bearing turn. These are the numbers the session audit
 * (`sessionAudit.ts`) reconciles its own per-turn sums against.
 */
function getUsageTotals(id: string): SessionUsageTotals | undefined {
  const row = getDb()
    .prepare("SELECT * FROM session_usage_totals WHERE session_id = ?")
    .get(id) as Record<string, number | string | null> | undefined;
  if (!row) return undefined;
  const n = (value: unknown): number =>
    typeof value === "number" ? value : Number(value ?? 0);
  return {
    inputTokens: n(row.input_tokens),
    outputTokens: n(row.output_tokens),
    cacheReadTokens: n(row.cache_read_tokens),
    cacheWriteTokens: n(row.cache_write_tokens),
    reasoningTokens: n(row.reasoning_tokens),
    totalTokens: n(row.total_tokens),
    ...(row.cost_micros != null ? { costMicros: n(row.cost_micros) } : {}),
    currency: String(row.currency ?? "USD"),
    usageTurns: n(row.usage_turns),
    assistantTurns: n(row.assistant_turns),
    ...(row.context_tokens != null
      ? { contextTokens: n(row.context_tokens) }
      : {}),
    ...(row.context_window != null
      ? { contextWindow: n(row.context_window) }
      : {}),
    usageSource: String(
      row.usage_source ?? "provider_reported",
    ) as SessionUsageSource,
    updatedAt: n(row.updated_at_ms),
  };
}

/** How many listable non-deleted sessions are archived, as a COUNT rather than a scan. */
function countArchived(opts: SessionScopeFilter = {}): number {
  const clauses = [
    "archived_at_ms IS NOT NULL",
    "deleted_at_ms IS NULL",
    "(message_count > 0 OR purpose = 'draft')",
  ];
  const params: unknown[] = [];
  scopeClause(opts, clauses, params);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM session_index WHERE ${clauses.join(" AND ")}`,
    )
    .get(...(params as never[])) as { n: number } | undefined;
  return row?.n ?? 0;
}

/* --------------------------------- links --------------------------------- */

interface DbSessionLinkRow {
  parent_session_id: string;
  child_session_id: string;
  metadata_json?: string | null;
}

/**
 * One coordinator edge as the session list reads it: who spawned the child, and
 * who owns it now.
 */
interface SpawnProvenance {
  parentSessionId: string;
  ownership: SpawnOwnership;
  /**
   * When the child was taken over: the user's explicit Take over, or — on an
   * edge marked before that rule — the visible prompt that marked it.
   */
  takenOverAt?: number;
}

/**
 * Ownership as stored on the `spawned` edge's `metadata_json`.
 *
 * Written only by {@link linkSpawned} (at creation) and
 * {@link setSpawnedOwnership}; anything else — an absent, unparseable, or
 * unrecognized value — fails closed to `unknown` rather than claiming the
 * coordinator still owns a child we know nothing about.
 */
function parseSpawnOwnership(raw: string | null | undefined): {
  ownership: SpawnOwnership;
  takenOverAt?: number;
} {
  if (!raw) return { ownership: "unknown" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ownership: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { ownership: "unknown" };
  const { ownership, takenOverAt } = parsed as {
    ownership?: unknown;
    takenOverAt?: unknown;
  };
  if (ownership === "coordinator") return { ownership };
  if (
    ownership === "taken-over" &&
    typeof takenOverAt === "number" &&
    Number.isFinite(takenOverAt)
  )
    return { ownership, takenOverAt };
  return { ownership: "unknown" };
}

/**
 * Whether a `spawned` edge passes its parent's approval grants down
 * (`docs/approvals.md`, Inherited grants).
 *
 * Writers record only the opt-out, `"inheritGrants": false`. An edge written
 * before inheritance existed (SQL NULL) or a well-formed object without the
 * property inherits; every other shape — invalid JSON, JSON `null`, a scalar,
 * an array, or any present value, even `true` — fails closed to NOT
 * inheriting, so a corrupt edge never widens authority.
 */
function parseSpawnInheritance(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return false;
  return !Object.hasOwn(parsed, "inheritGrants");
}

function linkInternal(input: {
  parentSessionId: string;
  childSessionId: string;
  label: string;
  createdAt: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO session_links (
         parent_session_id, child_session_id, relation_type, label, created_at_ms
       ) VALUES (?, ?, 'internal', ?, ?)
       ON CONFLICT(parent_session_id, child_session_id, relation_type) DO UPDATE SET
         label = excluded.label`,
    )
    .run(
      input.parentSessionId,
      input.childSessionId,
      input.label,
      input.createdAt,
    );
}

/**
 * Persist the one coordinator edge of an agent-spawned peer session, owned by
 * the coordinator from creation.
 *
 * Repeating the same write is idempotent, but assigning an existing child to a
 * different coordinator is refused: parentage is stored identity, never a
 * title- or transcript-derived guess that a later caller may overwrite. The
 * idempotent repeat also leaves the stored metadata alone, so re-linking cannot
 * reset a child the user has already taken over. Creation defaults to coordinator
 * ownership; a child born user-owned records taken-over and its creation timestamp
 * in this same insert, before its opening prompt can be delivered.
 */
function linkSpawned(
  parentSessionId: string,
  childSessionId: string,
  createdAt = Date.now(),
  ownership: SettableSpawnOwnership = "coordinator",
  options: { inheritGrants?: boolean } = {},
): void {
  const existing = getDb()
    .prepare(
      `SELECT parent_session_id, child_session_id
         FROM session_links
        WHERE child_session_id = ? AND relation_type = 'spawned'`,
    )
    .all(childSessionId) as unknown as DbSessionLinkRow[];
  const other = existing.find(
    (row) => row.parent_session_id !== parentSessionId,
  );
  if (other)
    throw new Error(
      `Session ${childSessionId} was already spawned by ${other.parent_session_id}.`,
    );
  getDb()
    .prepare(
      `INSERT INTO session_links (
         parent_session_id, child_session_id, relation_type, created_at_ms, metadata_json
       ) VALUES (?, ?, 'spawned', ?, ?)
       ON CONFLICT(parent_session_id, child_session_id, relation_type) DO NOTHING`,
    )
    .run(
      parentSessionId,
      childSessionId,
      createdAt,
      JSON.stringify({
        ...(ownership === "taken-over"
          ? { ownership, takenOverAt: createdAt }
          : { ownership }),
        ...(options.inheritGrants === false ? { inheritGrants: false } : {}),
      }),
    );
}

/**
 * Set who owns a spawned child — the user (`taken-over`) or its coordinator —
 * on the user's EXPLICIT word ([Task-637](pa://task/637)). Messaging a peer
 * is not that word: a poke leaves its coordinator in charge.
 *
 * Idempotent, so the returned boolean is exactly "ownership changed now" —
 * the one condition that justifies a session-list broadcast. Taking over a
 * child that is already taken over keeps its timestamp; after a Hand back, the
 * next Take over stamps afresh. An `unknown` edge may be set either
 * way: the user's decision is evidence that missing creation metadata is not.
 * A session with no spawn edge is not a spawned child and returns false
 * (`spawnOwnership.setSpawnOwnership` reports that case as `not-spawned`).
 */
function setSpawnedOwnership(
  childSessionId: string,
  ownership: SettableSpawnOwnership,
  at = Date.now(),
): boolean {
  const rows = getDb()
    .prepare(
      `SELECT parent_session_id, child_session_id, metadata_json
         FROM session_links
        WHERE child_session_id = ? AND relation_type = 'spawned'`,
    )
    .all(childSessionId) as unknown as DbSessionLinkRow[];
  const row = rows[0];
  if (!row) return false;
  if (parseSpawnOwnership(row.metadata_json).ownership === ownership)
    return false;
  getDb()
    .prepare(
      `UPDATE session_links
          SET metadata_json = ?
        WHERE parent_session_id = ? AND child_session_id = ? AND relation_type = 'spawned'`,
    )
    .run(
      JSON.stringify({
        ...(ownership === "taken-over"
          ? { ownership, takenOverAt: at }
          : { ownership }),
        // Ownership never changes inheritance: an edge that does not inherit,
        // corrupt ones included, keeps not inheriting in the rewritten form.
        ...(parseSpawnInheritance(row.metadata_json)
          ? {}
          : { inheritGrants: false }),
      }),
      row.parent_session_id,
      childSessionId,
    );
  return true;
}

/**
 * Resolve spawn provenance for a bounded set of list rows in one indexed read.
 * The child-leading `session_links_child_idx` serves the `IN` lookup; callers
 * derive the reverse children groups from these parent ids without per-row SQL.
 */
function spawnedParentsByChildIds(
  childSessionIds: Iterable<string>,
): Map<string, SpawnProvenance> {
  const ids = [...new Set(childSessionIds)];
  if (ids.length === 0) return new Map();
  const rows = getDb()
    .prepare(
      `SELECT parent_session_id, child_session_id, metadata_json
         FROM session_links
        WHERE child_session_id IN (${ids.map(() => "?").join(", ")})
          AND relation_type = 'spawned'`,
    )
    .all(...(ids as never[])) as unknown as DbSessionLinkRow[];
  return new Map(
    rows.map((row) => [
      row.child_session_id,
      {
        parentSessionId: row.parent_session_id,
        ...parseSpawnOwnership(row.metadata_json),
      },
    ]),
  );
}

/** One step up a spawn chain, as approval-grant inheritance reads it. */
export interface SpawnGrantEdge {
  parentSessionId: string;
  /** Whether the edge passes the parent's grants down ({@link parseSpawnInheritance}). */
  inherits: boolean;
  /** A soft-deleted parent holds no authority and ends the walk. */
  parentDeleted: boolean;
}

/**
 * A child's spawn edge with its parent's deletion state: one search of
 * `session_links_child_idx` and one primary-key read of the parent. Exported so
 * the query-plan test explains the exact statement.
 */
export const SPAWN_GRANT_EDGE_SQL = `SELECT l.parent_session_id, l.metadata_json, p.deleted_at_ms
    FROM session_links l
    JOIN session_index p ON p.id = l.parent_session_id
   WHERE l.child_session_id = ? AND l.relation_type = 'spawned'`;

function spawnGrantEdge(childSessionId: string): SpawnGrantEdge | undefined {
  const row = getDb().prepare(SPAWN_GRANT_EDGE_SQL).get(childSessionId) as
    | {
        parent_session_id: string;
        metadata_json: string | null;
        deleted_at_ms: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    parentSessionId: row.parent_session_id,
    inherits: parseSpawnInheritance(row.metadata_json),
    parentDeleted: row.deleted_at_ms !== null,
  };
}

/**
 * The ancestors whose approval grants reach a session, nearest first. The walk
 * climbs one edge at a time and stops at a session that was not spawned, at
 * an edge that does not inherit, at a soft-deleted parent, or on a cycle. An
 * archived parent still counts. `edgeOf` lets one caller share edge reads
 * across many walks; it defaults to a live read.
 */
function spawnGrantAncestors(
  sessionId: string,
  edgeOf: (
    childSessionId: string,
  ) => SpawnGrantEdge | undefined = spawnGrantEdge,
): string[] {
  const chain: string[] = [];
  const seen = new Set([sessionId]);
  for (
    let edge = edgeOf(sessionId);
    edge;
    edge = edgeOf(edge.parentSessionId)
  ) {
    if (!edge.inherits || edge.parentDeleted || seen.has(edge.parentSessionId))
      break;
    seen.add(edge.parentSessionId);
    chain.push(edge.parentSessionId);
  }
  return chain;
}

/**
 * Every session spawned below a root, at any depth, along `spawned` edges —
 * whatever their ownership, scope, archive, settlement or soft deletion — in
 * one recursive read whose both steps search the parent-leading primary key.
 * `UNION` (not
 * `UNION ALL`) visits a node once, so a cycle terminates; the root is excluded
 * even when a cycle reaches it. Exported so the query-plan test explains the
 * exact statement.
 */
export const SPAWNED_DESCENDANTS_SQL = `WITH RECURSIVE tree(id) AS (
    SELECT child_session_id FROM session_links
     WHERE parent_session_id = ? AND relation_type = 'spawned'
    UNION
    SELECT l.child_session_id FROM session_links l
      JOIN tree ON l.parent_session_id = tree.id
     WHERE l.relation_type = 'spawned'
  )
  SELECT id FROM tree WHERE id != ?`;

/**
 * Every spawn edge as child → coordinator, in one read: a worktree list build
 * walks each holder's coordinators up from here instead of one read per level
 * per row. Ownership, scope, archive and deletion are not filtered.
 */
function spawnedParentByChild(): Map<string, string> {
  const rows = getDb()
    .prepare(
      "SELECT parent_session_id, child_session_id FROM session_links WHERE relation_type = 'spawned'",
    )
    .all() as Array<{ parent_session_id: string; child_session_id: string }>;
  return new Map(
    rows.map((row) => [row.child_session_id, row.parent_session_id]),
  );
}

function spawnedDescendantIds(rootId: string): string[] {
  const rows = getDb()
    .prepare(SPAWNED_DESCENDANTS_SQL)
    .all(rootId, rootId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/* --------------------------------- usage --------------------------------- */

function recordUsageTurn(
  sessionId: string,
  usage: AgentUsage | undefined,
  opts: { assistantTurn?: boolean; updatedAt?: number } = {},
): void {
  if (!usage) return;
  const delta = usageDelta(usage);
  if (!delta.hasUsage) return;
  try {
    if (!rawRow(sessionId)) return;
    addUsageTotals(sessionId, {
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cacheReadTokens: delta.cacheReadTokens,
      cacheWriteTokens: delta.cacheWriteTokens,
      reasoningTokens: 0,
      totalTokens: delta.totalTokens,
      ...(delta.costMicros !== undefined
        ? { costMicros: delta.costMicros }
        : {}),
      currency: "USD",
      usageTurns: 1,
      assistantTurns: opts.assistantTurn === false ? 0 : 1,
      ...(delta.contextTokens !== undefined
        ? { contextTokens: delta.contextTokens }
        : {}),
      ...(usage.contextWindowTokens !== undefined
        ? { contextWindow: usage.contextWindowTokens }
        : {}),
      usageSource: "provider_reported",
      updatedAt: opts.updatedAt ?? Date.now(),
    });
  } catch (err) {
    console.warn(
      "sessionStore.recordUsageTurn failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function replaceUsage(sessionId: string, totals: SessionUsageTotals): void {
  getDb()
    .prepare(
      `
      INSERT INTO session_usage_totals (
        session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, cost_micros, currency, usage_turns, assistant_turns,
        context_tokens, context_window, usage_source, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        total_tokens = excluded.total_tokens,
        cost_micros = excluded.cost_micros,
        currency = excluded.currency,
        usage_turns = excluded.usage_turns,
        assistant_turns = excluded.assistant_turns,
        context_tokens = excluded.context_tokens,
        context_window = excluded.context_window,
        usage_source = excluded.usage_source,
        updated_at_ms = excluded.updated_at_ms
    `,
    )
    .run(
      sessionId,
      totals.inputTokens,
      totals.outputTokens,
      totals.cacheReadTokens,
      totals.cacheWriteTokens,
      totals.reasoningTokens,
      totals.totalTokens,
      totals.costMicros ?? null,
      totals.currency,
      totals.usageTurns,
      totals.assistantTurns,
      totals.contextTokens ?? null,
      totals.contextWindow ?? null,
      totals.usageSource,
      totals.updatedAt,
    );
}

/**
 * Record an internal (non-user-visible) session that exists only to attribute
 * token/cost usage of a background helper run (naming, commit messages, etc.),
 * optionally linking it under the session that spawned it.
 */
function createInternalUsageSession(input: {
  purpose: string;
  title: string;
  harness: Harness;
  agentType?: AgentType;
  provider?: string;
  providerSessionId?: string;
  model?: string;
  thinkingLevel?: string;
  parentSessionId?: string;
  requiresEnterprise?: boolean;
  label?: string;
  usage?: AgentUsage;
  startedAt?: number;
  completedAt?: number;
}): string {
  const id = `internal_${randomUUID()}`;
  const now = Date.now();
  try {
    const stored = upsert({
      id,
      scope: "internal",
      purpose: input.purpose,
      harness: input.harness,
      agentType: input.agentType ?? "assistant",
      title: input.title,
      createdAt: input.startedAt ?? now,
      updatedAt: input.completedAt ?? now,
      messageCount: 1,
      requiresEnterprise:
        input.requiresEnterprise === true ||
        !!(
          input.parentSessionId &&
          getIncludingDeleted(input.parentSessionId)?.requiresEnterprise
        ),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.providerSessionId !== undefined
        ? { providerSessionId: input.providerSessionId }
        : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.thinkingLevel !== undefined
        ? { thinkingLevel: input.thinkingLevel }
        : {}),
    });
    if (!stored) return id;
    if (input.parentSessionId && rawRow(input.parentSessionId)) {
      linkInternal({
        parentSessionId: input.parentSessionId,
        childSessionId: id,
        label: input.label ?? input.purpose,
        createdAt: input.startedAt ?? now,
      });
    }
    recordUsageTurn(id, input.usage, { updatedAt: input.completedAt ?? now });
  } catch (err) {
    console.warn(
      "sessionStore.createInternalUsageSession failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return id;
}

function addUsageTotals(sessionId: string, totals: SessionUsageTotals): void {
  getDb()
    .prepare(
      `
      INSERT INTO session_usage_totals (
        session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, cost_micros, currency, usage_turns, assistant_turns,
        context_tokens, context_window, usage_source, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        cost_micros = CASE
          WHEN session_usage_totals.cost_micros IS NULL AND excluded.cost_micros IS NULL THEN NULL
          ELSE coalesce(session_usage_totals.cost_micros, 0) + coalesce(excluded.cost_micros, 0)
        END,
        usage_turns = usage_turns + excluded.usage_turns,
        assistant_turns = assistant_turns + excluded.assistant_turns,
        context_tokens = coalesce(excluded.context_tokens, session_usage_totals.context_tokens),
        context_window = coalesce(excluded.context_window, session_usage_totals.context_window),
        usage_source = excluded.usage_source,
        updated_at_ms = excluded.updated_at_ms
    `,
    )
    .run(
      sessionId,
      totals.inputTokens,
      totals.outputTokens,
      totals.cacheReadTokens,
      totals.cacheWriteTokens,
      totals.reasoningTokens,
      totals.totalTokens,
      totals.costMicros ?? null,
      totals.currency,
      totals.usageTurns,
      totals.assistantTurns,
      totals.contextTokens ?? null,
      totals.contextWindow ?? null,
      totals.usageSource,
      totals.updatedAt,
    );
}

function usageDelta(
  usage: AgentUsage,
): SessionUsageTotals & { hasUsage: boolean } {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheCreationTokens ?? 0;
  const totalTokens =
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const costMicros =
    typeof usage.costUSD === "number"
      ? Math.round(usage.costUSD * 1_000_000)
      : undefined;
  const contextTokensValue =
    usage.contextTokens ??
    (inputTokens + cacheReadTokens + cacheWriteTokens || undefined);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: 0,
    totalTokens,
    ...(costMicros !== undefined ? { costMicros } : {}),
    currency: "USD",
    usageTurns: totalTokens > 0 || costMicros !== undefined ? 1 : 0,
    assistantTurns: 1,
    // Prefer the harness-reported context snapshot; the prompt-token sum
    // over-counts a multi-request tool loop.
    ...(contextTokensValue !== undefined
      ? { contextTokens: contextTokensValue }
      : {}),
    ...(usage.contextWindowTokens !== undefined
      ? { contextWindow: usage.contextWindowTokens }
      : {}),
    usageSource: "provider_reported",
    updatedAt: Date.now(),
    hasUsage: totalTokens > 0 || costMicros !== undefined,
  };
}

/**
 * The single façade over session metadata. Swap the backing store here (not at
 * call sites) if SQLite is ever replaced.
 */
export const sessionStore = {
  subscribeLiveness,
  get,
  getIncludingDeleted,
  list,
  liveDefaultScopeGate,
  claimScope,
  countArchived,
  upsert,
  switchCredentialProfile,
  markDeleted,
  remove,
  markRead,
  touch,
  getReadAt,
  setArchived,
  archiveSettledBatch,
  isArchived,
  setSettled,
  settleWithPeers,
  isSettled,
  recordSessionOutcome,
  acknowledgeMissingWorktree,
  worktreeMissingAck,
  worktreeMissingAckBySession,
  recordRunFailure,
  clearRunFailure,
  dismissRunFailure,
  recordInterruptedRun,
  clearInterruptedRun,
  updateStats,
  freezePromptConditions,
  getPromptConditions,
  freezeSkills,
  deleteSkills,
  getSkills,
  freezeAgent,
  getAgent,
  getUsageTotals,
  linkSpawned,
  setSpawnedOwnership,
  spawnedParentsByChildIds,
  spawnedDescendantIds,
  spawnedParentByChild,
  spawnGrantEdge,
  spawnGrantAncestors,
  recordUsageTurn,
  replaceUsage,
  createInternalUsageSession,
};
