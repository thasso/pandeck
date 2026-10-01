import {
  getGithubDefaultOwner,
  getGithubToolConfig,
  isGithubConfigured,
} from "../../githubSettings.ts";
import { githubRequest, type GithubApiConfig } from "../../githubClient.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

const MAX_REPOS = 15;
const PER_REPO_RELEASES = 10;
const PER_REPO_DEPLOYMENTS = 20;
const PER_REPO_CI_RUNS = 30;
const CONCURRENCY = 4;

interface Repo {
  name?: string;
  full_name?: string;
  pushed_at?: string;
  archived?: boolean;
}
interface Release {
  id?: number;
  tag_name?: string;
  name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  html_url?: string;
  author?: { login?: string } | null;
}
interface Deployment {
  id?: number;
  environment?: string;
  ref?: string;
  created_at?: string;
  creator?: { login?: string } | null;
}
interface WorkflowRun {
  id?: number;
  name?: string;
  head_branch?: string;
  event?: string;
  conclusion?: string | null;
  created_at?: string;
  html_url?: string;
}

/** True when an ISO timestamp falls inside the day window. */
export function inWindowIso(
  at: string | null | undefined,
  window: { startMs: number; endMs: number },
): boolean {
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms >= window.startMs && ms < window.endMs;
}

/** A published release → one fact. Semantics: a delivery EVENT (occurred at publish time). */
export function releaseFact(
  repo: string,
  release: Release,
  observedAt: string,
): DaySourceFact {
  return {
    id: `ghr:${repo}:${release.id}`,
    kind: "release",
    occurredAt: release.published_at ?? null,
    observedAt,
    actor: release.author?.login ?? null,
    title: `${repo} ${release.tag_name ?? release.name ?? ""}`.trim(),
    links: release.html_url
      ? [release.html_url]
      : [`https://github.com/${repo}/releases`],
    data: {
      repo,
      tag: release.tag_name ?? null,
      name: release.name ?? null,
      prerelease: Boolean(release.prerelease),
      publishedAt: release.published_at ?? null,
    },
    tags: ["release", "attention"],
  };
}

/** A deployment created in-window → one fact. Semantics: a delivery EVENT to an environment. */
export function deploymentFact(
  repo: string,
  deployment: Deployment,
  observedAt: string,
): DaySourceFact {
  return {
    id: `ghd:${repo}:${deployment.id}`,
    kind: "deployment",
    occurredAt: deployment.created_at ?? null,
    observedAt,
    actor: deployment.creator?.login ?? null,
    title: `${repo} → ${deployment.environment ?? "deploy"}`,
    links: [`https://github.com/${repo}/deployments`],
    data: {
      repo,
      environment: deployment.environment ?? null,
      ref: deployment.ref ?? null,
      createdAt: deployment.created_at ?? null,
    },
    tags: ["deployment", "attention"],
  };
}

/** A failed CI workflow run in-window → one fact. Semantics: an attention signal, not day-history. */
export function ciFailureFact(
  repo: string,
  run: WorkflowRun,
  observedAt: string,
): DaySourceFact {
  return {
    id: `ghc:${repo}:${run.id}`,
    kind: "ci-failure",
    occurredAt: run.created_at ?? null,
    observedAt,
    title: `${run.name ?? "CI"} failed on ${repo}`,
    links: run.html_url
      ? [run.html_url]
      : [`https://github.com/${repo}/actions`],
    data: {
      repo,
      workflow: run.name ?? null,
      branch: run.head_branch ?? null,
      event: run.event ?? null,
      conclusion: run.conclusion ?? "failure",
    },
    tags: ["ci-failure", "attention"],
  };
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++]!;
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
}

async function listRecentRepos(
  config: GithubApiConfig,
  owner: string,
  signal?: AbortSignal,
): Promise<Repo[]> {
  const query = { sort: "pushed", direction: "desc", per_page: MAX_REPOS };
  try {
    const res = await githubRequest<Repo[]>(
      config,
      "GET",
      `/orgs/${owner}/repos`,
      { query, ...(signal !== undefined ? { signal } : {}) },
    );
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    // Fall back to a user account when the owner is not an org.
    const res = await githubRequest<Repo[]>(
      config,
      "GET",
      `/users/${owner}/repos`,
      { query, ...(signal !== undefined ? { signal } : {}) },
    );
    return Array.isArray(res.data) ? res.data : [];
  }
}

/**
 * GitHub delivery + CI signals across the org's most recently pushed repos:
 * releases and deployments (delivery EVENTS, occurred-time facts) and failed CI
 * workflow runs (attention signals). Bounded to `MAX_REPOS` recently-active
 * repos with a small per-repo page, so cost stays predictable. `partial`
 * whenever a per-repo fetch errors — absence is never narrated as "no release".
 */
export const githubReleasesCollector: DaySourceCollector = {
  key: "github-releases",
  label: "GitHub releases",
  readiness() {
    if (!isGithubConfigured())
      return {
        ready: false,
        reason: "unconfigured",
        detail: "GitHub is not configured",
      };
    if (!getGithubDefaultOwner())
      return {
        ready: false,
        reason: "unconfigured",
        detail: "No default GitHub owner/org configured",
      };
    return { ready: true };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const config = getGithubToolConfig();
    const owner = getGithubDefaultOwner();
    const observedAt = new Date().toISOString();
    const window = { startMs: ctx.window.startMs, endMs: ctx.window.endMs };
    const sinceIso = new Date(ctx.window.startMs).toISOString();

    const repos = (await listRecentRepos(config, owner, ctx.signal))
      .filter((r) => r.name && !r.archived)
      .slice(0, MAX_REPOS);
    const facts: DaySourceFact[] = [];
    let errors = 0;

    await mapLimit(repos, CONCURRENCY, async (repo) => {
      const full = repo.full_name ?? `${owner}/${repo.name}`;
      try {
        const releases = await githubRequest<Release[]>(
          config,
          "GET",
          `/repos/${full}/releases`,
          {
            query: { per_page: PER_REPO_RELEASES },
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          },
        );
        for (const release of releases.data ?? []) {
          if (release.draft) continue;
          if (inWindowIso(release.published_at, window))
            facts.push(releaseFact(full, release, observedAt));
        }
        const deployments = await githubRequest<Deployment[]>(
          config,
          "GET",
          `/repos/${full}/deployments`,
          {
            query: { per_page: PER_REPO_DEPLOYMENTS },
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          },
        );
        for (const deployment of deployments.data ?? []) {
          if (inWindowIso(deployment.created_at, window))
            facts.push(deploymentFact(full, deployment, observedAt));
        }
        const runs = await githubRequest<{ workflow_runs?: WorkflowRun[] }>(
          config,
          "GET",
          `/repos/${full}/actions/runs`,
          {
            query: {
              status: "failure",
              per_page: PER_REPO_CI_RUNS,
              created: `>=${sinceIso}`,
            },
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          },
        );
        for (const run of runs.data?.workflow_runs ?? []) {
          if (inWindowIso(run.created_at, window))
            facts.push(ciFailureFact(full, run, observedAt));
        }
      } catch {
        errors += 1;
      }
    });

    ctx.cache.writeJson(ctx.date, "github-releases-raw", {
      repos: repos.length,
      facts: facts.length,
      errors,
    });
    return {
      result: errors > 0 ? "partial" : "complete",
      facts,
      completeness: { reposScanned: repos.length, perRepoErrors: errors },
      ...(errors > 0
        ? {
            notes: [
              `${errors} repo(s) failed to fetch; release/deployment/CI coverage is partial.`,
            ],
          }
        : {}),
    };
  },
};
