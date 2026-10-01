/**
 * SQL facade for versioned memory cards (Task 91). Pure persistence: no
 * validation, lifecycle, scope resolution, or idempotency policy — those live in
 * the memory lifecycle service (`../memory/memoryService.ts`). This module only
 * maps rows ⇄ {@link MemoryCard} and offers atomic revision-checked writes.
 */
import type {
  MemoryCard,
  MemoryKind,
  MemoryLifecycleState,
  MemoryRecurrence,
  MemoryScope,
  MemorySourceKind,
  MemoryTemporal,
  MemoryTemporalMode,
} from "@assistant/shared";
import { getDb } from "./index.ts";

interface MemoryCardRow {
  id: string;
  revision: number;
  text: string;
  kind: MemoryKind;
  project_id: string | null;
  persona: string | null;
  state: MemoryLifecycleState;
  pinned: number;
  strength: number;
  temporal_mode: MemoryTemporalMode;
  valid_from_ms: number | null;
  valid_until_ms: number | null;
  timezone: string | null;
  recurrence_json: string | null;
  observed_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
  last_loaded_at_ms: number | null;
  source_kind: MemorySourceKind;
  source_session_id: string | null;
  source_message_id: string | null;
  supersedes_id: string | null;
  idempotency_key: string | null;
  reason: string | null;
}

/** A full new card row (the service assembles + validates this). */
export interface MemoryCardInsert {
  id: string;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  state?: MemoryLifecycleState;
  pinned?: boolean;
  strength?: number;
  temporal: MemoryTemporal;
  observedAtMs: number;
  createdAt: number;
  updatedAt: number;
  sourceKind: MemorySourceKind;
  sourceSessionId?: string;
  sourceMessageId?: string;
  supersedesId?: string;
  idempotencyKey?: string;
  reason?: string;
}

/** Mutable fields for a revision-checked update. Undefined = leave unchanged. */
export interface MemoryCardUpdate {
  text?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  state?: MemoryLifecycleState;
  pinned?: boolean;
  strength?: number;
  temporal?: MemoryTemporal;
  lastLoadedAtMs?: number;
  supersedesId?: string;
  reason?: string;
  /** Content-dedup key. `null` clears it (freeing the content key, e.g. on supersede). */
  idempotencyKey?: string | null;
}

export interface MemoryCardFilter {
  states?: MemoryLifecycleState[];
  kinds?: MemoryKind[];
  /** Match cards whose project scope is exactly this (or null for global-only). */
  projectId?: string | null;
  persona?: string | null;
  pinned?: boolean;
  /** Case-insensitive substring match over card text, pushed into SQL (not a JS post-filter). */
  text?: string;
  /** Restrict to specific temporal modes (e.g. isolate `recurring`, which needs JS timezone evaluation, from the rest). */
  temporalModes?: MemoryTemporalMode[];
  /**
   * SQL-computable "active now" for the deterministic (non-`recurring`) temporal
   * modes: `persistent`/`until-changed` need a window (`validUntilMs` set) to
   * count, `window` mode counts whenever its from/until bounds admit `nowMs`.
   * This mirrors `memorySelector.temporalEligibility`'s boolean exactly for those
   * three modes — no timezone is needed for the boolean itself (only for the
   * "expires soon" display label, and for `recurring`, which this does NOT cover).
   */
  activeNowMs?: number;
  limit?: number;
  offset?: number;
  /**
   * Keyset cursor matching `list`'s `ORDER BY updated_at_ms DESC, id`: returns
   * only rows strictly after this position in that order. Use instead of
   * `offset` for chunked full-scan iteration (e.g. the `activeNow` recurring
   * scan) — an increasing `offset` makes SQLite re-walk and discard the entire
   * already-seen prefix on every call (O(N²) row visits across a full scan);
   * a keyset cursor is O(1) per chunk relative to the prefix already consumed.
   */
  afterCursor?: { updatedAtMs: number; id: string };
}

/** Operation reasons are free text; bound them so no path stores an unbounded blob. */
const REASON_MAX = 300;
function boundReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  return reason.slice(0, REASON_MAX);
}

function parseRecurrence(raw: string | null): MemoryRecurrence | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as MemoryRecurrence;
    return parsed;
  } catch {
    return undefined;
  }
}

function toTemporal(row: MemoryCardRow): MemoryTemporal {
  const temporal: MemoryTemporal = { mode: row.temporal_mode };
  if (row.valid_from_ms !== null) temporal.validFromMs = row.valid_from_ms;
  if (row.valid_until_ms !== null) temporal.validUntilMs = row.valid_until_ms;
  if (row.timezone !== null) temporal.timezone = row.timezone;
  const recurrence = parseRecurrence(row.recurrence_json);
  if (recurrence) temporal.recurrence = recurrence;
  return temporal;
}

