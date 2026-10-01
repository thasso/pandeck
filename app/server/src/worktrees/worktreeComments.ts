/**
 * Durable review comments on worktree lines, with anchors that survive future
 * edits and commits.
 *
 * Creation snapshots an immutable anchor: the worktree HEAD oid, the blob the
 * displayed content came from, and the exact line ± context lines. Comments
 * are anchored to the CURRENT state of the worktree (working tree for "new"
 * anchors, HEAD content for "old" anchors) — the client only offers
 * commenting on surfaces that show current content.
 *
 * Re-anchoring always recomputes from that immutable anchor (no incremental
 * drift): renames are resolved first, then the anchor line is mapped through
 * `git diff -U0` hunk offsets (anchor commit → working tree for clean roots;
 * snapshotted blob → validated working bytes for dirty roots). That mapped line
 * is the structural `block` hint for the shared selector resolver; position,
 * exact/fuzzy quote fallback and orphaning then follow the same ladder as every
 * other durable comment surface. Orphans are kept so a revert can revive them.
 *
 * Runs on git-state watcher events (agents auto-commit) and lazily on listing
 * when HEAD moved since the last pass.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  NewWorktreeCommentAnchor,
  ReviewSeverity,
  WorktreeComment,
  WorktreeCommentAuthor,
  WorktreeReviewSet,
  WorktreeReviewVerdict,
} from "@assistant/shared";
import type {
  PositionSelector,
  SelectorBundle,
} from "@assistant/shared/comments";
import { resolveAnchor } from "../comments/resolveAnchor.ts";
import {
  gitOptional,
  gitWithInputOptional,
  repoLockKey,
  withRepoLock,
} from "../gitExec.ts";
import {
  deleteComment as deleteCommentRow,
  deleteExpiredResolvedOrphanedMainComments,
  closeReviewSet,
  deleteMainCommentsForBranchSubject,
  getComment,
  getReviewSet,
  insertComment,
  insertReviewSet,
  listComments,
  listReviewSets,
  listMainWorktreeIdsWithComments,
  setCommentAttachedSession,
  setCommentResolved,
  updateCommentAnchor,
  type WorktreeCommentRow,
  type WorktreeReviewSetRow,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import { onWorktreeGitStateChange } from "./worktreeWatcher.ts";
import { containedRealPath, isSafeRef } from "./worktreeDiff.ts";
import {
  isMainWorktreeId,
  mainWorktreeId,
  resolveWorktreeRow,
} from "./worktreeResolve.ts";
import { captureMainCommentOwner } from "./worktreeCommentOwnership.ts";
import {
  reportCommentChanges,
  reportCommentMetadataChanges,
} from "../comments/commentChanges.ts";

const CONTEXT_LINES = 3;

/** Fixed policy: resolved main-checkout orphans remain recoverable for 30 days. */
export const MAIN_COMMENT_RETENTION_DAYS = 30;
const MAIN_COMMENT_RETENTION_MS =
  MAIN_COMMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface AnchorContext {
  before: string[];
  line: string;
  after: string[];
}

/** HEAD oid the last re-anchor pass ran against, per worktree. */
const lastReanchorHead = new Map<string, string>();

// Agents auto-commit; every detected HEAD move re-anchors that worktree's
// comments. Subscribed at module load (the connection layer imports this
// module before any comment can exist).
onWorktreeGitStateChange((worktreeId) => {
  void reanchorWorktreeCommentPass(worktreeId)
    .then(async ({ changedRootIds }) => {
      if (changedRootIds.length)
        await broadcastComments(worktreeId, changedRootIds);
    })
    .catch((err) =>
      console.warn(
        "[worktrees] re-anchor failed:",
        err instanceof Error ? err.message : String(err),
      ),
    );
});

interface WorkingSource {
  content: Buffer;
  lines: string[];
}

function readWorkingSource(
  row: WorktreeRow,
  path: string,
): WorkingSource | undefined {
  try {
    // containedRealPath: lexical containment + symlink resolution, so a repo
    // symlink cannot anchor comments to (and snapshot lines from) files
    // outside the worktree.
    const content = readFileSync(containedRealPath(row.path, path));
    if (content.includes(0)) return undefined;
    return { content, lines: content.toString("utf8").split("\n") };
  } catch {
    return undefined;
  }
}

