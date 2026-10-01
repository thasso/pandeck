/**
 * Resolving a worktree IDENTITY to something git can act on: a project's main
 * checkout (cached, since every synthetic-main surface re-resolves it), the
 * synthetic `main:<projectId>` id, and the one resolver that turns any worktree
 * id — synthetic or a spawned DB row — into a {@link WorktreeRow}.
 *
 * The leaf of the worktree layer: lifecycle (`worktrees.ts`), status, comments
 * and the watcher all resolve through this, so nothing here may import them.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitOptional } from "../gitExec.ts";
import { getProject, type ProjectRecord } from "../projectRegistry.ts";
import { getWorktree, type WorktreeRow } from "../db/worktreeStore.ts";

export interface MainRepoInfo {
  /** Absolute repo root of the project's main checkout. */
  root: string;
  /** Currently checked-out branch of the main checkout. */
  branch: string;
  /** HEAD oid of the main checkout. */
  headOid: string;
  /** Absolute git dir holding this checkout's HEAD. */
  gitDir: string;
  /** Absolute common git dir holding refs and packed-refs. */
  commonDir: string;
}

/**
 * The project's main checkout: the first configured local path that resolves
 * to a git repository (paths of kind "repo" are preferred). Returns undefined
 * when the project has no git-backed local path.
 *
 * ONE git process per candidate path: every spawn forks the whole server, so
 * the root, git dirs, HEAD oid and branch come from a single `rev-parse`.
 */
export async function resolveMainRepo(
  project: ProjectRecord,
): Promise<MainRepoInfo | undefined> {
  const paths = [...(project.localPaths ?? [])].sort(
    (a, b) => (a.kind === "repo" ? -1 : 0) - (b.kind === "repo" ? -1 : 0),
  );
  for (const localPath of paths) {
    if (!localPath.path || !existsSync(localPath.path)) continue;
    const res = await gitOptional(
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--absolute-git-dir",
        "--git-common-dir",
        "HEAD",
        "--abbrev-ref",
        "HEAD",
      ],
      localPath.path,
    );
    // Non-zero is an empty repo (no HEAD to fork from) or not a repo at all.
    if (res.code !== 0) continue;
    const [root, gitDir, commonDir, headOid, branch] = res.stdout
      .split("\n")
      .map((line) => line.trim());
    if (!root || !gitDir || !commonDir || !headOid || !branch) continue;
    return { root, branch, headOid, gitDir, commonDir };
  }
  return undefined;
}

/**
 * What must change on disk for a resolved main checkout to move: its HEAD, the
 * ref HEAD names, `packed-refs` and a reftable stack. A commit, checkout, reset
 * or ref pack rewrites one of them, so an unchanged stamp means the cached
 * branch and oid still hold — without spawning git to ask.
 */
function mainRepoStamp(info: MainRepoInfo): {
  stamp: string;
  newestMtimeMs: number;
} {
  const files = [
    join(info.gitDir, "HEAD"),
    join(info.commonDir, "packed-refs"),
    join(info.commonDir, "reftable", "tables.list"),
  ];
  if (info.branch !== "HEAD")
    files.push(join(info.commonDir, "refs", "heads", info.branch));
  let newestMtimeMs = 0;
  const stamp = files
    .map((file) => {
      const stat = statSync(file, { throwIfNoEntry: false, bigint: true });
      if (!stat) return "-";
      newestMtimeMs = Math.max(newestMtimeMs, Number(stat.mtimeMs));
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    })
    .join("|");
  return { stamp, newestMtimeMs };
}

/**
 * A stamp is only trusted when nothing it covers moved after the resolve
 * started: otherwise the resolved oid may predate the stamped state, and the
 * entry falls back to the short TTL. The slack covers coarse filesystem
 * timestamps.
 */
function trustedMainRepoStamp(
  info: MainRepoInfo,
  resolveStartedAt: number,
): string | undefined {
  const { stamp, newestMtimeMs } = mainRepoStamp(info);
  return newestMtimeMs < resolveStartedAt - 1_000 ? stamp : undefined;
}

/**
 * Why {@link resolveMainRepo} found nothing, worded for an agent: a clone of a
 * repository with no commits is a git repository too, but nothing can branch
 * from it, and "no git repository" would send the agent looking for the wrong
 * fix.
 */
export async function noMainRepoMessage(
  project: ProjectRecord,
): Promise<string> {
  for (const localPath of project.localPaths ?? []) {
    if (!localPath.path || !existsSync(localPath.path)) continue;
    const inside = await gitOptional(
      ["rev-parse", "--is-inside-work-tree"],
      localPath.path,
    );
    if (inside.code !== 0) continue;
    const head = await gitOptional(
      ["rev-parse", "--verify", "HEAD"],
      localPath.path,
    );
    if (head.code !== 0)
      return `Project ${project.name}'s repository at ${localPath.path} has no commits yet, so nothing can branch from it. An initial commit has to reach its remote first; then pull it into this checkout.`;
  }
  return `Project ${project.name} has no local path that is a git repository.`;
}

