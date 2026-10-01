/**
 * The `worktrees` store (see migrations/0006_worktrees.sql).
 *
 * A worktree's own attributes live in the `worktrees` row; relationships are
 * edges in the generic {@link ./links.ts} graph:
 *   - `session —in_worktree→ worktree`  the session executes in that worktree
 *   - `task —in_worktree→ worktree`     the task is implemented there
 *
 * Pure persistence: git operations, naming, and lifecycle rules live in
 * `../worktrees/`. Rows are soft-removed (`status='removed'`) so worktree and
 * relationship history remains resolvable; review comments are object-bounded
 * and are explicitly deleted when their spawned worktree is removed.
 */
import type { DatabaseSync } from "node:sqlite";
import { getDb, withDbTransaction } from "./index.ts";
import { sessionStore } from "./sessionStore.ts";
import {
  addLink,
  incoming,
  memoizedOnLinks,
  outgoing,
  outgoingByType,
  setOutgoing,
  type NodeRef,
} from "./links.ts";

type WorktreeRowStatus = "active" | "removed";

export interface WorktreeRow {
  id: string;
  projectId: string;
  mainRepoRoot: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  status: WorktreeRowStatus;
  mergeStateJson: string | null;
  /** Exact local branch oid still eligible for post-removal cleanup. */
  branchCleanupOid?: string | null;
  createdAt: number;
  updatedAt: number;
  removedAt: number | null;
}

/** The graph node for a worktree. */
function worktreeNode(id: string): NodeRef {
  return { type: "worktree", id };
}

function sessionNode(id: string): NodeRef {
  return { type: "session", id };
}

function taskNode(id: string): NodeRef {
  return { type: "task", id };
}

/* --------------------------------- reads --------------------------------- */

export function getWorktree(id: string): WorktreeRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM worktrees WHERE id = ?")
    .get(id) as DbWorktreeRow | undefined;
  return row ? fromRow(row) : undefined;
}

/**
 * Every ACTIVE worktree's path by id in one read, for a probe that asks about
 * many ids at once (the session list's missing-worktree flag).
 */
export function activeWorktreePaths(): Map<string, string> {
  const rows = getDb()
    .prepare("SELECT id, path FROM worktrees WHERE status = 'active'")
    .all() as Array<{ id: string; path: string }>;
  return new Map(rows.map((row) => [row.id, row.path]));
}

