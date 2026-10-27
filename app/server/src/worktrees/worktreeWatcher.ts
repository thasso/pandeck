/**
 * Event-driven change detection for worktrees — no polling. Two tiers:
 *
 * 1. Git-state tier (always on, one @parcel/watcher subscription per main
 *    repo's `.git` dir): detects commits, branch moves, and merges — a linked
 *    worktree's HEAD physically lives under `.git/worktrees/<name>/`. On a
 *    relevant change, the branch checkout and worktrees based on a moved base
 *    get a fresh status broadcast, and worktrees whose HEAD oid moved notify
 *    the git-state listeners (comment re-anchoring) and push fresh changes to
 *    viewers.
 *
 * 2. Working-tree tier (refcounted, lazy, per worktree): started when the
 *    first client watches the worktree (opens its view), kept for a linger
 *    period after the last one leaves, and capped at
 *    {@link maxTreeWatches} live subscriptions. Pushes debounced
 *    working-tree status + change lists while agents edit files; ref state is
 *    reused. A linked session's finished tool call rescans too
 *    ({@link rescanSessionWorktree}), so agent edits never depend on it.
 *
 * Each checkout's subscriptions and reads run on its side
 * (`checkoutWatchOn`, `checkoutFilesOn`): the Worker that owns the checkout,
 * or the server for the Knowledge Base row. Debounce, scan scheduling, the cap
 * and retries stay here. A subscription lost with its Worker connection
 * resubscribes once the Worker released it, and rescans in full
 * ({@link LOSS_STABLE_MS} bounds a flapping connection).
 *
 * All pushes go through the {@link worktreeBroadcaster} seam.
 */
import { basename, join, relative, sep } from "node:path";
import { checkoutFailureOf, checkoutFilesOn } from "../checkoutFileAccess.ts";
import {
  checkoutWatchOn,
  type CheckoutWatchSubscription,
} from "../checkoutWatchAccess.ts";
import { checkoutGitOn } from "../gitExec.ts";
import {
  listWorktrees,
  worktreeIdBySession,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import { KNOWLEDGE_WORKTREE_ID } from "@assistant/shared";
import { canonicalWorktreeId, worktreeExistsSync } from "./worktreeResolve.ts";
import type { CheckoutSide } from "../workers/placement.ts";
import {
  checkoutSideOf,
  resolveReadableWorktreeRow,
} from "./knowledgeCheckout.ts";
import {
  cachedRepoBranchUpstreams,
  computeWorktreeStatus,
  readRepoBranchUpstreams,
  refreshWorktreeRemotePatch,
  type BranchUpstreams,
  refreshWorktreeWorkingTree,
  stampWorktreeStatusFetchedAt,
} from "./worktreeStatus.ts";
import {
  onFetchCompleted,
  setFetchInterestSource,
  type WatchedRepo,
} from "./worktreeFetch.ts";
import {
  getWorktreeChanges,
  worktreeChangesFromSnapshot,
} from "./worktreeDiff.ts";
import { worktreeBroadcaster } from "./worktreeEvents.ts";

const GIT_DEBOUNCE_MS = 300;
const TREE_DEBOUNCE_MS = 400;
/**
 * How long a tree watch outlives its last viewer. Moving between sessions
 * must not re-crawl: parcel frees a subscription's heap on unsubscribe, but
 * glibc keeps the pages, and every re-subscribe grew resident memory further
 * (one 21k-directory tree: 33 MB after one subscribe, 75 MB after ten cycles).
 */
let treeLingerMs = 10 * 60_000;
/**
 * Hard cap on live tree subscriptions. Viewed trees rank before lingering
 * ones, then by most recent view; a viewed tree past the cap is unwatched and
 * refreshes only through tool-call and git-dir rescans.
 */
let maxTreeWatches = 8;
/** An event batch this large (install, build) may have created ignored dirs. */
const TREE_BULK_EVENTS = 1_000;
/** Minimum spacing of ignore-set refreshes of one tree. */
let treeIgnoreRefreshMs = 30_000;
/** First retry of a failed tree subscribe; doubles up to 60 s. */
let treeRetryBaseMs = 5_000;
const TREE_RETRY_MAX_MS = 60_000;
/**
 * A subscription lost within this long of its last recovery is a quick loss:
 * it waits out the backoff instead of resubscribing at once, so a flapping
 * Worker connection cannot drive unbounded rescans. A minute without a loss
 * resets the run.
 */
const LOSS_STABLE_MS = 60_000;
/**
 * Ignored subtrees of a watched checkout, as PATHS. @parcel/watcher resolves a
 * plain name against the root, and matches a glob as a regex against every
 * path of its crawl — on the libuv pool that file I/O and WebSocket
 * compression share, so four `**` globs made one subscribe ~7x slower and a
 * few concurrent ones starved everything else. Everything git ignores and
 * every submodule working tree is therefore added as an explicit path
 * ({@link treeIgnore}).
 */
const TREE_IGNORE_NAMES = [".git", "node_modules", "dist", ".DS_Store"];
/** Bounds the ignore list: parcel compares every crawled path against it. */
const MAX_TREE_IGNORES = 500;
/**
 * What parcel's wrapper (`is-glob`) may read as a glob. A directory named like
 * that would turn its ignore entry back into a per-path regex, so it is
 * skipped and stays watched.
 */
const GLOB_LIKE = /[*?[\]{}()!|\\]/;

/**
 * The root ignores, every directory git ignores, and every submodule working
 * tree. A change under an ignored directory never changes `git status`, and a
 * submodule is its own repository: the parent only sees its gitlink, which
 * moves with a commit under the git dir the git-state tier watches. Edits
 * inside a submodule's files reach viewers through tool-call rescans only.
 *
 * `ls-files --directory` also names a directory whose every file is ignored
 * (a source dir holding only `__pycache__`), where a new source file WOULD
 * show in status; `check-ignore` keeps only directories an exclude pattern
 * matches. Read-only git through the broker. A failed read only means those
 * directories are watched, and reports the set `complete: false` so the
 * caller derives it again. Shallow directories win the
 * {@link MAX_TREE_IGNORES} cut, as they usually hold the most.
 */
async function treeIgnore(
  side: CheckoutSide,
  root: string,
): Promise<{ ignore: string[]; complete: boolean }> {
  const { gitReadOnlyOptional, gitWithInputOptional } = checkoutGitOn(side);
  const [others, modules] = await Promise.all([
    gitReadOnlyOptional(
      [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
      ],
      root,
    ).catch(() => undefined),
    gitReadOnlyOptional(
      [
        "config",
        "-z",
        "--file",
        ".gitmodules",
        "--get-regexp",
        String.raw`^submodule\..*\.path$`,
      ],
      root,
    ).catch(() => undefined),
  ]);
  const candidates = (
    others?.code === 0 ? others.stdout.split("\0") : []
  ).filter((entry) => entry.endsWith("/") && !GLOB_LIKE.test(entry));
  const checked =
    candidates.length === 0
      ? undefined
      : await gitWithInputOptional(
          ["check-ignore", "-z", "--stdin"],
          root,
          candidates.join("\0"),
        ).catch(() => undefined);
  const ignored = (
    checked && checked.code <= 1 ? checked.stdout.split("\0") : []
  )
    .filter((entry) => entry.endsWith("/"))
    .map((entry) => entry.slice(0, -1))
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .slice(0, MAX_TREE_IGNORES);
  // Records are `submodule.<name>.path\n<path>`.
  const submodules = (modules?.code === 0 ? modules.stdout.split("\0") : [])
    .map((record) => record.slice(record.indexOf("\n") + 1))
    .filter((path) => path && !GLOB_LIKE.test(path));
  // Exit 1 of `config` is "no submodules"; of `check-ignore`, "none ignored".
  const complete =
    others?.code === 0 &&
    (modules?.code === 0 || modules?.code === 1) &&
    (candidates.length === 0 || (checked !== undefined && checked.code <= 1));
  return {
    ignore: [...new Set([...TREE_IGNORE_NAMES, ...submodules, ...ignored])],
    complete,
  };
}

/** Test seam: the ignore list a tree watch of `root` on `side` subscribes with. */
export async function treeIgnoreForTests(
  side: CheckoutSide,
  root: string,
): Promise<string[]> {
  return (await treeIgnore(side, root)).ignore;
}

/**
 * Object stores under a git dir, as explicit paths: the main store, LFS, and
 * each submodule's (`modules/…`, also under a linked worktree's admin dir).
 * No relevant ref or HEAD lives there, and they hold most of its directories.
 * Read on the repo's side: a directory the filesystem cannot list adds
 * nothing, as an unreadable `HEAD` is no file; a Worker failure rejects.
 */
async function gitDirIgnore(
  side: CheckoutSide,
  gitDir: string,
): Promise<string[]> {
  const files = checkoutFilesOn(side);
  const answered =
    <T>(fallback: T) =>
    (err: unknown) => {
      if (checkoutFailureOf(err) === "filesystem") return fallback;
      throw err;
    };
  const ignore = ["objects", "lfs"];
  const entriesOf = (dir: string) =>
    files.readDir(gitDir, join(gitDir, dir)).catch(answered([]));
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await entriesOf(dir);
    if (
      entries.some((entry) => entry.name === "HEAD" && !entry.directory) &&
      (await files
        .inspect(gitDir, join(gitDir, dir, "HEAD"), { follow: false })
        .then((head) => head.kind === "file", answered(false)))
    )
      ignore.push(`${dir}/objects`);
    if (depth >= 6) return;
    for (const entry of entries) {
      if (!entry.directory || GIT_DIR_SKIP.has(entry.name)) continue;
      if (!GLOB_LIKE.test(entry.name))
        await walk(`${dir}/${entry.name}`, depth + 1);
    }
  };
  await walk("modules", 0);
  for (const linked of await entriesOf("worktrees"))
    if (!GLOB_LIKE.test(linked.name))
      await walk(`worktrees/${linked.name}/modules`, 0);
  return ignore;
}
/** Git-dir children that never contain another submodule's git dir. */
const GIT_DIR_SKIP = new Set(["objects", "refs", "logs", "hooks", "info"]);

