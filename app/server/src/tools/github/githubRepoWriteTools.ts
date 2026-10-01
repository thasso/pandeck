/**
 * GitHub repository operations for coding personas (gate `github`):
 *
 *  - `github_rerun_actions_run` re-runs a finished Actions run's failed jobs,
 *    all of its jobs, or one job. It writes DIRECTLY — a re-run loses nothing
 *    and is what an agent watching CI needs inside its loop.
 *  - `github_delete_branch` stages an approval card for deleting remote
 *    branches; the default branch and protected branches are refused both when
 *    proposing and again when executing, and the delete itself is bound to the
 *    proposed commit (GraphQL `updateRefs` with `beforeOid`), so a branch that
 *    moved since the proposal is not deleted.
 */
import { defineAgentTool } from "../../mcp/tool.ts";
import { getGithubToolConfig } from "../../githubSettings.ts";
import {
  githubGraphql,
  githubRequest,
  type GithubApiConfig,
} from "../../githubClient.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import { resolveRepo } from "./githubTools.ts";
import type { ApprovalCard, GithubBranchDeleteItem } from "@assistant/shared";

type RerunParams = {
  repo: string;
  runId: number;
  jobId?: number;
  failedOnly?: boolean;
};
type DeleteBranchParams = { repo: string; branches: string[] };

const MAX_BRANCHES = 20;
const MAX_LISTED_PULLS = 5;

function repoPathOf(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** Branch names keep their `/` separators as path segments. */
function branchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function positiveId(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1)
    throw new Error(`${what} must be a positive id.`);
  return Math.trunc(value);
}