export function listWorktrees(
  filter: { projectId?: string; includeRemoved?: boolean } = {},
): WorktreeRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (!filter.includeRemoved) clauses.push("status != 'removed'");
  if (filter.projectId) {
    clauses.push("project_id = ?");
    params.push(filter.projectId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM worktrees ${where} ORDER BY created_at_ms`)
    .all(...params) as unknown as DbWorktreeRow[];
  return rows.map(fromRow);
}

/* -------------------------------- writes --------------------------------- */

export function insertWorktree(row: WorktreeRow): void {
  getDb()
    .prepare(
      `
      INSERT INTO worktrees (id, project_id, main_repo_root, path, branch, base_branch, base_commit, status, merge_state_json, branch_cleanup_oid, created_at_ms, updated_at_ms, removed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      row.id,
      row.projectId,
      row.mainRepoRoot,
      row.path,
      row.branch,
      row.baseBranch,
      row.baseCommit,
      row.status,
      row.mergeStateJson,
      row.branchCleanupOid ?? null,
      row.createdAt,
      row.updatedAt,
      row.removedAt,
    );
}

export function updateWorktree(
  id: string,
  patch: Partial<Pick<WorktreeRow, "status" | "mergeStateJson" | "removedAt">>,
): void {
  const existing = getWorktree(id);
  if (!existing) return;
  getDb()
    .prepare(
      "UPDATE worktrees SET status = ?, merge_state_json = ?, removed_at_ms = ?, updated_at_ms = ? WHERE id = ?",
    )
    .run(
      patch.status ?? existing.status,
      patch.mergeStateJson !== undefined
        ? patch.mergeStateJson
        : existing.mergeStateJson,
      patch.removedAt !== undefined ? patch.removedAt : existing.removedAt,
      Date.now(),
      id,
    );
}

/** Replace the active row's merge-back target and whole-branch diff pivot. */
export function updateWorktreeBase(
  id: string,
  baseBranch: string,
  baseCommit: string,
): WorktreeRow | undefined {
  const result = getDb()
    .prepare(
      "UPDATE worktrees SET base_branch = ?, base_commit = ?, updated_at_ms = ? WHERE id = ? AND status = 'active'",
    )
    .run(baseBranch, baseCommit, Date.now(), id);
  return result.changes === 1 ? getWorktree(id) : undefined;
}

/** Test-only legacy fixture hook; production removal uses finalizeWorktreeRemoval. */
export function markWorktreeRemovedForTests(id: string): void {
  updateWorktree(id, { status: "removed", removedAt: Date.now() });
}

/* --------------------------------- edges ---------------------------------- */

/** A session executes in at most ONE worktree: relinking replaces the edge. */
export function linkSessionToWorktree(
  sessionId: string,
  worktreeId: string,
): void {
  setOutgoing(sessionNode(sessionId), "in_worktree", [
    { to: worktreeNode(worktreeId) },
  ]);
}

export function linkTaskToWorktree(taskId: string, worktreeId: string): void {
  addLink(taskNode(taskId), "in_worktree", worktreeNode(worktreeId));
}

/** The worktree a session executes in, if any (a session has at most one). */
export function worktreeIdForSession(sessionId: string): string | undefined {
  return outgoing(sessionNode(sessionId), "in_worktree")[0]?.toId;
}

/**
 * Every session→worktree mapping in one query, for the session list; rebuilt
 * only after a session edge changes ({@link memoizedOnLinks}).
 */
export const worktreeIdBySession: () => ReadonlyMap<string, string> =
  memoizedOnLinks("session", () => {
    const index = new Map<string, string>();
    for (const [sessionId, links] of outgoingByType("session", "in_worktree")) {
      const worktreeId = links[0]?.toId;
      if (worktreeId) index.set(sessionId, worktreeId);
    }
    return index;
  });

export function sessionIdsForWorktree(worktreeId: string): string[] {
  return incoming(worktreeNode(worktreeId), "in_worktree")
    .filter((link) => link.fromType === "session")
    .map((link) => link.fromId);
}

/**
 * The sessions on a worktree that are still LIVE — neither settled, archived
 * nor deleted.
 *
 * The edges are insert-only, so {@link sessionIdsForWorktree} answers "every
 * session EVER linked": one checkout normally carries a dev session plus the
 * review and fork sessions spun off it, and long after those are finished they
 * still show up there. A caller asking "who is still working in this checkout"
 * — removing it, settling it — means this one.
 */
export function liveSessionIdsForWorktree(worktreeId: string): string[] {
  return sessionIdsForWorktree(worktreeId).filter((sessionId) => {
    // `get` already hides deleted sessions; settlement is asked EFFECTIVELY
    // (`isSettled`), so a session woken by its own outcome still counts as
    // working here even though it carries an older settlement mark.
    const session = sessionStore.get(sessionId);
    return Boolean(
      session && !session.archivedAt && !sessionStore.isSettled(sessionId),
    );
  });
}

export function taskIdsForWorktree(worktreeId: string): string[] {
  return incoming(worktreeNode(worktreeId), "in_worktree")
    .filter((link) => link.fromType === "task")
    .map((link) => link.fromId);
}

/* -------------------------------- comments -------------------------------- */

export type CommentAnchorState = "anchored" | "moved" | "orphaned";
type ReviewSeverity = "critical" | "major" | "minor" | "nit";
export type WorktreeReviewVerdict =
  "approve" | "approve-with-fixes" | "request-changes" | "reject";

export interface WorktreeReviewSetRow {
  id: string;
  worktreeId: string;
  authorSessionId: string;
  authorModel: string | null;
  authorThinkingLevel: string | null;
  blind: boolean;
  verdict: WorktreeReviewVerdict | null;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorktreeCommentRow {
  id: string;
  worktreeId: string;
  parentId: string | null;
  authorKind: "user" | "agent";
  authorSessionId: string | null;
  authorModel?: string | null;
  authorThinkingLevel?: string | null;
  severity?: ReviewSeverity | null;
  reviewSetId?: string | null;
  body: string;
  resolvedAt: number | null;
  resolvedBy: string | null;
  anchorPath: string | null;
  anchorSide: "old" | "new" | null;
  anchorLine: number | null;
  anchorCommit: string | null;
  anchorBlob: string | null;
  anchorDirty: boolean | null;
  /** {before: string[], line: string, after: string[]} as JSON. */
  anchorContextJson: string | null;
  anchorQuoteExact: string | null;
  anchorQuotePrefix: string | null;
  anchorQuoteSuffix: string | null;
  anchorPositionStart: number | null;
  anchorPositionEnd: number | null;
  anchorBlockId: string | null;
  anchorBlockOccurrence: number | null;
  currentPath: string | null;
  currentLine: number | null;
  anchorState: CommentAnchorState | null;
  attachedSessionId: string | null;
  ownerWorktreeId: string | null;
  ownerBranch: string | null;
  ownerSource: "merge-in-flight" | "branch-exclusive" | null;
  createdAt: number;
  updatedAt: number;
}

export function insertComment(row: WorktreeCommentRow): void {
  withDbTransaction(() => {
    const database = getDb();
    if (!row.worktreeId.startsWith("main:")) {
      const worktree = database
        .prepare("SELECT status FROM worktrees WHERE id = ?")
        .get(row.worktreeId) as { status: WorktreeRowStatus } | undefined;
      if (!worktree || worktree.status !== "active")
        throw new Error("Unknown worktree.");
    }
    if (row.parentId) {
      const parent = database
        .prepare("SELECT worktree_id FROM worktree_comments WHERE id = ?")
        .get(row.parentId) as { worktree_id: string } | undefined;
      if (!parent || parent.worktree_id !== row.worktreeId)
        throw new Error("Unknown parent comment.");
    }
    if (row.reviewSetId) {
      const set = database
        .prepare("SELECT worktree_id FROM worktree_review_sets WHERE id = ?")
        .get(row.reviewSetId) as { worktree_id: string } | undefined;
      if (!set || set.worktree_id !== row.worktreeId)
        throw new Error("Unknown review set.");
    }
    insertCommentRow(database, row);
  });
}

function insertCommentRow(
  database: DatabaseSync,
  row: WorktreeCommentRow,
): void {
  database
    .prepare(
      `
      INSERT INTO worktree_comments (
        id, worktree_id, parent_id, author_kind, author_session_id,
        author_model, author_thinking_level, severity, review_set_id, body,
        resolved_at_ms, resolved_by, anchor_path, anchor_side, anchor_line,
        anchor_commit, anchor_blob, anchor_dirty, anchor_context_json,
        anchor_quote_exact, anchor_quote_prefix, anchor_quote_suffix,
        anchor_position_start, anchor_position_end, anchor_block_id,
        anchor_block_occurrence, current_path, current_line, anchor_state,
        attached_session_id, owner_worktree_id, owner_branch, owner_source,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      row.id,
      row.worktreeId,
      row.parentId,
      row.authorKind,
      row.authorSessionId,
      row.authorModel ?? null,
      row.authorThinkingLevel ?? null,
      row.severity ?? null,
      row.reviewSetId ?? null,
      row.body,
      row.resolvedAt,
      row.resolvedBy,
      row.anchorPath,
      row.anchorSide,
      row.anchorLine,
      row.anchorCommit,
      row.anchorBlob,
      row.anchorDirty === null ? null : row.anchorDirty ? 1 : 0,
      row.anchorContextJson,
      row.anchorQuoteExact,
      row.anchorQuotePrefix,
      row.anchorQuoteSuffix,
      row.anchorPositionStart,
      row.anchorPositionEnd,
      row.anchorBlockId,
      row.anchorBlockOccurrence,
      row.currentPath,
      row.currentLine,
      row.anchorState,
      row.attachedSessionId,
      row.ownerWorktreeId,
      row.ownerBranch,
      row.ownerSource,
      row.createdAt,
      row.updatedAt,
    );
}

/** Test-only corruption hooks for historical cross-scope/orphan fixtures. */
function assertTestRuntime(): void {
  if (process.env.VITEST !== "true") throw new Error("Test-only DB mutation.");
}

export function reassignCommentWorktreeForTests(
  id: string,
  worktreeId: string,
): void {
  assertTestRuntime();
  getDb()
    .prepare("UPDATE worktree_comments SET worktree_id = ? WHERE id = ?")
    .run(worktreeId, id);
}

export function reparentCommentForTests(
  id: string,
  parentId: string | null,
): void {
  assertTestRuntime();
  getDb()
    .prepare("UPDATE worktree_comments SET parent_id = ? WHERE id = ?")
    .run(parentId, id);
}

/** Test-only fixture hook for exercising age/state-based retention. */
export function setCommentRetentionFieldsForTests(
  id: string,
  fields: {
    resolvedAt: number | null;
    anchorState?: CommentAnchorState;
    updatedAt?: number;
  },
): void {
  assertTestRuntime();
  const existing = getComment(id);
  if (!existing) throw new Error("Unknown comment.");
  getDb()
    .prepare(
      "UPDATE worktree_comments SET resolved_at_ms = ?, resolved_by = ?, anchor_state = ?, updated_at_ms = ? WHERE id = ?",
    )
    .run(
      fields.resolvedAt,
      fields.resolvedAt === null ? null : "user",
      fields.anchorState ?? existing.anchorState,
      fields.updatedAt ?? existing.updatedAt,
      id,
    );
}

export function getComment(id: string): WorktreeCommentRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM worktree_comments WHERE id = ?")
    .get(id) as DbCommentRow | undefined;
  return row ? commentFromRow(row) : undefined;
}

export function listComments(worktreeId: string): WorktreeCommentRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM worktree_comments WHERE worktree_id = ? ORDER BY created_at_ms",
    )
    .all(worktreeId) as unknown as DbCommentRow[];
  return rows.map(commentFromRow);
}

export function insertReviewSet(row: WorktreeReviewSetRow): void {
  withDbTransaction(() => {
    const database = getDb();
    if (!row.worktreeId.startsWith("main:")) {
      const worktree = database
        .prepare("SELECT status FROM worktrees WHERE id = ?")
        .get(row.worktreeId) as { status: WorktreeRowStatus } | undefined;
      if (!worktree || worktree.status !== "active")
        throw new Error("Unknown worktree.");
    }
    database
      .prepare(
        `INSERT INTO worktree_review_sets (
          id, worktree_id, author_session_id, author_model,
          author_thinking_level, blind, verdict, summary, created_at_ms,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.worktreeId,
        row.authorSessionId,
        row.authorModel,
        row.authorThinkingLevel,
        row.blind ? 1 : 0,
        row.verdict,
        row.summary,
        row.createdAt,
        row.updatedAt,
      );
  });
}

export function getReviewSet(id: string): WorktreeReviewSetRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM worktree_review_sets WHERE id = ?")
    .get(id) as DbReviewSetRow | undefined;
  return row ? reviewSetFromRow(row) : undefined;
}

