/**
 * Forgejo PR write tools (coding personas only, gate `forgejo`): approval-gated
 * pull-request creation, description edits, reviews, and comments against a self-hosted
 * Gitea-compatible instance. Same contract as the GitHub twins in
 * `../github/githubPrWriteTools.ts` — these NEVER write during the model turn:
 * each stages a PENDING approval via the shared `../../pendingApprovals.ts`
 * subsystem and returns a bounded summary; the write executes server-side only
 * after the user approves the card.
 *
 * Repository resolution is `resolveForgejoRepo` from the read module
 * `./forgejoTools.ts`, as the GitHub twin takes `resolveRepo` from its own.
 *
 * Forgejo's API is close to GitHub's but not identical, and the three
 * differences all live in the executor:
 *
 *  - `CreatePullRequestOption` has no `draft` field — a draft is the `WIP: `
 *    title prefix;
 *  - `CreatePullReviewComment` anchors with `new_position`/`old_position`, not
 *    `line` + `side`;
 *  - a review `event` is a `ReviewStateType` (`APPROVED` / `COMMENT` /
 *    `REQUEST_CHANGES`), not GitHub's `APPROVE` / `CHANGES_REQUESTED`.
 */
import { defineAgentTool } from "../../mcp/tool.ts";
import { getForgejoToolConfig } from "../../forgejoSettings.ts";
import { forgejoRequest } from "../../forgejoClient.ts";
import { forgejoProvider } from "../../gitHosting.ts";
import { invalidateForgejoPullRequestWrite } from "../../pullRequestInventorySync.ts";
import { resolveForgejoRepo } from "./forgejoTools.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import type {
  ApprovalCard,
  ForgejoPrInlineCommentDisplay,
  ForgejoPrReviewEvent,
  ForgejoPullRequestApprovalBody,
} from "@assistant/shared";

type CreatePullRequestParams = {
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
};
type EditPullRequestParams = {
  repo: string;
  number: number;
  body: string;
};
type ReadyPullRequestParams = { repo: string; number: number };
type ReviewPullRequestParams = {
  repo: string;
  number: number;
  event: ForgejoPrReviewEvent;
  summary?: string;
  comments?: ForgejoPrInlineCommentDisplay[];
};
type CommentPullRequestParams = {
  repo: string;
  number: number;
  body: string;
  replyToReviewId?: number;
  replyPath?: string;
  replyLine?: number;
  replySide?: "LEFT" | "RIGHT";
};

const PENDING_NOTE =
  "Do not claim it succeeded until the approved result appears.";

/** Forgejo's default work-in-progress title prefix (there is no draft flag). */
const WIP_PREFIX = "WIP: ";

export const forgejoCreatePullRequestTool =
  defineAgentTool<CreatePullRequestParams>({
    name: "forgejo_create_pull_request",
    label: "Forgejo: Create Pull Request",
    description:
      "Prepare a Forgejo pull request for the user to approve. This never writes immediately: it stages a pending approval card; the PR is opened only after the user approves.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "title", "head", "base"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        title: { type: "string", description: "Pull request title." },
        head: {
          type: "string",
          description: "Head branch (the branch with the changes).",
        },
        base: {
          type: "string",
          description: "Base branch to merge into, e.g. main.",
        },
        body: {
          type: "string",
          description: "Pull request description (Markdown).",
        },
        draft: {
          type: "boolean",
          description:
            "Open as a work-in-progress PR. Forgejo has no draft flag, so this prefixes the title with 'WIP: '. Defaults to false.",
        },
      },
    },
    async execute(params, ctx) {
      getForgejoToolConfig();
      const { owner, repo } = resolveForgejoRepo(params.repo);
      const title = params.title.trim();
      const head = params.head.trim();
      const base = params.base.trim();
      if (!title)
        throw new Error("title must be a non-empty pull-request title.");
      if (!head || !base)
        throw new Error("head and base branches are required.");
      const prBodyValue = params.body?.trim() || undefined;
      const body: ForgejoPullRequestApprovalBody = {
        kind: "forgejoPullRequest",
        operation: "create",
        repo: `${owner}/${repo}`,
        title,
        head,
        base,
        ...(prBodyValue !== undefined ? { prBody: prBodyValue } : {}),
        draft: params.draft === true,
      };
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind: "forgejoPullRequest",
        title: "Create pull request",
        summary: `${owner}/${repo}: ${head} → ${base}`,
        sourceToolCallId: ctx.toolCallId,
        body,
      });
      return {
        content: [
          {
            type: "text",
            text: `Prepared a pull-request proposal (${owner}/${repo}: ${head} → ${base}) pending your approval. ${PENDING_NOTE} ${approvalCardReference(card)}`,
          },
        ],
        terminate: true,
      };
    },
  });

