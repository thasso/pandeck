/**
 * Hosted web links for a finished push: the branch's page on its provider and
 * the branch's pull request, if one exists. They ride on the push card so the
 * reader can jump from "pushed" to where it went.
 *
 * Best effort by design. The push already happened; a provider that cannot be
 * resolved, a lookup that fails or takes too long only drops the links, never
 * the card. The remote's PUSH URL decides the provider, as for every other
 * provider read (`hostingProviderForRepo`).
 */
import type {
  GitHostingProviderKind,
  PushDisplay,
  PushHostedLinks,
  WorktreePullRequestInfo,
} from "@assistant/shared";
import {
  hostingProviderForRepo,
  type GitHostingProvider,
} from "./gitHosting.ts";
import { toPushDisplay, type PushWorkflowResult } from "./pushWorkflow.ts";

/** The pull-request read must not hold the push card back noticeably. */
const PULL_REQUEST_LOOKUP_TIMEOUT_MS = 5_000;

const BRANCH_PATH: Record<GitHostingProviderKind, string> = {
  github: "tree",
  forgejo: "src/branch",
};

/** The provider's web page for one branch; each ref segment is encoded. */
export function branchWebUrl(
  provider: Pick<GitHostingProvider, "kind" | "repoWebUrl">,
  branch: string,
): string {
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  return `${provider.repoWebUrl}/${BRANCH_PATH[provider.kind]}/${ref}`;
}

async function pullRequestFor(
  provider: GitHostingProvider,
  branch: string,
  timeoutMs: number,
): Promise<WorktreePullRequestInfo | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    const found = await Promise.race([
      provider.findPullRequestForBranch(branch).catch(() => null),
      timeout,
    ]);
    return found ?? undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePushLinks(
  result: PushWorkflowResult,
  options: {
    provider?: (
      repoRoot: string,
      remote: string,
    ) => Promise<GitHostingProvider | null>;
    timeoutMs?: number;
  } = {},
): Promise<PushHostedLinks | undefined> {
  // Only a branch the push provably updated is linked; its source may differ.
  const { repoRoot, remote, publishedBranch: branch } = result;
  if (result.status === "failed" || !repoRoot || !remote || !branch) return;
  try {
    const provider = await (options.provider ?? hostingProviderForRepo)(
      repoRoot,
      remote,
    );
    if (!provider) return;
    const pullRequest = await pullRequestFor(
      provider,
      branch,
      options.timeoutMs ?? PULL_REQUEST_LOOKUP_TIMEOUT_MS,
    );
    return {
      provider: provider.kind,
      branchUrl: branchWebUrl(provider, branch),
      ...(pullRequest ? { pullRequest } : {}),
    };
  } catch {
    return;
  }
}

/** {@link toPushDisplay} plus the hosted links, for every push card surface. */
export async function toLinkedPushDisplay(
  result: PushWorkflowResult,
): Promise<PushDisplay> {
  const hosted = await resolvePushLinks(result);
  return { ...toPushDisplay(result), ...(hosted ? { hosted } : {}) };
}