export const githubRerunActionsRunTool = defineAgentTool<RerunParams>({
  name: "github_rerun_actions_run",
  label: "GitHub: Re-run Actions",
  description:
    "Re-run a FINISHED GitHub Actions run: its failed jobs (default, dependents included), every job, or one job by jobId. Runs immediately, without an approval card. Re-run only after reading why it failed (github_get_actions_run / github_get_actions_job_log) and when a retry can plausibly pass — a flaky test or infrastructure failure, or after pushing nothing new; a new commit starts fresh runs on its own. Then wait on the result with github_watch_pull_request_checks or github_get_actions_run.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "runId"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      runId: {
        type: "number",
        description: "Actions run id (from github_list_actions_runs).",
      },
      jobId: {
        type: "number",
        description:
          "Re-run only this job (and jobs depending on it). Overrides failedOnly.",
      },
      failedOnly: {
        type: "boolean",
        description:
          "true (default): re-run only failed/cancelled jobs. false: re-run every job.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const { owner, repo } = resolveRepo(params.repo);
    const repoPath = repoPathOf(owner, repo);
    const runId = positiveId(params.runId, "runId");
    const jobId =
      params.jobId === undefined
        ? undefined
        : positiveId(params.jobId, "jobId");
    const signal = ctx.signal !== undefined ? { signal: ctx.signal } : {};
    const run = (
      await githubRequest<Record<string, any>>(
        config,
        "GET",
        `${repoPath}/actions/runs/${runId}`,
        signal,
      )
    ).data;
    if (run.status !== "completed")
      throw new Error(
        `Run ${runId} is still ${run.status ?? "running"}; only a finished run can be re-run.`,
      );
    const scope =
      jobId !== undefined
        ? "job"
        : params.failedOnly === false
          ? "all-jobs"
          : "failed-jobs";
    if (jobId !== undefined) {
      // A job id from another run would re-run THAT run while this result
      // reported the one named here.
      const job = (
        await githubRequest<{ run_id?: number; status?: string }>(
          config,
          "GET",
          `${repoPath}/actions/jobs/${jobId}`,
          signal,
        )
      ).data;
      if (job.run_id !== runId)
        throw new Error(
          `Job ${jobId} belongs to run ${job.run_id ?? "unknown"}, not run ${runId}.`,
        );
      if (job.status !== "completed")
        throw new Error(
          `Job ${jobId} is still ${job.status ?? "running"}; only a finished job can be re-run.`,
        );
    }
    if (scope === "failed-jobs" && run.conclusion === "success")
      throw new Error(
        `Run ${runId} succeeded, so it has no failed jobs to re-run; pass failedOnly: false to re-run every job.`,
      );
    const path =
      scope === "job"
        ? `${repoPath}/actions/jobs/${jobId}/rerun`
        : scope === "all-jobs"
          ? `${repoPath}/actions/runs/${runId}/rerun`
          : `${repoPath}/actions/runs/${runId}/rerun-failed-jobs`;
    await githubRequest(config, "POST", path, { body: {}, ...signal });
    const payload = {
      repo: `${owner}/${repo}`,
      runId,
      rerun: scope,
      ...(jobId !== undefined ? { jobId } : {}),
      previousConclusion: run.conclusion ?? null,
      newAttempt:
        typeof run.run_attempt === "number" ? run.run_attempt + 1 : null,
      headBranch: run.head_branch ?? null,
      url: run.html_url ?? null,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

async function repositoryOf(
  config: GithubApiConfig,
  repoPath: string,
  signal?: AbortSignal,
): Promise<{ defaultBranch: string | null; nodeId: string | null }> {
  const res = await githubRequest<{
    default_branch?: string;
    node_id?: string;
  }>(config, "GET", repoPath, signal !== undefined ? { signal } : {});
  return {
    defaultBranch: res.data.default_branch ?? null,
    nodeId: res.data.node_id ?? null,
  };
}

const ZERO_OID = "0".repeat(40);

/**
 * Delete `branch` only if it still points at `expectedSha`. REST
 * `DELETE /git/refs` takes no expected value, so a push landing between a read
 * and that call would delete the NEW tip; GraphQL `updateRefs` checks
 * `beforeOid` atomically on GitHub's side and rejects a moved ref.
 */
async function deleteBranchAt(
  config: GithubApiConfig,
  repositoryId: string,
  branch: string,
  expectedSha: string,
): Promise<void> {
  await githubGraphql(
    config,
    `mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }`,
    {
      input: {
        repositoryId,
        refUpdates: [
          {
            name: `refs/heads/${branch}`,
            beforeOid: expectedSha,
            afterOid: ZERO_OID,
            force: true,
          },
        ],
      },
    },
  );
}

/**
 * The branch's current tip, refusing what must never be deleted. A missing
 * branch throws GitHub's 404 with a readable prefix.
 */
async function deletableBranchTip(
  config: GithubApiConfig,
  repoPath: string,
  branch: string,
  defaultBranch: string | null,
  signal?: AbortSignal,
): Promise<string> {
  if (defaultBranch !== null && branch === defaultBranch)
    throw new Error(`${branch} is the repository's default branch.`);
  let data: { protected?: boolean; commit?: { sha?: string } };
  try {
    data = (
      await githubRequest<typeof data>(
        config,
        "GET",
        `${repoPath}/branches/${branchPath(branch)}`,
        signal !== undefined ? { signal } : {},
      )
    ).data;
  } catch (error) {
    if (/HTTP 404/.test(String(error)))
      throw new Error(`Branch ${branch} does not exist.`);
    throw error;
  }
  if (data.protected === true)
    throw new Error(`${branch} is a protected branch.`);
  if (typeof data.commit?.sha !== "string")
    throw new Error(`GitHub returned no commit for branch ${branch}.`);
  return data.commit.sha;
}

async function openPullRequestsUsing(
  config: GithubApiConfig,
  repoPath: string,
  owner: string,
  branch: string,
  signal?: AbortSignal,
): Promise<NonNullable<GithubBranchDeleteItem["openPullRequests"]>> {
  const out: NonNullable<GithubBranchDeleteItem["openPullRequests"]> = [];
  for (const role of ["head", "base"] as const) {
    const res = await githubRequest<
      Array<{ number?: number; title?: string; html_url?: string }>
    >(config, "GET", `${repoPath}/pulls`, {
      query: {
        state: "open",
        per_page: MAX_LISTED_PULLS,
        [role]: role === "head" ? `${owner}:${branch}` : branch,
      },
      ...(signal !== undefined ? { signal } : {}),
    });
    for (const pull of res.data)
      if (typeof pull.number === "number")
        out.push({
          number: pull.number,
          title: pull.title ?? "",
          url: pull.html_url ?? "",
          role,
        });
  }
  return out;
}

export const githubDeleteBranchTool = defineAgentTool<DeleteBranchParams>({
  name: "github_delete_branch",
  label: "GitHub: Delete Remote Branches",
  description:
    "Prepare deleting branches on a GitHub repository for the user to approve. The default branch and protected branches are refused. The card lists open pull requests still using each branch: deleting a PR's head closes it, deleting its base closes it too. Approval deletes the commit each branch pointed at when proposed; a branch that moved since is left alone. For a managed worktree's own branch, worktree_remove handles cleanup. Never deletes until approved.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "branches"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      branches: {
        type: "array",
        items: { type: "string" },
        description: `Branch names without 'refs/heads/', at most ${MAX_BRANCHES}.`,
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const { owner, repo } = resolveRepo(params.repo);
    const repoPath = repoPathOf(owner, repo);
    const branches = [
      ...new Set(
        (params.branches ?? [])
          .map((name) =>
            String(name)
              .trim()
              .replace(/^refs\/heads\//, ""),
          )
          .filter(Boolean),
      ),
    ];
    if (!branches.length) throw new Error("Name at least one branch.");
    if (branches.length > MAX_BRANCHES)
      throw new Error(`At most ${MAX_BRANCHES} branches per proposal.`);
    const { defaultBranch } = await repositoryOf(config, repoPath, ctx.signal);
    const items: GithubBranchDeleteItem[] = [];
    for (const branch of branches) {
      const headSha = await deletableBranchTip(
        config,
        repoPath,
        branch,
        defaultBranch,
        ctx.signal,
      );
      const openPullRequests = await openPullRequestsUsing(
        config,
        repoPath,
        owner,
        branch,
        ctx.signal,
      );
      items.push({
        branch,
        headSha,
        ...(openPullRequests.length ? { openPullRequests } : {}),
      });
    }
    const pullCount = items.reduce(
      (sum, item) => sum + (item.openPullRequests?.length ?? 0),
      0,
    );
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "githubBranchDelete",
      title:
        items.length === 1
          ? `Delete branch ${items[0]!.branch}`
          : `Delete ${items.length} branches`,
      summary: `${owner}/${repo}${pullCount ? ` · ${pullCount} open pull request(s) affected` : ""}`,
      sourceToolCallId: ctx.toolCallId,
      body: { kind: "githubBranchDelete", repo: `${owner}/${repo}`, items },
    });
    const pullNote = pullCount
      ? ` ${pullCount} open pull request(s) still use these branches and would be closed.`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `Prepared deleting ${items.map((item) => item.branch).join(", ")} in ${owner}/${repo} pending your approval.${pullNote} Do not claim it succeeded until the approved result appears. ${approvalCardReference(card)}`,
        },
      ],
      terminate: true,
    };
  },
});

