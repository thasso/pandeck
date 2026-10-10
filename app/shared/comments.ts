/**
 * The comment anchor vocabulary shared by every commentable surface (KB entries,
 * worktree diffs, session transcripts) — see `docs/comments.md`.
 *
 * A comment names a target plus a BUNDLE of redundant selectors, tried in order
 * of precision when the comment is read back. Line numbers are deliberately
 * absent from the stored model: they are the most volatile coordinate in a
 * document, so they are DERIVED at read time (`ResolvedAnchor.line`) for display
 * and agent handoff only.
 *
 * NORMALIZATION CONTRACT: `normalizeAnchorText` exists for COMPARISON only.
 * Stored selectors keep the original text, and every offset in this model —
 * `PositionSelector`, `BlockSelector` ranges, the resolver's result — is a
 * character offset into the RAW document text. Normalizing what is stored, or
 * reporting an offset into normalized text, is the classic bug here.
 */

/** Per-connection bound shared by the server LRU and reconnect replay. */
export const MAX_OPEN_COMMENT_TARGETS = 64;

/** What a comment is attached to; the selectors below are relative to it. */
export type CommentTarget =
  | {
      kind: "worktree";
      worktreeId: string;
      path: string;
      side: "old" | "new";
      revision: string;
    }
  | { kind: "session"; sessionId: string; entryId: string; blockIndex: number };

/** The durable selector: the quoted text plus the raw text around it. */
export interface QuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
}

/** Character offsets into the raw document text; `end` is exclusive. */
export interface PositionSelector {
  start: number;
  end: number;
}

/** Optional structural hint, defined per domain (markdown block, diff line). */
export interface BlockSelector {
  id: string;
  /** Optional end of a structural range (for example a multi-line KB selection). */
  endId?: string;
  occurrence: number;
}

export interface SelectorBundle {
  /** REQUIRED — the durable selector, always stored. */
  quote: QuoteSelector;
  /** Fast path: where the quote was when the comment was made. */
  position?: PositionSelector;
  /** chat: entry+block; diff: line; KB: omitted (the heading serves). */
  block?: BlockSelector;
}

export type AnchorState = "anchored" | "moved" | "orphaned";

export interface ResolvedAnchor {
  state: AnchorState;
  /** Absent iff orphaned. Offsets into the raw document text. */
  position?: PositionSelector;
  /** 1-based, DERIVED from `position` — never stored. */
  line?: { start: number; end: number };
  /** 0..1, for diagnostics only — never branched on by UI. */
  confidence: number;
}

/** One author shape on every server-backed comment surface. */
export interface CommentAuthor {
  kind: "user" | "agent" | "system";
  name: string;
  /** Originating agent session, when the author is an agent. */
  sessionId?: string;
  /** Agent runtime snapshots captured when this comment was written. */
  model?: string;
  thinkingLevel?: string;
}

export type ReviewSeverity = "critical" | "major" | "minor" | "nit";
export type WorktreeReviewVerdict =
  "approve" | "approve-with-fixes" | "request-changes" | "reject";

/** One durable agent review and its rollup over member thread roots. */
export interface WorktreeReviewSet {
  id: string;
  worktreeId: string;
  authorSessionId: string;
  authorModel?: string;
  authorThinkingLevel?: string;
  blind: boolean;
  /** Absent while the review is in progress. */
  verdict?: WorktreeReviewVerdict;
  summary?: string;
  openCount: number;
  addressedCount: number;
  createdAt: number;
  updatedAt: number;
}

/** A root comment or reply in the shared thread projection. */
export interface CommentItem {
  id: string;
  author: CommentAuthor;
  body: string;
  parentId?: string;
  createdAt: number;
  editedAt?: number;
}

/** Display coordinates are a projection, never the persisted anchor identity. */
export interface CommentLocation {
  path?: string;
  lineStart: number;
  lineEnd: number;
  heading?: string;
}

/** One wire shape for KB and worktree comments. */
export interface CommentThread {
  id: string;
  target: CommentTarget;
  status: "open" | "resolved";
  root: CommentItem;
  replies: CommentItem[];
  /** Worktree-only review metadata; absent on human and other-domain threads. */
  severity?: ReviewSeverity;
  reviewSetId?: string;
  selectors?: SelectorBundle;
  anchorState?: AnchorState;
  original?: CommentLocation;
  current?: CommentLocation;
  resolvedAt?: number;
  resolvedBy?: CommentAuthor;
  resolutionReason?: string;
  /** Sessions this thread has explicitly been handed to, oldest first. */
  handoffSessionIds: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * The object a comment failure belongs to: the thing the thread is ON, never the
 * comment or the thread.
 *
 * A comment is not an object the user can navigate to — it is drawn by whatever
 * renders the entry, the diff or the transcript it hangs off — so that
 * host is the only surface that can report the failure in place
 * (`docs/messaging.md`). One function, so the server sites that raise those
 * failures cannot disagree about which object they were about.
 */
export function messageTargetForComment(target: CommentTarget): {
  type: "worktree" | "session";
  id: string;
} {
  switch (target.kind) {
    case "worktree":
      return { type: "worktree", id: target.worktreeId };
    case "session":
      return { type: "session", id: target.sessionId };
  }
}

/** Stable key for the per-object comment projection. */
export function commentTargetKey(target: CommentTarget): string {
  switch (target.kind) {
    case "worktree":
      return `worktree:${target.worktreeId}`;
    case "session":
      return `session:${target.sessionId}:${target.entryId}:${target.blockIndex}`;
  }
}

/**
 * Context captured on each side of the quote. The describer and the resolver
 * must agree on this, so both import it from here.
 */
export const PREFIX_LEN = 32;
export const SUFFIX_LEN = 32;

/**
 * Collapse whitespace runs and trim, for COMPARISON only — never for storage
 * and never as the text offsets are measured against (see the module header).
 */
export function normalizeAnchorText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
