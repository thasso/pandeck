/**
 * Resolving THIS build's identity, once, for whoever is asking.
 *
 * Two callers, deliberately the same code: the server (which reports its build
 * on every `ready` frame) and `app/web/vite.config.ts`, which bakes the answer
 * into the browser bundle as a define. A single resolver is what makes the two
 * numbers comparable in Settings → About; two implementations would drift on
 * exactly the case that matters (a Nix build, where git is absent).
 *
 * Order of trust: the environment first, git second, nothing third. The
 * environment is how a build that has no `.git` — the Nix package is built from
 * a gitignore-filtered source tree — still knows its commit: `flake.nix` passes
 * `self.rev` in as `ASSISTANT_BUILD_COMMIT`. Git is the local-development and
 * shell-build path. Neither is required: a build that knows only its version
 * says only its version, which is honest and enough.
 *
 * The git calls are synchronous and do not go through `gitExec.ts` on purpose:
 * this is not a repository operation on a user's checkout but one question about
 * the tree this process was built from, asked at most once per process (and never
 * at all in a packaged build, where the environment already answered). Vite's
 * `define` also needs the answer synchronously while it builds its config.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildInfo } from "@assistant/shared/buildInfo";
import { RUNTIME_ASSET_ROOT } from "./runtimeAssets.ts";

/**
 * Manifest root for this build. Development reads the checkout; a packaged
 * executable reads the explicit immutable runtime layout beside it.
 */
const REPO_ROOT = RUNTIME_ASSET_ROOT;

// Capture the packaged build stamp during module initialization. Server startup
// scrubs process.env before resolveBuildInfo may fall back to a git subprocess.
const SERVER_BUILD_COMMIT = process.env.ASSISTANT_BUILD_COMMIT?.trim();

/**
 * The one declared version. Read from the ROOT manifest rather than the server's
 * own so there is a single file to be wrong: `release:check` already refuses a
 * release whose declarations disagree.
 */
function declaredVersion(root: string): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    const version =
      typeof manifest === "object" && manifest !== null
        ? (manifest as { version?: unknown }).version
        : undefined;
    if (typeof version === "string" && version) return version;
  } catch {
    // Falls through to the placeholder below.
  }
  // Only reachable if the tree is broken; naming that beats an empty string in
  // an About panel.
  return "unknown";
}

/** A git question whose "no" — no repository, no git binary — is just undefined. */
function git(root: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** A commit sha as git writes them, or undefined for anything else. */
function validCommit(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}

/**
 * Resolve the build identity of the tree at `root`.
 *
 * Not memoized here: the server memoizes below, and the Vite config calls it
 * once per build. Doing the git work eagerly on every call would put three
 * subprocesses in the hot path of nothing.
 */
export function resolveBuildInfo(
  root: string = REPO_ROOT,
  buildCommit: string | undefined = process.env.ASSISTANT_BUILD_COMMIT?.trim(),
): BuildInfo {
  const version = declaredVersion(root);
  const stamped = validCommit(buildCommit);
  if (stamped) {
    // A stamped build was packaged from a source tree, not a checkout: it knows
    // its commit exactly and has no tags to consult, so `release` stays unknown
    // rather than becoming a guess.
    return { version, commit: stamped };
  }
  const commit = validCommit(git(root, "rev-parse", "HEAD"));
  if (!commit) return { version };
  // `--points-at` rather than `describe`: the question is whether THIS commit is
  // the release, and a commit can carry several tags.
  const tags = git(root, "tag", "--points-at", "HEAD");
  const release =
    tags === undefined
      ? undefined
      : tags.split("\n").includes(`v${version}`) ||
        tags.split("\n").includes(version);
  // Tracked-file changes only (`--porcelain -uno`): an untracked scratch file in
  // a checkout is not a different build of the app.
  const status = git(root, "status", "--porcelain", "-uno");
  const dirty = status === undefined ? undefined : status.length > 0;
  return {
    version,
    commit,
    ...(release === undefined ? {} : { release }),
    ...(dirty ? { dirty } : {}),
  };
}

let cached: BuildInfo | undefined;

/** This server process's build identity, resolved once per process. */
export function serverBuildInfo(): BuildInfo {
  cached ??= resolveBuildInfo(REPO_ROOT, SERVER_BUILD_COMMIT);
  return cached;
}
