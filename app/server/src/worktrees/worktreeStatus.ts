/**
 * Live git state per worktree: dirty/change counts from the worktree itself,
 * ahead/behind/merged vs the base branch from the main repo. Computed on
 * demand with a short TTL cache + in-flight coalescing (the same pattern as
 * `workshopGit.ts`); the watcher (worktreeWatcher.ts) refreshes and pushes.
 *
 * Never memoize or gate a row-context tracking read from main-checkout state:
 * per-worktree config and local/global `includeIf gitdir:` can change its input
 * without any root-observable event. Five cheap proxies failed for this reason:
 * extension probes, private-file existence, cached values, root-map silence,
 * and root-map presence.
 */
import type { WorktreeChangeFile, WorktreeGitStatus } from "@assistant/shared";
import { existsSync } from "node:fs";
import {
  gitOptionalExit,
  gitReadOnlyOptional,
  gitReadOnlyOptionalExit,
  repoLockKey,
  type GitResult,
} from "../gitExec.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { workingTreeFilesFromPorcelainV2 } from "./worktreeDiff.ts";
import {
  fetchRepoIfDue,
  noteRepoInterest,
  noteWorktreeInterest,
} from "./worktreeFetch.ts";

const STATUS_CACHE_MS = 1_000;
const MERGED_CACHE_MAX = 512;