export function listReviewSets(worktreeId: string): WorktreeReviewSetRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM worktree_review_sets WHERE worktree_id = ? ORDER BY created_at_ms",
    )
    .all(worktreeId) as unknown as DbReviewSetRow[];
  return rows.map(reviewSetFromRow);
}

export function closeReviewSet(
  id: string,
  verdict: WorktreeReviewVerdict,
  summary: string,
): void {
  const result = getDb()
    .prepare(
      `UPDATE worktree_review_sets
       SET verdict = ?, summary = ?, updated_at_ms = ?
       WHERE id = ? AND verdict IS NULL`,
    )
    .run(verdict, summary, Date.now(), id);
  if (result.changes === 0) throw new Error("Review set is already closed.");
}

/** Synthetic main checkouts that currently own at least one comment. */
export function listMainWorktreeIdsWithComments(): string[] {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT worktree_id FROM worktree_comments WHERE worktree_id LIKE 'main:%' ORDER BY worktree_id",
    )
    .all() as unknown as Array<{ worktree_id: string }>;
  return rows.map((row) => row.worktree_id);
}

export function updateCommentAnchor(
  id: string,
  patch: {
    currentPath: string | null;
    currentLine: number | null;
    anchorState: CommentAnchorState;
  },
): void {
  getDb()
    .prepare(
      "UPDATE worktree_comments SET current_path = ?, current_line = ?, anchor_state = ?, updated_at_ms = ? WHERE id = ?",
    )
    .run(
      patch.currentPath,
      patch.currentLine,
      patch.anchorState,
      Date.now(),
      id,
    );
}