export const forgejoEditPullRequestTool =
  defineAgentTool<EditPullRequestParams>({
    name: "forgejo_edit_pull_request",
    label: "Forgejo: Edit Pull Request Description",
    description:
      "Prepare a replacement description for an existing Forgejo pull request. An empty body clears the description. Never writes until the user approves the proposal.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number", "body"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        number: { type: "number", description: "Pull-request index/number." },
        body: {
          type: "string",
          description:
            "Complete replacement description (Markdown); use an empty string to clear it.",
        },
      },
    },
    async execute(params, ctx) {
      getForgejoToolConfig();
      const { owner, repo } = resolveForgejoRepo(params.repo);
      if (!Number.isInteger(params.number) || params.number < 1)
        throw new Error("number must be a valid pull-request number.");
      const body: ForgejoPullRequestApprovalBody = {
        kind: "forgejoPullRequest",
        operation: "edit",
        repo: `${owner}/${repo}`,
        pullNumber: params.number,
        prBody: params.body,
      };
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind: "forgejoPullRequest",
        title: "Edit pull request description",
        summary: `${owner}/${repo}#${params.number}`,
        sourceToolCallId: ctx.toolCallId,
        body,
      });
      return {
        content: [
          {
            type: "text",
            text: `Prepared a description edit for ${owner}/${repo}#${params.number} pending your approval. ${PENDING_NOTE} ${approvalCardReference(card)}`,
          },
        ],
        terminate: true,
      };
    },
  });

export const forgejoReadyPullRequestTool =
  defineAgentTool<ReadyPullRequestParams>({
    name: "forgejo_ready_pull_request",
    label: "Forgejo: Mark Pull Request Ready",
    description:
      "Propose removing the WIP/draft marker from an open Forgejo pull request. This does not merge it or guarantee checks/reviews pass. Requires user approval before the provider write. For managed worktrees, use worktree_ready_pull_request instead.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        number: { type: "number", description: "Pull-request number." },
      },
    },
    async execute(params, ctx) {
      getForgejoToolConfig();
      const { owner, repo } = resolveForgejoRepo(params.repo);
      if (!Number.isInteger(params.number) || params.number < 1)
        throw new Error("number must be a valid pull-request number.");
      const body: ForgejoPullRequestApprovalBody = {
        kind: "forgejoPullRequest",
        operation: "ready",
        repo: `${owner}/${repo}`,
        pullNumber: params.number,
      };
      createApproval({
        sessionId: ctx.session.sessionId,
        kind: "forgejoPullRequest",
        title: "Mark WIP pull request ready",
        summary: `${owner}/${repo}#${params.number}`,
        sourceToolCallId: ctx.toolCallId,
        body,
      });
      return {
        content: [
          {
            type: "text",
            text: `Prepared a ready-for-review proposal for ${owner}/${repo}#${params.number} pending your approval. ${PENDING_NOTE}`,
          },
        ],
        terminate: true,
      };
    },
  });

