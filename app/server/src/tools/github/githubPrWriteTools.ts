/**
 * GitHub PR write tools (coding personas only, gate `github`): approval-gated
 * pull-request creation, description edits, reviews, comments, and reviewer/assignee changes. These
 * tools NEVER write during the model turn — each stages a PENDING approval via
 * the shared `../../pendingApprovals.ts` subsystem and returns a bounded
 * summary; the write executes server-side only after the user approves the card
 * (works on pi AND claude-sdk, with attention + agent-resume). Reads live in
 * `githubTools.ts`.
 */
import { defineAgentTool } from "../../mcp/tool.ts";
import { getGithubToolConfig } from "../../githubSettings.ts";
import {
  githubRequest,
  resolveAuthenticatedLogin,
} from "../../githubClient.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import { invalidateGithubPullRequestWrite } from "../../pullRequestInventorySync.ts";
import { githubProvider } from "../../gitHosting.ts";
import { resolveRepo } from "./githubTools.ts";
import type {
  ApprovalCard,
  GithubPrInlineCommentDisplay,
  GithubPrReviewEvent,
  GithubPullRequestApprovalBody,
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
  event: GithubPrReviewEvent;
  summary?: string;
  comments?: GithubPrInlineCommentDisplay[];
};
type CommentPullRequestParams = {
  repo: string;
  number: number;
  body: string;
  replyToCommentId?: number;
};
type AssignPullRequestParams = {
  repo: string;
  number: number;
  addReviewers?: string[];
  removeReviewers?: string[];
  addReviewerTeams?: string[];
  removeReviewerTeams?: string[];
  addAssignees?: string[];
  removeAssignees?: string[];
};

const PENDING_NOTE =
  "Do not claim it succeeded until the approved result appears.";