interface CacheEntry {
  status: WorktreeGitStatus;
  cachedAt: number;
  /** A mutation invalidated ref fields; tree refreshes may reuse but not bless them. */
  referenceStale: boolean;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<WorktreeGitStatus>>();
const mergedByTips = new Map<string, Promise<boolean>>();

interface BranchTracking {
  ahead: number;
  behind: number;
  /** Exact configured upstream ref, including refs/remotes/<remote>/. */
  upstreamRef?: string;
  /** Git's resolved short upstream name, preserving the configured remote. */
  upstreamName?: string;
  /** Exact symbolic target when this local branch is itself a symref. */
  symref?: string;
  gone?: boolean;
}
export type BranchUpstreams = ReadonlyMap<string, BranchTracking>;
interface BranchUpstreamCacheEntry {
  upstreams: BranchUpstreams;
  cachedAt: number;
}
const branchUpstreamsByRepo = new Map<string, BranchUpstreamCacheEntry>();
/** Last relationship map by watched root; targeting survives the short TTL. */
const branchUpstreamsByRoot = new Map<string, BranchUpstreams>();
const branchUpstreamsInFlight = new Map<string, Promise<BranchUpstreams>>();
let fullStatusComputes = 0;
let workingTreeStatusComputes = 0;
let branchUpstreamMapComputes = 0;

/**
 * The last MEANINGFUL state we saw per worktree, so `changedAt` can report when
 * something happened rather than when we last looked.
 *
 * It deliberately outlives the TTL cache, which mutations invalidate and
 * watcher scans replace: `updatedAt` is stamped by each scan, so a list
 * ordered or aged by it treats a routine rescan — including the one after a
 * fetch that found nothing — as fresh activity on every watched worktree.
 */
const lastSeen = new Map<string, { signature: string; changedAt?: number }>();

/** Everything about a status that constitutes a real change. */
export function worktreeStatusSignature(status: WorktreeGitStatus): string {
  return [
    status.branch ?? "",
    status.head ?? "",
    status.dirty,
    status.filesChanged,
    status.untracked,
    status.additions,
    status.deletions,
    status.ahead,
    status.behind,
    status.upstream
      ? `${status.upstream.name ?? ""}:${status.upstream.ahead}/${status.upstream.behind}`
      : "-",
    status.merged,
    Boolean(status.baseUnresolved),
  ].join("|");
}

/**
 * `changedAt` for a freshly computed status, or UNDEFINED when we have not
 * witnessed a transition.
 *
 * The first observation deliberately claims nothing. This map is in-memory, so
 * every restart and every deploy re-observes every worktree: stamping `now`
 * there would mark every quiet worktree as freshly active and re-sort the list
 * by scan order — the exact false recency this field exists to remove, arriving
 * on a schedule instead of continuously. A baseline is recorded so the NEXT
 * real change is dated correctly; until then the field is absent and consumers
 * fall back to what they can actually justify.
 */
function resolveChangedAt(
  worktreeId: string,
  status: WorktreeGitStatus,
  now: number,
): number | undefined {
  const signature = worktreeStatusSignature(status);
  const previous = lastSeen.get(worktreeId);
  if (!previous) {
    lastSeen.set(worktreeId, { signature });
    return undefined;
  }
  const changedAt = previous.signature === signature ? previous.changedAt : now;
  lastSeen.set(worktreeId, { signature, ...(changedAt ? { changedAt } : {}) });
  return changedAt;
}

/**
 * Mark a caller-side mutation's reference state stale without discarding the
 * working-tree tier's baseline. A plain/full read must refresh it; a file event
 * may still reuse it temporarily while the matching ref/reflog event catches up.
 */
export function invalidateWorktreeStatus(worktreeId: string): void {
  const cached = cache.get(worktreeId);
  if (cached) cached.referenceStale = true;
}

/** Test seam: the change-detection rule, without a git repo behind it. */
export function resolveChangedAtForTests(
  worktreeId: string,
  status: WorktreeGitStatus,
  now: number,
): number | undefined {
  return resolveChangedAt(worktreeId, status, now);
}

/** Test hook: forget all status state. */
export function clearWorktreeStatusMemoryForTests(): void {
  lastSeen.clear();
  cache.clear();
  inFlight.clear();
  branchUpstreamsByRepo.clear();
  branchUpstreamsByRoot.clear();
  branchUpstreamsInFlight.clear();
  resetWorktreeStatusComputeCountsForTests();
}

/** Test hook: reset process-tier counters without discarding cached baselines. */
export function resetWorktreeStatusComputeCountsForTests(): void {
  fullStatusComputes = 0;
  workingTreeStatusComputes = 0;
  branchUpstreamMapComputes = 0;
}

/** Test seam for count-based surface and watcher scenarios. */
export function worktreeStatusComputeCountsForTests(): {
  full: number;
  workingTree: number;
  branchUpstreamMap: number;
} {
  return {
    full: fullStatusComputes,
    workingTree: workingTreeStatusComputes,
    branchUpstreamMap: branchUpstreamMapComputes,
  };
}

function storeComputedStatus(
  worktreeId: string,
  computed: WorktreeGitStatus,
  kind: "full" | "workingTree",
): WorktreeGitStatus {
  const changedAt = resolveChangedAt(worktreeId, computed, computed.updatedAt);
  const status: WorktreeGitStatus = {
    ...computed,
    ...(changedAt ? { changedAt } : {}),
  };
  cache.set(worktreeId, {
    status,
    cachedAt: Date.now(),
    referenceStale:
      kind === "workingTree"
        ? (cache.get(worktreeId)?.referenceStale ?? false)
        : false,
  });
  return status;
}

function startStatusCompute(
  row: WorktreeRow,
  kind: "full" | "workingTree",
  run: () => Promise<WorktreeGitStatus>,
): Promise<WorktreeGitStatus> {
  const promise = run()
    .then((computed) => storeComputedStatus(row.id, computed, kind))
    .finally(() => {
      // Only retract our OWN entry: a forced read can start after this one and
      // replace the slot while this promise is settling.
      if (inFlight.get(row.id) === promise) inFlight.delete(row.id);
    });
  inFlight.set(row.id, promise);
  return promise;
}

export async function computeWorktreeStatus(
  row: WorktreeRow,
  opts: { force?: boolean; branchUpstreams?: BranchUpstreams } = {},
): Promise<WorktreeGitStatus> {
  const now = Date.now();
  const cached = cache.get(row.id);
  if (
    !opts.force &&
    cached &&
    !cached.referenceStale &&
    now - cached.cachedAt < STATUS_CACHE_MS
  )
    return cached.status;
  const running = inFlight.get(row.id);
  // Coalescing is right for a plain read, but a FORCED read is authoritative:
  // its caller has just changed the checkout (committed, merged, acted on a
  // watcher event) and must not be handed a scan that STARTED BEFORE that
  // change — it would report the pre-change dirty/ahead counts as current.
  // Let the running scan settle, then take a fresh one of our own.
  if (running) {
    if (!opts.force) return running;
    await running.catch(() => undefined);
  }

  return startStatusCompute(row, "full", () => {
    fullStatusComputes += 1;
    return compute(
      row,
      undefined,
      opts.branchUpstreams,
      Boolean(opts.force || cached?.referenceStale),
    );
  });
}

/**
 * Refresh only fields a working-tree write can change. Reference state comes
 * from the latest full status. A missing baseline (possible only after a failed
 * initial read) recovers with one authoritative full scan instead of going mute.
 *
 * This is a forced watcher read: it waits out any scan that may have started
 * before the file event, then takes a fresh working-tree snapshot of its own.
 */
export interface WorktreeWorkingTreeRefresh {
  status: WorktreeGitStatus;
  files: WorktreeChangeFile[];
  branch: string | null;
  head: string | null;
}

/** Refresh status and retain the parsed change files from the same git reads. */
export async function refreshWorktreeWorkingTree(
  row: WorktreeRow,
): Promise<WorktreeWorkingTreeRefresh> {
  const running = inFlight.get(row.id);
  if (running) await running.catch(() => undefined);
  const reference = cache.get(row.id)?.status;
  let snapshot: CapturedWorkingTree = {
    files: [],
    branch: row.branch,
    head: null,
  };
  const capture = (freshSnapshot: CapturedWorkingTree) => {
    snapshot = freshSnapshot;
  };
  const status = reference
    ? await startStatusCompute(row, "workingTree", () => {
        workingTreeStatusComputes += 1;
        return computeWorkingTree(row, reference, capture);
      })
    : await startStatusCompute(row, "full", () => {
        fullStatusComputes += 1;
        return compute(row, capture);
      });
  return { status, ...snapshot };
}

/** Stamp a successful no-op fetch without paying for another git scan. */
export async function stampWorktreeStatusFetchedAt(
  worktreeId: string,
  fetchedAt: number,
): Promise<WorktreeGitStatus | undefined> {
  await inFlight.get(worktreeId)?.catch(() => undefined);
  const cached = cache.get(worktreeId);
  if (!cached || cached.referenceStale) return undefined;
  const status = {
    ...cached.status,
    fetchedAt,
    updatedAt: Date.now(),
  };
  cache.set(worktreeId, {
    status,
    cachedAt: Date.now(),
    referenceStale: false,
  });
  return status;
}

/**
 * Read every local branch's ahead/behind against its configured upstream in one
 * process. The full LOCAL refname is stripped exactly because it is the map
 * key; Git's `%(upstream:short)` is preserved separately as the display name,
 * including any disambiguating prefix. The exact `%(upstream)` supplies the
 * tracking relationship, `%(upstream:track)` the counts, and `%(symref)` marks
 * local refs for which a remote-only move is not patch-safe.
 */
export async function readRepoBranchUpstreams(
  mainRepoRoot: string,
  opts: { force?: boolean; repoKey?: string } = {},
): Promise<BranchUpstreams> {
  const repoKey = opts.repoKey ?? (await repoLockKey(mainRepoRoot));
  const now = Date.now();
  const cached = branchUpstreamsByRepo.get(repoKey);
  if (!opts.force && cached && now - cached.cachedAt < STATUS_CACHE_MS)
    return cached.upstreams;
  const running = branchUpstreamsInFlight.get(repoKey);
  if (running) {
    if (!opts.force) return running;
    // Forced reads deliberately do not coalesce: K overlapping authoritative
    // or stale-baseline reads cost K maps rather than adopting an older read.
    await running.catch(() => undefined);
  }

  const promise = (async (): Promise<BranchUpstreams> => {
    branchUpstreamMapComputes += 1;
    const result = await gitReadOnlyOptional(
      [
        "for-each-ref",
        "--format=%(refname)%09%(upstream)%09%(upstream:track)%09%(symref)%09%(upstream:short)",
        "refs/heads",
      ],
      mainRepoRoot,
      undefined,
      { LC_ALL: "C" },
    );
    if (result.code !== 0) {
      const previous = branchUpstreamsByRoot.get(mainRepoRoot);
      branchUpstreamsByRepo.delete(repoKey);
      branchUpstreamsByRoot.delete(mainRepoRoot);
      return previous ?? new Map();
    }

    const upstreams = new Map<string, BranchTracking>();
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const [refname, upstreamRef, track = "", symref, upstreamName] =
        line.split("\t");
      const branch = /^refs\/heads\/(.+)$/.exec(refname ?? "")?.[1];
      if (!branch) continue;
      upstreams.set(
        branch,
        trackingFromFields(upstreamRef, track, symref, upstreamName),
      );
    }
    branchUpstreamsByRepo.set(repoKey, {
      upstreams,
      cachedAt: Date.now(),
    });
    branchUpstreamsByRoot.set(mainRepoRoot, upstreams);
    return upstreams;
  })().finally(() => {
    if (branchUpstreamsInFlight.get(repoKey) === promise)
      branchUpstreamsInFlight.delete(repoKey);
  });
  branchUpstreamsInFlight.set(repoKey, promise);
  return promise;
}