function fromRow(row: MemoryCardRow): MemoryCard {
  const scope: MemoryScope = {};
  if (row.project_id !== null) scope.projectId = row.project_id;
  if (row.persona !== null)
    scope.persona = row.persona as NonNullable<MemoryScope["persona"]>;
  return {
    id: row.id,
    revision: row.revision,
    text: row.text,
    kind: row.kind,
    scope,
    state: row.state,
    pinned: row.pinned === 1,
    strength: row.strength,
    temporal: toTemporal(row),
    observedAtMs: row.observed_at_ms,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(row.last_loaded_at_ms !== null
      ? { lastLoadedAt: row.last_loaded_at_ms }
      : {}),
    provenance: {
      sourceKind: row.source_kind,
      ...(row.source_session_id !== null
        ? { sessionId: row.source_session_id }
        : {}),
      ...(row.source_message_id !== null
        ? { messageId: row.source_message_id }
        : {}),
    },
    ...(row.supersedes_id !== null ? { supersedesId: row.supersedes_id } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
}

const SELECT = "SELECT * FROM memory_cards";

/** Shared WHERE-clause builder for `list`/`count`, so totals always match the listed page. */
function buildWhere(filter: MemoryCardFilter): {
  clause: string;
  params: Array<string | number>;
} {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.states?.length) {
    where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
    params.push(...filter.states);
  }
  if (filter.kinds?.length) {
    where.push(`kind IN (${filter.kinds.map(() => "?").join(",")})`);
    params.push(...filter.kinds);
  }
  if (filter.projectId !== undefined) {
    if (filter.projectId === null) where.push("project_id IS NULL");
    else {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
  }
  if (filter.persona !== undefined) {
    if (filter.persona === null) where.push("persona IS NULL");
    else {
      where.push("persona = ?");
      params.push(filter.persona);
    }
  }
  if (filter.pinned !== undefined) {
    where.push("pinned = ?");
    params.push(filter.pinned ? 1 : 0);
  }
  if (filter.text) {
    where.push("text LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(filter.text)}%`);
  }
  if (filter.temporalModes?.length) {
    where.push(
      `temporal_mode IN (${filter.temporalModes.map(() => "?").join(",")})`,
    );
    params.push(...filter.temporalModes);
  }
  if (filter.activeNowMs !== undefined) {
    const now = filter.activeNowMs;
    // Mirrors temporalEligibility()'s boolean for persistent/until-changed/window:
    // from/until bounds gate eligibility for every mode, and persistent/
    // until-changed additionally require an actual window (validUntilMs set) to
    // count as "active now" (an unbounded persistent card does not).
    where.push(
      `(valid_from_ms IS NULL OR valid_from_ms <= ?) AND (valid_until_ms IS NULL OR valid_until_ms >= ?) AND ` +
        `((temporal_mode IN ('persistent','until-changed') AND valid_until_ms IS NOT NULL) OR temporal_mode = 'window')`,
    );
    params.push(now, now);
  }
  if (filter.afterCursor) {
    // Matches `list`'s `ORDER BY updated_at_ms DESC, id`: strictly after this
    // (updated_at_ms, id) position in that order.
    where.push(`(updated_at_ms < ? OR (updated_at_ms = ? AND id > ?))`);
    params.push(
      filter.afterCursor.updatedAtMs,
      filter.afterCursor.updatedAtMs,
      filter.afterCursor.id,
    );
  }
  return {
    clause: where.length ? ` WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

/** Escape SQL LIKE metacharacters so a search term is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Builds `list`'s exact SQL + params, so a test can `EXPLAIN QUERY PLAN` the identical query `list` issues (no drift). */
function listQuery(filter: MemoryCardFilter): {
  sql: string;
  params: Array<string | number>;
} {
  const { clause, params } = buildWhere(filter);
  const limit = filter.limit ?? 500;
  const offset = filter.offset ?? 0;
  return {
    sql: `${SELECT}${clause} ORDER BY updated_at_ms DESC, id LIMIT ? OFFSET ?`,
    params: [...params, limit, offset],
  };
}

/** Test-only introspection: the exact SQL/params `list(filter)` would run, for `EXPLAIN QUERY PLAN` assertions. */
export function debugListQueryForTests(filter: MemoryCardFilter): {
  sql: string;
  params: Array<string | number>;
} {
  return listQuery(filter);
}

export const memoryStore = {
  insert(input: MemoryCardInsert): MemoryCard {
    const db = getDb();
    db.prepare(
      `INSERT INTO memory_cards (
        id, revision, text, kind, project_id, persona, state, pinned, strength,
        temporal_mode, valid_from_ms, valid_until_ms, timezone, recurrence_json,
        observed_at_ms, created_at_ms, updated_at_ms, source_kind,
        source_session_id, source_message_id, supersedes_id, idempotency_key, reason
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.text,
      input.kind,
      input.scope.projectId ?? null,
      input.scope.persona ?? null,
      input.state ?? "active",
      input.pinned ? 1 : 0,
      input.strength ?? 1,
      input.temporal.mode,
      input.temporal.validFromMs ?? null,
      input.temporal.validUntilMs ?? null,
      input.temporal.timezone ?? null,
      input.temporal.recurrence
        ? JSON.stringify(input.temporal.recurrence)
        : null,
      input.observedAtMs,
      input.createdAt,
      input.updatedAt,
      input.sourceKind,
      input.sourceSessionId ?? null,
      input.sourceMessageId ?? null,
      input.supersedesId ?? null,
      input.idempotencyKey ?? null,
      boundReason(input.reason),
    );
    return this.get(input.id)!;
  },

  get(id: string): MemoryCard | undefined {
    const row = getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as
      MemoryCardRow | undefined;
    return row ? fromRow(row) : undefined;
  },

  findByIdempotencyKey(key: string): MemoryCard | undefined {
    const row = getDb()
      .prepare(`${SELECT} WHERE idempotency_key = ?`)
      .get(key) as MemoryCardRow | undefined;
    return row ? fromRow(row) : undefined;
  },

  /**
   * Atomic optimistic-concurrency update: applies `fields` and bumps `revision`
   * only when the stored revision still equals `expectedRevision`. Returns the
   * updated card, or `undefined` when the id is gone or the revision is stale
   * (the caller re-reads to decide).
   */
  updateChecked(
    id: string,
    expectedRevision: number,
    fields: MemoryCardUpdate,
    updatedAtMs: number,
  ): MemoryCard | undefined {
    const db = getDb();
    const sets: string[] = ["revision = revision + 1", "updated_at_ms = ?"];
    const params: Array<string | number | null> = [updatedAtMs];
    if (fields.text !== undefined) {
      sets.push("text = ?");
      params.push(fields.text);
    }
    if (fields.kind !== undefined) {
      sets.push("kind = ?");
      params.push(fields.kind);
    }
    if (fields.scope !== undefined) {
      sets.push("project_id = ?", "persona = ?");
      params.push(fields.scope.projectId ?? null, fields.scope.persona ?? null);
    }
    if (fields.state !== undefined) {
      sets.push("state = ?");
      params.push(fields.state);
    }
    if (fields.pinned !== undefined) {
      sets.push("pinned = ?");
      params.push(fields.pinned ? 1 : 0);
    }
    if (fields.strength !== undefined) {
      sets.push("strength = ?");
      params.push(fields.strength);
    }
    if (fields.temporal !== undefined) {
      sets.push(
        "temporal_mode = ?",
        "valid_from_ms = ?",
        "valid_until_ms = ?",
        "timezone = ?",
        "recurrence_json = ?",
      );
      params.push(
        fields.temporal.mode,
        fields.temporal.validFromMs ?? null,
        fields.temporal.validUntilMs ?? null,
        fields.temporal.timezone ?? null,
        fields.temporal.recurrence
          ? JSON.stringify(fields.temporal.recurrence)
          : null,
      );
    }
    if (fields.lastLoadedAtMs !== undefined) {
      sets.push("last_loaded_at_ms = ?");
      params.push(fields.lastLoadedAtMs);
    }
    if (fields.supersedesId !== undefined) {
      sets.push("supersedes_id = ?");
      params.push(fields.supersedesId);
    }
    if (fields.reason !== undefined) {
      sets.push("reason = ?");
      params.push(boundReason(fields.reason));
    }
    if (fields.idempotencyKey !== undefined) {
      sets.push("idempotency_key = ?");
      params.push(fields.idempotencyKey);
    }
    params.push(id, expectedRevision);
    const result = db
      .prepare(
        `UPDATE memory_cards SET ${sets.join(", ")} WHERE id = ? AND revision = ?`,
      )
      .run(...params);
    if (result.changes === 0) return undefined;
    return this.get(id);
  },

  /** Touch last_loaded_at without bumping revision (loading is not a mutation). */
  markLoaded(ids: string[], atMs: number): void {
    if (ids.length === 0) return;
    const db = getDb();
    const stmt = db.prepare(
      "UPDATE memory_cards SET last_loaded_at_ms = ? WHERE id = ?",
    );
    for (const id of ids) stmt.run(atMs, id);
  },

  list(filter: MemoryCardFilter = {}): MemoryCard[] {
    const { sql, params } = listQuery(filter);
    const rows = getDb()
      .prepare(sql)
      .all(...params) as unknown as MemoryCardRow[];
    return rows.map(fromRow);
  },

  /** Total matching rows for `filter` (same WHERE as `list`, minus limit/offset) — a real SQL count, never capped. */
  count(filter: MemoryCardFilter = {}): number {
    const { clause, params } = buildWhere(filter);
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM memory_cards${clause}`)
      .get(...params) as { n: number };
    return row.n;
  },

  /** The active cards eligible for scope/time selection (Task 95 reads this). */
  activeCards(): MemoryCard[] {
    return this.list({ states: ["active"], limit: 10_000 });
  },

  /** The full supersession chain rooted at a card id, newest first. */
  supersededBy(id: string): MemoryCard[] {
    const rows = getDb()
      .prepare(`${SELECT} WHERE supersedes_id = ? ORDER BY created_at_ms DESC`)
      .all(id) as unknown as MemoryCardRow[];
    return rows.map(fromRow);
  },
};