export function setCommentResolved(
  id: string,
  resolvedBy: string | null,
): void {
  getDb()
    .prepare(
      "UPDATE worktree_comments SET resolved_at_ms = ?, resolved_by = ?, updated_at_ms = ? WHERE id = ?",
    )
    .run(resolvedBy === null ? null : Date.now(), resolvedBy, Date.now(), id);
}

export function setCommentAttachedSession(id: string, sessionId: string): void {
  getDb()
    .prepare(
      "UPDATE worktree_comments SET attached_session_id = ?, updated_at_ms = ? WHERE id = ?",
    )
    .run(sessionId, Date.now(), id);
}

/** Delete a comment; replies cascade via the FK. */
export function deleteComment(id: string): void {
  getDb().prepare("DELETE FROM worktree_comments WHERE id = ?").run(id);
}

export interface MainCommentRetentionDeletion {
  rootIds: string[];
  deletedComments: number;
}

/** Delete synthetic-main roots owned by one spawned branch subject. */
export function deleteMainCommentsForBranchSubject(
  mainWorktreeId: string,
  ownerWorktreeId: string,
): MainCommentRetentionDeletion {
  if (!mainWorktreeId.startsWith("main:"))
    throw new Error("Branch-subject purge requires a synthetic main id.");
  return withDbTransaction(() => {
    const database = getDb();
    const roots = database
      .prepare(
        `
        SELECT id
        FROM worktree_comments
        WHERE worktree_id = ?
          AND parent_id IS NULL
          AND owner_worktree_id = ?
        ORDER BY id
      `,
      )
      .all(mainWorktreeId, ownerWorktreeId) as unknown as Array<{ id: string }>;
    if (roots.length === 0) return { rootIds: [], deletedComments: 0 };

    assertCommentRootsScoped(
      database,
      mainWorktreeId,
      roots.map((root) => root.id),
    );
    const before = countComments(database, mainWorktreeId);
    const remove = database.prepare(
      "DELETE FROM worktree_comments WHERE id = ? AND worktree_id = ? AND parent_id IS NULL",
    );
    for (const root of roots) remove.run(root.id, mainWorktreeId);
    return {
      rootIds: roots.map((root) => root.id),
      deletedComments: before - countComments(database, mainWorktreeId),
    };
  });
}