/** Latest relationship map for watcher targeting, without spawning git. */
export function cachedRepoBranchUpstreams(
  mainRepoRoot: string,
): BranchUpstreams | undefined {
  return branchUpstreamsByRoot.get(mainRepoRoot);
}

function countersOf(
  tracking: BranchTracking | undefined,
): WorktreeGitStatus["upstream"] | undefined {
  return tracking?.upstreamRef && !tracking.gone
    ? {
        ahead: tracking.ahead,
        behind: tracking.behind,
        ...(tracking.upstreamName ? { name: tracking.upstreamName } : {}),
      }
    : undefined;
}

function withBaseUpstream(
  status: WorktreeGitStatus,
  row: WorktreeRow,
  branchUpstreams: BranchUpstreams,
): WorktreeGitStatus {
  const { baseUpstream: _baseUpstream, ...rest } = status;
  const baseUpstream =
    row.path === row.mainRepoRoot
      ? undefined
      : countersOf(branchUpstreams.get(row.baseBranch));
  return {
    ...rest,
    ...(baseUpstream ? { baseUpstream } : {}),
  };
}

function trackingFromFields(
  upstreamRef: string | undefined,
  track: string,
  symref: string | undefined,
  upstreamName?: string,
): BranchTracking {
  const ahead = /(?:^\[|, )ahead (\d+)/.exec(track)?.[1];
  const behind = /(?:^\[|, )behind (\d+)/.exec(track)?.[1];
  return {
    ahead: Number(ahead) || 0,
    behind: Number(behind) || 0,
    ...(upstreamRef ? { upstreamRef } : {}),
    ...(upstreamName ? { upstreamName } : {}),
    ...(symref ? { symref } : {}),
    ...(track === "[gone]" ? { gone: true } : {}),
  };
}

async function readContextBranchTracking(
  row: WorktreeRow,
  branch: string,
): Promise<{ ok: boolean; tracking?: BranchTracking }> {
  const result = await gitReadOnlyOptional(
    [
      "for-each-ref",
      "--format=%(refname)%09%(upstream)%09%(upstream:track)%09%(symref)%09%(upstream:short)",
      `refs/heads/${branch}`,
    ],
    row.path,
    undefined,
    { LC_ALL: "C" },
  );
  if (result.code !== 0) return { ok: false };
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [refname, upstreamRef, track = "", symref, upstreamName] =
      line.split("\t");
    if (refname !== `refs/heads/${branch}`) continue;
    return {
      ok: true,
      tracking: trackingFromFields(upstreamRef, track, symref, upstreamName),
    };
  }
  return { ok: false };
}

/** Patch remote axes, resolving root-invisible tracking in the row's context. */
export async function refreshWorktreeRemotePatch(
  row: WorktreeRow,
  branchUpstreams: BranchUpstreams,
): Promise<WorktreeGitStatus | undefined> {
  await inFlight.get(row.id)?.catch(() => undefined);
  const cached = cache.get(row.id);
  if (!cached || cached.referenceStale) return undefined;
  let status = cached.status;
  const branch = status.branch;
  if (!branch) return undefined;
  if (!branchUpstreams.get(branch)?.upstreamRef) {
    // Root silence cannot distinguish never-published from tracking added in a
    // linked-only config context after the baseline: both map and cache are
    // identical. Ask Git in the live branch's worktree context; never infer.
    const contextual = await readContextBranchTracking(row, branch);
    if (!contextual.ok) return undefined;
    const { upstream: _upstream, ...withoutUpstream } = status;
    const upstream = countersOf(contextual.tracking);
    status = {
      ...withoutUpstream,
      ...(upstream ? { upstream } : {}),
    };
  }
  return storeComputedStatus(
    row.id,
    {
      ...withBaseUpstream(status, row, branchUpstreams),
      updatedAt: Date.now(),
    },
    "full",
  );
}

interface CapturedWorkingTree {
  files: WorktreeChangeFile[];
  branch: string | null;
  head: string | null;
}

type CaptureWorkingTree = (snapshot: CapturedWorkingTree) => void;

async function compute(
  row: WorktreeRow,
  captureWorkingTree?: CaptureWorkingTree,
  suppliedBranchUpstreams?: BranchUpstreams,
  forceBranchUpstreams = false,
): Promise<WorktreeGitStatus> {
  const gone = row.status !== "active" || !existsSync(row.path);
  if (gone) {
    captureWorkingTree?.({ files: [], branch: row.branch, head: null });
    return {
      worktreeId: row.id,
      branch: row.branch,
      head: null,
      dirty: false,
      filesChanged: 0,
      untracked: 0,
      additions: 0,
      deletions: 0,
      ahead: 0,
      behind: 0,
      merged: true,
      updatedAt: Date.now(),
    };
  }

  const repoKey = await noteWorktreeInterest(row.mainRepoRoot);
  const workingTree = await readWorkingTree(row);
  captureWorkingTree?.(workingTree);
  const { snapshot, additions, deletions } = workingTree;
  const branchTip = snapshot.oid ?? row.branch;
  const branchUpstreams =
    suppliedBranchUpstreams ??
    (row.path === row.mainRepoRoot
      ? new Map()
      : await readRepoBranchUpstreams(row.mainRepoRoot, {
          force: forceBranchUpstreams,
          ...(repoKey ? { repoKey } : {}),
        }));
  const aheadBehindRes = await gitReadOnlyOptional(
    ["rev-list", "--left-right", "--count", `${row.baseBranch}...${branchTip}`],
    row.mainRepoRoot,
  );

  let behind = 0;
  let ahead = 0;
  if (aheadBehindRes.code === 0) {
    const [left, right] = aheadBehindRes.stdout.trim().split(/\s+/);
    behind = Number(left) || 0; // commits only on baseBranch
    ahead = Number(right) || 0; // commits only on the worktree branch
  }
  // A base branch that resolves to no local commit — deleted after a stacked
  // base landed, renamed upstream, never pulled — fails that rev-list, which
  // left ahead at 0 and made `isMerged` answer "merged" trivially: the checkout
  // claiming delivery in exactly the case where nothing could be verified,
  // while removal's containment guard read the same missing ref and refused.
  // Report the ignorance instead, and ONLY the local ignorance: no absent local
  // ref proves a remote lacks the branch, so what a fetching flow could still
  // verify is not this scan's to guess. The probe (rev-list fails when EITHER
  // revision is unresolvable, so ask which) runs only on this error path.
  const baseUnresolved =
    aheadBehindRes.code !== 0 && !(await resolveBaseCommit(row));

  // Reading a status is the one signal that a surface wants these numbers, so
  // it is what keeps the repo's remote refs being refreshed — and what stamps
  // how current the `behind` counts above actually are. The fetch itself is
  // never awaited: this response carries the PREVIOUS stamp, and the watcher
  // broadcasts a fresh status once new refs land.
  let fetchedAt: number | undefined;
  if (repoKey) {
    fetchedAt = noteRepoInterest(repoKey, row.mainRepoRoot);
    fetchRepoIfDue(repoKey, row.mainRepoRoot);
  }

  return withBaseUpstream(
    {
      worktreeId: row.id,
      branch: snapshot.branch,
      // Porcelain exposes only the full oid. A fixed 12-character abbreviation
      // avoids another process; unlike `rev-parse --short`, it does not grow when
      // the repository contains an ambiguous prefix.
      head: snapshot.oid?.slice(0, 12) ?? null,
      dirty: snapshot.filesChanged > 0 || snapshot.untracked > 0,
      filesChanged: snapshot.filesChanged,
      untracked: snapshot.untracked,
      additions,
      deletions,
      ...(snapshot.upstream ? { upstream: snapshot.upstream } : {}),
      ahead,
      behind,
      ...(baseUnresolved ? { baseUnresolved: true } : {}),
      // Counts that could not be taken are never a delivery claim.
      merged:
        aheadBehindRes.code === 0
          ? await isMerged(row, ahead, snapshot.oid)
          : false,
      updatedAt: Date.now(),
      ...(fetchedAt ? { fetchedAt } : {}),
    },
    row,
    branchUpstreams,
  );
}

async function computeWorkingTree(
  row: WorktreeRow,
  reference: WorktreeGitStatus,
  captureWorkingTree?: CaptureWorkingTree,
): Promise<WorktreeGitStatus> {
  if (row.status !== "active" || !existsSync(row.path)) {
    captureWorkingTree?.({ files: [], branch: row.branch, head: null });
    return {
      ...reference,
      dirty: false,
      filesChanged: 0,
      untracked: 0,
      additions: 0,
      deletions: 0,
      updatedAt: Date.now(),
    };
  }

  const workingTree = await readWorkingTree(row);
  captureWorkingTree?.(workingTree);
  const { snapshot, additions, deletions } = workingTree;

  return {
    // A fetch completion can refresh this cache while the working-tree commands
    // run. Preserve that newest reference/freshness half rather than restoring
    // the snapshot captured before the commands started.
    ...(cache.get(row.id)?.status ?? reference),
    dirty: snapshot.filesChanged > 0 || snapshot.untracked > 0,
    filesChanged: snapshot.filesChanged,
    untracked: snapshot.untracked,
    additions,
    deletions,
    updatedAt: Date.now(),
  };
}

async function readWorkingTree(row: WorktreeRow): Promise<{
  snapshot: StatusSnapshot;
  files: WorktreeChangeFile[];
  additions: number;
  deletions: number;
  branch: string | null;
  head: string | null;
}> {
  const [statusRes, numstatRes] = await Promise.all([
    gitReadOnlyOptional(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "--ahead-behind",
        "--untracked-files=all",
        "-z",
      ],
      row.path,
    ),
    gitReadOnlyOptional(["diff", "--numstat", "-z", "HEAD", "--"], row.path),
  ]);
  const snapshot = parseStatus(statusRes);
  const files = await workingTreeFilesFromPorcelainV2(
    row,
    statusRes.code === 0 ? statusRes.stdout : "",
    numstatRes.code === 0 ? numstatRes.stdout : "",
  );
  const totals = files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  return {
    snapshot,
    files,
    ...totals,
    branch: snapshot.branch,
    head: snapshot.oid?.slice(0, 12) ?? null,
  };
}