/** Test seam: the ignore list the git-state watch of `gitDir` on `side` uses. */
export function gitDirIgnoreForTests(
  side: CheckoutSide,
  gitDir: string,
): Promise<string[]> {
  return gitDirIgnore(side, gitDir);
}
type GitStateListener = (worktreeId: string, newHead: string) => void;

/**
 * How a watch recovers a lost subscription (`docs/child-processes.md`). Both
 * tiers keep it beside their own retry state.
 */
interface LossRecovery {
  /** Consecutive quick losses; see {@link LOSS_STABLE_MS}. */
  lossRun: number;
  /** When a resubscribe after a loss last succeeded. */
  recoveredAt: number | undefined;
  /** The next successful subscribe follows a loss: it rescans in full. */
  resumeScan: boolean;
  /** Successful resubscribes after a loss, for the test seams. */
  recoveries: number;
}

interface RepoWatch extends LossRecovery {
  /** Its {@link repoWatches} key. */
  key: string;
  /** The side every row it holds runs its git on: part of its key. */
  side: CheckoutSide;
  mainRepoRoot: string;
  subscription: CheckoutWatchSubscription | undefined;
  /** The next subscribe attempt after a Worker failure or a quick loss. */
  retry: ReturnType<typeof setTimeout> | undefined;
  retryMs: number | undefined;
  /** Consecutive failed subscribes; only the first of a run is logged. */
  failures: number;
  /** The next scan reads every row in full (overflow, recovery). */
  fullRescan: boolean;
  fullRescans: number;
  /** Initialization subscribes first, then snapshots branch relationships. */
  ready: Promise<void>;
  repoKey: string | undefined;
  worktreeIds: Set<string>;
  /**
   * Registrations still reading before their row joins. Unregistering a row
   * drops its own, so a read pending past the removal cannot bring the row
   * back, and the watch is released only once none is left.
   */
  joining: Set<RepoJoin>;
  /** Linked-worktree git-dir name per id; absent means the main checkout. */
  gitDirNames: Map<string, string | undefined>;
  /** Last seen HEAD oid per worktree, to tell real commits from ref noise. */
  lastHeads: Map<string, string>;
  pendingGitPaths: Set<string>;
  debounce: ReturnType<typeof setTimeout> | undefined;
  /** Launched scans; teardown waits them out after stopping new callbacks. */
  scans: Set<Promise<void>>;
}

interface RepoJoin {
  worktreeId: string;
}

interface TreeWatch extends LossRecovery {
  id: string;
  /** Checkout path, set once the id resolved to an active row. */
  path: string | undefined;
  /** The row's side, set with {@link path}. */
  side: CheckoutSide | undefined;
  subscription: CheckoutWatchSubscription | undefined;
  /** Ignore list {@link subscription} was made with. */
  ignore: string[] | undefined;
  /**
   * Tail of this watch's subscribe/unsubscribe chain: each step reads the
   * demand it finds when it runs, so racing viewers never double-subscribe
   * or leave a torn-down watch subscribed.
   */
  reconciling: Promise<void>;
  refs: number;
  /** Last time a viewer arrived; orders the {@link maxTreeWatches} cap. */
  lastViewedAt: number;
  linger: ReturnType<typeof setTimeout> | undefined;
  debounce: ReturnType<typeof setTimeout> | undefined;
  /** Last change broadcast was empty; a fresh clean scan needs no repeat. */
  lastChangesEmpty: boolean | undefined;
  /** An event may have changed what git ignores; see {@link settleTree}. */
  ignoreStale: boolean;
  ignoreRefreshedAt: number;
  /** Next {@link settleTree} of a throttled refresh or a failed step. */
  retry: ReturnType<typeof setTimeout> | undefined;
  /** The delay {@link retry} was armed with. */
  retryMs: number | undefined;
  /** {@link retry} releases a subscription, so it outlives the viewers. */
  retryRelease: boolean;
  /** Consecutive failed subscribes/releases; only the first is logged. */
  failures: number;
  /** Why a viewed tree holds no subscription; logged once per episode. */
  unwatched: "cap" | "missing" | undefined;
  /**
   * No demand is left (linger over, no slot, worktree removed), but the entry
   * stays registered until its subscription is released: a re-view of the
   * path reuses THIS watch, whose chain orders the release before any new
   * subscribe, and the cap still counts the subscription.
   */
  retired: boolean;
  /** A subscribe is in flight; it already occupies a slot. */
  subscribing: boolean;
  /** A failed subscribe or release waits for its armed retry, not a re-rank. */
  backingOff: boolean;
  /**
   * What this watch has done, for {@link treeActivityForTests}: a test waits
   * for these instead of a clock. Nothing branches on them.
   */
  eventBatches: number;
  scansScheduled: number;
  settlesPending: number;
}

/**
 * Keyed by side and main-repo root ({@link repoWatchKey}): a folder that is
 * both the Knowledge Base and a registered checkout has one watch per side, so
 * a KB scan never runs on a Worker. Tree watches are keyed by row id, which
 * already tells the KB row from every checkout.
 */
const repoWatches = new Map<string, RepoWatch>();
const treeWatches = new Map<string, TreeWatch>();

function repoWatchKey(side: CheckoutSide, mainRepoRoot: string): string {
  return `${checkoutGitOn(side).sideKey}\0${mainRepoRoot}`;
}
const gitStateListeners = new Set<GitStateListener>();

/** Subscribe to per-worktree HEAD-oid changes (commit detection). */
export function onWorktreeGitStateChange(listener: GitStateListener): void {
  gitStateListeners.add(listener);
}

/**
 * Whether a `.git`-dir event path is a state change worth reacting to.
 *
 * `refs/remotes/` is in here because a FETCH is what moves it, and a fetch is
 * exactly what changes the `behind` counts a status reports. Without it the
 * background fetch would silently update the refs and nothing would ever
 * broadcast the new numbers — the surface would keep showing the pre-fetch
 * answer until something else happened to move.
 */
function isRelevantGitPath(mainRepoRoot: string, path: string): boolean {
  const relative = relativeGitPath(mainRepoRoot, path);
  const privateConfig =
    relative === "config.worktree" ||
    /^worktrees\/[^/]+\/config\.worktree$/.test(relative);
  return (
    relative === "config" ||
    privateConfig ||
    /(?:^|\/)(?:HEAD|MERGE_HEAD)$/.test(relative) ||
    relative === "packed-refs" ||
    relative.includes("refs/heads/") ||
    relative.includes("refs/remotes/")
  );
}

/* ------------------------------ git-state tier ----------------------------- */

async function currentHead(
  side: CheckoutSide,
  path: string,
): Promise<string | undefined> {
  const res = await checkoutGitOn(side).gitOptional(
    ["rev-parse", "--verify", "HEAD"],
    path,
  );
  return res.code === 0 ? res.stdout.trim() : undefined;
}