/**
 * Delete old resolved-orphan roots from one synthetic main checkout. The caller
 * must complete a fresh re-anchor pass immediately before this synchronous
 * transaction, including only roots that the pass reported as evaluated;
 * and deleting together prevents an intervening comment mutation from changing
 * the eligible set. Replies follow their root through the self-FK cascade.
 */
export function deleteExpiredResolvedOrphanedMainComments(
  worktreeId: string,
  resolvedBefore: number,
  freshlyReanchoredRootIds: readonly string[],
): MainCommentRetentionDeletion {
  if (!worktreeId.startsWith("main:"))
    throw new Error("Main-comment retention requires a synthetic main id.");
  return withDbTransaction(() => {
    const database = getDb();
    const freshlyReanchored = new Set(freshlyReanchoredRootIds);
    const roots = (
      database
        .prepare(
          `
          SELECT id
          FROM worktree_comments
          WHERE worktree_id = ?
            AND parent_id IS NULL
            AND anchor_state = 'orphaned'
            AND resolved_at_ms IS NOT NULL
            AND resolved_at_ms < ?
          ORDER BY id
        `,
        )
        .all(worktreeId, resolvedBefore) as unknown as Array<{ id: string }>
    ).filter((root) => freshlyReanchored.has(root.id));
    if (roots.length === 0) return { rootIds: [], deletedComments: 0 };

    assertCommentRootsScoped(
      database,
      worktreeId,
      roots.map((root) => root.id),
    );
    const before = countComments(database, worktreeId);
    const remove = database.prepare(
      "DELETE FROM worktree_comments WHERE id = ? AND worktree_id = ? AND parent_id IS NULL",
    );
    for (const root of roots) remove.run(root.id, worktreeId);
    const deletedComments = before - countComments(database, worktreeId);
    return { rootIds: roots.map((root) => root.id), deletedComments };
  });
}

