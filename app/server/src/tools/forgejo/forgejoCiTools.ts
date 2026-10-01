/**
 * Forgejo CI read tools (catalog group `forgejo-ci`, gate `forgejo`): ref
 * checks and Actions workflow runs against the configured instance, the twin of
 * `../github/githubTools.ts`'s `github-ci` group. Helpers (`resolveForgejoRepo`,
 * `dropNulls`, `clamp`, `compactUser`) come from the read module
 * `./forgejoTools.ts`, as `forgejoPrWriteTools.ts` takes its resolver there too.
 *
 * Everything here stays on API v1. Three Forgejo realities shape the group, and
 * each is a deliberate divergence from the GitHub twin rather than an omission:
 *
 *  - there is NO check-runs concept — Actions jobs report as ordinary commit
 *    statuses — so `forgejo_get_ref_checks` is one endpoint, shared with
 *    `gitHosting.ts`'s `ciStatus` through `forgejoClient.forgejoRefChecks`;
 *  - `GET /actions/runs/{run_id}` answers with the RUN ALONE: API v1 has no
 *    per-run jobs/steps route. Jobs are recovered from the repo-wide task list
 *    (`GET /actions/tasks`) by run number, scanned newest-first under a page
 *    budget — so a run far enough back reports its jobs as unavailable, and one
 *    the budget cuts through reports them as possibly incomplete, rather than
 *    paging the whole history. Tasks carry no per-step breakdown, so `steps`
 *    has no Forgejo equivalent at all;
 *  - there is NO job-log tool. Logs live only on Forgejo's WEB routes
 *    (`POST /{o}/{r}/actions/runs/{run}/jobs/{job}/attempt/{n}` and its
 *    `/logs` sibling), and a probe against Forgejo 15.0.6 established that an
 *    API token does not authenticate there in ANY form — `token`, `Bearer`,
 *    basic auth, and `?token=` all still bounce `/notifications` to
 *    `/user/login`. Those routes answer for a PUBLIC repository because they
 *    permit anonymous reads, not because the token was accepted, so a log tool
 *    built on them would work until pointed at a private repo and then fail for
 *    a reason no caller could act on. `url` on a run is the way to the log.
 */
import { defineAgentTool } from "../../mcp/tool.ts";
import { getForgejoToolConfig } from "../../forgejoSettings.ts";
import {
  absoluteForgejoUrl,
  forgejoRefChecks,
  forgejoRequest,
  normalizeForgejoBaseUrl,
  type ForgejoApiConfig,
} from "../../forgejoClient.ts";
import { forgejoProvider } from "../../gitHosting.ts";
import { createPullRequestCheckWatchTool } from "../pullRequestCheckWatch.ts";
import {
  clamp,
  compactUser,
  dropNulls,
  resolveForgejoRepo,
} from "./forgejoTools.ts";

type GetRefChecksParams = {
  repo: string;
  ref: string;
  includeHistory?: boolean;
};

type ListActionsRunsParams = {
  repo: string;
  ref?: string;
  headSha?: string;
  event?: string;
  status?: string;
  workflowId?: string;
  runNumber?: number;
  maxResults?: number;
};

type GetActionsRunParams = {
  repo: string;
  runId: number;
  includeJobs?: boolean;
  maxJobs?: number;
};

/** Superseded status rows kept when `includeHistory` is on. */
const MAX_STATUS_HISTORY = 50;

/** Tasks read per page while looking for one run's jobs. */
const TASK_PAGE_SIZE = 50;

/** Task pages scanned before a run is declared too old for the jobs lookup. */
const MAX_TASK_PAGES = 4;

export const forgejoWatchPullRequestChecksTool =
  createPullRequestCheckWatchTool({
    name: "forgejo_watch_pull_request_checks",
    label: "Forgejo: Watch Pull Request Checks",
    providerName: "Forgejo",
    repoDescription: "Repository as 'owner/repo'.",
    resolve(repoInput, signal) {
      const config = getForgejoToolConfig();
      const { owner, repo } = resolveForgejoRepo(repoInput);
      const canonicalRepo = `${owner}/${repo}`;
      const baseUrl = normalizeForgejoBaseUrl(config.baseUrl);
      return {
        repo: canonicalRepo,
        provider: forgejoProvider(
          { host: new URL(baseUrl).hostname, owner, repo },
          config,
          signal,
        ),
        pullRequestUrl: (number) =>
          `${baseUrl}/${canonicalRepo}/pulls/${number}`,
      };
    },
  });