async function ensureRepoWatch(row: WorktreeRow): Promise<void> {
  const side = checkoutSideOf(row);
  const key = repoWatchKey(side, row.mainRepoRoot);
  let repo = repoWatches.get(key);
  const created = !repo;
  let markReady!: () => void;
  if (!repo) {
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    repo = {
      key,
      side,
      mainRepoRoot: row.mainRepoRoot,
      subscription: undefined,
      ready,
      repoKey: undefined,
      worktreeIds: new Set(),
      joining: new Set(),
      gitDirNames: new Map(),
      lastHeads: new Map(),
      pendingGitPaths: new Set(),
      debounce: undefined,
      scans: new Set(),
      retry: undefined,
      retryMs: undefined,
      failures: 0,
      fullRescan: false,
      fullRescans: 0,
      lossRun: 0,
      recoveredAt: undefined,
      resumeScan: false,
      recoveries: 0,
    };
    repoWatches.set(key, repo);
  }
  const join: RepoJoin = { worktreeId: row.id };
  repo.joining.add(join);
  try {
    if (created) {
      await subscribeRepo(repo);
      try {
        repo.repoKey = await checkoutGitOn(side).repoLockKey(row.mainRepoRoot);
        await readRepoBranchUpstreams(side, row.mainRepoRoot, {
          force: true,
          repoKey: repo.repoKey,
        });
      } finally {
        markReady();
      }
    } else {
      await repo.ready;
    }
    // Read before the row joins: a Worker failure leaves it out.
    const gitDirName = await linkedGitDirName(repo.side, row);
    // Unregistered meanwhile: the row stays out.
    if (!repo.joining.has(join)) return;
    repo.worktreeIds.add(row.id);
    repo.gitDirNames.set(row.id, gitDirName);
    const head = await currentHead(repo.side, row.path);
    if (head && repo.joining.has(join)) repo.lastHeads.set(row.id, head);
  } finally {
    repo.joining.delete(join);
    await releaseUnusedRepo(repo);
  }
}

/**
 * Tear down a repo watch that no row holds and none is joining. The root goes
 * first so a subscription callback already queued by the platform cannot
 * schedule another scan while teardown is settling the scans launched before
 * this point.
 */
async function releaseUnusedRepo(repo: RepoWatch): Promise<void> {
  if (repo.worktreeIds.size > 0 || repo.joining.size > 0) return;
  if (repoWatches.get(repo.key) !== repo) return;
  repoWatches.delete(repo.key);
  if (repo.debounce) clearTimeout(repo.debounce);
  clearRepoRetry(repo);
  await repo.subscription?.unsubscribe().catch(() => undefined);
  await Promise.allSettled([...repo.scans]);
}

/**
 * One subscribe attempt of a repo watch's git dir. It never rejects: an
 * answered native failure is logged and not retried, as a failed git-dir
 * watch always was; a Worker failure (or a read failure that is no
 * filesystem answer) retries on the backoff, and its success rescans in full.
 */