function countComments(database: DatabaseSync, worktreeId: string): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS count FROM worktree_comments WHERE worktree_id = ?",
    )
    .get(worktreeId) as { count: number };
  return row.count;
}

/** Refuse a root purge whose FK cascade could cross worktree ownership. */
function assertCommentRootsScoped(
  database: DatabaseSync,
  worktreeId: string,
  rootIds: string[],
): void {
  const crossScope = database.prepare(
    `
    WITH RECURSIVE descendants(id, worktree_id) AS (
      SELECT id, worktree_id FROM worktree_comments WHERE id = ?
      UNION
      SELECT child.id, child.worktree_id
      FROM worktree_comments AS child
      JOIN descendants AS parent ON child.parent_id = parent.id
    )
    SELECT id, worktree_id
    FROM descendants
    WHERE worktree_id != ?
    LIMIT 1
  `,
  );
  for (const rootId of rootIds) {
    const row = crossScope.get(rootId, worktreeId) as
      { id: string; worktree_id: string } | undefined;
    if (row)
      throw new Error(
        `Cannot delete comment thread ${rootId}: descendant ${row.id} belongs to ${row.worktree_id}.`,
      );
  }
}

/**
 * Delete every thread owned by a spawned worktree. Historical cross-scope reply
 * chains are rejected before root deletion so the self-FK cannot cascade into
 * another spawned worktree or synthetic main.
 */
export function deleteWorktreeComments(worktreeId: string): number {
  if (worktreeId.startsWith("main:"))
    throw new Error(
      "Synthetic-main comments cannot be deleted by worktree lifecycle.",
    );
  return withDbTransaction(() =>
    deleteWorktreeCommentsInTransaction(getDb(), worktreeId),
  );
}

/** Refuse a lifecycle purge that could cascade beyond one spawned worktree. */
export function assertWorktreeCommentsDeletable(worktreeId: string): void {
  if (worktreeId.startsWith("main:"))
    throw new Error(
      "Synthetic-main comments cannot be deleted by worktree lifecycle.",
    );
  withDbTransaction(() => assertWorktreeCommentScope(getDb(), worktreeId));
}

function assertWorktreeCommentScope(
  database: DatabaseSync,
  worktreeId: string,
): void {
  const unrooted = database
    .prepare(
      `
      WITH RECURSIVE target_tree(id) AS (
        SELECT id
        FROM worktree_comments
        WHERE worktree_id = ? AND parent_id IS NULL
        UNION
        SELECT child.id
        FROM worktree_comments AS child
        JOIN target_tree AS parent ON child.parent_id = parent.id
        WHERE child.worktree_id = ?
      )
      SELECT comments.id, comments.parent_id
      FROM worktree_comments AS comments
      LEFT JOIN target_tree ON target_tree.id = comments.id
      WHERE comments.worktree_id = ? AND target_tree.id IS NULL
      LIMIT 1
    `,
    )
    .get(worktreeId, worktreeId, worktreeId) as
    { id: string; parent_id: string | null } | undefined;
  if (unrooted)
    throw new Error(
      `Cannot delete worktree comments for ${worktreeId}: comment ${unrooted.id} is not in a ${worktreeId}-rooted thread.`,
    );

  const crossScope = database
    .prepare(
      `
      WITH RECURSIVE descendants(id, worktree_id) AS (
        SELECT id, worktree_id
        FROM worktree_comments
        WHERE worktree_id = ? AND parent_id IS NULL
        UNION
        SELECT child.id, child.worktree_id
        FROM worktree_comments AS child
        JOIN descendants AS parent ON child.parent_id = parent.id
      )
      SELECT id, worktree_id
      FROM descendants
      WHERE worktree_id != ?
      LIMIT 1
    `,
    )
    .get(worktreeId, worktreeId) as
    { id: string; worktree_id: string } | undefined;
  if (crossScope)
    throw new Error(
      `Cannot delete worktree comments for ${worktreeId}: descendant ${crossScope.id} belongs to ${crossScope.worktree_id}.`,
    );
}

