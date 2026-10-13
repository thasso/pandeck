/**
 * The edit proposal shared by `github_edit_pull_request` and
 * `forgejo_edit_pull_request`: a replacement description, a new base, or both.
 * Both providers accept the same two fields on their pull-request PATCH.
 */

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

/** The provider PATCH body: only the fields the approved proposal changes. */
export function pullRequestEditPayload(
  b: PullRequestEditFields,
): Record<string, string> {
  return {
    ...(typeof b.prBody === "string" ? { body: b.prBody } : {}),
    ...(b.base ? { base: b.base } : {}),
  };
}

export function pullRequestEditSummary(
  b: PullRequestEditFields & { pullNumber?: number },
): string {
  return [
    ...(b.base ? [`Retargeted #${b.pullNumber} onto ${b.base}`] : []),
    ...(typeof b.prBody === "string"
      ? [`Updated description on #${b.pullNumber}`]
      : []),
  ].join("; ");
}
