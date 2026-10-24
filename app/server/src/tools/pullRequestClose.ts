/**
 * The close proposal shared by `github_close_pull_request` and
 * `forgejo_close_pull_request`: close one open pull request without merging,
 * optionally posting a comment first and deleting its head branch after.
 *
 * The proposal binds the head the user sees on the card. Approval closes only
 * while the pull request is still open at exactly that commit, so a push that
 * lands while the card waits is never closed (or deleted) unseen.
 */
import type { GitHostingProvider } from "../gitHosting.ts";
import { withHostedPullRequestMutation } from "../pullRequestMerge.ts";

const MAX_COMMENT_CHARS = 65_536;

interface PullRequestCloseInput {
  number: number;
  comment?: string;
  deleteBranch?: boolean;
}

interface PullRequestCloseFields {
  pullNumber: number;
  head: string;
  base: string;
  headSha: string;
  commentBody?: string;
  deleteBranch?: boolean;
}

/** Validate the tool input and bind the pull request's current head. */
export async function pullRequestCloseProposal(
  provider: GitHostingProvider,
  params: PullRequestCloseInput,
): Promise<PullRequestCloseFields> {
  if (!Number.isInteger(params.number) || params.number < 1)
    throw new Error("number must be a valid pull-request number.");
  const comment = params.comment?.trim();
  if (params.comment !== undefined && !comment)
    throw new Error("comment must not be empty; omit it to close silently.");
  if (comment && comment.length > MAX_COMMENT_CHARS)
    throw new Error(`comment exceeds ${MAX_COMMENT_CHARS} characters.`);
  const detail = await provider.pullRequestDetail(params.number);
  if (!detail)
    throw new Error(`Pull request #${params.number} could not be read.`);
  if (detail.state !== "open" || detail.merged)
    throw new Error(
      `Pull request #${params.number} is already ${detail.merged ? "merged" : detail.state}; there is nothing to close.`,
    );
  if (!detail.headSha)
    throw new Error(
      `Pull request #${params.number} reports no head commit, so a close could not be bound to one.`,
    );
  return {
    pullNumber: params.number,
    head: detail.headBranch,
    base: detail.baseBranch,
    headSha: detail.headSha,
    ...(comment ? { commentBody: comment } : {}),
    ...(params.deleteBranch === true ? { deleteBranch: true } : {}),
  };
}

/**
 * Execute an approved close under the pull request's hosted mutation lock,
 * the one managed merges, closes and retargets of it also hold. A close whose
 * confirmation failed, or a requested branch deletion that did not happen, is
 * an executed card with a warning: the provider write already landed.
 */
export async function applyPullRequestClose(
  provider: GitHostingProvider,
  b: PullRequestCloseFields,
  pullUrl: string,
): Promise<{ resultSummary: string; resultUrl: string }> {
  const result = await withHostedPullRequestMutation(
    {
      providerKind: provider.kind,
      repoUrl: provider.repoWebUrl,
      number: b.pullNumber,
    },
    "an approved close",
    () =>
      provider.closePullRequest(b.pullNumber, {
        expectedHeadSha: b.headSha,
        ...(b.commentBody ? { comment: b.commentBody } : {}),
        ...(b.deleteBranch ? { deleteBranch: true } : {}),
      }),
  );
  const branchOutcome = !b.deleteBranch
    ? undefined
    : result.branchDeleted
      ? `Deleted ${b.head}.`
      : `Warning: kept ${b.head} (${(result.branchKeptReason ?? result.branchDeleteError ?? "not deleted").replace(/\.$/, "")}).`;
  const parts = [
    result.closed
      ? `Closed #${b.pullNumber} without merging.`
      : `Warning: sent the close for #${b.pullNumber}, but ${result.unconfirmedReason ?? "closure is unconfirmed."}`,
    ...(result.commentUrl !== undefined ? ["Posted the comment."] : []),
    ...(branchOutcome ? [branchOutcome] : []),
  ];
  return {
    resultSummary: parts.join(" "),
    resultUrl: result.commentUrl || pullUrl,
  };
}
