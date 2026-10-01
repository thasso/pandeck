/**
 * Which build of the app a surface is: the version the tree declared, and the
 * commit it was built from.
 *
 * Every runtime resolves this the same way — the declared SemVer plus what git
 * said at BUILD time — because none of them can ask afterwards: the web bundle
 * is static assets, the server runs from an immutable store path with no `.git`,
 * and the shell is a signed binary. So the answer is stamped in and travels:
 * the shell reports its own through `shell_info`, the server reports its own on
 * the `ready` frame, and the web bundle carries its own as a build-time define.
 *
 * The three are independent on purpose. The shell is installed and updated by
 * hand, the browser bundle comes from whichever server it loaded, and the server
 * is deployed separately — so "which version am I running" is three answers, and
 * Settings → About shows all three rather than pretending they agree.
 */

/** One runtime's build identity. Every field beyond `version` may be unknown. */
export interface BuildInfo {
  /** The SemVer this tree declared (`pnpm run version:set` owns every copy). */
  version: string;
  /** Full commit sha the build came from, absent when the build had no git. */
  commit?: string;
  /**
   * Whether this commit carries the `v<version>` release tag — that is, whether
   * the declared version is the truth about this build or just the last release
   * the branch is descended from.
   *
   * Tri-state on purpose: `false` means the build POSITIVELY is not the tagged
   * release (a local or CI build ahead of the tag), while `undefined` means the
   * build could not tell — a Nix build sees a `.git`-less source tree, so it
   * knows its commit but never its tags, and must not claim either way.
   */
  release?: boolean;
  /** Whether the working tree had uncommitted changes when this was built. */
  dirty?: boolean;
}

/** How many hex characters of a sha identify a commit in this UI. */
const SHORT_COMMIT_LENGTH = 8;

/** Abbreviated sha, or undefined when the build did not know its commit. */
export function shortCommit(commit: string | undefined): string | undefined {
  return commit ? commit.slice(0, SHORT_COMMIT_LENGTH) : undefined;
}

/**
 * The version to SHOW. A build known not to be the tagged release is suffixed
 * `-dev`, so `0.14.1` never means two different things: at the tag it is the
 * release, and ten commits later it is `0.14.1-dev`.
 */
export function buildVersionLabel(info: BuildInfo): string {
  return info.release === false ? `${info.version}-dev` : info.version;
}

/** The build's commit as a label: `88b944c8`, or `88b944c8-dirty` for a modified tree. */
export function buildCommitLabel(info: BuildInfo): string | undefined {
  const short = shortCommit(info.commit);
  if (!short) return undefined;
  return info.dirty ? `${short}-dirty` : short;
}

/**
 * One line naming this build — `0.14.1 (88b944c8)` — for an About panel or a
 * copied diagnostic. The commit is dropped rather than faked when unknown.
 */
export function formatBuildInfo(info: BuildInfo): string {
  const commit = buildCommitLabel(info);
  return commit
    ? `${buildVersionLabel(info)} (${commit})`
    : buildVersionLabel(info);
}
