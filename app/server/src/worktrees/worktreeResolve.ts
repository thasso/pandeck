/**
 * Resolving a worktree IDENTITY to something git can act on: a project's main
 * checkout (cached, since every synthetic-main surface re-resolves it), the
 * synthetic `main:<projectId>` id, and the one resolver that turns any worktree
 * id — synthetic or a spawned DB row — into a {@link WorktreeRow}.
 *
 * The leaf of the worktree layer: lifecycle (`worktrees.ts`), status, comments
 * and the watcher all resolve through this, so nothing here may import them.
 */
import { join } from "node:path";
import { checkoutFailureOf, checkoutFilesOn } from "../checkoutFileAccess.ts";
import { checkoutGitOn } from "../gitExec.ts";
import { getProject, type ProjectRecord } from "../projectRegistry.ts";
import {
  touchAllSessionRows,
  touchSessionRows,
} from "../db/sessionListChanges.ts";
import {
  getWorktree,
  sessionIdsForWorktree,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import type { PathInspection } from "../fileReads.ts";
import { DEFAULT_WORKER_SIDE } from "../workers/placement.ts";
import {
  checkPresence,
  forgetPresence,
  notifyPresenceChange,
  onPresenceChange,
  presenceKey,
  presenceNow,
  trackPresenceWork,
  type PresenceAnswer,
  type PresenceChange,
} from "./checkoutPresence.ts";

/**
 * A main checkout's side. Never the Knowledge Base row (`checkoutSideOf`
 * answers the default Worker for every `main:<projectId>` id), named here
 * because `knowledgeCheckout.ts` imports this module.
 */
const MAIN_SIDE = DEFAULT_WORKER_SIDE;

function mainFiles() {
  return checkoutFilesOn(MAIN_SIDE);
}

/** Whether `path` exists, as the main checkout's side answers it. */
function existsOnMainSide(path: string): Promise<boolean> {
  return mainFiles().pathExists(path, path);
}

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
    if (!localPath.path || !(await existsOnMainSide(localPath.path))) continue;
    const res = await checkoutGitOn(MAIN_SIDE).gitOptional(
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
 * `path`'s `stat` on the main checkout's side, or undefined for a filesystem
 * ENOENT: what `statSync(…, { throwIfNoEntry: false })` answers undefined in
 * production's Bun. Anything else, ENOTDIR and every Worker failure
 * included, throws.
 */
async function statOrAbsent(path: string): Promise<PathInspection | undefined> {
  try {
    return await mainFiles().inspect(path, path, { follow: true });
  } catch (error) {
    if (
      checkoutFailureOf(error) === "filesystem" &&
      (error as { code?: unknown }).code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

/**
 * What must change on disk for a resolved main checkout to move: its HEAD, the
 * ref HEAD names, `packed-refs` and a reftable stack. A commit, checkout, reset
 * or ref pack rewrites one of them, so an unchanged stamp means the cached
 * branch and oid still hold — without spawning git to ask. Stated on the
 * Worker; when several files fail, the first in this order's failure is
 * thrown.
 */
async function mainRepoStamp(info: MainRepoInfo): Promise<{
  stamp: string;
  newestMtimeMs: number;
}> {
  const files = [
    join(info.gitDir, "HEAD"),
    join(info.commonDir, "packed-refs"),
    join(info.commonDir, "reftable", "tables.list"),
  ];
  if (info.branch !== "HEAD")
    files.push(join(info.commonDir, "refs", "heads", info.branch));
  const stats = await Promise.allSettled(files.map(statOrAbsent));
  let newestMtimeMs = 0;
  const parts: string[] = [];
  for (const settled of stats) {
    if (settled.status === "rejected") throw settled.reason;
    const stat = settled.value;
    if (!stat) {
      parts.push("-");
      continue;
    }
    // A bigint stat's `mtimeMs` is its nanoseconds floored to milliseconds.
    newestMtimeMs = Math.max(
      newestMtimeMs,
      Number(BigInt(stat.mtimeNs) / 1_000_000n),
    );
    parts.push(`${stat.ino}:${stat.size}:${stat.mtimeNs}`);
  }
  return { stamp: parts.join("|"), newestMtimeMs };
}

/**
 * A stamp is only trusted when nothing it covers moved after the resolve
 * started: otherwise the resolved oid may predate the stamped state, and the
 * entry falls back to the short TTL. The slack covers coarse filesystem
 * timestamps.
 */
async function trustedMainRepoStamp(
  info: MainRepoInfo,
  resolveStartedAt: number,
): Promise<string | undefined> {
  const { stamp, newestMtimeMs } = await mainRepoStamp(info);
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
    if (!localPath.path || !(await existsOnMainSide(localPath.path))) continue;
    const inside = await checkoutGitOn(MAIN_SIDE).gitOptional(
      ["rev-parse", "--is-inside-work-tree"],
      localPath.path,
    );
    if (inside.code !== 0) continue;
    const head = await checkoutGitOn(MAIN_SIDE).gitOptional(
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
 * {@link mainRepoStamp} is unchanged, which costs a few Worker `inspect`s
 * instead of a fork of the server; the TTL is only a backstop for what a stamp
 * cannot see (a repository replaced in place). A resolve whose files moved
 * while it ran keeps the short TTL. A project without a repo is retried after
 * a minute: provisioning and registry edits invalidate it explicitly, so only
 * a repo created by hand waits that long. Keyed by canonical project id.
 *
 * One in-flight resolve per project owns the resolve, its stamp and the
 * publication, and publishes through {@link publishAsOwner} only. A freshness
 * check is shared by the callers that ask while it runs, and its answer counts
 * only for the entry it checked.
 */
const MAIN_REPO_TTL_MS = 3_000;
const MAIN_REPO_ABSENT_TTL_MS = 60_000;
const MAIN_REPO_STAMPED_TTL_MS = 10 * 60_000;
interface MainRepoCacheEntry {
  info: MainRepoInfo | undefined;
  at: number;
  stamp: string | undefined;
  /** The running stamp comparison, joined by callers that ask meanwhile. */
  freshness?: Promise<boolean> | undefined;
}

/** Base's cached "no repository" verdict, within its TTL. */
function noRepositoryHolds(entry: MainRepoCacheEntry, now: number): boolean {
  return !entry.info && now - entry.at < MAIN_REPO_ABSENT_TTL_MS;
}

/** Whether `entry` still holds; a Worker stamp only where the TTL cannot tell. */
function mainRepoCacheFresh(
  entry: MainRepoCacheEntry,
  now: number,
): boolean | Promise<boolean> {
  if (!entry.info) return noRepositoryHolds(entry, now);
  if (entry.stamp === undefined) return now - entry.at < MAIN_REPO_TTL_MS;
  if (now - entry.at >= MAIN_REPO_STAMPED_TTL_MS) return false;
  return (entry.freshness ??= stampStillHolds(entry, entry.info));
}

async function stampStillHolds(
  entry: MainRepoCacheEntry,
  info: MainRepoInfo,
): Promise<boolean> {
  try {
    return (await mainRepoStamp(info)).stamp === entry.stamp;
  } finally {
    entry.freshness = undefined;
  }
}

const mainRepoCache = new Map<string, MainRepoCacheEntry>();
/** The running owned resolve per project; joined only while its owner holds. */
const mainRepoInFlight = new Map<
  string,
  { promise: Promise<MainRepoInfo | undefined>; owner: ResolveOwner }
>();
// Per-key generation, bumped on invalidation/clear and on dropping a root its
// side answered absent. Together with the entry an operation read, it is what
// the operation owns: see {@link publishAsOwner}.
const mainRepoGeneration = new Map<string, number>();
let mainRepoColdResolves = 0;

function bumpMainRepoGeneration(key: string): void {
  mainRepoGeneration.set(key, (mainRepoGeneration.get(key) ?? 0) + 1);
}

/**
 * A session on `key`'s main checkout reads these caches for its list row's
 * `worktreeMissing` (`mainCheckoutEdgeNow`), so a write here touches it.
 * Candidate transitions also notify `main:<id>`, whose listener touches too.
 */
function touchMainCheckoutSessions(key: string): void {
  touchSessionRows(sessionIdsForWorktree(mainWorktreeId(key)));
}

function mainRepoGenerationOf(key: string): number {
  return mainRepoGeneration.get(key) ?? 0;
}

/**
 * What an operation owns in one of the main checkout's caches: the key's entry
 * there (or its absence) and the key's generation, read in the same turn as
 * the project record it works on, before its first yield.
 */
interface MainOwner<Entry> {
  readonly cache: ReadonlyMap<string, NonNullable<Entry>>;
  readonly key: string;
  readonly entry: Entry;
  readonly generation: number;
}

/** The resolve cache's owner of `key`, as of now. */
type ResolveOwner = MainOwner<MainRepoCacheEntry | undefined>;

function resolveOwner(key: string): ResolveOwner {
  return {
    cache: mainRepoCache,
    key,
    entry: mainRepoCache.get(key),
    generation: mainRepoGenerationOf(key),
  };
}

/** Whether `owner` still holds: the same entry under the same generation. */
function ownsMain<Entry>(owner: MainOwner<Entry>): boolean {
  return (
    owner.cache.get(owner.key) === owner.entry &&
    mainRepoGenerationOf(owner.key) === owner.generation
  );
}

/**
 * The one way a main-checkout result reaches a cache: `publish` runs only
 * while `owner` still holds, BOTH its entry and its generation, and this
 * answers whether it ran. Detached work has no owner and never publishes;
 * it answers its own result to its own caller alone.
 */
function publishAsOwner<Entry>(
  owner: MainOwner<Entry> | undefined,
  publish: (entry: Entry) => void,
): boolean {
  if (!owner || !ownsMain(owner)) return false;
  publish(owner.entry);
  return true;
}

/** Test hook: how many uncached {@link resolveMainRepo} calls the cache made. */
export function mainRepoResolveCount(): number {
  return mainRepoColdResolves;
}

/**
 * Test hook: drop the cache so tests observe fresh resolutions deterministically.
 * Candidate states and every main-checkout presence key go with it.
 */
export function clearMainRepoCache(): void {
  for (const key of new Set([
    ...mainRepoCache.keys(),
    ...mainRepoInFlight.keys(),
    ...mainCandidates.keys(),
  ]))
    bumpMainRepoGeneration(key);
  mainRepoCache.clear();
  mainRepoInFlight.clear();
  mainCandidates.clear();
  for (const key of [...mainPresencePaths.keys()]) forgetProjectPresence(key);
  touchAllSessionRows("main checkout cache cleared");
}

/**
 * Drop a project's cached main-repo resolution, its candidate state and the
 * presence of its local paths and root. Call after project mutations that can
 * change main resolution (localPath edits, worktreeRoot, repo swaps), so the
 * next list/open reflects the change immediately instead of after the TTL.
 */
export function invalidateMainRepo(projectId: string): void {
  const canonicalId = getProject(projectId)?.id ?? projectId;
  for (const key of new Set([canonicalId, projectId])) {
    mainRepoCache.delete(key);
    mainRepoInFlight.delete(key);
    mainCandidates.delete(key);
    forgetProjectPresence(key);
    bumpMainRepoGeneration(key); // invalidate any in-flight resolve's write-back
    touchMainCheckoutSessions(key);
  }
}

async function resolveMainRepoCached(
  project: ProjectRecord,
): Promise<MainRepoInfo | undefined> {
  const key = project.id;
  // `project` and what this call owns are read in the same turn.
  const owner = resolveOwner(key);
  const cached = owner.entry;
  if (cached) {
    const freshness = mainRepoCacheFresh(cached, Date.now());
    if (typeof freshness === "boolean") {
      if (freshness) return cached.info;
    } else {
      const holds = await freshness;
      if (!ownsMain(owner)) {
        // Dropped or replaced while the stamp was read: `project` may be the
        // pre-edit record, and a newer resolve may have published. This call
        // resolves it for itself alone, outside the in-flight map, detached.
        mainRepoColdResolves += 1;
        return resolveAndPublishMainRepo(project, undefined, Date.now());
      }
      if (holds) return cached.info;
    }
  }
  const running = mainRepoInFlight.get(key);
  if (running && ownsMain(running.owner)) return running.promise;
  mainRepoColdResolves += 1;
  const promise = resolveAndPublishMainRepo(project, owner, Date.now()).finally(
    () => {
      if (mainRepoInFlight.get(key)?.promise === promise)
        mainRepoInFlight.delete(key);
    },
  );
  mainRepoInFlight.set(key, { promise, owner });
  return promise;
}

/**
 * Resolves `project` and its stamp; publishes for `owner` if it still holds.
 * Without one (detached) it publishes nothing.
 */
async function resolveAndPublishMainRepo(
  project: ProjectRecord,
  owner: ResolveOwner | undefined,
  startedAt: number,
): Promise<MainRepoInfo | undefined> {
  const key = project.id;
  const info = await resolveMainRepo(project);
  const stamp = info ? await trustedMainRepoStamp(info, startedAt) : undefined;
  publishAsOwner(owner, (entry) => {
    mainRepoCache.set(key, { info, at: Date.now(), stamp });
    touchMainCheckoutSessions(key);
    const previous = entry?.info?.root;
    if (previous !== undefined && previous !== info?.root)
      forgetMainPresence(key, previous);
  });
  return info;
}

/* --------------------------- main checkout presence -------------------------- */

/**
 * The main-checkout paths each project read presence for: its repo/workspace
 * localPaths and its resolved root. Forgotten together on invalidation, so an
 * edited project leaves no key behind.
 */
const mainPresencePaths = new Map<string, Set<string>>();

function recordMainPresencePath(key: string, path: string): void {
  let paths = mainPresencePaths.get(key);
  if (!paths) mainPresencePaths.set(key, (paths = new Set()));
  paths.add(path);
}

function mainPresenceNow(key: string, path: string): PresenceAnswer {
  recordMainPresencePath(key, path);
  return presenceNow(MAIN_SIDE, path);
}

function checkMainPresence(key: string, path: string): Promise<boolean> {
  recordMainPresencePath(key, path);
  return checkPresence(MAIN_SIDE, path);
}

function forgetMainPresence(key: string, path: string): void {
  forgetPresence(MAIN_SIDE, path);
  mainPresencePaths.get(key)?.delete(path);
}

function forgetProjectPresence(key: string): void {
  for (const path of mainPresencePaths.get(key) ?? [])
    forgetPresence(MAIN_SIDE, path);
  mainPresencePaths.delete(key);
}

/**
 * Whether `projectId`'s main checkout answer reads one of the changed presence
 * `keys`: its candidate key (`main:<projectId>`) or a path it read presence
 * for. A root dropped as absent is no longer one: its drop, and the
 * candidate rescan that follows, notify under the candidate key.
 */
export function mainCheckoutReadsKey(
  projectId: string,
  keys: ReadonlySet<string>,
): boolean {
  const key = getProject(projectId)?.id ?? projectId;
  if (keys.has(mainWorktreeId(key))) return true;
  for (const path of mainPresencePaths.get(key) ?? [])
    if (keys.has(presenceKey(MAIN_SIDE, path))) return true;
  return false;
}

/**
 * A resolved root its side answered absent: the resolve entry goes and the
 * synchronous readers fall to a fresh candidate scan, as base fell to its scan
 * once the stamp moved after a deletion. A candidate from before the resolve
 * goes too, so no stale path answers live meanwhile. Only `owner`'s resolved
 * entry is dropped, while it holds; answers whether it was.
 */
function dropResolvedRoot(owner: ResolveOwner): boolean {
  if (!owner.entry?.info) return false;
  return publishAsOwner(owner, (entry) => {
    mainRepoCache.delete(owner.key);
    mainCandidates.delete(owner.key);
    bumpMainRepoGeneration(owner.key);
    touchMainCheckoutSessions(owner.key);
    if (entry?.info) forgetMainPresence(owner.key, entry.info.root);
  });
}

// A root answered absent is dropped here, before any later listener runs, and
// the drop forgets the root's key. Its main answer turned from the root to the
// reset candidate, a transition like any other, so it notifies `main:<id>`:
// a reader matches by that key alone, starts the rescan by reading, and the
// rescan notifies once more when it answers. Notified once per dropped entry.
onPresenceChange((changes) => {
  const dropped: PresenceChange[] = [];
  for (const change of changes) {
    if (change.answer !== "absent") continue;
    for (const [key, entry] of mainRepoCache)
      if (
        entry.info &&
        presenceKey(MAIN_SIDE, entry.info.root) === change.key &&
        dropResolvedRoot(resolveOwner(key))
      )
        dropped.push({ key: mainWorktreeId(key) });
  }
  if (dropped.length > 0) notifyPresenceChange(dropped);
});

/**
 * The main checkout before a resolve: base's git-free candidate rule, run on
 * the Worker. `unknown` until a scan answered; a failed background scan keeps
 * the last state. Keyed by canonical project id; every transition notifies
 * `main:<projectId>`.
 */
type MainCandidateState =
  { kind: "unknown" } | { kind: "path"; path: string } | { kind: "none" };

interface MainCandidateEntry {
  state: MainCandidateState;
  issued: number;
  applied: number;
  backgroundInFlight: boolean;
  /** A background failure was logged since the last answer. */
  failing: boolean;
}

const mainCandidates = new Map<string, MainCandidateEntry>();

function mainCandidateEntry(key: string): MainCandidateEntry {
  let entry = mainCandidates.get(key);
  if (!entry)
    mainCandidates.set(
      key,
      (entry = {
        state: { kind: "unknown" },
        issued: 0,
        applied: 0,
        backgroundInFlight: false,
        failing: false,
      }),
    );
  return entry;
}

/**
 * Base's candidate rule on the Worker: the first repo/workspace path (`repo`
 * first) with a `.git` entry, else the first that exists; realpath'd, where a
 * filesystem failure keeps the path as chosen (path resolution only); then
 * one final existence check of the selected path, which base's `existsSync`
 * made. Adds no presence key. A Worker failure at any step rejects.
 */
async function scanMainCandidate(
  project: ProjectRecord,
): Promise<MainCandidateState> {
  const paths = [...(project.localPaths ?? [])]
    .filter((p) => p.kind === "repo" || p.kind === "workspace")
    .sort(
      (a, b) => (a.kind === "repo" ? -1 : 0) - (b.kind === "repo" ? -1 : 0),
    );
  let chosen: string | undefined;
  for (const p of paths)
    if (p.path && (await existsOnMainSide(join(p.path, ".git")))) {
      chosen = p.path;
      break;
    }
  if (chosen === undefined)
    for (const p of paths)
      if (p.path && (await existsOnMainSide(p.path))) {
        chosen = p.path;
        break;
      }
  if (chosen === undefined) return { kind: "none" };
  // realpath so the candidate matches the (realpath'd) root resolveMainRepo
  // returns.
  let selected: string;
  try {
    selected = await mainFiles().realpath(chosen, chosen);
  } catch (error) {
    if (checkoutFailureOf(error) !== "filesystem") throw error;
    selected = chosen;
  }
  return (await existsOnMainSide(selected))
    ? { kind: "path", path: selected }
    : { kind: "none" };
}

function sameCandidate(a: MainCandidateState, b: MainCandidateState): boolean {
  return a.kind === "path" && b.kind === "path"
    ? a.path === b.path
    : a.kind === b.kind;
}

/** What a scan may write, read in the same turn as the record it scans. */
type CandidateOwner = MainOwner<MainCandidateEntry>;

function candidateOwner(key: string): CandidateOwner {
  return {
    cache: mainCandidates,
    key,
    entry: mainCandidateEntry(key),
    generation: mainRepoGenerationOf(key),
  };
}

/**
 * One scan of `project`'s candidate, resolving with its own result. It writes
 * only for an `owner` it still is, and only when no newer scan wrote; without
 * one it writes nothing.
 */
async function runMainCandidateScan(
  project: ProjectRecord,
  owner: CandidateOwner | undefined,
): Promise<MainCandidateState> {
  const key = project.id;
  const ticket = owner ? ++owner.entry.issued : 0;
  const state = await scanMainCandidate(project);
  publishAsOwner(owner, (entry) => {
    if (ticket <= entry.applied) return;
    entry.applied = ticket;
    entry.failing = false;
    const previous = entry.state;
    entry.state = state;
    if (!sameCandidate(previous, state))
      notifyPresenceChange([{ key: mainWorktreeId(key) }]);
  });
  return state;
}

/**
 * The candidate state now; schedules one background rescan (refresh on read).
 * The rescan owns what this read saw, and does not start once that is gone:
 * it has no caller to answer.
 */
function mainCandidateNow(project: ProjectRecord): MainCandidateState {
  const key = project.id;
  const owner = candidateOwner(key);
  const { entry } = owner;
  if (!entry.backgroundInFlight) {
    entry.backgroundInFlight = true;
    const scan = Promise.resolve()
      .then(() =>
        ownsMain(owner) ? runMainCandidateScan(project, owner) : undefined,
      )
      .then(
        () => {},
        (error: unknown) => {
          publishAsOwner(owner, (owned) => {
            if (owned.failing) return;
            owned.failing = true;
            console.warn(
              `[checkout-presence] main checkout scan of ${key} failed; keeping the last state:`,
              error,
            );
          });
        },
      )
      .finally(() => {
        entry.backgroundInFlight = false;
      });
    trackPresenceWork(scan);
  }
  return entry.state;
}

/**
 * A fresh scan of `project`'s candidate, writing for `owner` if still owned;
 * rejects on any Worker failure.
 */
function checkMainCandidate(
  project: ProjectRecord,
  owner: CandidateOwner | undefined,
): Promise<MainCandidateState> {
  return runMainCandidateScan(project, owner);
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

/** What the synchronous readers know of a project's main checkout. */
export type MainCheckoutEdge =
  | { kind: "live"; path: string }
  /** `retired`: a DB verdict (no project) or base's cached "no repository". */
  | { kind: "missing"; retired: boolean }
  | { kind: "unverified" };

/**
 * The main checkout as a session edge reads it, synchronously: a resolved
 * root by its last presence answer, base's cached "no repository" within its
 * TTL, else the candidate state. A root its side answered absent is dropped,
 * and the candidate answers instead.
 */
export function mainCheckoutEdgeNow(projectId: string): MainCheckoutEdge {
  const project = getProject(projectId);
  if (!project) return { kind: "missing", retired: true };
  const key = project.id;
  const rootOwner = resolveOwner(key);
  const cached = rootOwner.entry;
  if (cached?.info) {
    const answer = mainPresenceNow(key, cached.info.root);
    if (answer === "present") return { kind: "live", path: cached.info.root };
    if (answer === "unverified") return { kind: "unverified" };
    dropResolvedRoot(rootOwner);
  } else if (cached && noRepositoryHolds(cached, Date.now()))
    return { kind: "missing", retired: true };
  const state = mainCandidateNow(project);
  if (state.kind === "path") return { kind: "live", path: state.path };
  return state.kind === "none"
    ? { kind: "missing", retired: false }
    : { kind: "unverified" };
}

/** A main checkout's own Worker check, for the paths that act on it. */
export type MainCheckoutCheck =
  | { verdict: "live"; path: string }
  | { verdict: "missing-absent" | "missing-no-repository" | "missing-db" };

/**
 * The main checkout from checks this call requests: a resolved root's own
 * presence check (absent drops it), else base's cached "no repository" within
 * its TTL with no Worker call, else a fresh candidate scan. Rejects on any
 * Worker failure; never adopts an older probe or scan.
 *
 * The check answers from its own record, read when it started. It writes only
 * what it still owns: the root it found absent is dropped, and its scan
 * recorded, only if no invalidation, clear or other drop came first;
 * otherwise its scan answers it alone.
 *
 * The project is read synchronously, so a store error throws from this call
 * itself; the promise rejects only on a Worker failure.
 */
export function checkMainCheckout(
  projectId: string,
): Promise<MainCheckoutCheck> {
  const project = getProject(projectId);
  if (!project) return Promise.resolve({ verdict: "missing-db" });
  return checkProjectMainCheckout(project);
}

async function checkProjectMainCheckout(
  project: ProjectRecord,
): Promise<MainCheckoutCheck> {
  const key = project.id;
  const rootOwner = resolveOwner(key);
  const cached = rootOwner.entry;
  let owner: CandidateOwner | undefined;
  if (cached?.info) {
    const root = cached.info.root;
    if (await checkMainPresence(key, root))
      return { verdict: "live", path: root };
    // A drop that was this check's, in this turn, owns what follows.
    if (dropResolvedRoot(rootOwner)) owner = candidateOwner(key);
  } else if (cached && noRepositoryHolds(cached, Date.now()))
    return { verdict: "missing-no-repository" };
  else owner = candidateOwner(key);
  const state = await checkMainCandidate(project, owner);
  return state.kind === "path"
    ? { verdict: "live", path: state.path }
    : { verdict: "missing-absent" };
}

/**
 * Sync resolution of a project's main checkout path, for the session cwd/binding
 * surfaces that must stay synchronous. Never touches the filesystem.
 *
 * Whenever a resolved {@link resolveMainRepo} result is cached, returns that git
 * ROOT, so it matches the synthetic row's `path`/`mainRepoRoot` exactly even for
 * a localPath nested inside a repo — with no stamp or TTL check here, so the
 * root stays the answer across a commit and TTL expiry until the entry is
 * dropped or replaced; only the async resolve re-validates. A cached "no
 * repository" answers undefined within its TTL. Otherwise answers the
 * candidate state: the git-free scan's path, which can be a subdirectory when
 * the localPath is nested — the same repo, just a deeper cwd — or undefined
 * while none or not yet scanned.
 */
export function mainCheckoutPathForProject(
  projectId: string,
): string | undefined {
  const project = getProject(projectId);
  if (!project) return undefined;
  const cached = mainRepoCache.get(project.id);
  if (cached?.info) return cached.info.root;
  if (cached && noRepositoryHolds(cached, Date.now())) return undefined;
  const state = mainCandidateNow(project);
  return state.kind === "path" ? state.path : undefined;
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
 * main id requires the project to exist AND have a repo/workspace localPath its
 * side has not answered absent: an unverified one is plausible (git-backing is
 * still confirmed by the async resolve, which releases the reservation if
 * there's no repo). A spawned id requires an active row.
 */
export function worktreeExistsSync(id: string): boolean {
  if (isMainWorktreeId(id)) {
    const project = getProject(projectIdFromMainWorktreeId(id));
    if (!project) return false;
    return (project.localPaths ?? []).some(
      (p) =>
        (p.kind === "repo" || p.kind === "workspace") &&
        !!p.path &&
        mainPresenceNow(project.id, p.path) !== "absent",
    );
  }
  return getWorktree(id)?.status === "active";
}