export const forgejoReviewPullRequestTool =
  defineAgentTool<ReviewPullRequestParams>({
    name: "forgejo_review_pull_request",
    label: "Forgejo: Review Pull Request",
    description:
      "Prepare a Forgejo pull-request review (COMMENT / APPROVED / REQUEST_CHANGES) with an optional summary and inline comments, for the user to approve. Never submits until approved.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number", "event"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        number: { type: "number", description: "Pull-request index/number." },
        event: {
          type: "string",
          enum: ["COMMENT", "APPROVED", "REQUEST_CHANGES"],
          description:
            "Review verdict, in Forgejo's spelling (APPROVED, not APPROVE; REQUEST_CHANGES, not CHANGES_REQUESTED).",
        },
        summary: {
          type: "string",
          description: "Overall review body (Markdown).",
        },
        comments: {
          type: "array",
          description: "Inline review comments anchored to diff lines.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "line", "body"],
            properties: {
              path: {
                type: "string",
                description: "File path within the repo.",
              },
              line: {
                type: "number",
                description: "Line number on the PR diff.",
              },
              side: {
                type: "string",
                enum: ["LEFT", "RIGHT"],
                description:
                  "Diff side; RIGHT (post-change) by default. LEFT anchors the comment to the pre-change line.",
              },
              body: { type: "string", description: "Comment text." },
              suggestion: {
                type: "string",
                description:
                  "Optional replacement code; rendered as a suggestion block.",
              },
            },
          },
        },
      },
    },
    async execute(params, ctx) {
      getForgejoToolConfig();
      const { owner, repo } = resolveForgejoRepo(params.repo);
      if (!Number.isFinite(params.number) || params.number < 1)
        throw new Error("number must be a valid pull-request number.");
      const pullNumber = Math.trunc(params.number);
      const comments = (params.comments ?? [])
        .map((c) => ({
          path: String(c.path).trim(),
          line: Math.trunc(c.line),
          ...(c.side ? { side: c.side } : {}),
          body: String(c.body),
          ...(c.suggestion ? { suggestion: String(c.suggestion) } : {}),
        }))
        .filter((c) => c.path && Number.isFinite(c.line));
      const reviewSummaryValue = params.summary?.trim() || undefined;
      const body: ForgejoPullRequestApprovalBody = {
        kind: "forgejoPullRequest",
        operation: "review",
        repo: `${owner}/${repo}`,
        pullNumber,
        reviewEvent: params.event,
        ...(reviewSummaryValue !== undefined
          ? { reviewSummary: reviewSummaryValue }
          : {}),
        ...(comments.length ? { inlineComments: comments } : {}),
      };
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind: "forgejoPullRequest",
        title: `Submit review (${params.event})`,
        summary: `${owner}/${repo}#${pullNumber} · ${comments.length} inline comment(s)`,
        sourceToolCallId: ctx.toolCallId,
        body,
      });
      return {
        content: [
          {
            type: "text",
            text: `Prepared a ${params.event} review proposal for ${owner}/${repo}#${pullNumber} (${comments.length} inline comment(s)) pending your approval. ${PENDING_NOTE} ${approvalCardReference(card)}`,
          },
        ],
        terminate: true,
      };
    },
  });

