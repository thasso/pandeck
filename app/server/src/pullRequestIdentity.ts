/**
 * Identity of ONE pull request, for the server-side joins that must not confuse
 * two of them.
 *
 * A number alone is not an identity: every repository numbers its pull requests
 * from 1, so two Forgejo projects both having #7 is ordinary, and so is one
 * project whose spawned worktree publishes to a `pushurl` repository while its
 * main checkout lists another. Joining on `<provider>#<number>` attaches one
 * repository's sessions, Tasks, authorship or review state to another's pull
 * request.
 *
 * The key is therefore `<provider>#<owner>/<repo>#<number>`, derived from any
 * repository or pull-request URL the provider gave us. The HOST is deliberately
 * left out. One provider kind resolves to one configured instance here (GitHub
 * only for `github.com`, Forgejo only for its configured base URL), so
 * `owner/repo` already separates repositories — while the same repository's web
 * URL legitimately appears under different roots (a Forgejo `ROOT_URL` that
 * differs from the base URL we build repository links from). Keying on the host
 * would split one repository's identity in two, which is the failure this
 * module exists to prevent; the collision it would guard against cannot happen
 * with a single instance per provider kind.
 */
import type { GitHostingProviderKind } from "@assistant/shared";

/**
 * `owner/repo`, lowercased, from a repository URL *or* a pull-request URL
 * (`…/owner/repo`, `…/owner/repo/pull/7`, `…/owner/repo/pulls/7`). `undefined`
 * when the URL proves no repository — identity is never guessed.
 */
export function repositoryKeyFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  let path = trimmed;
  try {
    path = new URL(trimmed).pathname;
  } catch {
    // Not absolute; fall back to treating the whole value as a path.
  }
  const segments = path.split("/").filter(Boolean);
  // Drop the pull-request tail, if this was a pull-request URL.
  if (
    segments.length > 2 &&
    /^\d+$/.test(segments[segments.length - 1]!) &&
    /^pulls?$/i.test(segments[segments.length - 2]!)
  )
    segments.splice(-2, 2);
  if (segments.length < 2) return undefined;
  const repo = segments[segments.length - 1]!.replace(/\.git$/i, "");
  const owner = segments[segments.length - 2]!;
  if (!repo || !owner) return undefined;
  return `${owner}/${repo}`.toLowerCase();
}

/** Both halves of one pull request's identity, resolved together. */
export interface PullRequestIdentity {
  /**
   * `owner/repo`, lowercased. Addressable on its own, because a CLIENT has to
   * name the repository too: `/pull-requests/:projectId/:number` would be
   * ambiguous for exactly the case above, where one project holds two
   * repositories that both number a pull request 7.
   */
  repositoryKey: string;
  /** The full join key `<provider>#<owner>/<repo>#<number>`. */
  key: string;
}

/**
 * The identity of one pull request. `undefined` when the URL proves no
 * repository: a caller then contributes nothing rather than joining on a
 * number, which is exactly the confusion described above.
 */
export function pullRequestIdentity(
  provider: GitHostingProviderKind,
  url: string,
  number: number,
): PullRequestIdentity | undefined {
  const repositoryKey = repositoryKeyFromUrl(url);
  if (!repositoryKey) return undefined;
  return { repositoryKey, key: `${provider}#${repositoryKey}#${number}` };
}

/**
 * This pull request's identity THROUGH a resolved provider, or `undefined` when
 * that provider speaks for another repository.
 *
 * Both halves matter, which is why the check and the key are one call. The
 * check is what stops one repository's number from reaching another's pull
 * request; the key it returns is derived from the PROVIDER rather than
 * assembled from the request, and only a key derived that way matches the
 * entries the inventory wrote under it.
 */
export function pullRequestIdentityThrough(
  provider: { kind: GitHostingProviderKind; repoWebUrl: string },
  target: {
    provider: GitHostingProviderKind;
    repositoryKey: string;
    number: number;
  },
): PullRequestIdentity | undefined {
  if (provider.kind !== target.provider) return undefined;
  const identity = pullRequestIdentity(
    provider.kind,
    provider.repoWebUrl,
    target.number,
  );
  return identity?.repositoryKey === target.repositoryKey
    ? identity
    : undefined;
}

/** Just the join key, for a caller that has nothing to address. */
export function pullRequestKey(
  provider: GitHostingProviderKind,
  url: string,
  number: number,
): string | undefined {
  return pullRequestIdentity(provider, url, number)?.key;
}