async function subscribeRepo(repo: RepoWatch): Promise<void> {
  const { side, mainRepoRoot } = repo;
  const gitDir = join(mainRepoRoot, ".git");
  let subscription: CheckoutWatchSubscription | undefined;
  let lostEarly = false;
  try {
    if (!(await checkoutFilesOn(side).pathExists(mainRepoRoot, gitDir))) return;
    const ignore = await gitDirIgnore(side, gitDir);
    try {
      subscription = await checkoutWatchOn(side).subscribe(
        mainRepoRoot,
        gitDir,
        (err, events) => {
          if (err) return;
          const paths = events
            .map((event) => event.path)
            .filter((path) => isRelevantGitPath(mainRepoRoot, path));
          if (paths.length > 0) scheduleRepoScan(repo.key, paths);
        },
        {
          ignore,
          onOverflow: () => requestFullRescan(repo),
          onLost: () => {
            if (subscription) onRepoLost(repo, subscription);
            else lostEarly = true;
          },
        },
      );
    } catch (err) {
      if (checkoutFailureOf(err) !== "filesystem") throw err;
      console.warn(
        "[worktrees] failed to watch git dir:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
  } catch (err) {
    repo.resumeScan = true;
    armRepoRetry(repo, repoBackoff(repo, err));
    return;
  }
  // Removed or replaced while subscribing: nothing holds it any more.
  if (repoWatches.get(repo.key) !== repo) {
    await subscription.unsubscribe().catch(() => undefined);
    return;
  }
  repo.subscription = subscription;
  repo.failures = 0;
  if (lostEarly) {
    onRepoLost(repo, subscription);
    return;
  }
  if (repo.resumeScan) {
    repo.resumeScan = false;
    repo.recoveredAt = Date.now();
    repo.recoveries += 1;
    requestFullRescan(repo);
  }
}

/** Count a failure (logging only the first of a run); the next retry delay. */
function repoBackoff(repo: RepoWatch, err?: unknown): number {
  if (err !== undefined) {
    repo.failures += 1;
    if (repo.failures === 1 || repo.failures % 10 === 0)
      console.warn(
        `[worktrees] git-dir watch of ${repo.mainRepoRoot} failed ${repo.failures}x (retrying):`,
        err instanceof Error ? err.message : String(err),
      );
  }
  return retryDelay(repo.failures);
}

function armRepoRetry(repo: RepoWatch, ms: number): void {
  if (repoWatches.get(repo.key) !== repo) return;
  clearRepoRetry(repo);
  repo.retryMs = ms;
  repo.retry = setTimeout(() => runRepoRetry(repo), ms);
}

function runRepoRetry(repo: RepoWatch): void {
  repo.retry = undefined;
  repo.retryMs = undefined;
  if (repoWatches.get(repo.key) === repo && !repo.subscription)
    void subscribeRepo(repo);
}

function clearRepoRetry(repo: RepoWatch): void {
  if (repo.retry) clearTimeout(repo.retry);
  repo.retry = undefined;
  repo.retryMs = undefined;
}

/**
 * The connection that held the git-dir subscription ended, and its Worker
 * released it: resubscribe now, or after the backoff when the last recovery
 * was less than {@link LOSS_STABLE_MS} ago.
 */
function onRepoLost(
  repo: RepoWatch,
  subscription: CheckoutWatchSubscription,
): void {
  if (repo.subscription !== subscription) return;
  repo.subscription = undefined;
  repo.resumeScan = true;
  if (repoWatches.get(repo.key) !== repo) return;
  if (quickLoss(repo)) {
    repo.lossRun += 1;
    repo.failures = repo.lossRun;
    armRepoRetry(repo, repoBackoff(repo));
    return;
  }
  repo.lossRun = 0;
  void subscribeRepo(repo);
}

function quickLoss(watch: LossRecovery): boolean {
  return (
    watch.recoveredAt !== undefined &&
    Date.now() - watch.recoveredAt < LOSS_STABLE_MS
  );
}

/** The retry delay after `failures` consecutive failures: 5 s doubling to 60 s. */
function retryDelay(failures: number): number {
  return Math.min(
    treeRetryBaseMs * 2 ** Math.max(0, failures - 1),
    TREE_RETRY_MAX_MS,
  );
}

/**
 * Where a linked worktree's admin directory lives, from its `.git` pointer;
 * undefined for the main checkout, or a pointer the filesystem cannot read.
 * A Worker failure rejects.
 */
async function linkedGitDirName(
  side: CheckoutSide,
  row: WorktreeRow,
): Promise<string | undefined> {
  if (row.path === row.mainRepoRoot) return undefined;
  let pointer: string;
  try {
    pointer = (
      await checkoutFilesOn(side).readFile(row.path, join(row.path, ".git"))
    )
      .toString("utf8")
      .trim();
  } catch (err) {
    if (checkoutFailureOf(err) === "filesystem") return undefined;
    throw err;
  }
  const normalized = pointer.split(sep).join("/");
  const marker = "/worktrees/";
  const start = normalized.lastIndexOf(marker);
  return start >= 0
    ? normalized.slice(start + marker.length).split("/")[0]
    : undefined;
}

function scheduleRepoScan(key: string, paths: string[]): void {
  const repo = repoWatches.get(key);
  if (!repo) return;
  for (const path of paths) repo.pendingGitPaths.add(path);
  if (repo.debounce) clearTimeout(repo.debounce);
  repo.debounce = setTimeout(() => {
    repo.debounce = undefined;
    const pendingPaths = [...repo.pendingGitPaths];
    repo.pendingGitPaths.clear();
    const full = repo.fullRescan;
    repo.fullRescan = false;
    const scan = scanRepo(key, pendingPaths, full);
    repo.scans.add(scan);
    void scan
      .catch((err) => {
        console.warn(
          "[worktrees] repo scan failed:",
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => repo.scans.delete(scan));
  }, GIT_DEBOUNCE_MS);
}

/**
 * Events were lost (a queue overflow, or the gap before a resubscribe): the
 * next scan reads every row in full, merged into the pending debounce.
 */
function requestFullRescan(repo: RepoWatch): void {
  if (repoWatches.get(repo.key) !== repo) return;
  repo.fullRescan = true;
  repo.fullRescans += 1;
  scheduleRepoScan(repo.key, []);
}

function relativeGitPath(mainRepoRoot: string, path: string): string {
  const normalized = path.split(sep).join("/");
  const prefix = `${mainRepoRoot.split(sep).join("/")}/.git/`;
  return normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized;
}

function branchMatchesRemote(
  branch: string | null,
  remoteRef: string,
  remoteBranch: string,
  branchUpstreams?: BranchUpstreams,
): boolean {
  if (!branch) return false;
  const tracking = branchUpstreams?.get(branch);
  if (tracking?.upstreamRef || tracking?.symref) {
    return tracking.upstreamRef === remoteRef || tracking.symref === remoteRef;
  }
  // Root-context config cannot see includeIf relationships scoped to a linked
  // worktree. Preserve main's same-name heuristic when exact metadata is absent.
  return branch === remoteBranch;
}

/** Pure targeting rule used by the watcher and its count-based tests. */
export function affectedWorktreeIdsForGitPaths(
  rows: WorktreeRow[],
  mainRepoRoot: string,
  paths: string[],
  gitDirNames: ReadonlyMap<string, string | undefined> = new Map(),
  branchUpstreams?: BranchUpstreams,
  linkedGitDirExists: (name: string) => boolean = () => true,
): string[] {
  const affected = new Set<string>();
  const all = () => rows.forEach((row) => affected.add(row.id));

  for (const path of paths) {
    const relative = relativeGitPath(mainRepoRoot, path);
    if (relative === "config") continue;
    if (relative === "config.worktree") {
      for (const row of rows) {
        if (gitDirNames.get(row.id) === undefined) affected.add(row.id);
      }
      continue;
    }
    const linkedConfig = /^worktrees\/([^/]+)\/config\.worktree$/.exec(
      relative,
    );
    if (linkedConfig) {
      for (const row of rows) {
        if (gitDirNames.get(row.id) === linkedConfig[1]) affected.add(row.id);
      }
      continue;
    }
    if (/(?:^|\/)config(?:\.worktree)?$/.test(relative)) continue;

    const refBatch =
      relative === "packed-refs" ||
      /^(?:logs\/)?refs\/(?:heads|remotes)\//.test(relative);
    if (refBatch && branchUpstreams) {
      for (const row of rows) {
        if (
          (row.branch && branchUpstreams.get(row.branch)?.symref) ||
          branchUpstreams.get(row.baseBranch)?.symref
        )
          affected.add(row.id);
      }
    }

    if (relative === "packed-refs") {
      all();
      continue;
    }

    const localBranch = /^(?:logs\/)?refs\/heads\/(.+)$/.exec(relative)?.[1];
    if (localBranch) {
      for (const row of rows) {
        if (row.branch === localBranch || row.baseBranch === localBranch)
          affected.add(row.id);
      }
      continue;
    }

    const remotePath = /^(?:logs\/)?refs\/remotes\/(.+)$/.exec(relative)?.[1];
    if (remotePath) {
      const remoteRef = `refs/remotes/${remotePath}`;
      const remoteBranch = remotePath.split("/").slice(1).join("/");
      for (const row of rows) {
        if (
          branchMatchesRemote(
            row.branch,
            remoteRef,
            remoteBranch,
            branchUpstreams,
          ) ||
          branchMatchesRemote(
            row.baseBranch,
            remoteRef,
            remoteBranch,
            branchUpstreams,
          )
        )
          affected.add(row.id);
      }
      continue;
    }

    if (/^(?:logs\/)?(?:HEAD|MERGE_HEAD)$/.test(relative)) {
      for (const row of rows) {
        if (gitDirNames.get(row.id) === undefined) affected.add(row.id);
      }
      continue;
    }

    const linkedHead =
      /^worktrees\/([^/]+)\/(?:logs\/)?(?:HEAD|MERGE_HEAD)$/.exec(relative);
    if (linkedHead) {
      let matched = false;
      for (const row of rows) {
        if (gitDirNames.get(row.id) !== linkedHead[1]) continue;
        matched = true;
        affected.add(row.id);
      }
      // An unknown linked HEAD fails safe to a full scan — unless its admin
      // directory is gone. That is a removal (ours drops the row before this
      // scan runs), and another checkout's HEAD vanishing moves nobody else.
      if (!matched && linkedGitDirExists(linkedHead[1]!)) all();
      continue;
    }

    // A relevant path Git lays out differently than expected must fail safe.
    all();
  }
  return [...affected];
}

function isRemoteOnlyGitBatch(mainRepoRoot: string, paths: string[]): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) =>
      /^(?:logs\/)?refs\/remotes\//.test(relativeGitPath(mainRepoRoot, path)),
    )
  );
}

function remoteBatchMovesBranch(
  mainRepoRoot: string,
  paths: string[],
  branch: string | null,
  branchUpstreams: BranchUpstreams,
): boolean {
  return paths.some((path) => {
    const remotePath = /^(?:logs\/)?refs\/remotes\/(.+)$/.exec(
      relativeGitPath(mainRepoRoot, path),
    )?.[1];
    if (!remotePath) return false;
    return branchMatchesRemote(
      branch,
      `refs/remotes/${remotePath}`,
      remotePath.split("/").slice(1).join("/"),
      branchUpstreams,
    );
  });
}

interface GitStatusBatchRefresh {
  statuses: Map<string, Awaited<ReturnType<typeof computeWorktreeStatus>>>;
  /** Rows that took the authoritative tier and may have moved HEAD/tree state. */
  fullyScanned: Set<string>;
}