export const githubCreatePullRequestTool =
  defineAgentTool<CreatePullRequestParams>({
    name: "github_create_pull_request",
    label: "GitHub: Create Pull Request",
    description:
      "Prepare a GitHub pull request for the user to approve. This never writes immediately: it stages a pending approval card; the PR is opened only after the user approves.",
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
          description: "Open as a draft PR. Defaults to false.",
        },
      },
    },
    async execute(params, ctx) {
      getGithubToolConfig();
      const { owner, repo } = resolveRepo(params.repo);
      const title = params.title.trim();
      const head = params.head.trim();
      const base = params.base.trim();
      if (!title)
        throw new Error("title must be a non-empty pull-request title.");
      if (!head || !base)
        throw new Error("head and base branches are required.");
      const prBodyValue = params.body?.trim() || undefined;
      const body: GithubPullRequestApprovalBody = {
        kind: "githubPullRequest",
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
        kind: "githubPullRequest",
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

export const githubEditPullRequestTool = defineAgentTool<EditPullRequestParams>(
  {
    name: "github_edit_pull_request",
    label: "GitHub: Edit Pull Request Description",
    description:
      "Prepare a replacement description for an existing GitHub pull request. An empty body clears the description. Never writes until the user approves the proposal.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number", "body"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        number: { type: "number", description: "Pull-request number." },
        body: {
          type: "string",
          description:
            "Complete replacement description (Markdown); use an empty string to clear it.",
        },
      },
    },
    async execute(params, ctx) {
      getGithubToolConfig();
      const { owner, repo } = resolveRepo(params.repo);
      if (!Number.isInteger(params.number) || params.number < 1)
        throw new Error("number must be a valid pull-request number.");
      const body: GithubPullRequestApprovalBody = {
        kind: "githubPullRequest",
        operation: "edit",
        repo: `${owner}/${repo}`,
        pullNumber: params.number,
        prBody: params.body,
      };
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind: "githubPullRequest",
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
  },
);

export const githubReadyPullRequestTool =
  defineAgentTool<ReadyPullRequestParams>({
    name: "github_ready_pull_request",
    label: "GitHub: Mark Pull Request Ready",
    description:
      "Propose moving an open GitHub draft pull request into reviewable state. This does not merge it or guarantee checks/reviews pass. Requires user approval before the provider write. For managed worktrees, use worktree_ready_pull_request instead.",
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
      getGithubToolConfig();
      const { owner, repo } = resolveRepo(params.repo);
      if (!Number.isInteger(params.number) || params.number < 1)
        throw new Error("number must be a valid pull-request number.");
      const body: GithubPullRequestApprovalBody = {
        kind: "githubPullRequest",
        operation: "ready",
        repo: `${owner}/${repo}`,
        pullNumber: params.number,
      };
      createApproval({
        sessionId: ctx.session.sessionId,
        kind: "githubPullRequest",
        title: "Mark draft pull request ready",
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

export const githubReviewPullRequestTool =
  defineAgentTool<ReviewPullRequestParams>({
    name: "github_review_pull_request",
    label: "GitHub: Review Pull Request",
    description:
      "Prepare a GitHub pull-request review (COMMENT / APPROVE / REQUEST_CHANGES) with an optional summary and inline comments, for the user to approve. Never submits until approved.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number", "event"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        number: { type: "number", description: "Pull-request number." },
        event: {
          type: "string",
          enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"],
          description: "Review verdict.",
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
                description: "Diff side; RIGHT (post-change) by default.",
              },
              body: { type: "string", description: "Comment text." },
              suggestion: {
                type: "string",
                description:
                  "Optional replacement code; rendered as a GitHub suggestion block.",
              },
            },
          },
        },
      },
    },
    async execute(params, ctx) {
      getGithubToolConfig();
      const { owner, repo } = resolveRepo(params.repo);
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
      const body: GithubPullRequestApprovalBody = {
        kind: "githubPullRequest",
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
        kind: "githubPullRequest",
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

export const githubCommentPullRequestTool =
  defineAgentTool<CommentPullRequestParams>({
    name: "github_comment_pull_request",
    label: "GitHub: Comment on Pull Request",
    description:
      "Prepare a GitHub pull-request comment for the user to approve — a general timeline comment, or a reply to an existing review comment. Never posts until approved.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number", "body"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        number: { type: "number", description: "Pull-request number." },
        body: { type: "string", description: "Comment text (Markdown)." },
        replyToCommentId: {
          type: "number",
          description:
            "Reply to this review comment id (from github_get_pull_request review threads). Omit for a general timeline comment.",
        },
      },
    },
    async execute(params, ctx) {
      getGithubToolConfig();
      const { owner, repo } = resolveRepo(params.repo);
      if (!Number.isFinite(params.number) || params.number < 1)
        throw new Error("number must be a valid pull-request number.");
      const pullNumber = Math.trunc(params.number);
      const commentBody = params.body.trim();
      if (!commentBody) throw new Error("body must be a non-empty comment.");
      const body: GithubPullRequestApprovalBody = {
        kind: "githubPullRequest",
        operation: "comment",
        repo: `${owner}/${repo}`,
        pullNumber,
        commentBody,
        ...(typeof params.replyToCommentId === "number"
          ? { replyToCommentId: Math.trunc(params.replyToCommentId) }
          : {}),
      };
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind: "githubPullRequest",
        title: params.replyToCommentId
          ? "Reply to review comment"
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

/**
 * Shape each value, THEN drop empties and de-duplicate: shaping is what turns
 * `org/` into nothing and makes `org/platform` and `platform` the same team, so
 * filtering before it would let both through to the card and the API. Order
 * preserved.
 */
function normalizeNames(
  values: readonly string[] | undefined,
  shape: (value: string) => string,
): string[] {
  const out: string[] = [];
  for (const raw of values ?? []) {
    const name = shape(String(raw).trim()).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Logins are bare: a leading `@` is accepted and dropped. */
export function cleanLogins(values: readonly string[] | undefined): string[] {
  return normalizeNames(values, (value) => value.replace(/^@+/, ""));
}

/** Team slugs are the bare slug; `org/team` and a leading `@` are accepted. */
function cleanTeamSlugs(values: readonly string[] | undefined): string[] {
  return normalizeNames(
    values,
    (value) => value.replace(/^@+/, "").split("/").pop() ?? "",
  );
}

/**
 * ONLY the `@`-prefixed form is the self alias: `me` is a real GitHub account,
 * so a request naming it must reach that account and not the token's owner.
 */
export function isSelfAlias(value: string): boolean {
  return /^@me$/i.test(String(value).trim());
}

type AssignmentStep = {
  label: string;
  method: "POST" | "DELETE";
  /** Review requests and assignees live on different endpoints. */
  target: "reviewers" | "assignees";
  payload: Record<string, string[]>;
};

/**
 * The people changes an `assign` proposal carries, in execution order and
 * without the lists it leaves alone. One source for both the card's wording and
 * the API calls, so a failure can name exactly which steps already landed.
 */
function assignmentSteps(
  body: GithubPullRequestApprovalBody,
): AssignmentStep[] {
  const reviewers = (logins?: string[], teams?: string[]) => ({
    names: [...(logins ?? []), ...(teams ?? []).map((slug) => `team:${slug}`)],
    payload: {
      ...(logins?.length ? { reviewers: logins } : {}),
      ...(teams?.length ? { team_reviewers: teams } : {}),
    },
  });
  const requested = reviewers(body.addReviewers, body.addReviewerTeams);
  const unrequested = reviewers(body.removeReviewers, body.removeReviewerTeams);
  return [
    {
      label: `request review: ${requested.names.join(", ")}`,
      method: "POST" as const,
      target: "reviewers" as const,
      payload: requested.payload,
    },
    {
      label: `cancel review request: ${unrequested.names.join(", ")}`,
      method: "DELETE" as const,
      target: "reviewers" as const,
      payload: unrequested.payload,
    },
    {
      label: `assign: ${(body.addAssignees ?? []).join(", ")}`,
      method: "POST" as const,
      target: "assignees" as const,
      payload: body.addAssignees?.length
        ? { assignees: body.addAssignees }
        : {},
    },
    {
      label: `unassign: ${(body.removeAssignees ?? []).join(", ")}`,
      method: "DELETE" as const,
      target: "assignees" as const,
      payload: body.removeAssignees?.length
        ? { assignees: body.removeAssignees }
        : {},
    },
  ].filter((step) => Object.keys(step.payload).length > 0);
}

export const githubAssignPullRequestTool =
  defineAgentTool<AssignPullRequestParams>({
    name: "github_assign_pull_request",
    label: "GitHub: Assign Pull Request",
    description:
      "Prepare a change to who is on a GitHub pull request, for the user to approve: request or cancel REVIEWS from users and org teams, and add or remove ASSIGNEES. Reviewers and assignees are independent — asking someone to review does not assign the PR to them, so pick the list the user meant. Omitted lists are left untouched. Never writes until approved.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        number: { type: "number", description: "Pull-request number." },
        addReviewers: {
          type: "array",
          items: { type: "string" },
          description:
            "Logins to request a review from. Only the exact string '@me' means the authenticated GitHub user; a bare 'me' is the account of that name. GitHub rejects the pull request's own author.",
        },
        removeReviewers: {
          type: "array",
          items: { type: "string" },
          description:
            "Logins whose pending review request is cancelled. Does not remove a review already submitted.",
        },
        addReviewerTeams: {
          type: "array",
          items: { type: "string" },
          description:
            "Org team slugs to request a review from, e.g. 'platform'.",
        },
        removeReviewerTeams: {
          type: "array",
          items: { type: "string" },
          description: "Org team slugs whose review request is cancelled.",
        },
        addAssignees: {
          type: "array",
          items: { type: "string" },
          description:
            "Logins to assign the pull request to (who OWNS the work). Only the exact string '@me' means the authenticated GitHub user. GitHub silently ignores a login without push access to the repo.",
        },
        removeAssignees: {
          type: "array",
          items: { type: "string" },
          description: "Logins to unassign from the pull request.",
        },
      },
    },
    async execute(params, ctx) {
      const config = getGithubToolConfig();
      const { owner, repo } = resolveRepo(params.repo);
      if (!Number.isFinite(params.number) || params.number < 1)
        throw new Error("number must be a valid pull-request number.");
      const pullNumber = Math.trunc(params.number);
      // The alias is resolved on the RAW input, before `@` stripping makes
      // `@me` and the real account `me` look alike.
      const raw = {
        addReviewers: params.addReviewers ?? [],
        removeReviewers: params.removeReviewers ?? [],
        addAssignees: params.addAssignees ?? [],
        removeAssignees: params.removeAssignees ?? [],
      };
      if (Object.values(raw).some((list) => list.some(isSelfAlias))) {
        const self = await resolveAuthenticatedLogin(config, ctx.signal);
        if (!self)
          throw new Error(
            "Could not resolve '@me': the configured GitHub token did not return an authenticated user.",
          );
        for (const [key, list] of Object.entries(raw))
          raw[key as keyof typeof raw] = list.map((value) =>
            isSelfAlias(value) ? self : value,
          );
      }
      const people = {
        addReviewers: cleanLogins(raw.addReviewers),
        removeReviewers: cleanLogins(raw.removeReviewers),
        addAssignees: cleanLogins(raw.addAssignees),
        removeAssignees: cleanLogins(raw.removeAssignees),
      };
      const teams = {
        addReviewerTeams: cleanTeamSlugs(params.addReviewerTeams),
        removeReviewerTeams: cleanTeamSlugs(params.removeReviewerTeams),
      };
      const lists = { ...people, ...teams };
      const body: GithubPullRequestApprovalBody = {
        kind: "githubPullRequest",
        operation: "assign",
        repo: `${owner}/${repo}`,
        pullNumber,
      };
      // An empty list stays ABSENT: the executor treats a present list as work
      // to do, and the card renders only the lists that change.
      for (const [key, list] of Object.entries(lists))
        if (list.length) body[key as keyof typeof lists] = list;
      const changes = assignmentSteps(body).map((step) => step.label);
      if (!changes.length)
        throw new Error(
          "Name at least one reviewer, reviewer team, or assignee to add or remove.",
        );
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind: "githubPullRequest",
        title: "Change pull-request reviewers/assignees",
        summary: `${owner}/${repo}#${pullNumber} · ${changes.join(" · ")}`,
        sourceToolCallId: ctx.toolCallId,
        body,
      });
      return {
        content: [
          {
            type: "text",
            text: `Prepared a reviewer/assignee change for ${owner}/${repo}#${pullNumber} (${changes.join("; ")}) pending your approval. ${PENDING_NOTE} ${approvalCardReference(card)}`,
          },
        ],
        terminate: true,
      };
    },
  });

/** Execute an approved GitHub PR write against the API. */
registerApprovalExecutor("githubPullRequest", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "githubPullRequest")
      throw new Error("Mismatched approval body for githubPullRequest.");
    const b = card.body;
    try {
      return await executeApprovedWrite(b);
    } finally {
      // Also after a failure: an assignment's earlier steps may have landed.
      // A plain comment changes nothing the inventory shows.
      if (b.operation !== "comment") {
        const [owner, repoName] = b.repo.split("/");
        invalidateGithubPullRequestWrite(
          owner!,
          repoName!,
          b.operation === "create" ? b.resultNumber : b.pullNumber,
        );
      }
    }
  },
});

