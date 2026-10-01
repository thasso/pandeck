/**
 * App-side `git push` workflow behind the `/push` slash command and the
 * checked `worktree_push` agent tool.
 *
 * WHY THIS IS APP-SIDE (not native Bash):
 * The Claude Agent SDK's bundled Claude Code CLI has a git-safety gate that
 * denies every `git push` from the native Bash tool BEFORE the SDK permission
 * layer (`canUseTool`) is consulted — it is not overridable by
 * `permissionMode: "bypassPermissions"`, permission callbacks, hooks, or
 * `allowedTools` rules. `/push` and `worktree_push` therefore run git here,
 * outside the CLI. `/push` keeps its human-authorized free-form surface; the
 * agent tool supplies only server-derived targets and preconditions.
 */
import { relative } from "node:path";
import type { PushDisplay } from "@assistant/shared";
import { gitOptional, resolveRepoRoot } from "./gitExec.ts";
import { CWD } from "./config.ts";
import { errorText } from "./errors.ts";

/**
 * Non-interactive git/ssh environment: `/push` runs without a tty, so a remote
 * needing a password/passphrase or a new host key would otherwise hang forever.
 * These make git fail fast with a clear message instead (mirrors
 * `projectProvision.ts` `PROVISION_ENV`).
 */
const PUSH_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20",
};