async function refreshGitStatuses(
  side: CheckoutSide,
  rows: WorktreeRow[],
  mainRepoRoot: string,
  paths: string[],
  gitDirNames: ReadonlyMap<string, string | undefined> = new Map(),
  suppliedRepoKey?: string,
): Promise<GitStatusBatchRefresh> {
  const statuses = new Map<
    string,
    Awaited<ReturnType<typeof computeWorktreeStatus>>
  >();
  const fullyScanned = new Set<string>();
  const relativePaths = paths.map((path) =>
    relativeGitPath(mainRepoRoot, path),
  );
  const configPresent = relativePaths.includes("config");
  const refPathsPresent = relativePaths.some(
    (path) =>
      path === "packed-refs" ||
      /^(?:logs\/)?refs\/(?:heads|remotes)\//.test(path),
  );
  const previousBranchUpstreams =
    configPresent || refPathsPresent
      ? cachedRepoBranchUpstreams(side, mainRepoRoot)
      : undefined;
  let branchUpstreams = previousBranchUpstreams;
  // Whether an unknown linked HEAD's admin directory still exists, read on
  // the repo's side before the synchronous targeting rule asks. A Worker
  // failure rejects the scan.
  const known = new Set(rows.map((row) => gitDirNames.get(row.id)));
  const present = new Map<string, boolean>();
  const files = checkoutFilesOn(side);
  for (const path of relativePaths) {
    const name = /^worktrees\/([^/]+)\/(?:logs\/)?(?:HEAD|MERGE_HEAD)$/.exec(
      path,
    )?.[1];
    if (name === undefined || known.has(name) || present.has(name)) continue;
    const adminDir = join(mainRepoRoot, ".git", "worktrees", name);
    present.set(name, await files.pathExists(mainRepoRoot, adminDir));
  }
  const linkedGitDirExists = (name: string) => present.get(name) ?? true;
  let affected = new Set(
    affectedWorktreeIdsForGitPaths(
      rows,
      mainRepoRoot,
      paths,
      gitDirNames,
      branchUpstreams,
      linkedGitDirExists,
    ),
  );
  // A watched repo primes relationship metadata once at registration. A cold
  // ref event must read before concluding it has no targets: a differently
  // named upstream or symbolic local ref can defeat name-only targeting.
  if (
    affected.size === 0 &&
    !configPresent &&
    (!refPathsPresent || branchUpstreams)
  )
    return { statuses, fullyScanned };

  // One authoritative ref map is shared by every row in the batch. This keeps
  // a fetch across N linked worktrees at one process rather than N scans.
  const repoKey =
    suppliedRepoKey ?? (await checkoutGitOn(side).repoLockKey(mainRepoRoot));
  branchUpstreams = await readRepoBranchUpstreams(side, mainRepoRoot, {
    force: true,
    repoKey,
  });
  if (refPathsPresent) {
    affected = new Set(
      affectedWorktreeIdsForGitPaths(
        rows,
        mainRepoRoot,
        paths,
        gitDirNames,
        branchUpstreams,
        linkedGitDirExists,
      ),
    );
  }
  if (configPresent) {
    const relationship = (branch: string | null, map?: BranchUpstreams) => {
      const tracking = branch ? map?.get(branch) : undefined;
      return `${tracking?.upstreamRef ?? ""}|${tracking?.symref ?? ""}|${tracking?.gone ? "gone" : "present"}`;
    };
    for (const row of rows) {
      if (
        !previousBranchUpstreams ||
        relationship(row.branch, previousBranchUpstreams) !==
          relationship(row.branch, branchUpstreams) ||
        relationship(row.baseBranch, previousBranchUpstreams) !==
          relationship(row.baseBranch, branchUpstreams)
      )
        affected.add(row.id);
    }
  }
  if (affected.size === 0) return { statuses, fullyScanned };

  const remoteOnly = isRemoteOnlyGitBatch(mainRepoRoot, paths);
  for (const row of rows) {
    if (!affected.has(row.id)) continue;
    const symbolic = Boolean(
      (row.branch && branchUpstreams.get(row.branch)?.symref) ||
      branchUpstreams.get(row.baseBranch)?.symref,
    );
    const mappedOwnUpstream = row.branch
      ? branchUpstreams.get(row.branch)?.upstreamRef
      : undefined;
    const ownUpstreamMoved =
      remoteOnly && mappedOwnUpstream
        ? remoteBatchMovesBranch(
            mainRepoRoot,
            paths,
            row.branch,
            branchUpstreams,
          )
        : false;
    const patched =
      remoteOnly && !symbolic && !ownUpstreamMoved
        ? await refreshWorktreeRemotePatch(row, branchUpstreams)
        : undefined;
    const status =
      patched ??
      (await computeWorktreeStatus(row, {
        force: true,
        branchUpstreams,
      }));
    if (!patched) fullyScanned.add(row.id);
    statuses.set(row.id, status);
  }
  return { statuses, fullyScanned };
}

/**
 * Test seam for count-based git-batch assertions without watcher timing. The
 * rows share one side, as a repo watch's do.
 */
export async function refreshGitStatusesForTests(
  side: CheckoutSide,
  rows: WorktreeRow[],
  mainRepoRoot: string,
  paths: string[],
  gitDirNames: ReadonlyMap<string, string | undefined> = new Map(),
  suppliedRepoKey?: string,
): Promise<Map<string, Awaited<ReturnType<typeof computeWorktreeStatus>>>> {
  return (
    await refreshGitStatuses(
      side,
      rows,
      mainRepoRoot,
      paths,
      gitDirNames,
      suppliedRepoKey,
    )
  ).statuses;
}

/**
 * Every row in full: one authoritative ref map, then a forced status of each,
 * never the remote patch.
 */
async function refreshAllGitStatuses(
  side: CheckoutSide,
  rows: WorktreeRow[],
  mainRepoRoot: string,
  suppliedRepoKey?: string,
): Promise<GitStatusBatchRefresh> {
  const repoKey =
    suppliedRepoKey ?? (await checkoutGitOn(side).repoLockKey(mainRepoRoot));
  const branchUpstreams = await readRepoBranchUpstreams(side, mainRepoRoot, {
    force: true,
    repoKey,
  });
  const statuses: GitStatusBatchRefresh["statuses"] = new Map();
  for (const row of rows)
    statuses.set(
      row.id,
      await computeWorktreeStatus(row, { force: true, branchUpstreams }),
    );
  return { statuses, fullyScanned: new Set(statuses.keys()) };
}