function deleteWorktreeCommentsInTransaction(
  database: DatabaseSync,
  worktreeId: string,
): number {
  assertWorktreeCommentScope(database, worktreeId);
  const { count } = database
    .prepare(
      "SELECT COUNT(*) AS count FROM worktree_comments WHERE worktree_id = ?",
    )
    .get(worktreeId) as { count: number };
  database
    .prepare(
      "DELETE FROM worktree_comments WHERE worktree_id = ? AND parent_id IS NULL",
    )
    .run(worktreeId);
  const remaining = database
    .prepare(
      "SELECT COUNT(*) AS count FROM worktree_comments WHERE worktree_id = ?",
    )
    .get(worktreeId) as { count: number };
  if (remaining.count !== 0)
    throw new Error(
      `Could not delete all worktree comments for ${worktreeId}: ${remaining.count} row(s) remain.`,
    );
  database
    .prepare("DELETE FROM worktree_review_sets WHERE worktree_id = ?")
    .run(worktreeId);
  return count;
}

/** Atomically tombstone a spawned worktree and purge its scoped comments. */
export function finalizeWorktreeRemoval(
  worktreeId: string,
  branchCleanupOid: string | null,
): number {
  if (worktreeId.startsWith("main:"))
    throw new Error("The synthetic main checkout cannot be removed.");
  return withDbTransaction(() => {
    const database = getDb();
    const worktree = database
      .prepare("SELECT id FROM worktrees WHERE id = ?")
      .get(worktreeId);
    if (!worktree) throw new Error("Unknown worktree.");
    const count = deleteWorktreeCommentsInTransaction(database, worktreeId);
    const now = Date.now();
    database
      .prepare(
        "UPDATE worktrees SET status = 'removed', branch_cleanup_oid = ?, removed_at_ms = ?, updated_at_ms = ? WHERE id = ?",
      )
      .run(branchCleanupOid, now, now, worktreeId);
    return count;
  });
}

/** Clear one still-matching branch cleanup claim after success or ref reuse. */
export function clearWorktreeBranchCleanup(
  worktreeId: string,
  expectedOid: string,
): boolean {
  const result = getDb()
    .prepare(
      "UPDATE worktrees SET branch_cleanup_oid = NULL, updated_at_ms = ? WHERE id = ? AND status = 'removed' AND branch_cleanup_oid = ?",
    )
    .run(Date.now(), worktreeId, expectedOid);
  return result.changes === 1;
}

export interface OrphanedWorktreeComments {
  worktreeId: string;
  branch: string | null;
  removedAt: number | null;
  commentCount: number;
}

/**
 * Comments whose spawned worktree is missing or soft-removed. Synthetic main
 * ids are deliberately excluded: main-checkout comment lifetime is separate.
 */
export function listOrphanedWorktreeComments(): OrphanedWorktreeComments[] {
  return listOrphanedWorktreeCommentsInTransaction(getDb());
}

function listOrphanedWorktreeCommentsInTransaction(
  database: DatabaseSync,
): OrphanedWorktreeComments[] {
  const rows = database
    .prepare(
      `
      SELECT
        comments.worktree_id,
        worktrees.branch,
        worktrees.removed_at_ms,
        COUNT(*) AS comment_count
      FROM worktree_comments AS comments
      LEFT JOIN worktrees ON worktrees.id = comments.worktree_id
      WHERE comments.worktree_id NOT LIKE 'main:%'
        AND (worktrees.id IS NULL OR worktrees.status = 'removed')
      GROUP BY comments.worktree_id, worktrees.branch, worktrees.removed_at_ms
      ORDER BY comments.worktree_id
    `,
    )
    .all() as unknown as DbOrphanedWorktreeComments[];
  return rows.map((row) => ({
    worktreeId: row.worktree_id,
    branch: row.branch,
    removedAt: row.removed_at_ms,
    commentCount: row.comment_count,
  }));
}

/** Classify and delete the complete orphan set in one all-or-nothing write. */
export function deleteOrphanedWorktreeComments(): {
  candidates: OrphanedWorktreeComments[];
  deletedComments: number;
} {
  return withDbTransaction(() => {
    const database = getDb();
    const candidates = listOrphanedWorktreeCommentsInTransaction(database);
    let deletedComments = 0;
    for (const candidate of candidates) {
      deletedComments += deleteWorktreeCommentsInTransaction(
        database,
        candidate.worktreeId,
      );
    }
    return { candidates, deletedComments };
  });
}