export interface PushWorkflowOptions {
  /** Working directory whose enclosing git repo should be pushed. Defaults to app CWD. */
  cwd?: string;
  /** `--force` → bare `--force-with-lease`, retained for human/guarded callers. */
  force?: boolean;
  /** Strong agent mode: atomically require this exact current remote oid. */
  explicitLease?: { expectedRemoteOid: string };
  /** Explicit remote (positional arg 1). Defaults to the branch upstream's remote, else `origin`. */
  remote?: string;
  /** Explicit branch/refspec (positional arg 2). Defaults to the current branch. */
  branch?: string;
  /** Server-derived local identity preconditions for managed publication. */
  expectedBranch?: string;
  expectedHead?: string;
  /** Refuse publication if non-ignored index/working-tree changes remain. */
  requireClean?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ResolvedPushTarget {
  repoRoot: string;
  remote: string;
  upstream?: { remote: string; branch: string };
}

export interface PushWorkflowResult {
  status: "pushed" | "up-to-date" | "failed";
  repoRoot?: string;
  remote?: string;
  branch?: string;
  forced: boolean;
  setUpstream: boolean;
  /** Combined git stdout/stderr for display (git push reports progress on stderr). */
  output: string;
  error?: string;
}

export interface ParsedPushArgs {
  force: boolean;
  remote?: string;
  branch?: string;
}

/** Parse `/push [--force|-f] [remote] [branch]`. */
export function parsePushArgs(rawArgs: string): ParsedPushArgs {
  const parts = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let force = false;
  const positional: string[] = [];
  for (const part of parts) {
    const value = part.replace(/^(["'])([\s\S]*)\1$/, "$2");
    if (value === "--force" || value === "-f") force = true;
    else positional.push(value);
  }
  return {
    force,
    ...(positional[0] !== undefined ? { remote: positional[0] } : {}),
    ...(positional[1] !== undefined ? { branch: positional[1] } : {}),
  };
}

async function currentBranch(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await gitOptional(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoRoot,
    signal,
  );
  return res.code === 0 ? res.stdout.trim() : "HEAD";
}

/** The upstream ref (e.g. `origin/main`) for a named local branch. */
async function upstreamRef(
  repoRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const res = await gitOptional(
    [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${branch}@{upstream}`,
    ],
    repoRoot,
    signal,
  );
  const value = res.stdout.trim();
  return res.code === 0 && value ? value : undefined;
}

async function listRemotes(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await gitOptional(["remote"], repoRoot, signal);
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Resolve remote/upstream using the one policy shared by every push surface. */
export async function resolvePushTarget(
  repoRoot: string,
  branch: string,
  explicitRemote?: string,
  signal?: AbortSignal,
): Promise<ResolvedPushTarget> {
  const remotes = await listRemotes(repoRoot, signal);
  const tracked = await upstreamRef(repoRoot, branch, signal);
  // Longest match handles legal remote names containing `/`.
  const trackedRemote = tracked
    ? remotes
        .filter((remote) => tracked.startsWith(`${remote}/`))
        .sort((a, b) => b.length - a.length)[0]
    : undefined;
  const upstream =
    tracked && trackedRemote
      ? {
          remote: trackedRemote,
          branch: tracked.slice(trackedRemote.length + 1),
        }
      : undefined;

  let remote = explicitRemote ?? upstream?.remote;
  if (!remote) {
    if (remotes.includes("origin")) remote = "origin";
    else if (remotes.length === 1) remote = remotes[0]!;
    else if (remotes.length === 0)
      throw new Error("No git remote is configured for this repository.");
    else
      throw new Error(
        `Multiple remotes (${remotes.join(", ")}); a remote must be selected explicitly.`,
      );
  }
  return {
    repoRoot,
    remote,
    ...(upstream ? { upstream } : {}),
  };
}

/** Authoritatively read one exact remote branch without updating local refs. */
export async function readRemoteBranchOid(
  repoRoot: string,
  remote: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ref = `refs/heads/${branch}`;
  const result = await gitOptional(
    ["ls-remote", "--refs", remote, ref],
    repoRoot,
    signal,
    PUSH_ENV,
  );
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "Remote branch lookup failed.",
    );
  const line = result.stdout
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  if (!line) return undefined;
  const [oid, foundRef] = line.split(/\s+/, 2);
  if (foundRef !== ref || !oid || !/^[0-9a-fA-F]{40,64}$/.test(oid))
    throw new Error("The remote returned an invalid branch oid.");
  return oid.toLowerCase();
}

/** Build the exact push argv; exported so the lease shape remains testable. */
export function buildPushArgs(options: {
  remote: string;
  branch: string;
  source?: string;
  force: boolean;
  explicitLease?: { expectedRemoteOid: string };
  setUpstream: boolean;
}): string[] {
  const destination = `refs/heads/${options.branch}`;
  const args = ["push"];
  if (options.explicitLease)
    args.push(
      `--force-with-lease=${destination}:${options.explicitLease.expectedRemoteOid}`,
    );
  else if (options.force) args.push("--force-with-lease");
  if (options.setUpstream) args.push("--set-upstream");
  args.push(
    options.remote,
    options.source ? `${options.source}:${destination}` : options.branch,
  );
  return args;
}

async function localHead(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await gitOptional(["rev-parse", "HEAD"], repoRoot, signal);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function isClean(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await gitOptional(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repoRoot,
    signal,
  );
  return result.code === 0 && result.stdout.trim() === "";
}

/**
 * Run the push. Intentionally NOT under `withRepoLock`: push is a
 * network-bound operation that reads local refs and writes the remote plus
 * remote-tracking refs — it does not touch the index/working tree/local branch
 * refs, so it cannot corrupt a concurrent commit/merge, and holding the per-repo
 * lock across an unbounded network transfer would needlessly block those.
 */
export async function runPushWorkflow(
  options: PushWorkflowOptions,
): Promise<PushWorkflowResult> {
  const forced = Boolean(options.force || options.explicitLease);
  const base = (patch: Partial<PushWorkflowResult>): PushWorkflowResult => ({
    status: patch.status ?? "failed",
    forced,
    setUpstream: patch.setUpstream ?? false,
    output: patch.output ?? "",
    ...patch,
  });

  try {
    options.onProgress?.("Resolving repository…");
    const repoRoot = await resolveRepoRoot(options.cwd ?? CWD, options.signal);

    if (options.force && options.explicitLease)
      return base({
        status: "failed",
        repoRoot,
        error: "Push cannot combine legacy force and an explicit lease.",
      });
    if (options.explicitLease) {
      if (!/^[0-9a-fA-F]{40,64}$/.test(options.explicitLease.expectedRemoteOid))
        return base({
          status: "failed",
          repoRoot,
          error: "The explicit remote lease oid is invalid.",
        });
      if (
        options.expectedBranch === undefined ||
        options.expectedHead === undefined ||
        options.remote === undefined ||
        options.branch !== undefined ||
        options.requireClean !== true
      )
        return base({
          status: "failed",
          repoRoot,
          error:
            "An explicit lease requires a derived remote plus checked local branch, HEAD, and cleanliness preconditions.",
        });
    }

    const actualBranch = await currentBranch(repoRoot, options.signal);
    const branch = options.branch ?? actualBranch;
    if (actualBranch === "HEAD" && !options.branch) {
      return base({
        status: "failed",
        repoRoot,
        error: "HEAD is detached; specify a branch: /push <remote> <branch>.",
      });
    }
    if (
      options.expectedBranch !== undefined &&
      actualBranch !== options.expectedBranch
    )
      return base({
        status: "failed",
        repoRoot,
        branch,
        error: `The checked-out branch changed from ${options.expectedBranch} to ${actualBranch === "HEAD" ? "a detached HEAD" : actualBranch}.`,
      });

    const beforeHead = await localHead(repoRoot, options.signal);
    if (
      options.expectedHead !== undefined &&
      beforeHead !== options.expectedHead
    )
      return base({
        status: "failed",
        repoRoot,
        branch,
        error: `The local branch head changed from ${options.expectedHead} to ${beforeHead || "an unreadable HEAD"}.`,
      });
    if (options.requireClean && !(await isClean(repoRoot, options.signal)))
      return base({
        status: "failed",
        repoRoot,
        branch,
        error:
          "The worktree has staged, modified, or non-ignored untracked changes. Commit the complete change set before pushing.",
      });

    const target = await resolvePushTarget(
      repoRoot,
      branch,
      options.remote,
      options.signal,
    );
    const { remote, upstream } = target;
    // Pushing the current branch for the first time should establish tracking
    // whether the remote was inferred (`/push`) or explicit (`/push origin`).
    const needsUpstream = !upstream && !options.branch;
    // `git push -u <remote> <oid>:<ref>` succeeds but cannot set tracking: Git
    // needs a local branch as the source peer. Managed pushes retain the exact
    // oid source and establish tracking explicitly after publication instead.
    const pushSetsUpstream = needsUpstream && !options.expectedHead;
    const args = buildPushArgs({
      remote,
      branch,
      ...(options.expectedHead ? { source: options.expectedHead } : {}),
      force: Boolean(options.force),
      ...(options.explicitLease
        ? { explicitLease: options.explicitLease }
        : {}),
      setUpstream: pushSetsUpstream,
    });

    options.onProgress?.(
      `Pushing ${branch} → ${remote}${forced ? " (force-with-lease)" : ""}…`,
    );
    const res = await gitOptional(args, repoRoot, options.signal, PUSH_ENV);
    const output = [res.stdout.trim(), res.stderr.trim()]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (res.code !== 0) {
      return base({
        status: "failed",
        repoRoot,
        remote,
        branch,
        setUpstream: pushSetsUpstream,
        output,
        error: output || `git push exited with code ${res.code}.`,
      });
    }
    const upToDate = /everything up-to-date/i.test(output);
    let setUpstream = pushSetsUpstream;
    let finalOutput = output;
    if (needsUpstream && options.expectedHead) {
      options.onProgress?.(`Setting upstream ${remote}/${branch}…`);
      const tracking = await gitOptional(
        ["branch", `--set-upstream-to=${remote}/${branch}`, branch],
        repoRoot,
        options.signal,
      );
      const trackingOutput = [tracking.stdout.trim(), tracking.stderr.trim()]
        .filter(Boolean)
        .join("\n")
        .trim();
      finalOutput = [output, trackingOutput].filter(Boolean).join("\n").trim();
      if (tracking.code !== 0)
        return base({
          status: "failed",
          repoRoot,
          remote,
          branch,
          setUpstream: false,
          output: finalOutput,
          error: `Push succeeded, but setting upstream ${remote}/${branch} failed${trackingOutput ? `: ${trackingOutput}` : "."}`,
        });
      setUpstream = true;
    }
    if (
      options.expectedBranch !== undefined ||
      options.expectedHead !== undefined
    ) {
      const [afterBranch, afterHead, clean] = await Promise.all([
        currentBranch(repoRoot, options.signal),
        localHead(repoRoot, options.signal),
        options.requireClean
          ? isClean(repoRoot, options.signal)
          : Promise.resolve(true),
      ]);
      if (
        (options.expectedBranch !== undefined &&
          afterBranch !== options.expectedBranch) ||
        (options.expectedHead !== undefined &&
          afterHead !== options.expectedHead) ||
        !clean
      )
        return base({
          status: "failed",
          repoRoot,
          remote,
          branch,
          setUpstream,
          output: finalOutput,
          error:
            "The managed local branch, HEAD, or worktree changed while the push was in progress. Reinspect before reporting delivery.",
        });
    }
    return base({
      status: upToDate ? "up-to-date" : "pushed",
      repoRoot,
      remote,
      branch,
      setUpstream,
      output: finalOutput || "Pushed.",
    });
  } catch (err) {
    return base({ status: "failed", error: errorText(err) });
  }
}

/** Project a {@link PushWorkflowResult} into the wire {@link PushDisplay} card. */
export function toPushDisplay(result: PushWorkflowResult): PushDisplay {
  // On failure `output` and `error` are the same git text; show it once (as the
  // error). The synthetic "Pushed." placeholder carries no detail — drop it too.
  const output =
    result.output &&
    result.output !== "Pushed." &&
    result.output !== result.error
      ? result.output
      : undefined;
  return {
    status: result.status,
    ...(result.repoRoot
      ? { repoRoot: relative(CWD, result.repoRoot) || "." }
      : {}),
    ...(result.remote !== undefined ? { remote: result.remote } : {}),
    ...(result.branch !== undefined ? { branch: result.branch } : {}),
    forced: result.forced,
    setUpstream: result.setUpstream,
    ...(output !== undefined ? { output } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}