/**
 * Cached {@link resolveMainRepo}: the synthetic-main read/watch/list surfaces
 * re-resolve the same repo constantly (a single detail-page load does status +
 * changes + file-diff + comments + watch, and every worktree-list broadcast
 * resolves EVERY project). A resolved entry stays valid while its
 * {@link mainRepoStamp} is unchanged, which costs a few `stat`s instead of a
 * fork of the server; the TTL is only a backstop for what a stamp cannot see
 * (a repository replaced in place). A resolve whose files moved while it ran
 * keeps the short TTL. A project without a repo is retried after a minute:
 * provisioning and registry edits invalidate it explicitly, so only a repo
 * created by hand waits that long. Keyed by canonical project id.
 */
const MAIN_REPO_TTL_MS = 3_000;
const MAIN_REPO_ABSENT_TTL_MS = 60_000;
const MAIN_REPO_STAMPED_TTL_MS = 10 * 60_000;
interface MainRepoCacheEntry {
  info: MainRepoInfo | undefined;
  at: number;
  stamp: string | undefined;
}

function mainRepoCacheFresh(entry: MainRepoCacheEntry, now: number): boolean {
  if (!entry.info) return now - entry.at < MAIN_REPO_ABSENT_TTL_MS;
  if (entry.stamp === undefined) return now - entry.at < MAIN_REPO_TTL_MS;
  if (now - entry.at >= MAIN_REPO_STAMPED_TTL_MS) return false;
  return mainRepoStamp(entry.info).stamp === entry.stamp;
}
const mainRepoCache = new Map<string, MainRepoCacheEntry>();
const mainRepoInFlight = new Map<string, Promise<MainRepoInfo | undefined>>();
// Per-key generation, bumped on invalidation/clear. A cold resolve captures the
// generation at start and only writes its result back if it hasn't changed —
// so an invalidation that lands mid-resolve can't be clobbered by the older
// resolve completing afterwards.
const mainRepoGeneration = new Map<string, number>();
let mainRepoColdResolves = 0;

function bumpMainRepoGeneration(key: string): void {
  mainRepoGeneration.set(key, (mainRepoGeneration.get(key) ?? 0) + 1);
}

/** Test hook: how many uncached {@link resolveMainRepo} calls the cache made. */
export function mainRepoResolveCount(): number {
  return mainRepoColdResolves;
}

/** Test hook: drop the cache so tests observe fresh resolutions deterministically. */
export function clearMainRepoCache(): void {
  for (const key of new Set([
    ...mainRepoCache.keys(),
    ...mainRepoInFlight.keys(),
  ]))
    bumpMainRepoGeneration(key);
  mainRepoCache.clear();
  mainRepoInFlight.clear();
}

/**
 * Drop a project's cached main-repo resolution. Call after project mutations
 * that can change main resolution (localPath edits, worktreeRoot, repo swaps),
 * so the next list/open reflects the change immediately instead of after the TTL.
 */
export function invalidateMainRepo(projectId: string): void {
  const canonicalId = getProject(projectId)?.id ?? projectId;
  for (const key of new Set([canonicalId, projectId])) {
    mainRepoCache.delete(key);
    mainRepoInFlight.delete(key);
    bumpMainRepoGeneration(key); // invalidate any in-flight resolve's write-back
  }
}

async function resolveMainRepoCached(
  project: ProjectRecord,
): Promise<MainRepoInfo | undefined> {
  const key = project.id;
  const now = Date.now();
  const cached = mainRepoCache.get(key);
  if (cached && mainRepoCacheFresh(cached, now)) return cached.info;
  const running = mainRepoInFlight.get(key);
  if (running) return running;
  mainRepoColdResolves += 1;
  const generation = mainRepoGeneration.get(key) ?? 0;
  const startedAt = Date.now();
  const promise = resolveMainRepo(project).finally(() => {
    if (mainRepoInFlight.get(key) === promise) mainRepoInFlight.delete(key);
  });
  mainRepoInFlight.set(key, promise);
  const info = await promise;
  // Skip the write-back if an invalidation/clear bumped the generation while we
  // were resolving — the result may reflect pre-edit localPaths.
  if ((mainRepoGeneration.get(key) ?? 0) === generation)
    mainRepoCache.set(key, {
      info,
      at: Date.now(),
      stamp: info ? trustedMainRepoStamp(info, startedAt) : undefined,
    });
  return info;
}

/* ------------------------------- main checkout ------------------------------ */

const MAIN_PREFIX = "main:";

/** The synthetic worktree id for a project's main checkout. */
export function mainWorktreeId(projectId: string): string {
  return `${MAIN_PREFIX}${projectId}`;
}

