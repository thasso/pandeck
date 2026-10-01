/**
 * The generic relationship graph (see docs/tasks/PLAN.md, Topic 5).
 *
 * One directed, labeled, ordered edge table for every relationship between two
 * nodes in the app. A node is `(type, id)` with a text id, so any entity can
 * participate — integer task ids (as strings), session uuids, project ids, jira
 * keys, urls, and future types like knowledge docs.
 *
 * There are no database foreign keys (the endpoints are polymorphic), so:
 *   - the relation vocabulary is a small fixed set, validated here;
 *   - callers remove an entity's edges via {@link removeAllFor} on delete.
 *
 * This module owns only edges. Entity rows (tasks, projects, …) live in their
 * own stores, which build their typed helpers on top of these primitives.
 */
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./index.ts";

/** Known node types. Kept small and explicit; extend as new entities appear. */
export type NodeType =
  | "task"
  | "project"
  | "session"
  | "jira"
  | "github"
  | "url"
  | "doc"
  | "worktree"
  | "knowledge";

/**
 * Known relations. Directed from → to:
 *  - `subtask`    task → task (ordered by `position`: the child's rank among siblings)
 *  - `parent`     project → project (child → parent hierarchy; sibling order is a column)
 *  - `in_project` task → project, and session → project (standalone session mapping)
 *  - `context`    task → session (legacy task membership), and session →
 *                  first-class object (structured context relation surfaced as
 *                  inspector related-object rows)
 *  - `jira`       task → jira key, and project → jira key (role/notes in metadata)
 *  - `github`     task → canonical GitHub issue ref (`owner/repo#123`)
 *  - `link`       task → url (source/related distinction in metadata)
 *  - `in_worktree` session → worktree (the session executes in that worktree),
 *                  and task → worktree (the task is implemented there)
 */
export type Relation =
  | "subtask"
  | "parent"
  | "in_project"
  | "context"
  | "jira"
  | "github"
  | "link"
  | "in_worktree";

const RELATIONS: ReadonlySet<Relation> = new Set([
  "subtask",
  "parent",
  "in_project",
  "context",
  "jira",
  "github",
  "link",
  "in_worktree",
]);

export interface NodeRef {
  type: NodeType;
  id: string;
}

export interface Link {
  fromType: NodeType;
  fromId: string;
  relation: Relation;
  toType: NodeType;
  toId: string;
  position?: number;
  metadata?: unknown;
  createdAt: number;
}

export interface AddLinkOptions {
  position?: number;
  metadata?: unknown;
}

/**
 * Writes this process made to edges leaving each node type. Every write in this
 * module bumps the source type's counter; {@link removeAllFor} also deletes
 * edges INTO a node, whatever they leave from, so it bumps every type.
 */
const writesByFromType = new Map<NodeType, number>();
let writesToEveryType = 0;

function noteWrite(fromType: NodeType): void {
  writesByFromType.set(fromType, (writesByFromType.get(fromType) ?? 0) + 1);
}

function writeCount(fromType: NodeType): number {
  return (writesByFromType.get(fromType) ?? 0) + writesToEveryType;
}

/**
 * Memoize a projection of the edges leaving `fromType` nodes until one of them
 * may have changed.
 *
 * The session list reads three such projections on every rebuild (up to ~4
 * times a second while agents stream); scanning and materializing every
 * session edge each time was most of the rebuild, while the edges themselves
 * change a few times a minute. The value is keyed on:
 *   - this process's write count for `fromType` (every write goes through this
 *     module; a raw SQL write to `links` elsewhere would be a bug);
 *   - `PRAGMA data_version`, which moves when ANOTHER connection commits;
 *   - the connection itself, since a reopened database is a new one.
 * A value built inside an open transaction is never kept: it may hold writes
 * that roll back under the same count. Callers get the SAME instance on a hit,
 * which is why `build` should return a readonly type.
 */
export function memoizedOnLinks<T>(
  fromType: NodeType,
  build: () => T,
): () => T {
  let cached:
    | { db: DatabaseSync; writes: number; dataVersion: number; value: T }
    | undefined;
  return () => {
    const db = getDb();
    const writes = writeCount(fromType);
    const dataVersion = (
      db.prepare("PRAGMA data_version").get() as { data_version: number }
    ).data_version;
    if (
      cached &&
      cached.db === db &&
      cached.writes === writes &&
      cached.dataVersion === dataVersion
    )
      return cached.value;
    const value = build();
    cached = db.isTransaction ? undefined : { db, writes, dataVersion, value };
    return value;
  };
}

function assertRelation(relation: string): asserts relation is Relation {
  if (!RELATIONS.has(relation as Relation)) {
    throw new Error(`Unknown link relation: ${relation}`);
  }
}

/** Insert or update one edge (idempotent on its identity key). */
export function addLink(
  from: NodeRef,
  relation: Relation,
  to: NodeRef,
  opts: AddLinkOptions = {},
): void {
  assertRelation(relation);
  getDb()
    .prepare(
      `
      INSERT INTO links (from_type, from_id, relation, to_type, to_id, position, metadata_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_type, from_id, relation, to_type, to_id) DO UPDATE SET
        position = excluded.position,
        metadata_json = excluded.metadata_json
    `,
    )
    .run(
      from.type,
      from.id,
      relation,
      to.type,
      to.id,
      opts.position ?? null,
      opts.metadata !== undefined ? JSON.stringify(opts.metadata) : null,
      Date.now(),
    );
  noteWrite(from.type);
}