export const forgejoCommentPullRequestTool =
  defineAgentTool<CommentPullRequestParams>({
    name: "forgejo_comment_pull_request",
    label: "Forgejo: Comment on Pull Request",
    description:
      "Prepare a Forgejo pull-request comment for the user to approve — a general timeline comment, or a code comment added to an existing review thread. Never posts until approved.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number", "body"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        number: { type: "number", description: "Pull-request index/number." },
        body: { type: "string", description: "Comment text (Markdown)." },
        replyToReviewId: {
          type: "number",
          description:
            "Add the comment to this existing review instead of the timeline. Forgejo has no reply-to-comment endpoint, so a threaded reply is a comment on the review that owns the thread, and replyPath + replyLine are then required.",
        },
        replyPath: {
          type: "string",
          description: "File path the reply anchors to (with replyToReviewId).",
        },
        replyLine: {
          type: "number",
          description: "Diff line the reply anchors to (with replyToReviewId).",
        },
        replySide: {
          type: "string",
          enum: ["LEFT", "RIGHT"],
          description: "Diff side of the reply anchor; RIGHT by default.",
        },
      },
    },
    async execute(params, ctx) {
      getForgejoToolConfig();
      const { owner, repo } = resolveForgejoRepo(params.repo);
      if (!Number.isFinite(params.number) || params.number < 1)
        throw new Error("number must be a valid pull-request number.");
      const pullNumber = Math.trunc(params.number);
      const commentBody = params.body.trim();
      if (!commentBody) throw new Error("body must be a non-empty comment.");
      const replyToReviewId =
        typeof params.replyToReviewId === "number"
          ? Math.trunc(params.replyToReviewId)
          : undefined;
      const replyPath = params.replyPath?.trim() || undefined;
      const replyLine =
        typeof params.replyLine === "number"
          ? Math.trunc(params.replyLine)
          : undefined;
      if (replyToReviewId !== undefined && (!replyPath || !replyLine))
        throw new Error(
          "replyPath and replyLine are required when replying to a review thread.",
        );
      const body: ForgejoPullRequestApprovalBody = {
        kind: "forgejoPullRequest",
        operation: "comment",
        repo: `${owner}/${repo}`,
        pullNumber,
        commentBody,
        ...(replyToReviewId !== undefined ? { replyToReviewId } : {}),
        ...(replyToReviewId !== undefined
          ? {
              ...(replyPath !== undefined ? { replyPath } : {}),
              ...(replyLine !== undefined ? { replyLine } : {}),
              ...(params.replySide ? { replySide: params.replySide } : {}),
            }
          : {}),
      };
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind: "forgejoPullRequest",
        title:
          replyToReviewId !== undefined
            ? "Reply to review thread"
            : "Comment on pull request",
        summary: `${owner}/${repo}#${pullNumber}`,
        sourceToolCallId: ctx.toolCallId,
        body,
      });
      return {
        content: [
          {
            type: "text",
            text: `Prepared a comment proposal for ${owner}/${repo}#${pullNumber} pending your approval. ${PENDING_NOTE} ${approvalCardReference(card)}`,
          },
        ],
        terminate: true,
      };
    },
  });

/** `WIP: ` prefix for a draft, unless the title already carries a WIP marker. */
function wipTitle(title: string): string {
  return /^(wip:|\[wip\])/i.test(title.trim())
    ? title
    : `${WIP_PREFIX}${title}`;
}

/** Position-anchored `CreatePullReviewComment` payload for one inline comment. */
function reviewCommentPayload(comment: {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
  suggestion?: string;
}): Record<string, unknown> {
  return {
    path: comment.path,
    body: comment.suggestion
      ? `${comment.body}\n\n\`\`\`suggestion\n${comment.suggestion}\n\`\`\``
      : comment.body,
    ...(comment.side === "LEFT"
      ? { old_position: comment.line }
      : { new_position: comment.line }),
  };
}