/** Whether an id addresses a project's main checkout rather than a spawned worktree. */
export function isMainWorktreeId(id: string): boolean {
  return id.startsWith(MAIN_PREFIX);
}

/** The projectId encoded in a main worktree id. */
export function projectIdFromMainWorktreeId(id: string): string {
  return id.slice(MAIN_PREFIX.length);
}

/**
 * Sync resolution of a project's main checkout path, for the session cwd/binding
 * surfaces that must stay synchronous.
 *
 * When a fresh {@link resolveMainRepo} result is cached (the usual case — binding
 * happens right after the list/detail resolved it), returns that git ROOT, so it
 * matches the synthetic row's `path`/`mainRepoRoot` exactly even for a localPath
 * nested inside a repo. Otherwise falls back to a git-free scan: prefer a path
 * with a `.git` entry, else any existing repo/workspace path (`repo` over
 * `workspace`). The fallback can return a subdirectory when the localPath is
 * nested and the cache is cold — the same repo, just a deeper cwd.
 */
export function mainCheckoutPathForProject(
  projectId: string,
): string | undefined {
  const project = getProject(projectId);
  if (!project) return undefined;
  const cached = mainRepoCache.get(project.id);
  if (cached && mainRepoCacheFresh(cached, Date.now()))
    return cached.info?.root;
  const paths = [...(project.localPaths ?? [])]
    .filter((p) => p.kind === "repo" || p.kind === "workspace")
    .sort(
      (a, b) => (a.kind === "repo" ? -1 : 0) - (b.kind === "repo" ? -1 : 0),
    );
  const gitBacked = paths.find(
    (p) => p.path && existsSync(join(p.path, ".git")),
  );
  const chosen =
    gitBacked?.path ?? paths.find((p) => p.path && existsSync(p.path))?.path;
  if (!chosen) return undefined;
  // realpath so the fallback matches the (realpath'd) root the cache/resolveMainRepo
  // return — consistent cwd whether the cache is warm or cold.
  try {
    return realpathSync(chosen);
  } catch {
    return chosen;
  }
}

/**
 * Build the synthetic {@link WorktreeRow} for a project's main checkout, or
 * undefined when the project has no resolvable git repo. `baseBranch === branch`
 * so the shared status computation yields dirty-only state (ahead/behind 0).
 */
export async function resolveMainWorktreeRow(
  projectId: string,
): Promise<WorktreeRow | undefined> {
  const project = getProject(projectId);
  if (!project) return undefined;
  const main = await resolveMainRepoCached(project);
  if (!main) return undefined;
  // Key on the CANONICAL project id: getProject normalizes aliases (`WT-PROJ`,
  // `wt/proj` → `wt-proj`), so the synthetic id/edges always match the
  // `main:<projectId>` row that `worktreeList` emits.
  return {
    id: mainWorktreeId(project.id),
    projectId: project.id,
    mainRepoRoot: main.root,
    path: main.root,
    branch: main.branch,
    baseBranch: main.branch,
    baseCommit: main.headOid,
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 0,
    updatedAt: 0,
    removedAt: null,
  };
}

/**
 * Resolve any worktree id — a spawned DB row or a synthetic `main:<projectId>` —
 * to a {@link WorktreeRow}. The single resolver every read/watch surface uses.
 */
export async function resolveWorktreeRow(
  id: string,
): Promise<WorktreeRow | undefined> {
  if (isMainWorktreeId(id))
    return resolveMainWorktreeRow(projectIdFromMainWorktreeId(id));
  return getWorktree(id);
}

/**
 * Canonicalize a worktree id WITHOUT touching git: a `main:<projectId>` id is
 * normalized through the (in-memory) project registry so an aliased id
 * (`main:MAIN-PROJ`) collapses to the same key the read/watch surfaces use;
 * spawned ids pass through unchanged. Cheap enough to call on every watch op.
 */
export function canonicalWorktreeId(id: string): string {
  if (!isMainWorktreeId(id)) return id;
  const project = getProject(projectIdFromMainWorktreeId(id));
  return project ? mainWorktreeId(project.id) : id;
}

/**
 * Cheap, git-free plausibility check for a (canonical) worktree id — gates global
 * watcher state so a noisy client can't allocate entries for implausible ids. A
 * main id requires the project to exist AND have an existing repo/workspace
 * localPath (git-backing is still confirmed by the async resolve, which releases
 * the reservation if there's no repo). A spawned id requires an active row.
 */
export function worktreeExistsSync(id: string): boolean {
  if (isMainWorktreeId(id)) {
    const project = getProject(projectIdFromMainWorktreeId(id));
    if (!project) return false;
    return (project.localPaths ?? []).some(
      (p) =>
        (p.kind === "repo" || p.kind === "workspace") &&
        !!p.path &&
        existsSync(p.path),
    );
  }
  return getWorktree(id)?.status === "active";
}