interface StatusSnapshot {
  oid?: string;
  branch: string | null;
  filesChanged: number;
  untracked: number;
  upstream?: NonNullable<WorktreeGitStatus["upstream"]>;
}

function parseStatus(result: GitResult): StatusSnapshot {
  let oid: string | undefined;
  let branch: string | null = null;
  let upstreamName: string | undefined;
  let upstream: NonNullable<WorktreeGitStatus["upstream"]> | undefined;
  let filesChanged = 0;
  const untrackedPaths: string[] = [];
  const records = result.code === 0 ? result.stdout.split("\0") : [];

  for (let index = 0; index < records.length; index += 1) {
    const rawRecord = records[index]!;
    // `-z` normally terminates headers with NUL too. Splitting only a header
    // record on LF also tolerates Git versions that retain header newlines,
    // without corrupting a filename that itself contains a newline.
    const logicalRecords = rawRecord.startsWith("# ")
      ? rawRecord.split("\n")
      : [rawRecord];
    for (const record of logicalRecords) {
      if (record.startsWith("# branch.oid ")) {
        const value = record.slice("# branch.oid ".length);
        if (/^[0-9a-f]+$/i.test(value)) oid = value;
      } else if (record.startsWith("# branch.head ")) {
        const value = record.slice("# branch.head ".length);
        branch = value === "(detached)" ? null : value || null;
      } else if (record.startsWith("# branch.upstream ")) {
        upstreamName = record.slice("# branch.upstream ".length) || undefined;
      } else if (record.startsWith("# branch.ab ")) {
        const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
        if (match)
          upstream = {
            ahead: Number(match[1]),
            behind: Number(match[2]),
            ...(upstreamName ? { name: upstreamName } : {}),
          };
      } else if (record.startsWith("? ")) {
        untrackedPaths.push(record.slice(2));
      } else if (
        record.startsWith("1 ") ||
        record.startsWith("2 ") ||
        record.startsWith("u ")
      ) {
        filesChanged += 1;
        // A `2` rename/copy record is followed by the original path under `-z`.
        if (record.startsWith("2 ")) index += 1;
      }
      // `!` records are ignored, matching the old v1 count rule in practice:
      // ignored files are not dirty and are not requested from git status.
    }
  }

  return {
    ...(oid ? { oid } : {}),
    branch,
    filesChanged,
    untracked: untrackedPaths.length,
    ...(upstreamName && upstream ? { upstream } : {}),
  };
}