interface DbOrphanedWorktreeComments {
  worktree_id: string;
  branch: string | null;
  removed_at_ms: number | null;
  comment_count: number;
}

interface DbReviewSetRow {
  id: string;
  worktree_id: string;
  author_session_id: string;
  author_model: string | null;
  author_thinking_level: string | null;
  blind: number;
  verdict: WorktreeReviewVerdict | null;
  summary: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function reviewSetFromRow(row: DbReviewSetRow): WorktreeReviewSetRow {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    authorSessionId: row.author_session_id,
    authorModel: row.author_model,
    authorThinkingLevel: row.author_thinking_level,
    blind: row.blind === 1,
    verdict: row.verdict,
    summary: row.summary,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

interface DbCommentRow {
  id: string;
  worktree_id: string;
  parent_id: string | null;
  author_kind: "user" | "agent";
  author_session_id: string | null;
  author_model: string | null;
  author_thinking_level: string | null;
  severity: ReviewSeverity | null;
  review_set_id: string | null;
  body: string;
  resolved_at_ms: number | null;
  resolved_by: string | null;
  anchor_path: string | null;
  anchor_side: "old" | "new" | null;
  anchor_line: number | null;
  anchor_commit: string | null;
  anchor_blob: string | null;
  anchor_dirty: number | null;
  anchor_context_json: string | null;
  anchor_quote_exact: string | null;
  anchor_quote_prefix: string | null;
  anchor_quote_suffix: string | null;
  anchor_position_start: number | null;
  anchor_position_end: number | null;
  anchor_block_id: string | null;
  anchor_block_occurrence: number | null;
  current_path: string | null;
  current_line: number | null;
  anchor_state: CommentAnchorState | null;
  attached_session_id: string | null;
  owner_worktree_id: string | null;
  owner_branch: string | null;
  owner_source: "merge-in-flight" | "branch-exclusive" | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function commentFromRow(row: DbCommentRow): WorktreeCommentRow {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    parentId: row.parent_id,
    authorKind: row.author_kind,
    authorSessionId: row.author_session_id,
    authorModel: row.author_model,
    authorThinkingLevel: row.author_thinking_level,
    severity: row.severity,
    reviewSetId: row.review_set_id,
    body: row.body,
    resolvedAt: row.resolved_at_ms,
    resolvedBy: row.resolved_by,
    anchorPath: row.anchor_path,
    anchorSide: row.anchor_side,
    anchorLine: row.anchor_line,
    anchorCommit: row.anchor_commit,
    anchorBlob: row.anchor_blob,
    anchorDirty: row.anchor_dirty === null ? null : row.anchor_dirty === 1,
    anchorContextJson: row.anchor_context_json,
    anchorQuoteExact: row.anchor_quote_exact,
    anchorQuotePrefix: row.anchor_quote_prefix,
    anchorQuoteSuffix: row.anchor_quote_suffix,
    anchorPositionStart: row.anchor_position_start,
    anchorPositionEnd: row.anchor_position_end,
    anchorBlockId: row.anchor_block_id,
    anchorBlockOccurrence: row.anchor_block_occurrence,
    currentPath: row.current_path,
    currentLine: row.current_line,
    anchorState: row.anchor_state,
    attachedSessionId: row.attached_session_id,
    ownerWorktreeId: row.owner_worktree_id,
    ownerBranch: row.owner_branch,
    ownerSource: row.owner_source,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

/* ---------------------------------- rows ---------------------------------- */

interface DbWorktreeRow {
  id: string;
  project_id: string;
  main_repo_root: string;
  path: string;
  branch: string;
  base_branch: string;
  base_commit: string;
  status: WorktreeRowStatus;
  merge_state_json: string | null;
  branch_cleanup_oid: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  removed_at_ms: number | null;
}

function fromRow(row: DbWorktreeRow): WorktreeRow {
  return {
    id: row.id,
    projectId: row.project_id,
    mainRepoRoot: row.main_repo_root,
    path: row.path,
    branch: row.branch,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    status: row.status,
    mergeStateJson: row.merge_state_json,
    branchCleanupOid: row.branch_cleanup_oid,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    removedAt: row.removed_at_ms,
  };
}