/** Remove one specific edge. */
export function removeLink(
  from: NodeRef,
  relation: Relation,
  to: NodeRef,
): void {
  getDb()
    .prepare(
      "DELETE FROM links WHERE from_type = ? AND from_id = ? AND relation = ? AND to_type = ? AND to_id = ?",
    )
    .run(from.type, from.id, relation, to.type, to.id);
  noteWrite(from.type);
}

/** Outgoing edges from a node, optionally filtered by relation, ordered by position then age. */
export function outgoing(from: NodeRef, relation?: Relation): Link[] {
  if (relation) assertRelation(relation);
  const rows = relation
    ? getDb()
        .prepare(
          "SELECT * FROM links WHERE from_type = ? AND from_id = ? AND relation = ? ORDER BY position IS NULL, position, created_at_ms",
        )
        .all(from.type, from.id, relation)
    : getDb()
        .prepare(
          "SELECT * FROM links WHERE from_type = ? AND from_id = ? ORDER BY relation, position IS NULL, position, created_at_ms",
        )
        .all(from.type, from.id);
  return (rows as unknown as DbLinkRow[]).map(fromRow);
}

/**
 * Every edge of one relation leaving nodes of `fromType`, grouped by source id.
 *
 * The session list resolves three of these relations for every row, up to ~4
 * times a second while agents stream; per-row queries made that 3xN round trips
 * through SQLite on the event loop, which every other connection then waits
 * behind. One indexed scan answers the whole list instead.
 */
export function outgoingByType(
  fromType: NodeType,
  relation: Relation,
): Map<string, Link[]> {
  assertRelation(relation);
  const rows = getDb()
    .prepare(
      "SELECT * FROM links WHERE from_type = ? AND relation = ? ORDER BY from_id, position IS NULL, position, created_at_ms",
    )
    .all(fromType, relation) as unknown as DbLinkRow[];
  const grouped = new Map<string, Link[]>();
  for (const row of rows) {
    const link = fromRow(row);
    const existing = grouped.get(link.fromId);
    if (existing) existing.push(link);
    else grouped.set(link.fromId, [link]);
  }
  return grouped;
}

/** Incoming edges to a node, optionally filtered by relation. */
export function incoming(to: NodeRef, relation?: Relation): Link[] {
  if (relation) assertRelation(relation);
  const rows = relation
    ? getDb()
        .prepare(
          "SELECT * FROM links WHERE to_type = ? AND to_id = ? AND relation = ? ORDER BY position IS NULL, position, created_at_ms",
        )
        .all(to.type, to.id, relation)
    : getDb()
        .prepare(
          "SELECT * FROM links WHERE to_type = ? AND to_id = ? ORDER BY relation, created_at_ms",
        )
        .all(to.type, to.id);
  return (rows as unknown as DbLinkRow[]).map(fromRow);
}

/**
 * Replace all outgoing edges of one relation from `from` with the given targets
 * (in order). Convenience for single-valued or fully-ordered relations.
 */
export function setOutgoing(
  from: NodeRef,
  relation: Relation,
  targets: Array<{ to: NodeRef; metadata?: unknown }>,
): void {
  assertRelation(relation);
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare(
      "DELETE FROM links WHERE from_type = ? AND from_id = ? AND relation = ?",
    ).run(from.type, from.id, relation);
    targets.forEach((t, index) =>
      addLink(from, relation, t.to, { position: index, metadata: t.metadata }),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    noteWrite(from.type);
  }
}

/** All edges, optionally of one relation. Cheap at app scale; used for batch assembly. */
export function allLinks(relation?: Relation): Link[] {
  if (relation) assertRelation(relation);
  const rows = relation
    ? getDb()
        .prepare(
          "SELECT * FROM links WHERE relation = ? ORDER BY position IS NULL, position, created_at_ms",
        )
        .all(relation)
    : getDb()
        .prepare(
          "SELECT * FROM links ORDER BY relation, position IS NULL, position, created_at_ms",
        )
        .all();
  return (rows as unknown as DbLinkRow[]).map(fromRow);
}

/** Delete every edge touching a node (either endpoint). Call when an entity is removed. */
export function removeAllFor(node: NodeRef): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM links WHERE from_type = ? AND from_id = ?").run(
      node.type,
      node.id,
    );
    db.prepare("DELETE FROM links WHERE to_type = ? AND to_id = ?").run(
      node.type,
      node.id,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    writesToEveryType += 1;
  }
}

interface DbLinkRow {
  from_type: NodeType;
  from_id: string;
  relation: Relation;
  to_type: NodeType;
  to_id: string;
  position: number | null;
  metadata_json: string | null;
  created_at_ms: number;
}

function fromRow(row: DbLinkRow): Link {
  return {
    fromType: row.from_type,
    fromId: row.from_id,
    relation: row.relation,
    toType: row.to_type,
    toId: row.to_id,
    ...(row.position !== null ? { position: row.position } : {}),
    ...(row.metadata_json ? { metadata: safeParse(row.metadata_json) } : {}),
    createdAt: row.created_at_ms,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