/** The base branch's commit oid, or `""` when the ref resolves to nothing. */
async function resolveBaseCommit(row: WorktreeRow): Promise<string> {
  const base = await gitReadOnlyOptionalExit(
    ["rev-parse", "--verify", `${row.baseBranch}^{commit}`],
    row.mainRepoRoot,
  );
  return base.code === 0 ? base.stdout.trim() : "";
}

/**
 * Merged = the branch's work is contained in the base branch: trivially when
 * nothing is ahead, via ancestry after a merge commit, or — after a squash
 * merge — when merging the branch would change nothing (tree equality). Never
 * asked for a base that resolves to nothing: that is unknown, not merged.
 */
async function isMerged(
  row: WorktreeRow,
  ahead: number,
  branchOid: string | undefined,
): Promise<boolean> {
  if (ahead === 0) return true;
  if (!branchOid) return false;

  const baseOid = await resolveBaseCommit(row);
  if (!baseOid) return false;

  const key = `${branchOid}:${baseOid}`;
  const cached = mergedByTips.get(key);
  if (cached) {
    mergedByTips.delete(key);
    mergedByTips.set(key, cached);
    return cached;
  }
  if (mergedByTips.size >= MERGED_CACHE_MAX) {
    const oldest = mergedByTips.keys().next().value;
    if (oldest) mergedByTips.delete(oldest);
  }
  const computed = branchContained(
    row.mainRepoRoot,
    branchOid,
    baseOid,
    gitReadOnlyOptionalExit,
  ).catch((err: unknown) => {
    mergedByTips.delete(key);
    throw err;
  });
  mergedByTips.set(key, computed);
  return computed;
}

/** Branch work is contained in a base branch or exact target commit. */
export async function branchContainedInBase(
  repoRoot: string,
  branch: string,
  baseTarget: string,
): Promise<boolean> {
  return branchContained(repoRoot, branch, baseTarget, gitOptionalExit);
}

type OptionalExit = (args: string[], cwd: string) => Promise<GitResult>;

async function branchContained(
  repoRoot: string,
  branch: string,
  baseTarget: string,
  run: OptionalExit,
): Promise<boolean> {
  const ancestor = await run(
    ["merge-base", "--is-ancestor", branch, baseTarget],
    repoRoot,
  );
  if (ancestor.code === 0) return true;
  const mergedTree = await run(
    ["merge-tree", "--write-tree", baseTarget, branch],
    repoRoot,
  );
  if (mergedTree.code !== 0) return false; // conflicts → definitely not contained
  const baseTree = await run(["rev-parse", `${baseTarget}^{tree}`], repoRoot);
  return (
    baseTree.code === 0 && mergedTree.stdout.trim() === baseTree.stdout.trim()
  );
}
