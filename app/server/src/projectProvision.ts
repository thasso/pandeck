/**
 * Project repo provisioning via the user's ambient git + ssh: clone a project's
 * `repoUrl` into `settings.projectsRoot/<project id>` (which then becomes the
 * project's main checkout, since main is derived from localPaths) and pull it.
 * No credential handling here — we rely on the host's git/ssh config.
 */
import { userHomeDir } from "./userHome.ts";
import { join, resolve, sep } from "node:path";
import { checkoutFilesOn } from "./checkoutFileAccess.ts";
import { checkoutLifecycleOn } from "./checkoutLifecycle.ts";
import { git } from "./gitExec.ts";
import { getProject, updateProject } from "./projectRegistry.ts";
import { getSettings } from "./settings.ts";
import { checkoutSideOf } from "./worktrees/knowledgeCheckout.ts";
import { mainWorktreeId } from "./worktrees/worktreeResolve.ts";
import type { CheckoutSide } from "./workers/placement.ts";

/**
 * Non-interactive git/ssh environment for provisioning. Without this, a clone
 * of a new host over ssh (or a repo needing credentials) blocks forever on an
 * interactive prompt with no tty, so the operation never resolves and the user
 * sees no progress and no error. These options make git fail fast with a clear
 * message instead:
 * - `GIT_TERMINAL_PROMPT=0`: never prompt for HTTPS credentials.
 * - `BatchMode=yes`: ssh never prompts for a password/passphrase.
 * - `StrictHostKeyChecking=accept-new`: trust-on-first-use for a new host key
 *   (rather than the interactive yes/no prompt), while still rejecting changed keys.
 * - `ConnectTimeout=20`: bound the TCP/handshake wait.
 */
const PROVISION_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20",
};

/** Expand a leading `~` to the home directory. */
function expandHome(p: string): string {
  if (p === "~") return userHomeDir();
  if (p.startsWith("~/")) return join(userHomeDir(), p.slice(2));
  return p;
}

/** The configured projects root (tilde-expanded). */
function projectsRootDir(): string {
  return expandHome(getSettings().projectsRoot);
}

/** Absolute directory a project's repo is provisioned into: projectsRoot/<id>. */
export function projectRepoDir(projectId: string): string {
  return join(projectsRootDir(), projectId);
}

/**
 * Where a project's managed clone lives: its main checkout's side. Every
 * filesystem step below runs there, and a Worker failure rejects.
 */
function provisionSide(projectId: string): CheckoutSide {
  return checkoutSideOf({ id: mainWorktreeId(projectId) });
}

function pathExistsOn(side: CheckoutSide, path: string): Promise<boolean> {
  return checkoutFilesOn(side).pathExists(path, path);
}

/** Whether `dir` looks like a git checkout. */
function isGitRepo(side: CheckoutSide, dir: string): Promise<boolean> {
  return pathExistsOn(side, join(dir, ".git"));
}

/**
 * Clone `repoUrl` into {@link projectRepoDir} if it is not already a checkout
 * (idempotent). Returns the directory. Throws if the path exists but isn't a repo.
 *
 * Clones with `--recurse-submodules` so submodules are initialized and checked
 * out recursively. Submodule fetches spawned by the clone inherit
 * {@link PROVISION_ENV}, so an ssh/https submodule fails fast rather than
 * hanging on an interactive prompt.
 */
export async function cloneProjectRepo(
  projectId: string,
  repoUrl: string,
): Promise<string> {
  const side = provisionSide(projectId);
  const dir = projectRepoDir(projectId);
  if (await isGitRepo(side, dir)) return dir;
  if (await pathExistsOn(side, dir))
    throw new Error(
      `Target directory already exists and is not a git repo: ${dir}`,
    );
  const root = projectsRootDir();
  await checkoutLifecycleOn(side).mkdir(root);
  await git(
    ["clone", "--recurse-submodules", "--", repoUrl, dir],
    root,
    undefined,
    PROVISION_ENV,
  );
  return dir;
}

/**
 * Clone a project's configured `repoUrl` into its managed checkout dir
 * ({@link projectRepoDir}) and register that dir as a `repo`/`prefix` local
 * path so it becomes the project's main checkout. Idempotent: a re-run on an
 * existing clone re-uses it and only registers the local path if missing.
 * Shared by the browser `provisionProjectRepo` command and the agent's
 * `project_registry_write` `cloneRepo` operation so both behave identically.
 *
 * Does NOT invalidate the main-repo cache or broadcast — callers own those side
 * effects (they differ by surface). Throws with a user-actionable message when
 * the project is unknown or has no repository URL configured.
 */
export async function cloneAndRegisterProjectRepo(projectId: string): Promise<{
  dir: string;
  repoUrl: string;
  cloned: boolean;
  registeredLocalPath: boolean;
}> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const repoUrl = project.repoUrl?.trim();
  if (!repoUrl) throw new Error("Set a repository URL on the project first.");
  const dir = projectRepoDir(projectId);
  const cloned = !(await isGitRepo(provisionSide(projectId), dir));
  await cloneProjectRepo(projectId, repoUrl);
  const already = (project.localPaths ?? []).some((p) => p.path === dir);
  if (!already) {
    updateProject(projectId, {
      localPaths: [
        ...(project.localPaths ?? []),
        { path: dir, kind: "repo", match: "prefix" },
      ],
    });
  }
  return { dir, repoUrl, cloned, registeredLocalPath: !already };
}

/** Whether `dir` is the managed clone folder for `projectId` (directly under projectsRoot). */
export function isManagedRepoDir(projectId: string, dir: string): boolean {
  return resolve(dir) === resolve(projectRepoDir(projectId));
}

/**
 * Delete the managed clone folder ({@link projectRepoDir}) from disk if present.
 * Refuses to touch anything outside the configured projects root, so a crafted
 * project id or unexpected path can never turn this into an arbitrary delete.
 * Returns whether a folder was actually removed.
 */
export async function deleteProjectRepoFolder(
  projectId: string,
): Promise<boolean> {
  const dir = resolve(projectRepoDir(projectId));
  const root = resolve(projectsRootDir());
  if (dir === root || !dir.startsWith(root + sep)) return false; // containment guard
  const side = provisionSide(projectId);
  if (!(await pathExistsOn(side, dir))) return false;
  await checkoutLifecycleOn(side).removeAll(dir);
  return true;
}