async function executeApprovedWrite(b: GithubPullRequestApprovalBody) {
  const config = getGithubToolConfig();
  const [owner, repoName] = b.repo.split("/");
  const base = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repoName!)}`;

  if (b.operation === "create") {
    const res = await githubRequest<{ html_url?: string; number?: number }>(
      config,
      "POST",
      `${base}/pulls`,
      {
        body: {
          title: b.title,
          head: b.head,
          base: b.base,
          body: b.prBody ?? "",
          draft: b.draft === true,
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
    const provider = githubProvider(
      { host: "github.com", owner: owner!, repo: repoName! },
      config,
    );
    const detail = await provider.pullRequestDetail(b.pullNumber!);
    if (!detail || detail.state !== "open" || detail.merged || !detail.draft)
      throw new Error(
        `Pull request #${b.pullNumber} is not an open draft; nothing was changed.`,
      );
    await provider.markPullRequestReady(b.pullNumber!);
    return {
      resultSummary: `Marked pull request #${b.pullNumber} ready for review`,
      resultUrl: `${provider.repoWebUrl}/pull/${b.pullNumber}`,
    };
  }

  if (b.operation === "edit") {
    if (typeof b.pullNumber !== "number" || typeof b.prBody !== "string")
      throw new Error(
        "Edit proposal is missing its pull-request number or description.",
      );
    const res = await githubRequest<{ html_url?: string }>(
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
    const comments = (b.inlineComments ?? []).map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? "RIGHT",
      body: c.suggestion
        ? `${c.body}\n\n\`\`\`suggestion\n${c.suggestion}\n\`\`\``
        : c.body,
    }));
    const res = await githubRequest<{ html_url?: string }>(
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

  if (b.operation === "assign") {
    if (typeof b.pullNumber !== "number")
      throw new Error("Assignment proposal is missing a pull-request number.");
    const steps = assignmentSteps(b);
    const path = (step: AssignmentStep) =>
      step.target === "reviewers"
        ? `${base}/pulls/${b.pullNumber}/requested_reviewers`
        : `${base}/issues/${b.pullNumber}/assignees`;
    let url: string | undefined;
    const applied: string[] = [];
    for (const step of steps) {
      try {
        const res = await githubRequest<{ html_url?: string }>(
          config,
          step.method,
          path(step),
          { body: step.payload },
        );
        if (!url && typeof res.data.html_url === "string")
          url = res.data.html_url;
        applied.push(step.label);
      } catch (error) {
        // Each step is its own request, so earlier ones already landed on
        // GitHub: name them rather than let the failure read as "nothing
        // happened".
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          applied.length
            ? `${message} — already applied: ${applied.join("; ")}`
            : message,
        );
      }
    }
    return {
      resultSummary: `#${b.pullNumber} — ${applied.join("; ")}`,
      ...(url !== undefined ? { resultUrl: url } : {}),
    };
  }

  // comment
  if (typeof b.pullNumber !== "number")
    throw new Error("Comment proposal is missing a pull-request number.");
  if (typeof b.replyToCommentId === "number") {
    const res = await githubRequest<{ html_url?: string }>(
      config,
      "POST",
      `${base}/pulls/${b.pullNumber}/comments/${b.replyToCommentId}/replies`,
      { body: { body: b.commentBody ?? "" } },
    );
    return {
      resultSummary: `Replied to review comment on #${b.pullNumber}`,
      ...(res.data.html_url !== undefined
        ? { resultUrl: res.data.html_url }
        : {}),
    };
  }
  const res = await githubRequest<{ html_url?: string }>(
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
}

export const githubPrWriteTools = [
  githubCreatePullRequestTool,
  githubEditPullRequestTool,
  githubReadyPullRequestTool,
  githubReviewPullRequestTool,
  githubCommentPullRequestTool,
  githubAssignPullRequestTool,
];