/** Execute an approved Forgejo PR write against the API. */
registerApprovalExecutor("forgejoPullRequest", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "forgejoPullRequest")
      throw new Error("Mismatched approval body for forgejoPullRequest.");
    const b = card.body;
    const config = getForgejoToolConfig();
    const [owner, repoName] = b.repo.split("/");
    const base = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repoName!)}`;

    if (b.operation === "create") {
      const title = b.title ?? "";
      const res = await forgejoRequest<{ html_url?: string; number?: number }>(
        config,
        "POST",
        `${base}/pulls`,
        {
          body: {
            title: b.draft === true ? wipTitle(title) : title,
            head: b.head,
            base: b.base,
            body: b.prBody ?? "",
          },
        },
      );
      if (res.data.number !== undefined) b.resultNumber = res.data.number;
      return {
        resultSummary: res.data.number
          ? `Opened pull request #${res.data.number}`
          : "Opened pull request",
        ...(res.data.html_url !== undefined
          ? { resultUrl: res.data.html_url }
          : {}),
      };
    }

    if (b.operation === "ready") {
      if (!Number.isInteger(b.pullNumber) || (b.pullNumber ?? 0) < 1)
        throw new Error("Ready proposal is missing its pull-request number.");
      const provider = forgejoProvider(
        { host: new URL(config.baseUrl).host, owner: owner!, repo: repoName! },
        config,
      );
      const detail = await provider.pullRequestDetail(b.pullNumber!);
      if (!detail || detail.state !== "open" || detail.merged || !detail.draft)
        throw new Error(
          `Pull request #${b.pullNumber} is not an open draft; nothing was changed.`,
        );
      try {
        await provider.markPullRequestReady(b.pullNumber!);
      } finally {
        invalidateForgejoPullRequestWrite(
          config.baseUrl,
          owner!,
          repoName!,
          b.pullNumber,
        );
      }
      return {
        resultSummary: `Marked pull request #${b.pullNumber} ready for review`,
        resultUrl: `${provider.repoWebUrl}/pulls/${b.pullNumber}`,
      };
    }

    if (b.operation === "edit") {
      if (typeof b.pullNumber !== "number" || typeof b.prBody !== "string")
        throw new Error(
          "Edit proposal is missing its pull-request number or description.",
        );
      const res = await forgejoRequest<{ html_url?: string }>(
        config,
        "PATCH",
        `${base}/pulls/${b.pullNumber}`,
        { body: { body: b.prBody } },
      );
      return {
        resultSummary: `Updated description on #${b.pullNumber}`,
        ...(res.data.html_url !== undefined
          ? { resultUrl: res.data.html_url }
          : {}),
      };
    }

    if (b.operation === "review") {
      if (typeof b.pullNumber !== "number")
        throw new Error("Review proposal is missing a pull-request number.");
      const comments = (b.inlineComments ?? []).map(reviewCommentPayload);
      const res = await forgejoRequest<{ html_url?: string }>(
        config,
        "POST",
        `${base}/pulls/${b.pullNumber}/reviews`,
        {
          body: {
            event: b.reviewEvent ?? "COMMENT",
            ...(b.reviewSummary ? { body: b.reviewSummary } : {}),
            ...(comments.length ? { comments } : {}),
          },
        },
      );
      return {
        resultSummary: `Submitted ${b.reviewEvent ?? "COMMENT"} review on #${b.pullNumber}`,
        ...(res.data.html_url !== undefined
          ? { resultUrl: res.data.html_url }
          : {}),
      };
    }

    // comment
    if (typeof b.pullNumber !== "number")
      throw new Error("Comment proposal is missing a pull-request number.");
    if (typeof b.replyToReviewId === "number") {
      if (!b.replyPath || typeof b.replyLine !== "number")
        throw new Error("Reply proposal is missing its file/line anchor.");
      const res = await forgejoRequest<{ html_url?: string }>(
        config,
        "POST",
        `${base}/pulls/${b.pullNumber}/reviews/${b.replyToReviewId}/comments`,
        {
          body: reviewCommentPayload({
            path: b.replyPath,
            line: b.replyLine,
            ...(b.replySide ? { side: b.replySide } : {}),
            body: b.commentBody ?? "",
          }),
        },
      );
      return {
        resultSummary: `Replied on review ${b.replyToReviewId} of #${b.pullNumber}`,
        ...(res.data.html_url !== undefined
          ? { resultUrl: res.data.html_url }
          : {}),
      };
    }
    const res = await forgejoRequest<{ html_url?: string }>(
      config,
      "POST",
      `${base}/issues/${b.pullNumber}/comments`,
      { body: { body: b.commentBody ?? "" } },
    );
    return {
      resultSummary: `Commented on #${b.pullNumber}`,
      ...(res.data.html_url !== undefined
        ? { resultUrl: res.data.html_url }
        : {}),
    };
  },
});

export const forgejoPrWriteTools = [
  forgejoCreatePullRequestTool,
  forgejoEditPullRequestTool,
  forgejoReadyPullRequestTool,
  forgejoReviewPullRequestTool,
  forgejoCommentPullRequestTool,
];