export const forgejoGetRefChecksTool = defineAgentTool<GetRefChecksParams>({
  name: "forgejo_get_ref_checks",
  label: "Forgejo: Ref Checks",
  description:
    "Aggregate CI for a branch/tag/SHA on the configured Forgejo instance — 'is CI green on this branch?'. Forgejo has no check-runs: Actions jobs report as commit statuses, one per job, rolled up into an overall state where the worst context wins. Read-only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "ref"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      ref: { type: "string", description: "Branch name, tag, or commit SHA." },
      includeHistory: {
        type: "boolean",
        description:
          "Also return superseded status rows (a context reported pending before it reported success). Defaults to false.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getForgejoToolConfig();
    const { owner, repo } = resolveForgejoRepo(params.repo);
    const ref = params.ref.trim();
    if (!ref)
      throw new Error("ref must be a non-empty branch, tag, or commit SHA.");
    const summary = await forgejoRefChecks(
      config,
      owner,
      repo,
      ref,
      ctx.signal,
    );
    const history = params.includeHistory
      ? await fetchStatusHistory(config, owner, repo, ref, ctx.signal)
      : null;
    const payload = dropNulls({
      repo: `${owner}/${repo}`,
      ref,
      sha: summary.sha,
      state: summary.state,
      total: summary.total,
      // Only ever true, so a payload without the key is a complete answer.
      truncated: summary.truncated ? true : null,
      url: summary.url,
      statuses: summary.statuses.map((status) => dropNulls(status)),
      history,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

export const forgejoListActionsRunsTool =
  defineAgentTool<ListActionsRunsParams>({
    name: "forgejo_list_actions_runs",
    label: "Forgejo: List Actions Runs",
    description:
      "List Forgejo Actions workflow runs for a repository, filterable by ref, head SHA, event, status, and workflow file. Read-only. Follow a run up with forgejo_get_actions_run for its jobs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        ref: {
          type: "string",
          description:
            "Filter to a Git reference, e.g. 'main' or 'refs/heads/main'.",
        },
        headSha: {
          type: "string",
          description: "Filter to a head commit SHA.",
        },
        event: {
          type: "string",
          description:
            "Filter by triggering event, e.g. push, pull_request, schedule.",
        },
        status: {
          type: "string",
          description:
            "Filter by run status: success, failure, running, waiting, blocked, cancelled, or skipped. Forgejo reports status and conclusion in ONE field.",
        },
        workflowId: {
          type: "string",
          description: "Filter to a workflow FILENAME, e.g. 'ci.yml'.",
        },
        runNumber: {
          type: "number",
          description:
            "Filter to the run with this per-repository run number (the number in the run's web URL).",
        },
        maxResults: {
          type: "number",
          description: "Maximum runs to return. Defaults to 20, maximum 100.",
        },
      },
    },
    async execute(params, ctx) {
      const config = getForgejoToolConfig();
      const { owner, repo } = resolveForgejoRepo(params.repo);
      const maxResults = clamp(params.maxResults, 20, 1, 100);
      const res = await forgejoRequest<{
        total_count?: number;
        workflow_runs?: Record<string, any>[];
      }>(
        config,
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`,
        {
          query: {
            ref: params.ref,
            head_sha: params.headSha,
            event: params.event,
            status: params.status,
            workflow_id: params.workflowId,
            run_number: params.runNumber,
            limit: maxResults,
          },
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      );
      // Sliced client-side as well as asked for: instances differ on whether
      // `limit` is honoured, and one that ignores it answered with all 447 runs.
      const runs = (res.data.workflow_runs ?? [])
        .slice(0, maxResults)
        .map((run) => compactRun(config, run));
      const payload = {
        repo: `${owner}/${repo}`,
        totalCount: res.data.total_count ?? runs.length,
        returned: runs.length,
        maxResults,
        runs,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  });

export const forgejoGetActionsRunTool = defineAgentTool<GetActionsRunParams>({
  name: "forgejo_get_actions_run",
  label: "Forgejo: Get Actions Run",
  description:
    "Fetch one Forgejo Actions run with its jobs and their statuses — the tool for 'which job failed'. Forgejo exposes no per-step breakdown and no log endpoint, so open the run's url for step detail and logs. Read-only. Bounded.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "runId"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      runId: {
        type: "number",
        description:
          "Actions run id — the `id` from forgejo_list_actions_runs, NOT the `runNumber` that appears in the run's web URL. The two differ.",
      },
      includeJobs: {
        type: "boolean",
        description:
          "Include the run's jobs with their statuses. Defaults to true. Recovered from the repo-wide task list, so a run far back in the history reports them as unavailable.",
      },
      maxJobs: {
        type: "number",
        description: "Maximum jobs to return. Defaults to 30, maximum 100.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getForgejoToolConfig();
    const { owner, repo } = resolveForgejoRepo(params.repo);
    const runId = clamp(params.runId, 0, 1, Number.MAX_SAFE_INTEGER);
    const res = await forgejoRequest<Record<string, any>>(
      config,
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`,
      { ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
    );
    const run = res.data ?? {};
    const runNumber =
      typeof run.index_in_repo === "number" ? run.index_in_repo : null;

    const jobs =
      params.includeJobs === false || runNumber === null
        ? null
        : await fetchRunJobs(config, owner, repo, {
            runNumber,
            maxJobs: clamp(params.maxJobs, 30, 1, 100),
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          });

    const payload = {
      repo: `${owner}/${repo}`,
      run: dropNulls({
        ...compactRun(config, { ...run, id: run.id ?? runId }),
        ...(jobs
          ? dropNulls({ jobs: jobs.jobs, jobsNote: jobs.note })
          : { jobsNote: jobsUnavailableNote(params, runNumber) }),
      }),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

/**
 * Why a run answered without jobs. `includeJobs: false` was asked for and needs
 * no explanation; a run the instance described without a run number cannot be
 * matched to tasks at all, and saying so beats an empty `jobs` array that reads
 * as "this run had no jobs".
 */
function jobsUnavailableNote(
  params: GetActionsRunParams,
  runNumber: number | null,
): string | null {
  if (params.includeJobs === false) return null;
  return runNumber === null
    ? "Jobs unavailable: the run carries no run number to match its tasks against."
    : null;
}

/** One run in the compact shape both run tools return. */
function compactRun(
  config: ForgejoApiConfig,
  run: Record<string, any>,
): Record<string, unknown> {
  return dropNulls({
    id: run.id ?? null,
    // Forgejo's own name for the run's per-repo number; it, not `id`, is what
    // the web URL shows, and the two are routinely off by one.
    runNumber: run.index_in_repo ?? null,
    title: run.title ?? null,
    workflowId: run.workflow_id ?? null,
    ref: run.prettyref ?? null,
    headSha:
      typeof run.commit_sha === "string" ? run.commit_sha.slice(0, 12) : null,
    event: run.event ?? run.trigger_event ?? null,
    // Forgejo folds GitHub's status and conclusion into one field.
    status: run.status ?? null,
    actor: compactUser(run.trigger_user),
    url: absoluteForgejoUrl(config.baseUrl, run.html_url),
    startedAt: run.started ?? null,
    stoppedAt: run.stopped ?? null,
    createdAt: run.created ?? null,
    updatedAt: run.updated ?? null,
  });
}

/** Superseded status rows for a ref, bounded and newest-first as Forgejo returns them. */
async function fetchStatusHistory(
  config: ForgejoApiConfig,
  owner: string,
  repo: string,
  ref: string,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const res = await forgejoRequest<Record<string, any>[]>(
    config,
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/statuses`,
    {
      query: { limit: MAX_STATUS_HISTORY },
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  return (Array.isArray(res.data) ? res.data : [])
    .slice(0, MAX_STATUS_HISTORY)
    .map((status) =>
      dropNulls({
        context: status.context ?? null,
        state: status.status ?? null,
        url: absoluteForgejoUrl(config.baseUrl, status.target_url),
        description: status.description ?? null,
        createdAt: status.created_at ?? null,
      }),
    );
}

/**
 * One run's jobs, from the repo-wide `GET /actions/tasks` list.
 *
 * API v1 has no per-run jobs route, and tasks are a flat repo-wide feed ordered
 * newest task first — so run numbers descend, but INTERLEAVE where runs overlap
 * in time (`447, 447, 446, 446, 447, …` is ordinary). The scan therefore stops
 * only once a whole page sits entirely below the target run, never at the first
 * lower row, and gives up after `MAX_TASK_PAGES` rather than walking a history
 * of thousands.
 *
 * The budget can run out in two different places, and BOTH are said out loud
 * rather than answered as if they were the whole truth: before the run's window
 * (no matches — reported unavailable, since an empty `jobs` list would read as
 * "no jobs ran"), and INSIDE it (some matches, but the interleaving above means
 * more may sit on the page that was never fetched — reported as possibly
 * incomplete).
 */
async function fetchRunJobs(
  config: ForgejoApiConfig,
  owner: string,
  repo: string,
  options: {
    runNumber: number;
    maxJobs: number;
    signal?: AbortSignal;
  },
): Promise<{
  jobs: Array<Record<string, unknown>> | null;
  note: string | null;
}> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/tasks`;
  const matches: Record<string, any>[] = [];
  let reachedWindow = false;
  // The scan saw PAST the run's window, so what it collected is all of it.
  // Only a short page or a page lying entirely below the run establishes that;
  // exhausting the page budget never does.
  let scanComplete = false;

  for (let page = 1; page <= MAX_TASK_PAGES; page++) {
    const res = await forgejoRequest<{ workflow_runs?: Record<string, any>[] }>(
      config,
      "GET",
      path,
      {
        query: { page, limit: TASK_PAGE_SIZE },
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    const tasks = (res.data.workflow_runs ?? []).slice(0, TASK_PAGE_SIZE);
    // Run numbers are repo-wide, so the number alone identifies the run; a
    // second guard on the workflow would only add a way to match NOTHING if the
    // two endpoints ever spell the workflow differently (`ci.yml` against
    // `.forgejo/workflows/ci.yml`), which reads as "this run had no jobs".
    for (const task of tasks) {
      if (task.run_number === options.runNumber) matches.push(task);
    }
    if (tasks.some((task) => task.run_number <= options.runNumber))
      reachedWindow = true;
    if (tasks.length < TASK_PAGE_SIZE) {
      scanComplete = true;
      break;
    }
    // The page's HIGHEST run number: below the target means the whole page has
    // dropped past the run, which is the only safe place to stop while adjacent
    // runs interleave.
    const pageCeiling = Math.max(
      ...tasks.map((task) =>
        typeof task.run_number === "number" ? task.run_number : -1,
      ),
    );
    if (pageCeiling < options.runNumber) {
      scanComplete = true;
      break;
    }
  }

  if (!matches.length)
    return reachedWindow || scanComplete
      ? { jobs: [], note: "No jobs are recorded for this run." }
      : {
          jobs: null,
          note: `Jobs unavailable: run ${options.runNumber} is further back than the ${MAX_TASK_PAGES * TASK_PAGE_SIZE}-task scan reaches. Open the run's url for its jobs.`,
        };

  // Oldest task first, which is the order the jobs started in.
  const ordered = matches.reverse();
  const jobs = ordered.slice(0, options.maxJobs).map((task) =>
    dropNulls({
      id: task.id ?? null,
      name: task.name ?? null,
      // Forgejo reports a job's outcome in the same single field a run uses.
      status: task.status ?? null,
      startedAt: task.run_started_at ?? null,
      updatedAt: task.updated_at ?? null,
    }),
  );
  const notes: string[] = [];
  if (ordered.length > jobs.length)
    notes.push(
      `Showing ${jobs.length} of ${ordered.length} jobs; raise maxJobs for the rest.`,
    );
  // The budget ended mid-window: more of this run's jobs may sit on the page
  // that was never fetched, so the list is offered as partial, not as the run.
  if (!scanComplete)
    notes.push(
      `These jobs may be incomplete: the ${MAX_TASK_PAGES * TASK_PAGE_SIZE}-task scan ended inside run ${options.runNumber}'s window. Open the run's url for the full list.`,
    );
  return { jobs, note: notes.join(" ") || null };
}

/** Ref checks and Actions runs/jobs (catalog group `forgejo-ci`). */
export const forgejoCiTools = [
  forgejoWatchPullRequestChecksTool,
  forgejoGetRefChecksTool,
  forgejoListActionsRunsTool,
  forgejoGetActionsRunTool,
];
