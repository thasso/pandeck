/**
 * The derivations every managed delivery tool shares: what a registered
 * spawned worktree currently IS locally, where it publishes, and which hosted
 * repository that publication target belongs to.
 *
 * They live here rather than in one tool module because commit/push/PR creation
 * and PR finishing must agree exactly on those answers: a second derivation of
 * "the remote head" or "the provider repository" is a second chance to target
 * something the caller never asked for.
 */
import { git, gitOptional, resolveRepoRoot } from "../../gitExec.ts";
import {
  hostingProviderForRepo,
  parseRemoteUrl,
  type GitHostingProvider,
  type RemoteRepoRef,
} from "../../gitHosting.ts";
import type { WorktreeRow } from "../../db/worktreeStore.ts";
import {
  readRemoteBranchOid,
  resolvePushTarget,
  type ResolvedPushTarget,
} from "../../pushWorkflow.ts";

/** The managed checkout as git reports it right now. */
export interface ManagedWorktreeLocalState {
  branch: string;
  head: string;
  clean: boolean;
}

export async function readManagedLocalState(
  row: WorktreeRow,
  signal?: AbortSignal,
): Promise<ManagedWorktreeLocalState> {
  const [branch, head, status] = await Promise.all([
    gitOptional(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      row.path,
      signal,
    ),
    git(["rev-parse", "HEAD^{commit}"], row.path, signal),
    git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      row.path,
      signal,
    ),
  ]);
  return {
    branch: branch.code === 0 ? branch.stdout.trim() : "",
    head: head.stdout.trim(),
    clean: status.stdout.trim() === "",
  };
}

export async function resolveManagedPushTarget(
  row: WorktreeRow,
  signal?: AbortSignal,
): Promise<ResolvedPushTarget> {
  const repoRoot = await resolveRepoRoot(row.path, signal);
  return resolvePushTarget(repoRoot, row.branch, undefined, signal);
}

export function readManagedRemoteHead(
  target: ResolvedPushTarget,
  branch: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return readRemoteBranchOid(target.repoRoot, target.remote, branch, signal);
}

/** The hosted repository behind a managed worktree's publication target. */
export interface ManagedHostingTarget {
  provider: GitHostingProvider;
  repository: RemoteRepoRef;
}

export async function resolveManagedHosting(
  target: ResolvedPushTarget,
  signal?: AbortSignal,
): Promise<ManagedHostingTarget | undefined> {
  const remoteUrl = await gitOptional(
    ["remote", "get-url", "--push", target.remote],
    target.repoRoot,
    signal,
  );
  const repository =
    remoteUrl.code === 0 ? parseRemoteUrl(remoteUrl.stdout.trim()) : null;
  if (!repository)
    throw new Error(
      `The derived push remote "${target.remote}" does not name a supported repository URL.`,
    );
  const provider = await hostingProviderForRepo(target.repoRoot, target.remote);
  return provider ? { provider, repository } : undefined;
}

function sameRepository(a: RemoteRepoRef, b: RemoteRepoRef): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/**
 * The remote argument passed into `hostingProviderForRepo` is the real binding.
 * This identity assertion is belt-and-braces over that same push URL and
 * protects injected/custom provider seams from describing another repository.
 */
export function assertManagedProviderRepository(
  hosted: ManagedHostingTarget,
  remote: string,
  refusal: string,
): void {
  const providerRepository =
    hosted.provider.repository ?? parseRemoteUrl(hosted.provider.repoWebUrl);
  if (
    !providerRepository ||
    !sameRepository(providerRepository, hosted.repository)
  )
    throw new Error(
      `The configured ${hosted.provider.kind} provider does not describe the repository behind push remote "${remote}"; ${refusal}`,
    );
}