async function scanRepo(
  key: string,
  paths: string[],
  full = false,
): Promise<void> {
  const repo = repoWatches.get(key);
  if (!repo) return;
  const { side, mainRepoRoot } = repo;
  const rows: WorktreeRow[] = [];
  for (const worktreeId of [...repo.worktreeIds]) {
    const row = await resolveReadableWorktreeRow(worktreeId);
    if (!row || row.status !== "active") {
      repo.worktreeIds.delete(worktreeId);
      repo.gitDirNames.delete(worktreeId);
      repo.lastHeads.delete(worktreeId);
      continue;
    }
    rows.push(row);
  }
  const refreshed = full
    ? await refreshAllGitStatuses(side, rows, mainRepoRoot, repo.repoKey)
    : await refreshGitStatuses(
        side,
        rows,
        mainRepoRoot,
        paths,
        repo.gitDirNames,
        repo.repoKey,
      );
  const remoteOnly = !full && isRemoteOnlyGitBatch(mainRepoRoot, paths);
  for (const row of rows) {
    const status = refreshed.statuses.get(row.id);
    if (!status) continue;
    worktreeBroadcaster().broadcastWorktree(status.worktreeId, {
      type: "worktreeStatus",
      status,
    });

    // A remote-tracking ref cannot move a local HEAD. The cheap tier ends here:
    // no rev-parse, listener fan-out or change-list scan after an interval fetch.
    if (remoteOnly && !refreshed.fullyScanned.has(row.id)) continue;
    const head = await currentHead(side, row.path);
    const lastHead = repo.lastHeads.get(row.id);
    if (head && head !== lastHead) {
      repo.lastHeads.set(row.id, head);
      for (const listener of gitStateListeners) {
        try {
          listener(row.id, head);
        } catch (err) {
          console.warn(
            "[worktrees] git-state listener failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if ((treeWatches.get(row.id)?.refs ?? 0) > 0) await pushChanges(row);
    }
  }
}

/* ----------------------------- working-tree tier --------------------------- */

async function pushChanges(row: WorktreeRow): Promise<void> {
  const tree = treeWatches.get(row.id);
  try {
    const changes = await getWorktreeChanges(row, { kind: "workingTree" });
    worktreeBroadcaster().broadcastWorktree(changes.worktreeId, {
      type: "worktreeChanges",
      changes,
    });
    if (tree && treeWatches.get(row.id) === tree)
      tree.lastChangesEmpty = changes.files.length === 0;
  } catch (err) {
    console.warn(
      "[worktrees] change scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function scanTreeEvent(
  row: WorktreeRow,
  lastChangesEmpty: boolean | undefined,
) {
  const refresh = await refreshWorktreeWorkingTree(row);
  return {
    status: refresh.status,
    ...(!refresh.status.dirty && lastChangesEmpty
      ? {}
      : {
          changes: worktreeChangesFromSnapshot(row, refresh, refresh.files),
        }),
  };
}

/** Test seam for subprocess-count assertions without filesystem timing. */
export async function scanTreeEventForTests(
  row: WorktreeRow,
  lastChangesEmpty: boolean | undefined,
) {
  return scanTreeEvent(row, lastChangesEmpty);
}

function scheduleTreeScan(worktreeId: string): void {
  const tree = treeWatches.get(worktreeId);
  if (!tree) return;
  tree.scansScheduled += 1;
  if (tree.debounce) clearTimeout(tree.debounce);
  tree.debounce = setTimeout(() => {
    tree.debounce = undefined;
    void (async () => {
      const row = await resolveReadableWorktreeRow(worktreeId);
      if (!row || row.status !== "active") return;
      const currentTree = treeWatches.get(worktreeId);
      try {
        const result = await scanTreeEvent(row, currentTree?.lastChangesEmpty);
        worktreeBroadcaster().broadcastWorktree(result.status.worktreeId, {
          type: "worktreeStatus",
          status: result.status,
        });
        if (result.changes) {
          worktreeBroadcaster().broadcastWorktree(result.changes.worktreeId, {
            type: "worktreeChanges",
            changes: result.changes,
          });
          if (treeWatches.get(worktreeId) === currentTree && currentTree)
            currentTree.lastChangesEmpty = result.changes.files.length === 0;
        }
      } catch {
        // Preserve the old independent failure domains: a status failure must
        // not prevent the change list from recovering through its public path.
        await pushChanges(row);
      }
      if (currentTree?.ignoreStale) void reconcileTree(currentTree);
    })();
  }, TREE_DEBOUNCE_MS);
}

/** Whether an event path lies in a git dir (the checkout's, or an embedded repo's). */
function inGitDir(root: string, path: string): boolean {
  return relative(root, path).split(sep).includes(".git");
}

function onTreeEvents(
  tree: TreeWatch,
  events: ReadonlyArray<{ path: string }>,
): void {
  const root = tree.path;
  if (!root || treeWatches.get(tree.id) !== tree) return;
  // The ignore option drops subtree events, but directory-entry events for
  // `.git` itself can still surface; filter defensively.
  const changed = events.filter((event) => !inGitDir(root, event.path));
  if (changed.length === 0) return;
  onTreeBatch(
    tree,
    changed.length >= TREE_BULK_EVENTS ||
      changed.some((event) => basename(event.path) === ".gitignore"),
  );
}

/** The Worker's queue overflowed: the lost batches count as one bulk batch. */
function onTreeOverflow(tree: TreeWatch): void {
  if (!tree.path || treeWatches.get(tree.id) !== tree) return;
  onTreeBatch(tree, true);
}

function onTreeBatch(tree: TreeWatch, bulk: boolean): void {
  tree.eventBatches += 1;
  if (bulk) tree.ignoreStale = true;
  // A lingering or retiring watch only keeps its crawl warm: no one would
  // receive a scan, and the next viewer takes a fresh read of its own.
  if (tree.refs === 0 || tree.retired) {
    tree.lastChangesEmpty = undefined;
    return;
  }
  scheduleTreeScan(tree.id);
}

/** Registered and not retired: its viewers and linger still count. */
function isActive(tree: TreeWatch): boolean {
  return treeWatches.get(tree.id) === tree && !tree.retired;
}

/**
 * Whether `tree` ranks among the {@link maxTreeWatches} watches that should
 * hold a subscription. Ranking only says who SHOULD; {@link canSubscribe}
 * says whether a slot is free right now.
 */
function holdsWatchSlot(tree: TreeWatch): boolean {
  if (!tree.path || !isActive(tree)) return false;
  const ranked = [...treeWatches.values()]
    .filter((other) => other.path && !other.retired)
    .sort(
      (a, b) =>
        Number(b.refs > 0) - Number(a.refs > 0) ||
        b.lastViewedAt - a.lastViewedAt,
    );
  return ranked.indexOf(tree) < maxTreeWatches;
}

/**
 * The hard cap: every subscription held or being made occupies a slot,
 * whatever its watch's state (active, displaced and still releasing,
 * retired). A ranked tree finding none free waits; the re-rank after each
 * successful release admits it.
 */
function canSubscribe(): boolean {
  let held = 0;
  for (const other of treeWatches.values())
    if (other.subscription || other.subscribing) held += 1;
  return held < maxTreeWatches;
}

function sameIgnore(a: string[], b: string[] | undefined): boolean {
  const known = new Set(b);
  return a.length === known.size && a.every((entry) => known.has(entry));
}

/**
 * Bring one watch's subscription in line with the demand it finds: subscribe
 * while it holds a slot, release it otherwise (an idle watch that lost its
 * slot is forgotten), and re-subscribe only when a refreshed ignore set
 * differs. A demand change during an await queues another step behind this
 * one, which settles whatever this step left. Nothing waits for an event to
 * come back: a throttled refresh, a failed subscribe of a viewed tree and a
 * failed release each schedule their own next step ({@link retryTree}).
 */
async function settleTree(tree: TreeWatch): Promise<void> {
  const path = tree.path;
  // Set together with the path, so a watch with a path has its side.
  const side = tree.side;
  // Undefined when the Worker failed to answer: never "missing".
  let present: boolean | undefined = false;
  let failure: unknown;
  if (path && side)
    try {
      present = await checkoutFilesOn(side).pathExists(path, path);
    } catch (err) {
      if (checkoutFailureOf(err) !== "worker") throw err;
      present = undefined;
      failure = err;
    }
  if (!path || !side || present === false || !holdsWatchSlot(tree)) {
    if (tree.refs === 0) retireTree(tree);
    else if (path && isActive(tree))
      noteUnwatched(tree, present === false ? "missing" : "cap");
    // Only its armed timer retries a failed release: a re-rank must not
    // hammer a native unsubscribe that keeps failing.
    if (tree.subscription && tree.backingOff) return;
    clearRetry(tree);
    const released = tree.subscription !== undefined;
    if (!(await releaseSubscription(tree))) {
      retryTree(tree, failureBackoff(tree), true);
      tree.backingOff = true;
      return;
    }
    tree.failures = 0;
    // A re-view during the release un-retired it; its own step subscribes.
    if (tree.retired) dropTree(tree);
    // The slot it held is free for a viewed tree that was denied one.
    if (released) reconcileTrees();
    return;
  }
  if (present === undefined) {
    // A failed step: it retries while viewed, as a failed subscribe does.
    if (!tree.backingOff) {
      retryTree(tree, failureBackoff(tree, failure));
      tree.backingOff = tree.retry !== undefined;
    }
    return;
  }
  tree.unwatched = undefined;
  if (tree.subscription && !tree.ignoreStale) return;
  if (tree.backingOff) return;
  const wait = tree.ignoreRefreshedAt + treeIgnoreRefreshMs - Date.now();
  if (tree.subscription && wait > 0) {
    retryTree(tree, wait);
    return;
  }
  // Cleared before the read so an edit landing during it marks the set stale
  // again; a failure below restores it.
  tree.ignoreStale = false;
  tree.ignoreRefreshedAt = Date.now();
  try {
    const { ignore, complete } = await treeIgnore(side, path);
    if (!complete) tree.ignoreStale = true;
    if (tree.subscription && (!complete || sameIgnore(ignore, tree.ignore)))
      return;
    if (!holdsWatchSlot(tree)) return;
    // Parcel keeps ONE crawled tree per directory whatever the ignore list: a
    // subscription made while the old one lives inherits its crawl and never
    // watches a newly un-ignored directory. So nothing subscribes until the
    // old one is provably released; a rescan covers the gap.
    const replacing = tree.subscription !== undefined;
    if (!(await releaseSubscription(tree))) {
      tree.ignoreStale = true;
      retryTree(tree, failureBackoff(tree));
      tree.backingOff = tree.retry !== undefined;
      return;
    }
    if (!canSubscribe()) return;
    tree.subscribing = true;
    let subscription: CheckoutWatchSubscription | undefined;
    let lostEarly = false;
    try {
      subscription = await checkoutWatchOn(side).subscribe(
        path,
        path,
        (err, events) => {
          if (!err) onTreeEvents(tree, events);
        },
        {
          ignore,
          onOverflow: () => onTreeOverflow(tree),
          onLost: () => {
            if (subscription) onTreeLost(tree, subscription);
            else lostEarly = true;
          },
        },
      );
      tree.subscription = subscription;
    } finally {
      tree.subscribing = false;
    }
    tree.ignore = ignore;
    tree.failures = 0;
    if (lostEarly) {
      onTreeLost(tree, subscription);
      return;
    }
    if (tree.resumeScan) {
      // Events between the loss and now went nowhere: one full rescan.
      tree.resumeScan = false;
      tree.recoveredAt = Date.now();
      tree.recoveries += 1;
      if (tree.refs > 0) scheduleTreeScan(tree.id);
    } else if (replacing && tree.refs > 0) scheduleTreeScan(tree.id);
  } catch (err) {
    tree.ignoreStale = true;
    const delay = failureBackoff(tree, err);
    if (!tree.subscription) {
      retryTree(tree, delay);
      tree.backingOff = tree.retry !== undefined;
    }
    // The slot this attempt reserved is free again for a waiting tree.
    for (const other of [...treeWatches.values()])
      if (other !== tree) void reconcileTree(other);
  } finally {
    // A stale set still has its next attempt due: an un-ignored directory
    // sends no event that would ask again.
    if (tree.ignoreStale && tree.subscription && !tree.retry)
      retryTree(tree, treeIgnoreRefreshMs);
  }
}

/**
 * Unsubscribe, keeping the reference unless parcel confirms the release: a
 * dropped live subscription would leak its watches and its crawl, which the
 * next subscribe of the directory would inherit.
 */
async function releaseSubscription(tree: TreeWatch): Promise<boolean> {
  const subscription = tree.subscription;
  if (!subscription) return true;
  try {
    await subscription.unsubscribe();
  } catch (err) {
    failureBackoff(tree, err);
    return false;
  }
  if (tree.subscription === subscription) {
    tree.subscription = undefined;
    tree.ignore = undefined;
  }
  return true;
}

/** Count a failure (logging only the first of a run); the next retry delay. */
function failureBackoff(tree: TreeWatch, err?: unknown): number {
  if (err !== undefined) {
    tree.failures += 1;
    if (tree.failures === 1 || tree.failures % 10 === 0)
      console.warn(
        `[worktrees] tree watch of ${tree.id} failed ${tree.failures}x (retrying; a subscription that never releases keeps its slot until restart):`,
        err instanceof Error ? err.message : String(err),
      );
  }
  return retryDelay(tree.failures);
}

/**
 * The connection that held the tree's subscription ended, and its Worker
 * released it. The slot is free now. Resubscribe at once, or after the
 * backoff when the last recovery was less than {@link LOSS_STABLE_MS} ago; a
 * lingering tree resubscribes when its next viewer arrives.
 */
function onTreeLost(
  tree: TreeWatch,
  subscription: CheckoutWatchSubscription,
): void {
  if (tree.subscription !== subscription) return;
  // A refresh or release retry armed for the lost subscription is moot.
  clearRetry(tree);
  tree.subscription = undefined;
  tree.ignore = undefined;
  tree.ignoreStale = true;
  tree.lastChangesEmpty = undefined;
  tree.resumeScan = true;
  if (!quickLoss(tree)) {
    tree.lossRun = 0;
    reconcileTrees();
    return;
  }
  tree.lossRun += 1;
  tree.failures = tree.lossRun;
  retryTree(tree, failureBackoff(tree));
  tree.backingOff = tree.retry !== undefined;
  // A retired tree has nothing left to wait for: its settle drops it.
  if (tree.retired) void reconcileTree(tree);
  for (const other of [...treeWatches.values()])
    if (other !== tree) void reconcileTree(other);
}

/** Log once per episode why a viewed tree holds no subscription. */
function noteUnwatched(tree: TreeWatch, reason: "cap" | "missing"): void {
  if (tree.unwatched === reason) return;
  tree.unwatched = reason;
  console.warn(
    reason === "cap"
      ? `[worktrees] ${maxTreeWatches} tree watches are live; ${tree.id} refreshes only on tool calls and git-dir changes`
      : `[worktrees] checkout of ${tree.id} is missing; not watching it`,
  );
}

/**
 * Settle `tree` again after `ms`. A refresh or subscribe retry runs only while
 * anyone views the tree (an idle watch settles again when its next viewer
 * arrives); a RELEASE retry runs until the subscription is gone, even for a
 * forgotten watch.
 */
function retryTree(tree: TreeWatch, ms: number, release = false): void {
  if (!release && (tree.refs === 0 || !isActive(tree))) return;
  clearRetry(tree);
  tree.retryRelease = release;
  tree.retryMs = ms;
  tree.retry = setTimeout(() => runRetry(tree, release), ms);
}

function runRetry(tree: TreeWatch, release: boolean): void {
  tree.retry = undefined;
  tree.retryMs = undefined;
  tree.backingOff = false;
  if (release ? tree.subscription : tree.refs > 0 && isActive(tree))
    void reconcileTree(tree);
}

function clearRetry(tree: TreeWatch): void {
  if (tree.retry) clearTimeout(tree.retry);
  tree.retry = undefined;
  tree.retryMs = undefined;
  tree.retryRelease = false;
  tree.backingOff = false;
}

/** Queue a {@link settleTree} step; resolves once this one has run. */
function reconcileTree(tree: TreeWatch): Promise<void> {
  tree.settlesPending += 1;
  tree.reconciling = tree.reconciling
    .then(() => settleTree(tree))
    .catch((err: unknown) => {
      console.warn(
        "[worktrees] failed to settle worktree watch:",
        err instanceof Error ? err.message : String(err),
      );
    })
    .finally(() => {
      tree.settlesPending -= 1;
    });
  return tree.reconciling;
}

/** A viewer arriving or leaving can move any watch across the cap. */
function reconcileTrees(): void {
  for (const tree of [...treeWatches.values()]) void reconcileTree(tree);
}

/**
 * End a watch's demand; the caller reconciles it, and {@link settleTree}
 * drops the entry once its subscription is released.
 */
function retireTree(tree: TreeWatch): void {
  tree.retired = true;
  if (tree.linger) clearTimeout(tree.linger);
  if (tree.debounce) clearTimeout(tree.debounce);
  if (!tree.retryRelease) clearRetry(tree);
  tree.linger = undefined;
  tree.debounce = undefined;
}

/** Remove a watch holding no subscription from the registry. */
function dropTree(tree: TreeWatch): void {
  if (treeWatches.get(tree.id) === tree) treeWatches.delete(tree.id);
  retireTree(tree);
  clearRetry(tree);
}

/**
 * A client opened the worktree view: refcount up, start the tree watch, and
 * ensure the git-state watch exists (idempotent per repo) so commits refresh
 * status — the only source for a viewed main checkout, which isn't registered
 * at create time like spawned worktrees.
 *
 * The id is canonicalized (git-free) so an aliased `main:MAIN-PROJ` keys the
 * SAME TreeWatch as the canonical `main:main-proj` the scans/broadcasts use;
 * otherwise the entry would never receive tree scans and could self-unsubscribe.
 * A cheap sync existence check runs BEFORE reserving global state so a noisy
 * client can't allocate entries for unknown ids. The refcount is then reserved
 * SYNCHRONOUSLY before the async resolve so a racing (sync)
 * {@link removeWorktreeViewer} always finds this TreeWatch to decrement.
 * Await the returned promise to know the subscription is live (tests rely on
 * this); production fires it and forgets.
 */
export async function addWorktreeViewer(worktreeId: string): Promise<void> {
  const id = canonicalWorktreeId(worktreeId);
  if (id !== KNOWLEDGE_WORKTREE_ID && !worktreeExistsSync(id)) return;

  let tree = treeWatches.get(id);
  if (!tree) {
    tree = {
      id,
      path: undefined,
      side: undefined,
      subscription: undefined,
      ignore: undefined,
      reconciling: Promise.resolve(),
      refs: 0,
      lastViewedAt: 0,
      linger: undefined,
      debounce: undefined,
      lastChangesEmpty: undefined,
      ignoreStale: false,
      ignoreRefreshedAt: 0,
      retry: undefined,
      retryMs: undefined,
      retryRelease: false,
      failures: 0,
      lossRun: 0,
      recoveredAt: undefined,
      resumeScan: false,
      recoveries: 0,
      unwatched: undefined,
      retired: false,
      subscribing: false,
      backingOff: false,
      eventBatches: 0,
      scansScheduled: 0,
      settlesPending: 0,
    };
    treeWatches.set(id, tree);
  }
  // A retired watch may still be releasing: reuse it, never subscribe the
  // same path from a second one.
  tree.retired = false;
  tree.refs += 1;
  tree.lastViewedAt = Date.now();
  if (tree.linger) {
    clearTimeout(tree.linger);
    tree.linger = undefined;
  }

  const row = await resolveReadableWorktreeRow(id);
  // No git-backed row (e.g. an existing but non-git project that passed the sync
  // gate): release our reservation immediately so no inert entry lingers.
  if (!row || row.status !== "active") {
    releaseReservation(tree);
    return;
  }
  // Torn down while resolving (last viewer already left): don't subscribe.
  if (!isActive(tree) || tree.refs === 0) return;
  await ensureRepoWatch(row);
  if (!isActive(tree) || tree.refs === 0) return;
  // Subscribe before taking the baseline so no write can land between the
  // snapshot and watcher startup. An event during the plain compute waits for
  // that in-flight scan, then takes its own fresh working-tree snapshot. A
  // lingering watch is already live and costs no crawl.
  tree.path = row.path; // row.id === id (canonical), so scans/teardown key match
  tree.side = checkoutSideOf(row);
  reconcileTrees();
  await tree.reconciling;
  if (!isActive(tree) || tree.refs === 0) return;
  // Concurrent first viewers and the connection answer adopt this same read.
  await computeWorktreeStatus(row).catch(() => undefined);
}

/** Undo a reservation from {@link addWorktreeViewer} when the id turns out invalid. */
function releaseReservation(tree: TreeWatch): void {
  if (!isActive(tree)) return;
  tree.refs = Math.max(0, tree.refs - 1);
  if (tree.refs > 0) return;
  retireTree(tree);
  void reconcileTree(tree);
}

/** A client left the worktree view: refcount down, stop after a linger. */
export function removeWorktreeViewer(worktreeId: string): void {
  const id = canonicalWorktreeId(worktreeId);
  const tree = treeWatches.get(id);
  if (!tree) return;
  tree.refs = Math.max(0, tree.refs - 1);
  if (tree.refs > 0 || tree.linger || tree.retired) return;
  // A refresh or subscribe retry serves viewers only; a release retry stays.
  if (!tree.retryRelease) clearRetry(tree);
  tree.linger = setTimeout(() => endLinger(tree), treeLingerMs);
  // Without viewers it ranks below every viewed watch.
  reconcileTrees();
}

function endLinger(tree: TreeWatch): void {
  tree.linger = undefined;
  if (tree.refs > 0 || !isActive(tree)) return;
  retireTree(tree);
  void reconcileTree(tree);
}

/**
 * A tool call of `sessionId` finished: rescan its linked worktree while anyone
 * views it. It shares the tree watch's debounce, so an edit the watch also saw
 * costs one scan, and it is what refreshes a viewer after an agent edit the
 * watch cannot see (a submodule's files, a tree past the cap).
 */
export function rescanSessionWorktree(sessionId: string): void {
  const worktreeId = worktreeIdBySession().get(sessionId);
  const tree = worktreeId ? treeWatches.get(worktreeId) : undefined;
  if (tree && tree.refs > 0 && isActive(tree)) scheduleTreeScan(tree.id);
}

/**
 * Main-repo roots of the worktrees a client is watching right now, each with
 * the side it is watched on. This is the background fetch's interest signal:
 * it is asked on every sweep and therefore cannot age out under a surface that
 * is open but quiet.
 */
export function watchedRepoRoots(): WatchedRepo[] {
  const roots = new Map<string, WatchedRepo>();
  for (const [worktreeId, tree] of treeWatches) {
    if (tree.refs <= 0 || tree.retired) continue;
    for (const [key, repo] of repoWatches) {
      if (repo.worktreeIds.has(worktreeId))
        roots.set(key, { side: repo.side, root: repo.mainRepoRoot });
    }
  }
  return [...roots.values()];
}

/** Test hook: current viewer refcount for a worktree id (0 if none). */
export function worktreeViewerRefs(worktreeId: string): number {
  return treeWatches.get(canonicalWorktreeId(worktreeId))?.refs ?? 0;
}

/** Test hook: whether a worktree's tree watch holds a live subscription. */
export async function treeWatchLiveForTests(
  worktreeId: string,
): Promise<boolean> {
  const tree = treeWatches.get(canonicalWorktreeId(worktreeId));
  await tree?.reconciling;
  return Boolean(tree?.subscription);
}

/** Test hook: end every running linger now, as its timer would. */
export function endTreeLingersForTests(): void {
  for (const tree of [...treeWatches.values()])
    if (tree.linger) {
      clearTimeout(tree.linger);
      endLinger(tree);
    }
}

/**
 * Test hook: what a registered watch has done — event batches delivered, scans
 * scheduled, settle steps not yet run, and whether a retry is armed — so a test
 * waits for a signal instead of a production timer.
 */
export function treeActivityForTests(worktreeId: string) {
  const tree = treeWatches.get(canonicalWorktreeId(worktreeId));
  return (
    tree && {
      eventBatches: tree.eventBatches,
      scansScheduled: tree.scansScheduled,
      settlesPending: tree.settlesPending,
      retryArmed: tree.retry !== undefined,
      retryMs: tree.retryMs,
      recoveries: tree.recoveries,
    }
  );
}

/**
 * Test hook: the git-dir watch holding a worktree — its armed retry and
 * delay, recoveries after a loss, and full rescans requested.
 */
export function repoActivityForTests(worktreeId: string) {
  for (const repo of repoWatches.values())
    if (repo.worktreeIds.has(worktreeId))
      return {
        retryArmed: repo.retry !== undefined,
        retryMs: repo.retryMs,
        recoveries: repo.recoveries,
        fullRescans: repo.fullRescans,
      };
  return undefined;
}

/** Test hook: run every repo watch's armed retry now, as its timer would. */
export function fireRepoRetriesForTests(): void {
  for (const repo of [...repoWatches.values()])
    if (repo.retry) {
      clearTimeout(repo.retry);
      runRepoRetry(repo);
    }
}

/** Test hook: run every registered watch's armed retry now, as its timer would. */
export function fireTreeRetriesForTests(): void {
  for (const tree of [...treeWatches.values()])
    if (tree.retry) {
      clearTimeout(tree.retry);
      runRetry(tree, tree.retryRelease);
    }
}

interface TreeWatchLimits {
  lingerMs: number;
  maxWatches: number;
  ignoreRefreshMs: number;
  retryBaseMs: number;
}

/**
 * Test hook: override the tree-tier limits, whose retry base the git-dir
 * watch's backoff shares; returns the previous ones.
 */
export function setTreeWatchLimitsForTests(
  limits: Partial<TreeWatchLimits>,
): TreeWatchLimits {
  const previous = {
    lingerMs: treeLingerMs,
    maxWatches: maxTreeWatches,
    ignoreRefreshMs: treeIgnoreRefreshMs,
    retryBaseMs: treeRetryBaseMs,
  };
  treeLingerMs = limits.lingerMs ?? treeLingerMs;
  maxTreeWatches = limits.maxWatches ?? maxTreeWatches;
  treeIgnoreRefreshMs = limits.ignoreRefreshMs ?? treeIgnoreRefreshMs;
  treeRetryBaseMs = limits.retryBaseMs ?? treeRetryBaseMs;
  return previous;
}

/* --------------------------------- lifecycle ------------------------------- */

/** Track a worktree in the always-on git-state tier (create + boot rehydrate). */
export async function registerWorktree(row: WorktreeRow): Promise<void> {
  if (row.status !== "active") return;
  await ensureRepoWatch(row);
}

/** Stop tracking a removed worktree (its repo watch stays for siblings). */
export async function unregisterWorktree(worktreeId: string): Promise<void> {
  for (const repo of repoWatches.values()) {
    let held = repo.worktreeIds.delete(worktreeId);
    for (const join of repo.joining)
      if (join.worktreeId === worktreeId) {
        repo.joining.delete(join);
        held = true;
      }
    if (!held) continue;
    repo.gitDirNames.delete(worktreeId);
    repo.lastHeads.delete(worktreeId);
    await releaseUnusedRepo(repo);
  }
  const tree = treeWatches.get(worktreeId);
  if (tree) {
    retireTree(tree);
    await reconcileTree(tree);
  }
}

/** Register every active worktree on boot. */
/**
 * Connect the background fetch to this watcher, both ways: it asks us who is
 * watching, and we rescan when it finishes.
 *
 * The rescan matters even for a fetch that changed nothing. A no-op fetch
 * writes no refs, so no filesystem event fires and the status — including its
 * `fetchedAt` stamp — would never be rebroadcast, freezing the card's "as of"
 * marker at the last fetch that happened to move something.
 */
function connectBackgroundFetch(): void {
  setFetchInterestSource(watchedRepoRoots);
  onFetchCompleted((side, repoPath, fetchedAt) => {
    const repo = repoWatches.get(repoWatchKey(side, repoPath));
    if (!repo) return;
    // Ref moves are targeted by the filesystem events above. A no-op fetch has
    // no such event, so update only the freshness stamp in cached statuses.
    void Promise.all(
      [...repo.worktreeIds].map((worktreeId) =>
        stampWorktreeStatusFetchedAt(worktreeId, fetchedAt).then((status) => {
          if (status)
            worktreeBroadcaster().broadcastWorktree(worktreeId, {
              type: "worktreeStatus",
              status,
            });
        }),
      ),
    ).catch(() => undefined);
  });
}

export async function rehydrateWorktreeWatchers(): Promise<void> {
  connectBackgroundFetch();
  for (const row of listWorktrees()) {
    try {
      await registerWorktree(row);
    } catch (err) {
      console.warn(
        "[worktrees] failed to register watcher:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