registerApprovalExecutor("githubBranchDelete", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "githubBranchDelete")
      throw new Error("Mismatched approval body for githubBranchDelete.");
    const b = card.body;
    const config = getGithubToolConfig();
    const [owner, repo] = b.repo.split("/");
    const repoPath = repoPathOf(owner!, repo!);
    // Re-checked now: protection or the default may have changed while the
    // card waited.
    const { defaultBranch, nodeId } = await repositoryOf(config, repoPath);
    if (!nodeId)
      throw new Error(
        `GitHub returned no node id for ${b.repo}; nothing was deleted.`,
      );
    for (const item of b.items) {
      try {
        const tip = await deletableBranchTip(
          config,
          repoPath,
          item.branch,
          defaultBranch,
        );
        if (tip !== item.headSha)
          throw new Error(
            `${item.branch} moved to ${tip.slice(0, 12)} since the proposal (${item.headSha.slice(0, 12)}); not deleted.`,
          );
        // The read above names a move in words; the atomic check is what
        // stops one that lands between that read and this write.
        await deleteBranchAt(config, nodeId, item.branch, item.headSha);
        item.deleted = true;
        delete item.error;
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
      }
    }
    const deleted = b.items.filter((item) => item.deleted);
    const failed = b.items.filter((item) => item.error);
    if (!deleted.length)
      throw new Error(failed.map((item) => item.error).join("; "));
    return {
      resultSummary: [
        `Deleted ${deleted.map((item) => item.branch).join(", ")} in ${b.repo}`,
        ...failed.map((item) => `failed: ${item.error}`),
      ].join("; "),
      resultUrl: `https://github.com/${b.repo}/branches`,
    };
  },
});

/** Coding-persona repository operations (catalog group `github-repo-writes`). */
export const githubRepoWriteTools = [
  githubRerunActionsRunTool,
  githubDeleteBranchTool,
];