async function hashSource(
  row: WorktreeRow,
  source: WorkingSource,
  write: boolean,
): Promise<string | undefined> {
  const run = () =>
    gitWithInputOptional(
      ["hash-object", ...(write ? ["-w"] : []), "--stdin"],
      row.path,
      source.content,
    );
  const result = write
    ? await withRepoLock(await repoLockKey(row.path), run)
    : await run();
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function showLines(
  row: WorktreeRow,
  source: string,
): Promise<string[] | undefined> {
  const res = await gitOptional(["show", source], row.path);
  if (res.code !== 0 || res.stdout.includes("\0")) return undefined;
  return res.stdout.split("\n");
}

function contextAt(lines: string[], line: number): AnchorContext | undefined {
  const index = line - 1;
  if (index < 0 || index >= lines.length) return undefined;
  return {
    before: lines.slice(Math.max(0, index - CONTEXT_LINES), index),
    line: lines[index]!,
    after: lines.slice(index + 1, index + 1 + CONTEXT_LINES),
  };
}

function lineSpan(lines: string[], line: number): PositionSelector | undefined {
  if (line < 1 || line > lines.length) return undefined;
  let start = 0;
  for (let index = 0; index < line - 1; index++)
    start += (lines[index] ?? "").length + 1;
  return { start, end: start + (lines[line - 1] ?? "").length };
}

/** Capture selectors from the authoritative source while preserving a valid sub-line selection. */
function selectorsAt(
  lines: string[],
  line: number,
  supplied?: SelectorBundle,
): SelectorBundle | undefined {
  const text = lines.join("\n");
  const wholeLine = lineSpan(lines, line);
  if (!wholeLine) return undefined;
  const suppliedPosition = supplied?.position;
  if (
    supplied &&
    (!suppliedPosition ||
      suppliedPosition.start < wholeLine.start ||
      suppliedPosition.end > wholeLine.end ||
      suppliedPosition.start >= suppliedPosition.end ||
      text.slice(suppliedPosition.start, suppliedPosition.end) !==
        supplied.quote.exact)
  )
    throw new Error(
      "Cannot anchor the comment: the selected text no longer matches the displayed file.",
    );
  const position = suppliedPosition ?? wholeLine;
  const contextStart = lineSpan(
    lines,
    Math.max(1, line - CONTEXT_LINES),
  )!.start;
  const contextEnd = lineSpan(
    lines,
    Math.min(lines.length, line + CONTEXT_LINES),
  )!.end;
  return {
    quote: {
      exact: text.slice(position.start, position.end),
      prefix: text.slice(contextStart, position.start),
      suffix: text.slice(position.end, contextEnd),
    },
    position,
    block: { id: String(line), occurrence: 1 },
  };
}

function selectorFields(bundle: SelectorBundle): Partial<WorktreeCommentRow> {
  return {
    anchorQuoteExact: bundle.quote.exact,
    anchorQuotePrefix: bundle.quote.prefix,
    anchorQuoteSuffix: bundle.quote.suffix,
    anchorPositionStart: bundle.position?.start ?? null,
    anchorPositionEnd: bundle.position?.end ?? null,
    anchorBlockId: bundle.block?.id ?? null,
    anchorBlockOccurrence: bundle.block?.occurrence ?? null,
  };
}

/** New columns are authoritative; historical rows derive a bundle on every read. */
function selectorBundleOf(row: WorktreeCommentRow): SelectorBundle {
  const context = row.anchorContextJson
    ? (JSON.parse(row.anchorContextJson) as AnchorContext)
    : undefined;
  const exact = row.anchorQuoteExact ?? context?.line ?? "";
  const bundle: SelectorBundle = {
    quote: {
      exact,
      prefix:
        row.anchorQuotePrefix ??
        (context?.before.length ? `${context.before.join("\n")}\n` : ""),
      suffix:
        row.anchorQuoteSuffix ??
        (context?.after.length ? `\n${context.after.join("\n")}` : ""),
    },
    block: {
      id: row.anchorBlockId ?? String(row.anchorLine ?? ""),
      occurrence: row.anchorBlockOccurrence ?? 1,
    },
  };
  if (row.anchorPositionStart !== null && row.anchorPositionEnd !== null)
    bundle.position = {
      start: row.anchorPositionStart,
      end: row.anchorPositionEnd,
    };
  return bundle;
}

/**
 * Complete a historical row's derived bundle from immutable anchor content.
 * Nothing is written back: legacy rows remain untouched, like KB comment events.
 */
async function selectorBundleForRead(
  comment: WorktreeCommentRow,
  bundle: SelectorBundle,
  worktree: WorktreeRow | undefined,
  anchorLinesCache: Map<string, Promise<string[] | undefined>>,
): Promise<SelectorBundle> {
  if (
    bundle.position ||
    !worktree ||
    !comment.anchorCommit ||
    !comment.anchorPath ||
    !comment.anchorLine
  )
    return bundle;
  const source =
    comment.anchorDirty && comment.anchorBlob
      ? comment.anchorBlob
      : `${comment.anchorCommit}:${comment.anchorPath}`;
  let sourceLinesPromise = anchorLinesCache.get(source);
  if (!sourceLinesPromise) {
    sourceLinesPromise = showLines(worktree, source);
    anchorLinesCache.set(source, sourceLinesPromise);
  }
  let sourceLines = await sourceLinesPromise;
  if (
    !sourceLines &&
    comment.anchorDirty &&
    comment.anchorBlob &&
    comment.anchorPath
  ) {
    // Rows created before dirty blobs were written may still be recoverable
    // while the working file is byte-identical to the snapshot hash.
    const currentSource = readWorkingSource(worktree, comment.anchorPath);
    const currentBlob = currentSource
      ? await hashSource(worktree, currentSource, false)
      : undefined;
    if (currentSource && currentBlob === comment.anchorBlob) {
      sourceLines = currentSource.lines;
      anchorLinesCache.set(source, Promise.resolve(sourceLines));
    }
  }
  const position = sourceLines
    ? lineSpan(sourceLines, comment.anchorLine)
    : undefined;
  if (position) bundle.position = position;
  return bundle;
}

async function protocolComments(
  rows: WorktreeCommentRow[],
  worktree?: WorktreeRow,
): Promise<WorktreeComment[]> {
  if (rows.length === 0) return [];
  let worktreePromise: Promise<WorktreeRow | undefined> | undefined = worktree
    ? Promise.resolve(worktree)
    : undefined;
  const getWorktree = () =>
    (worktreePromise ??= resolveWorktreeRow(rows[0]!.worktreeId));
  const anchorLinesCache = new Map<string, Promise<string[] | undefined>>();
  return Promise.all(
    rows.map(async (row) => {
      const selectors = selectorBundleOf(row);
      return toProtocol(
        row,
        row.parentId === null && !selectors.position
          ? await selectorBundleForRead(
              row,
              selectors,
              await getWorktree(),
              anchorLinesCache,
            )
          : selectors,
      );
    }),
  );
}

/* --------------------------------- creation -------------------------------- */

let afterAnchorHeadForTests: (() => Promise<void>) | undefined;
let beforeCommentInsertForTests: (() => Promise<void>) | undefined;

/** Test hook for deterministically advancing HEAD during anchor construction. */
export function setAfterAnchorHeadForTests(
  hook: (() => Promise<void>) | undefined,
): void {
  afterAnchorHeadForTests = hook;
}

/** Test hook for deterministically exercising removal during async anchoring. */
export function setBeforeCommentInsertForTests(
  hook: (() => Promise<void>) | undefined,
): void {
  beforeCommentInsertForTests = hook;
}

export interface AddCommentInput {
  worktreeId: string;
  body: string;
  author: WorktreeCommentAuthor;
  anchor?: NewWorktreeCommentAnchor;
  parentId?: string;
  severity?: ReviewSeverity;
  reviewSetId?: string;
}

export async function addWorktreeComment(
  input: AddCommentInput,
): Promise<WorktreeComment> {
  const row = await resolveWorktreeRow(input.worktreeId);
  if (!row || row.status !== "active") throw new Error("Unknown worktree.");
  if (!input.body.trim()) throw new Error("Comment body cannot be empty.");

  // Key comments off the CANONICAL row id (spawned id, or `main:<canonical
  // projectId>`), not the possibly-aliased client-supplied id, so threads
  // resolve under the same id `worktreeList` and the review tools use.
  const worktreeId = row.id;

  let anchorFields: Partial<WorktreeCommentRow> = {};
  let affectedReviewSetId = input.reviewSetId;
  if (input.parentId) {
    const parent = getComment(input.parentId);
    if (!parent || parent.worktreeId !== worktreeId)
      throw new Error("Unknown parent comment.");
    affectedReviewSetId = parent.reviewSetId ?? undefined;
  } else {
    if (!input.anchor) throw new Error("A new comment thread needs an anchor.");
    anchorFields = await buildAnchor(row, input.anchor);
  }

  const ownership =
    !input.parentId && isMainWorktreeId(worktreeId)
      ? await captureMainCommentOwner(row, anchorFields.anchorCommit ?? null)
      : undefined;
  const now = Date.now();
  const comment: WorktreeCommentRow = {
    id: randomUUID(),
    worktreeId,
    parentId: input.parentId ?? null,
    authorKind: input.author.kind,
    authorSessionId:
      input.author.kind === "agent" ? input.author.sessionId : null,
    authorModel:
      input.author.kind === "agent" ? (input.author.model ?? null) : null,
    authorThinkingLevel:
      input.author.kind === "agent"
        ? (input.author.thinkingLevel ?? null)
        : null,
    severity: input.author.kind === "agent" ? (input.severity ?? null) : null,
    reviewSetId: input.reviewSetId ?? null,
    body: input.body.trim(),
    resolvedAt: null,
    resolvedBy: null,
    anchorPath: null,
    anchorSide: null,
    anchorLine: null,
    anchorCommit: null,
    anchorBlob: null,
    anchorDirty: null,
    anchorContextJson: null,
    anchorQuoteExact: null,
    anchorQuotePrefix: null,
    anchorQuoteSuffix: null,
    anchorPositionStart: null,
    anchorPositionEnd: null,
    anchorBlockId: null,
    anchorBlockOccurrence: null,
    currentPath: null,
    currentLine: null,
    anchorState: null,
    attachedSessionId: null,
    ownerWorktreeId: null,
    ownerBranch: null,
    ownerSource: null,
    createdAt: now,
    updatedAt: now,
    ...anchorFields,
    ...ownership,
  };
  await beforeCommentInsertForTests?.();
  insertComment(comment);
  // A ref anchor was snapshotted at an older commit, so its seeded `current`
  // position may already be stale; map it to current content immediately.
  if (input.anchor?.ref !== undefined)
    await reanchorWorktreeComments(worktreeId).catch(() => false);
  const target = {
    kind: "worktree" as const,
    worktreeId,
    path: anchorFields.anchorPath ?? "",
    side: anchorFields.anchorSide ?? ("new" as const),
    revision: anchorFields.anchorCommit ?? "",
  };
  reportCommentChanges(target, [input.parentId ?? comment.id]);
  if (affectedReviewSetId)
    reportCommentMetadataChanges(target, [affectedReviewSetId]);
  const stored = getComment(comment.id) ?? comment;
  return toProtocol(stored);
}

async function buildAnchor(
  row: WorktreeRow,
  anchor: NewWorktreeCommentAnchor,
): Promise<Partial<WorktreeCommentRow>> {
  // Ref anchors: the commented surface showed content at an older commit (e.g.
  // reviewing one of several commits an agent made). Snapshot the anchor at
  // exactly that commit; the ordinary re-anchor pass maps it forward from
  // there, so a later-rewritten line re-anchors or orphans like any other.
  if (anchor.ref !== undefined) {
    if (!isSafeRef(anchor.ref)) throw new Error("Invalid anchor revision.");
    const oidRes = await gitOptional(
      ["rev-parse", "--verify", `${anchor.ref}^{commit}`],
      row.path,
    );
    const refOid = oidRes.code === 0 ? oidRes.stdout.trim() : "";
    if (!refOid)
      throw new Error("Cannot anchor the comment: unknown revision.");

    const lines = await showLines(row, `${refOid}:${anchor.path}`);
    const context = lines ? contextAt(lines, anchor.line) : undefined;
    const selectors = lines
      ? selectorsAt(lines, anchor.line, anchor.selectors)
      : undefined;
    if (!context || !selectors)
      throw new Error(
        "Cannot anchor the comment: the line does not exist at that revision.",
      );
    const blobRes = await gitOptional(
      ["rev-parse", `${refOid}:${anchor.path}`],
      row.path,
    );

    return {
      anchorPath: anchor.path,
      anchorSide: anchor.side,
      anchorLine: anchor.line,
      anchorCommit: refOid,
      anchorBlob: blobRes.code === 0 ? blobRes.stdout.trim() : "",
      anchorDirty: false,
      anchorContextJson: JSON.stringify(context),
      ...selectorFields(selectors),
      // The initial current position is computed by the immediate re-anchor
      // below creation; seed with the anchor position as a safe default.
      currentPath: anchor.path,
      currentLine: anchor.line,
      anchorState: "anchored",
    };
  }

  const headRes = await gitOptional(
    ["rev-parse", "--verify", "HEAD"],
    row.path,
  );
  const head = headRes.code === 0 ? headRes.stdout.trim() : "";
  await afterAnchorHeadForTests?.();

  const workingSource =
    anchor.side === "new" ? readWorkingSource(row, anchor.path) : undefined;
  const lines =
    anchor.side === "new"
      ? workingSource?.lines
      : await showLines(row, `${head}:${anchor.path}`);
  const context = lines ? contextAt(lines, anchor.line) : undefined;
  const selectors = lines
    ? selectorsAt(lines, anchor.line, anchor.selectors)
    : undefined;
  if (!context || !selectors)
    throw new Error("Cannot anchor the comment: the line no longer exists.");

  let blob = "";
  let dirty = false;
  if (anchor.side === "new") {
    // `anchorBlob` is the immutable source coordinate system for dirty roots.
    // Hash the bytes already read through `containedRealPath`; never reopen a
    // path that could be swapped to an escaping symlink between validation and
    // snapshotting.
    blob = workingSource
      ? ((await hashSource(row, workingSource, true)) ?? "")
      : "";
    const headBlob = await gitOptional(
      ["rev-parse", `${head}:${anchor.path}`],
      row.path,
    );
    dirty = headBlob.code !== 0 || headBlob.stdout.trim() !== blob;
  } else {
    const headBlob = await gitOptional(
      ["rev-parse", `${head}:${anchor.path}`],
      row.path,
    );
    blob = headBlob.code === 0 ? headBlob.stdout.trim() : "";
  }

  return {
    anchorPath: anchor.path,
    anchorSide: anchor.side,
    anchorLine: anchor.line,
    anchorCommit: head,
    anchorBlob: blob,
    anchorDirty: dirty,
    anchorContextJson: JSON.stringify(context),
    ...selectorFields(selectors),
    currentPath: anchor.path,
    currentLine: anchor.line,
    anchorState: "anchored",
  };
}

/* -------------------------------- mutations -------------------------------- */

export function createWorktreeReviewSet(input: {
  worktreeId: string;
  authorSessionId: string;
  authorModel?: string;
  authorThinkingLevel?: string;
  blind: boolean;
  /**
   * A caller-owned id, for a publisher whose set identity is DERIVED rather
   * than fresh (the workflow one is its step's, so a repeated publication
   * attempt collides with its own set instead of opening a second one). The
   * table's primary key is the guard: an id already taken is rejected here.
   */
  id?: string;
}): WorktreeReviewSet {
  if (isMainWorktreeId(input.worktreeId))
    throw new Error("Review sets are not available on the main checkout.");
  if (input.id && getReviewSet(input.id))
    throw new Error("That review set id already exists.");
  const now = Date.now();
  const row: WorktreeReviewSetRow = {
    id: input.id ?? randomUUID(),
    worktreeId: input.worktreeId,
    authorSessionId: input.authorSessionId,
    authorModel: input.authorModel ?? null,
    authorThinkingLevel: input.authorThinkingLevel ?? null,
    blind: input.blind,
    verdict: null,
    summary: null,
    createdAt: now,
    updatedAt: now,
  };
  insertReviewSet(row);
  reportCommentMetadataChanges(
    {
      kind: "worktree",
      worktreeId: input.worktreeId,
      path: "",
      side: "new",
      revision: "",
    },
    [row.id],
  );
  return reviewSetToProtocol(row, listComments(input.worktreeId));
}

export function closeWorktreeReviewSet(input: {
  reviewSetId: string;
  verdict: WorktreeReviewVerdict;
  summary: string;
}): WorktreeReviewSet {
  if (!input.summary.trim()) throw new Error("Review summary cannot be empty.");
  const before = getReviewSet(input.reviewSetId);
  if (!before) throw new Error("Unknown review set.");
  closeReviewSet(input.reviewSetId, input.verdict, input.summary.trim());
  const row = getReviewSet(input.reviewSetId)!;
  reportCommentMetadataChanges(
    {
      kind: "worktree",
      worktreeId: row.worktreeId,
      path: "",
      side: "new",
      revision: "",
    },
    [row.id],
  );
  return reviewSetToProtocol(row, listComments(row.worktreeId));
}

export function listWorktreeReviewSets(
  worktreeId: string,
): WorktreeReviewSet[] {
  const comments = listComments(worktreeId);
  return listReviewSets(worktreeId).map((set) =>
    reviewSetToProtocol(set, comments),
  );
}

function reviewSetToProtocol(
  row: WorktreeReviewSetRow,
  comments: WorktreeCommentRow[],
): WorktreeReviewSet {
  const roots = comments.filter(
    (comment) => !comment.parentId && comment.reviewSetId === row.id,
  );
  const openCount = roots.filter(
    (comment) => comment.resolvedAt === null,
  ).length;
  const repliedRootIds = new Set(
    comments
      .filter(
        (comment) =>
          comment.parentId &&
          (comment.authorKind !== "agent" ||
            comment.authorSessionId !== row.authorSessionId),
      )
      .map((comment) => comment.parentId as string),
  );
  const addressedCount = roots.filter(
    (comment) => comment.resolvedAt !== null || repliedRootIds.has(comment.id),
  ).length;
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    authorSessionId: row.authorSessionId,
    ...(row.authorModel ? { authorModel: row.authorModel } : {}),
    ...(row.authorThinkingLevel
      ? { authorThinkingLevel: row.authorThinkingLevel }
      : {}),
    blind: row.blind,
    ...(row.verdict ? { verdict: row.verdict } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    openCount,
    addressedCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function reviewSetIdOf(comment: WorktreeCommentRow): string | undefined {
  if (comment.reviewSetId) return comment.reviewSetId;
  return comment.parentId
    ? (getComment(comment.parentId)?.reviewSetId ?? undefined)
    : undefined;
}

function reportReviewSetRollupChange(comment: WorktreeCommentRow): void {
  const reviewSetId = reviewSetIdOf(comment);
  if (!reviewSetId) return;
  reportCommentMetadataChanges(
    {
      kind: "worktree",
      worktreeId: comment.worktreeId,
      path: comment.anchorPath ?? "",
      side: comment.anchorSide ?? "new",
      revision: comment.anchorCommit ?? "",
    },
    [reviewSetId],
  );
}

export function resolveWorktreeComment(
  commentId: string,
  resolved: boolean,
  by: string,
): void {
  const comment = getComment(commentId);
  if (!comment) throw new Error("Unknown comment.");
  setCommentResolved(commentId, resolved ? by : null);
  reportCommentChanges(
    {
      kind: "worktree",
      worktreeId: comment.worktreeId,
      path: comment.anchorPath ?? "",
      side: comment.anchorSide ?? "new",
      revision: comment.anchorCommit ?? "",
    },
    [comment.parentId ?? comment.id],
  );
  reportReviewSetRollupChange(comment);
}

export function deleteWorktreeComment(commentId: string): void {
  const comment = getComment(commentId);
  if (!comment) return;
  deleteCommentRow(commentId);
  reportCommentChanges(
    {
      kind: "worktree",
      worktreeId: comment.worktreeId,
      path: comment.anchorPath ?? "",
      side: comment.anchorSide ?? "new",
      revision: comment.anchorCommit ?? "",
    },
    [comment.parentId ?? comment.id],
  );
  reportReviewSetRollupChange(comment);
}

export function markCommentsAttached(
  commentIds: string[],
  sessionId: string,
): void {
  const touched = new Map<string, WorktreeCommentRow[]>();
  for (const id of commentIds) {
    const comment = getComment(id);
    if (!comment) continue;
    setCommentAttachedSession(id, sessionId);
    const rows = touched.get(comment.worktreeId) ?? [];
    rows.push(comment);
    touched.set(comment.worktreeId, rows);
  }
  for (const [worktreeId, rows] of touched) {
    const first = rows[0]!;
    reportCommentChanges(
      {
        kind: "worktree",
        worktreeId,
        path: first.anchorPath ?? "",
        side: first.anchorSide ?? "new",
        revision: first.anchorCommit ?? "",
      },
      rows.map((row) => row.parentId ?? row.id),
    );
  }
}

/* --------------------------------- listing --------------------------------- */

export async function listWorktreeComments(
  worktreeId: string,
): Promise<WorktreeComment[]> {
  // Lazy guard: if HEAD moved since the last pass (missed watcher event,
  // server restart), re-anchor before serving.
  const row = await resolveWorktreeRow(worktreeId);
  if (row && row.status === "active") {
    const headRes = await gitOptional(
      ["rev-parse", "--verify", "HEAD"],
      row.path,
    );
    const head = headRes.code === 0 ? headRes.stdout.trim() : "";
    if (head && lastReanchorHead.get(worktreeId) !== head) {
      await reanchorWorktreeComments(worktreeId).catch(() => false);
    }
  }
  return protocolComments(listComments(worktreeId), row);
}

export function broadcastComments(
  worktreeId: string,
  touchedThreadIds: readonly string[],
  touchedReviewSetIds: readonly string[] = [],
): Promise<void> {
  const roots = listComments(worktreeId).filter((comment) => !comment.parentId);
  const first = roots[0];
  const target = {
    kind: "worktree" as const,
    worktreeId,
    path: first?.anchorPath ?? "",
    side: first?.anchorSide ?? ("new" as const),
    revision: first?.anchorCommit ?? "",
  };
  reportCommentChanges(target, touchedThreadIds);
  if (touchedReviewSetIds.length)
    reportCommentMetadataChanges(target, touchedReviewSetIds);
  return Promise.resolve();
}

/** Purge main-checkout threads whose persisted subject is this branch. */
export function purgeMainCommentsForBranchSubject(
  row: WorktreeRow,
  reason: "merged" | "branch-deleted",
): number {
  const worktreeId = mainWorktreeId(row.projectId);
  try {
    const deletion = deleteMainCommentsForBranchSubject(worktreeId, row.id);
    if (deletion.deletedComments === 0) return 0;
    void broadcastComments(worktreeId, deletion.rootIds);
    console.info(
      `[worktrees] main-checkout branch-subject purge deleted ${deletion.deletedComments} comment(s) in ${deletion.rootIds.length} root thread(s) for ${worktreeId}: reason=${reason} branch=${row.branch}.`,
    );
    return deletion.deletedComments;
  } catch (error) {
    console.warn(
      `[worktrees] main-checkout branch-subject purge failed for ${worktreeId}; delivery continues: reason=${reason} branch=${row.branch}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}

export interface MainCommentRetentionResult {
  checkedWorktrees: number;
  purgedRoots: number;
  purgedComments: number;
  failedWorktrees: number;
}

let mainCommentRetentionSweep: Promise<MainCommentRetentionResult> | undefined;

/**
 * Re-anchor synthetic-main roots, then purge only roots that are both orphaned
 * and resolved past the fixed retention window. This is server maintenance,
 * invoked at boot and by the existing daily retention pass, never by listing.
 */
export function sweepMainWorktreeCommentRetention(
  now = Date.now(),
): Promise<MainCommentRetentionResult> {
  if (mainCommentRetentionSweep) return mainCommentRetentionSweep;
  const sweep = runMainWorktreeCommentRetention(now).finally(() => {
    if (mainCommentRetentionSweep === sweep)
      mainCommentRetentionSweep = undefined;
  });
  mainCommentRetentionSweep = sweep;
  return sweep;
}

async function runMainWorktreeCommentRetention(
  now: number,
): Promise<MainCommentRetentionResult> {
  const worktreeIds = listMainWorktreeIdsWithComments();
  const result: MainCommentRetentionResult = {
    checkedWorktrees: 0,
    purgedRoots: 0,
    purgedComments: 0,
    failedWorktrees: 0,
  };
  const cutoff = now - MAIN_COMMENT_RETENTION_MS;

  for (const worktreeId of worktreeIds) {
    try {
      // A missing/aliased synthetic row cannot be refreshed safely. Keep its
      // comments rather than trusting a historical orphan verdict.
      const row = await resolveWorktreeRow(worktreeId);
      if (!row || row.status !== "active" || row.id !== worktreeId) continue;
      const reanchored = await reanchorWorktreeCommentPass(worktreeId);
      result.checkedWorktrees += 1;

      // No await between the fresh pass and this synchronous transaction: an
      // app-side mutation cannot interleave and make the verdict stale. Roots
      // lacking enough anchor data to evaluate are excluded explicitly.
      const deletion = deleteExpiredResolvedOrphanedMainComments(
        worktreeId,
        cutoff,
        reanchored.evaluatedRootIds,
      );
      const touchedThreadIds = [
        ...new Set([...reanchored.changedRootIds, ...deletion.rootIds]),
      ];
      if (deletion.deletedComments > 0) {
        result.purgedRoots += deletion.rootIds.length;
        result.purgedComments += deletion.deletedComments;
        console.info(
          `[worktrees] main-checkout comment retention purged ${deletion.deletedComments} comment(s) in ${deletion.rootIds.length} root thread(s) for ${worktreeId}: orphaned-and-resolved-for-${MAIN_COMMENT_RETENTION_DAYS}-days=${deletion.deletedComments}.`,
        );
      }
      if (touchedThreadIds.length)
        await broadcastComments(worktreeId, touchedThreadIds);
    } catch (error) {
      result.failedWorktrees += 1;
      console.warn(
        `[worktrees] main-checkout comment retention skipped ${worktreeId}; will retry later: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

function toProtocol(
  row: WorktreeCommentRow,
  selectors = selectorBundleOf(row),
): WorktreeComment {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    ...(row.parentId ? { parentId: row.parentId } : {}),
    author:
      row.authorKind === "agent"
        ? {
            kind: "agent",
            sessionId: row.authorSessionId ?? "",
            ...(row.authorModel ? { model: row.authorModel } : {}),
            ...(row.authorThinkingLevel
              ? { thinkingLevel: row.authorThinkingLevel }
              : {}),
          }
        : { kind: "user" },
    body: row.body,
    ...(row.severity ? { severity: row.severity } : {}),
    ...(row.reviewSetId ? { reviewSetId: row.reviewSetId } : {}),
    ...(row.resolvedAt !== null ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.resolvedBy !== null ? { resolvedBy: row.resolvedBy } : {}),
    ...(row.anchorPath !== null && row.anchorLine !== null
      ? {
          anchor: {
            path: row.anchorPath,
            side: row.anchorSide ?? "new",
            line: row.anchorLine,
            commit: row.anchorCommit ?? "",
            dirty: row.anchorDirty ?? false,
            selectors,
          },
        }
      : {}),
    ...(row.currentPath !== null && row.currentLine !== null
      ? { current: { path: row.currentPath, line: row.currentLine } }
      : {}),
    ...(row.anchorState !== null ? { anchorState: row.anchorState } : {}),
    ...(row.attachedSessionId !== null
      ? { attachedSessionId: row.attachedSessionId }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------- re-anchoring ------------------------------ */

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of diff.split("\n")) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    hunks.push({
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

/** Map an old-side line through hunk offsets; undefined = inside a rewritten hunk. */
function mapLineThroughHunks(line: number, hunks: Hunk[]): number | undefined {
  let delta = 0;
  for (const hunk of hunks) {
    // Zero-length old ranges (pure insertions) start "after" oldStart.
    const oldStart = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    if (line < oldStart) break;
    if (hunk.oldLines > 0 && line < hunk.oldStart + hunk.oldLines)
      return undefined;
    delta += hunk.newLines - hunk.oldLines;
  }
  return line + delta;
}

interface ReanchorPassResult {
  changed: boolean;
  changedRootIds: string[];
  /** Roots for which this pass had enough immutable anchor data to evaluate. */
  evaluatedRootIds: string[];
}

/** Re-anchor all thread roots of a worktree; returns true when anything changed. */
export async function reanchorWorktreeComments(
  worktreeId: string,
): Promise<boolean> {
  return (await reanchorWorktreeCommentPass(worktreeId)).changed;
}

async function reanchorWorktreeCommentPass(
  worktreeId: string,
): Promise<ReanchorPassResult> {
  const row = await resolveWorktreeRow(worktreeId);
  if (!row || row.status !== "active")
    return { changed: false, changedRootIds: [], evaluatedRootIds: [] };
  const headRes = await gitOptional(
    ["rev-parse", "--verify", "HEAD"],
    row.path,
  );
  const head = headRes.code === 0 ? headRes.stdout.trim() : "";
  if (head) lastReanchorHead.set(worktreeId, head);

  const roots = listComments(worktreeId).filter(
    (comment) => comment.parentId === null && comment.anchorPath !== null,
  );
  if (roots.length === 0)
    return { changed: false, changedRootIds: [], evaluatedRootIds: [] };

  // Rename pass: map anchor paths that were renamed since their anchor commit.
  const renames = new Map<string, Map<string, string>>(); // anchorCommit → old path → new path
  for (const commit of new Set(
    roots
      .map((comment) => comment.anchorCommit)
      .filter((value): value is string => Boolean(value)),
  )) {
    const res = await gitOptional(
      ["diff", "--find-renames", "--name-status", commit],
      row.path,
    );
    if (res.code !== 0) continue;
    const map = new Map<string, string>();
    for (const line of res.stdout.split("\n")) {
      const [code, a, b] = line.split("\t");
      if (code?.startsWith("R") && a && b) map.set(a, b);
    }
    renames.set(commit, map);
  }

  let changed = false;
  const changedRootIds: string[] = [];
  const evaluatedRootIds: string[] = [];
  const workingSourceCache = new Map<string, WorkingSource | undefined>();
  const hunksCache = new Map<string, Hunk[] | undefined>();

  for (const comment of roots) {
    const anchorCommit = comment.anchorCommit ?? "";
    const anchorLine = comment.anchorLine ?? 0;
    if (!anchorCommit || !anchorLine) continue;
    const bundle = selectorBundleOf(comment);

    // "old"-side anchors pin base content: orphan only when the base is gone.
    if (comment.anchorSide === "old") {
      const exists = await gitOptional(
        ["cat-file", "-e", `${anchorCommit}:${comment.anchorPath}`],
        row.path,
      );
      const state = exists.code === 0 ? "anchored" : "orphaned";
      evaluatedRootIds.push(comment.id);
      if (state !== comment.anchorState) {
        updateCommentAnchor(comment.id, {
          currentPath: state === "orphaned" ? null : comment.anchorPath,
          currentLine: state === "orphaned" ? null : anchorLine,
          anchorState: state,
        });
        changed = true;
        changedRootIds.push(comment.id);
      }
      continue;
    }

    const path =
      renames.get(anchorCommit)?.get(comment.anchorPath!) ??
      comment.anchorPath!;
    const dirtySource =
      comment.anchorDirty && comment.anchorBlob
        ? comment.anchorBlob
        : undefined;
    if (!workingSourceCache.has(path))
      workingSourceCache.set(path, readWorkingSource(row, path));
    const workingSource = workingSourceCache.get(path);
    const cacheKey = `${dirtySource ?? `${anchorCommit}:${comment.anchorPath}`}->${path}`;
    if (!hunksCache.has(cacheKey)) {
      let hunks: Hunk[] | undefined;
      if (dirtySource && workingSource) {
        // A dirty root's line and position belong to its snapshotted blob, not
        // anchorCommit. Diff blob-to-blob so the hunk map shares that coordinate
        // system without creating a temporary file. Hash the bytes already read
        // through `containedRealPath` so an escaping symlink is never reopened.
        // Pre-migration dirty oids were not written; do not write the current
        // blob unless the immutable source actually exists for a structural diff.
        const sourceExists = await gitOptional(
          ["cat-file", "-e", dirtySource],
          row.path,
        );
        if (sourceExists.code === 0) {
          const workingBlob = await hashSource(row, workingSource, true);
          if (workingBlob) {
            const res = await gitOptional(
              ["diff", "--no-color", "-U0", dirtySource, workingBlob],
              row.path,
            );
            if (res.code === 0) hunks = parseHunks(res.stdout);
          }
        }
      } else if (!dirtySource) {
        // For renamed anchors, diff BOTH paths with rename detection so git pairs
        // them into a modification diff — diffing only the new path would show a
        // full add and map every anchor line off the end of the file.
        const paths =
          path === comment.anchorPath ? [path] : [comment.anchorPath!, path];
        const res = await gitOptional(
          [
            "diff",
            "--no-color",
            "-U0",
            "--find-renames",
            anchorCommit,
            "--",
            ...paths,
          ],
          row.path,
        );
        if (res.code === 0) hunks = parseHunks(res.stdout);
      }
      hunksCache.set(cacheKey, hunks);
    }
    const lines = workingSource?.lines;
    const hunks = hunksCache.get(cacheKey);

    let nextLine: number | undefined;
    let resolvedState: "anchored" | "moved" | undefined;
    if (lines) {
      const mapped = hunks ? mapLineThroughHunks(anchorLine, hunks) : undefined;
      if (!bundle.quote.exact) {
        // The shared resolver deliberately refuses an empty quote. A blank-line
        // gutter anchor still has a meaningful structural identity, so keep the
        // hunk map as its only resolution step rather than freezing its old line.
        // Without that projection (notably an unwritten legacy dirty blob), no
        // honest fresh verdict is possible: preserve the prior state/retention age.
        if (!hunks) continue;
        if (mapped !== undefined && lines[mapped - 1] === "") {
          nextLine = mapped;
          const mappedPosition = lineSpan(lines, mapped);
          resolvedState =
            bundle.position && mappedPosition
              ? bundle.position.start === mappedPosition.start
                ? "anchored"
                : "moved"
              : mapped === anchorLine
                ? "anchored"
                : "moved";
        }
      } else {
        const mappedSpan =
          mapped === undefined ? undefined : lineSpan(lines, mapped);
        const blockRanges =
          mappedSpan && bundle.block
            ? new Map([[bundle.block.id, mappedSpan]])
            : undefined;
        // Position belongs to immutable source content and must not beat the
        // stronger hunk-mapped block. The resolver still sees it for accurate
        // anchored/moved state and candidate tie-breaking after that first rung.
        const resolution = resolveAnchor(bundle, lines.join("\n"), {
          ...(blockRanges !== undefined ? { blockRanges } : {}),
          skipPositionStep: true,
        });
        nextLine = resolution.line?.start;
        resolvedState = bundle.position
          ? resolution.state === "anchored"
            ? "anchored"
            : resolution.state === "moved"
              ? "moved"
              : undefined
          : nextLine === anchorLine
            ? "anchored"
            : "moved";
      }
    }

    evaluatedRootIds.push(comment.id);
    const nextState =
      nextLine === undefined
        ? "orphaned"
        : path !== comment.anchorPath
          ? "moved"
          : (resolvedState ?? "moved");
    const nextPath = nextLine === undefined ? null : path;
    if (
      nextState !== comment.anchorState ||
      nextPath !== comment.currentPath ||
      (nextLine ?? null) !== comment.currentLine
    ) {
      updateCommentAnchor(comment.id, {
        currentPath: nextPath,
        currentLine: nextLine ?? null,
        anchorState: nextState,
      });
      changed = true;
      changedRootIds.push(comment.id);
    }
  }
  return { changed, changedRootIds, evaluatedRootIds };
}

/* ----------------------------- session handoff ----------------------------- */

// The handoff prompt itself lives in `reviewHandoff.ts`: the browser and the
// workflow fixer path share one rendering of a selected thread set.
