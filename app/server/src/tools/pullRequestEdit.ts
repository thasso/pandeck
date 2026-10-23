/**
 * The edit proposal shared by `github_edit_pull_request` and
 * `forgejo_edit_pull_request`: a replacement description, a new base, or both.
 */
import type { GitHostingProvider } from "../gitHosting.ts";
import { withHostedPullRequestMutation } from "../pullRequestMerge.ts";

interface PullRequestEditInput {
  body?: string;
  base?: string;
}

interface PullRequestEditFields {
  prBody?: string;
  base?: string;
}

/** Validate the tool input into approval-body fields and card wording. */
export function pullRequestEdit(params: PullRequestEditInput): {
  fields: PullRequestEditFields;
  title: string;
  what: string;
} {
  const base = params.base?.trim();
  if (params.base !== undefined && !base)
    throw new Error("base must name a branch; omit it to keep the base.");
  if (params.body === undefined && !base)
    throw new Error("Provide a body, a base, or both.");
  const fields: PullRequestEditFields = {
    ...(params.body !== undefined ? { prBody: params.body } : {}),
    ...(base ? { base } : {}),
  };
  return {
    fields,
    title: base ? "Edit pull request base" : "Edit pull request description",
    what: [
      ...(base ? [`a retarget onto ${base}`] : []),
      ...(params.body !== undefined ? ["a description edit"] : []),
    ].join(" and "),
  };
}

/**
 * Execute an approved edit. The base goes through the provider seam under the
 * pull request's hosted mutation lock — the one every managed merge, close and
 * retarget of the same pull request also holds — so an approved retarget
 * cannot land between a merge's identity read and the merge itself. A
 * description is not a merge decision and uses the provider's body-only PATCH
 * without the retarget lock. A description that fails after the base landed names
 * the retarget rather than reading as "nothing happened".
 */
export async function applyPullRequestEdit(
  provider: GitHostingProvider,
  b: PullRequestEditFields & { pullNumber: number },
): Promise<{ resultSummary: string; resultUrl?: string }> {
  const applied: string[] = [];
  if (b.base) {
    const base = b.base;
    await withHostedPullRequestMutation(
      {
        providerKind: provider.kind,
        repoUrl: provider.repoWebUrl,
        number: b.pullNumber,
      },
      "an approved base edit",
      () => provider.retargetPullRequest(b.pullNumber, base),
    );
    applied.push(`Retargeted #${b.pullNumber} onto ${base}`);
  }
  let resultUrl: string | undefined;
  if (typeof b.prBody === "string") {
    try {
      resultUrl = (await provider.editPullRequestBody(b.pullNumber, b.prBody))
        .url;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        applied.length
          ? `${message} — already applied: ${applied.join("; ")}`
          : message,
      );
    }
    applied.push(`Updated description on #${b.pullNumber}`);
  }
  return {
    resultSummary: applied.join("; "),
    ...(resultUrl !== undefined ? { resultUrl } : {}),
  };
}
