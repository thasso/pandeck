/**
 * Review-comment tools for agents working inside a worktree: author review sets
 * and anchored findings, read current threads, reply, and resolve them.
 * The worktree is resolved from the calling session's `in_worktree` edge — the
 * tools only work for sessions that execute inside a worktree.
 */
import {
  defineAgentTool,
  jsonResult,
  type ToolSession,
} from "../../mcp/tool.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import {
  getComment,
  getReviewSet,
  listReviewSets,
  worktreeIdForSession,
} from "../../db/worktreeStore.ts";
import {
  addWorktreeComment,
  closeWorktreeReviewSet,
  createWorktreeReviewSet,
  listWorktreeComments,
  listWorktreeReviewSets,
  resolveWorktreeComment,
} from "../../worktrees/worktreeComments.ts";

function requireWorktreeId(session: ToolSession): string {
  const worktreeId = worktreeIdForSession(session.sessionId);
  if (!worktreeId)
    throw new Error(
      "This session does not run inside a worktree, so there are no review comments.",
    );
  return worktreeId;
}

const listSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    includeResolved: { type: "boolean", default: false },
  },
} as const;

const reviewCommentsList = defineAgentTool<{ includeResolved?: boolean }>({
  name: "review_comments_list",
  label: "List review comments",
  description:
    "The review comment threads on this worktree with their current file:line anchors; read before replying or resolving.",
  parameters: listSchema as unknown as Record<string, unknown>,
  async execute(params, ctx) {
    const worktreeId = requireWorktreeId(ctx.session);
    const comments = await listWorktreeComments(worktreeId);
    const sets = listReviewSets(worktreeId);
    const ownOpenBlind = sets.some(
      (set) =>
        set.blind &&
        set.verdict === null &&
        set.authorSessionId === ctx.session.sessionId,
    );
    const blindRoundOpen = sets.some(
      (set) => set.blind && set.verdict === null,
    );
    const visibleSetIds = new Set(
      sets
        .filter((set) =>
          ownOpenBlind
            ? set.authorSessionId === ctx.session.sessionId
            : set.authorSessionId === ctx.session.sessionId ||
              !set.blind ||
              !blindRoundOpen,
        )
        .map((set) => set.id),
    );
    const roots = comments.filter(
      (comment) =>
        !comment.parentId &&
        (params.includeResolved || comment.resolvedAt === undefined) &&
        (ownOpenBlind
          ? comment.author.kind === "agent" &&
            comment.author.sessionId === ctx.session.sessionId
          : !comment.reviewSetId || visibleSetIds.has(comment.reviewSetId)),
    );
    const threads = roots.map((root) => ({
      id: root.id,
      location: root.current
        ? `${root.current.path}:${root.current.line}`
        : `${root.anchor?.path ?? "?"} (orphaned)`,
      anchorState: root.anchorState,
      resolved: root.resolvedAt !== undefined,
      body: root.body,
      ...(root.severity ? { severity: root.severity } : {}),
      ...(root.reviewSetId ? { reviewSetId: root.reviewSetId } : {}),
      author: root.author,
      replies: comments
        .filter((comment) => comment.parentId === root.id)
        .map((reply) => ({ author: reply.author, body: reply.body })),
    }));
    const reviewSets = listWorktreeReviewSets(worktreeId).filter((set) =>
      visibleSetIds.has(set.id),
    );
    return jsonResult({ worktreeId, reviewSets, threads });
  },
});

const replySchema = {
  type: "object",
  additionalProperties: false,
  required: ["commentId", "text"],
  properties: {
    commentId: { type: "string", description: "Thread root id." },
    text: {
      type: "string",
      description: "What you changed, or why you disagree.",
    },
  },
} as const;

const reviewCommentReply = defineAgentTool<{ commentId: string; text: string }>(
  {
    name: "review_comment_reply",
    label: "Reply to review comment",
    description:
      "Reply on a review comment thread (e.g. describe the change you made in response).",
    parameters: replySchema as unknown as Record<string, unknown>,
    async execute(params, ctx) {
      const worktreeId = requireWorktreeId(ctx.session);
      const root = getComment(params.commentId);
      if (!root || root.worktreeId !== worktreeId)
        throw new Error("Unknown comment id for this worktree.");
      const session = sessionStore.get(ctx.session.sessionId);
      const reply = await addWorktreeComment({
        worktreeId,
        body: params.text,
        parentId: root.parentId ?? params.commentId,
        author: {
          kind: "agent",
          sessionId: ctx.session.sessionId,
          ...(session?.model ? { model: session.model } : {}),
          ...(session?.thinkingLevel
            ? { thinkingLevel: session.thinkingLevel }
            : {}),
        },
      });
      return jsonResult({ ok: true, replyId: reply.id });
    },
  },
);

const resolveSchema = {
  type: "object",
  additionalProperties: false,
  required: ["commentId", "resolved"],
  properties: {
    commentId: { type: "string", description: "Thread root id." },
    resolved: { type: "boolean", description: "false reopens the thread." },
  },
} as const;

const reviewCommentResolve = defineAgentTool<{
  commentId: string;
  resolved: boolean;
}>({
  name: "review_comment_resolve",
  label: "Resolve review comment",
  description:
    "Mark a review comment thread resolved after addressing it (or reopen it).",
  parameters: resolveSchema as unknown as Record<string, unknown>,
  async execute(params, ctx) {
    const worktreeId = requireWorktreeId(ctx.session);
    const root = getComment(params.commentId);
    if (!root || root.worktreeId !== worktreeId)
      throw new Error("Unknown comment id for this worktree.");
    resolveWorktreeComment(
      params.commentId,
      params.resolved,
      ctx.session.sessionId,
    );
    return jsonResult({ ok: true });
  },
});

const createSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "line", "body", "severity"],
  properties: {
    path: {
      type: "string",
      description: "Repository-relative file path for the finding.",
    },
    line: {
      type: "integer",
      minimum: 1,
      description: "Required 1-based line anchor in the current file.",
    },
    body: {
      type: "string",
      description: "One finding only; open another thread for another finding.",
    },
    severity: {
      type: "string",
      enum: ["critical", "major", "minor", "nit"],
      description: "Required severity for this agent-authored finding.",
    },
    reviewSetId: {
      type: "string",
      description:
        "Open review set that groups this finding; defaults to this session's open blind set.",
    },
  },
} as const;

const reviewCommentCreate = defineAgentTool<{
  path: string;
  line: number;
  body: string;
  severity: "critical" | "major" | "minor" | "nit";
  reviewSetId?: string;
}>({
  name: "review_comment_create",
  label: "Create review comment",
  description:
    "Create one durable, human-visible finding on this worktree. One finding per thread; a file:line anchor and severity are required for agent authors.",
  parameters: createSchema as unknown as Record<string, unknown>,
  async execute(params, ctx) {
    const worktreeId = requireWorktreeId(ctx.session);
    const reviewSetId =
      params.reviewSetId ??
      listReviewSets(worktreeId).find(
        (set) =>
          set.blind &&
          set.verdict === null &&
          set.authorSessionId === ctx.session.sessionId,
      )?.id;
    if (reviewSetId) {
      const set = getReviewSet(reviewSetId);
      if (
        !set ||
        set.worktreeId !== worktreeId ||
        set.authorSessionId !== ctx.session.sessionId
      )
        throw new Error("Unknown review set for this session and worktree.");
      if (set.verdict !== null)
        throw new Error("Review set is already closed.");
    }
    const session = sessionStore.get(ctx.session.sessionId);
    const comment = await addWorktreeComment({
      worktreeId,
      body: params.body,
      author: {
        kind: "agent",
        sessionId: ctx.session.sessionId,
        ...(session?.model ? { model: session.model } : {}),
        ...(session?.thinkingLevel
          ? { thinkingLevel: session.thinkingLevel }
          : {}),
      },
      anchor: { path: params.path, side: "new", line: params.line },
      severity: params.severity,
      ...(reviewSetId ? { reviewSetId } : {}),
    });
    return jsonResult({ ok: true, commentId: comment.id });
  },
});

const openSetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    blind: {
      type: "boolean",
      default: false,
      description:
        "Hide this round's reviewers from one another until every blind set is closed.",
    },
  },
} as const;

const reviewSetOpen = defineAgentTool<{ blind?: boolean }>({
  name: "review_set_open",
  label: "Open review set",
  description:
    "Open the durable set for one review. A set left open is visible as in progress. Use blind only when direct authoring must enforce parallel-review discovery blindness.",
  parameters: openSetSchema as unknown as Record<string, unknown>,
  async execute(params, ctx) {
    const worktreeId = requireWorktreeId(ctx.session);
    const duplicate = listReviewSets(worktreeId).find(
      (set) =>
        set.authorSessionId === ctx.session.sessionId && set.verdict === null,
    );
    if (duplicate)
      throw new Error("This session already has an open review set.");
    const session = sessionStore.get(ctx.session.sessionId);
    const set = createWorktreeReviewSet({
      worktreeId,
      authorSessionId: ctx.session.sessionId,
      ...(session?.model ? { authorModel: session.model } : {}),
      ...(session?.thinkingLevel
        ? { authorThinkingLevel: session.thinkingLevel }
        : {}),
      blind: params.blind ?? false,
    });
    return jsonResult({ reviewSetId: set.id });
  },
});

const closeSetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reviewSetId", "verdict", "summary"],
  properties: {
    reviewSetId: { type: "string", description: "Open review set id." },
    verdict: {
      type: "string",
      enum: ["approve", "approve-with-fixes", "request-changes", "reject"],
    },
    summary: { type: "string", description: "Bounded review summary." },
  },
} as const;

const reviewSetClose = defineAgentTool<{
  reviewSetId: string;
  verdict: "approve" | "approve-with-fixes" | "request-changes" | "reject";
  summary: string;
}>({
  name: "review_set_close",
  label: "Close review set",
  description:
    "Publish this session's completed review set with its required verdict and summary.",
  parameters: closeSetSchema as unknown as Record<string, unknown>,
  async execute(params, ctx) {
    const worktreeId = requireWorktreeId(ctx.session);
    const set = getReviewSet(params.reviewSetId);
    if (
      !set ||
      set.worktreeId !== worktreeId ||
      set.authorSessionId !== ctx.session.sessionId
    )
      throw new Error("Unknown review set for this session and worktree.");
    const closed = closeWorktreeReviewSet({
      reviewSetId: params.reviewSetId,
      verdict: params.verdict,
      summary: params.summary,
    });
    return jsonResult({ ok: true, reviewSet: closed });
  },
});

export const worktreeReviewFixTools = [
  reviewCommentsList,
  reviewCommentReply,
  reviewCommentResolve,
];
export const worktreeReviewAuthorTools = [
  reviewCommentCreate,
  reviewSetOpen,
  reviewSetClose,
];

// Keep the original three first: older integrations and focused tests address
// that stable trio positionally.
export const worktreeReviewTools = [
  ...worktreeReviewFixTools,
  ...worktreeReviewAuthorTools,
];
