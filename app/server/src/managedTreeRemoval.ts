/**
 * Deleting a directory tree the APP owns, when something else wrote into it as
 * another user (Task 659).
 *
 * The shape of the problem is generic. A container started with a bind mount
 * runs as uid 0 unless told otherwise, so everything it writes into the mounted
 * checkout belongs to root: a package store, a build output, a cache. Unlinking
 * an entry is governed by its PARENT directory's mode and owner, so ONE such
 * directory makes the whole tree undeletable by the server, which runs as an
 * ordinary user. `rmSync`'s `force` only ignores ENOENT; it fails with EACCES.
 *
 * Two kinds of blocker, and only one of them is ours to repair:
 *
 * - OWNER-LOCKED. The directory is ours, with its write or execute bit off
 *   (pytest's `dr-xr-xr-x` artifact directories are the common case). Restoring
 *   owner access and retrying reclaims it, which is what `agentTempTree.ts` has
 *   always done and what {@link restoreOwnerAccess} still does for both callers.
 * - FOREIGN-OWNED. The directory belongs to another uid. No mode change helps —
 *   chmod is the owner's privilege — so from the host this tree is undeletable,
 *   full stop. The only ways out are a `sudo` the user runs, or the container
 *   runtime that created it (`containerResidue.ts`), which is already effective
 *   root and can hand ownership back.
 *
 * The distinction is the whole point: refusing a removal for an owner-locked
 * directory would refuse the very trees this app deletes routinely, and
 * retrying forever on a foreign-owned one is how a worktree becomes permanently
 * unremovable.
 *
 * Running as root (uid 0) is its own answer: nothing is foreign-owned then,
 * because root ignores the checks. CI runs the suite exactly that way.
 */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  openSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Linux's `O_PATH`, which Node does not expose. It opens a handle that only
 * NAMES a file: no read permission on the object is required, which is the
 * whole point here — an agent can leave a mode-000 directory behind, and its
 * owner may still chmod it even though nothing may open it for reading.
 *
 * The value is kernel ABI and identical on the architectures this ships to
 * (`x86_64`, `aarch64`); it is deliberately gated on the platform rather than
 * probed, because the same bit means `O_SYMLINK` on macOS.
 */
const O_PATH = 0o10000000;

/** Whether {@link O_PATH} and the procfs handle names it needs are both available. */
const HAS_O_PATH = process.platform === "linux";

/** The ONE directory the scan stopped at, and who owns it. */
export interface TreeResidue {
  path: string;
  /** Why the host cannot delete it; only `foreign-owner` survives a repair. */
  reason: "foreign-owner" | "owner-locked";
  uid: number;
}

export interface TreeResidueScan {
  /** First directory owned by another uid, if the walk reached one. */
  foreign?: TreeResidue;
  /**
   * Whether the walk saw the WHOLE tree. `false` means it did not, and the
   * absence of a `foreign` is then no evidence: the budget ran out, or a
   * directory could not be listed and whatever it holds went unseen.
   */
  complete: boolean;
  directoriesVisited: number;
}

export interface TreeResidueScanOptions {
  /** Walk budget; exhausting it reports `complete: false`, never a refusal. */
  maxDirectories?: number;
  maxMs?: number;
  /** The uid this process deletes as. Injectable so the foreign case is testable. */
  selfUid?: number;
  /**
   * Owner of one directory. Injectable for the same reason: a fixture cannot be
   * given a foreign owner without root, and a seam per PATH is what lets a test
   * place residue somewhere specific rather than making the whole tree foreign.
   */
  uidOf?: (path: string) => number | undefined;
  now?: () => number;
}

/**
 * The bounds exist because this runs before every removal. A clean checkout of
 * this repository holds 92 directories (3 ms); the same checkout with its
 * dependencies installed holds 9,397 (959 ms), and a Gradle or Bazel tree is
 * larger still. Residue left by a bind-mounted container is always SHALLOW —
 * it sits at the mount root, where the build wrote it — so a breadth-first walk
 * finds it long before the budget runs out, and a budget that does run out
 * leaves the answer to the removal itself rather than stalling it.
 */
const DEFAULT_MAX_DIRECTORIES = 2_000;
const DEFAULT_MAX_MS = 300;

/**
 * Find the first directory in `root` that no mode change could let us delete.
 *
 * Breadth-first ON PURPOSE: it visits the shallow directories a container mount
 * writes into before descending into the deep ones an install created, so the
 * realistic offender is found inside the budget.
 */
export function scanTreeResidue(
  root: string,
  options: TreeResidueScanOptions = {},
): TreeResidueScan {
  const selfUid = options.selfUid ?? process.getuid?.() ?? 0;
  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const now = options.now ?? Date.now;
  // Root bypasses every permission check, so nothing in the tree is foreign to
  // it. Reporting residue here would refuse removals that would have succeeded.
  if (selfUid === 0) return { complete: true, directoriesVisited: 0 };

  const deadline = now() + maxMs;
  const queue: string[] = [root];
  let visited = 0;
  let complete = true;
  while (queue.length > 0) {
    if (visited >= maxDirectories || now() > deadline)
      return { complete: false, directoriesVisited: visited };
    const dir = queue.shift()!;
    visited += 1;
    const uid = ownerUid(dir, options);
    if (uid === undefined) continue;
    if (uid !== selfUid)
      return {
        foreign: { path: dir, reason: "foreign-owner", uid },
        complete: true,
        directoriesVisited: visited,
      };
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable but OURS (mode 000, say). Restoring owner access during
      // removal opens it, but THIS walk never saw the children, so it may not
      // claim the tree is clean: a foreign directory can sit under it.
      complete = false;
      continue;
    }
    for (const entry of entries)
      if (entry.isDirectory()) queue.push(join(dir, entry.name));
  }
  return { complete, directoriesVisited: visited };
}

export type TreeReclaimOutcome =
  { status: "reclaimed" } | { status: "unavailable"; reason: string };

export interface ManagedTreeRemovalOptions {
  /**
   * Hands a foreign-owned tree back to us — `containerResidue.ts` provides the
   * real one. Called ONLY when a foreign-owned directory blocks the removal.
   */
  reclaim?: (path: string) => Promise<TreeReclaimOutcome>;
  scanOptions?: TreeResidueScanOptions;
  /**
   * The removal attempt itself. Injectable because the interesting ladder steps
   * need a tree that survives an owner-mode repair, and creating one takes the
   * root the test suite does not have.
   */
  remove?: (path: string) => boolean;
}

export interface ManagedTreeRemovalResult {
  removed: boolean;
  /** What blocked it, when it is still there. */
  residue?: TreeResidue;
  /** Present when a reclaim ran; `false` with a reason when it could not. */
  reclaimed?: boolean;
  reclaimReason?: string;
}

/**
 * Remove a tree the app owns, repairing what can be repaired.
 *
 * The ladder is deliberate, cheapest first: plain removal, then owner-mode
 * repair, then — only for a foreign-owned blocker, and only when the caller
 * passed a reclaim — the container runtime. Every step is followed by another
 * removal attempt, because only a successful `rmSync` proves the tree is gone.
 */
export async function removeManagedTree(
  path: string,
  options: ManagedTreeRemovalOptions = {},
): Promise<ManagedTreeRemovalResult> {
  const remove = options.remove ?? tryRemove;
  if (!existsSync(path)) return { removed: true };
  if (remove(path)) return { removed: true };

  restoreOwnerAccess(path);
  if (remove(path)) return { removed: true };

  const scan = scanTreeResidue(path, options.scanOptions);
  const foreign = scan.foreign;
  if (!foreign || !options.reclaim)
    return { removed: false, ...(foreign ? { residue: foreign } : {}) };

  const outcome = await options.reclaim(path);
  if (outcome.status !== "reclaimed")
    return {
      removed: false,
      residue: foreign,
      reclaimed: false,
      reclaimReason: outcome.reason,
    };
  restoreOwnerAccess(path);
  if (remove(path)) return { removed: true, reclaimed: true };
  const after = scanTreeResidue(path, options.scanOptions);
  return {
    removed: false,
    reclaimed: true,
    ...(after.foreign ? { residue: after.foreign } : { residue: foreign }),
  };
}

/**
 * Who owns one directory. `undefined` for anything that is not a directory, or
 * that vanished: the removal itself reports what blocks it, and a scan that
 * guessed here would refuse on a race.
 */
function ownerUid(
  dir: string,
  options: TreeResidueScanOptions,
): number | undefined {
  if (options.uidOf) return options.uidOf(dir);
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() ? stat.uid : undefined;
  } catch {
    return undefined;
  }
}

function tryRemove(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The two codes a read-only directory in the tree produces; anything else is not ours to repair. */
export function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Give every directory in the tree owner `rwx` so its children can be unlinked.
 * Files are never touched: their own mode does not gate unlinking them.
 *
 * NEVER CHMODS A SYMLINK. `chmodSync` follows one and Linux has no `lchmod`, so
 * a path-based chmod here could be steered at anything the server can write.
 * Two things would have to hold, and a type check alone only gives the first:
 * `readdirSync`'s `Dirent` reports the link's own type, so `isDirectory()`
 * excludes a symlink that is already there — but a path checked and then
 * chmod'd is two lookups, and the entry can be swapped in between. The agent
 * whose tools filled this tree can still have live child processes when the
 * query ends, so that window is reachable.
 *
 * So the change is applied to a FILE DESCRIPTOR, not a path — see
 * {@link restoreDirectoryAccess}. What that does NOT cover is a rename of an
 * ANCESTOR between our open of a directory and our open of its child; closing
 * it needs `openat`, which Node does not expose. The residue is bounded by what
 * it could win: these trees are owned by the same uid as the server, and they
 * are filled by an agent that already runs arbitrary commands as that user.
 * Anything it could make us chmod, it can chmod itself.
 *
 * Top-down, so a directory is always made searchable before its children are
 * opened, and iterative rather than recursive: the depth here is whatever an
 * agent's tools happened to create, which is not a bound worth trusting a call
 * stack to.
 */
export function restoreOwnerAccess(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    if (!restoreDirectoryAccess(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries)
      if (entry.isDirectory()) pending.push(join(dir, entry.name));
  }
}

/**
 * Give ONE directory owner `rwx` — 0o700, the mode these trees are created
 * with, so this restores the intended one rather than inventing a new one.
 *
 * The handle is what makes this safe: a symlink, a non-directory or a vanished
 * entry all fail the open, so the type check and the change are one decision
 * rather than two lookups an agent's live child process could race.
 *
 * On Linux the handle is `O_PATH`, because the directory to repair may be
 * mode-000 — its owner may still chmod it, but nothing may open it for reading.
 * An `O_PATH` handle cannot be `fchmod`'d (EBADF), so the mode is set through
 * its procfs name, which resolves to the object the fd holds and not to
 * whatever the original path points at by then.
 *
 * Elsewhere it is a plain read handle and `fchmodSync`, equally race-safe but
 * unable to open a directory with no read bit. Such a tree is then reported as
 * left behind rather than reclaimed; the deployment target is Linux.
 */
function restoreDirectoryAccess(dir: string): boolean {
  const fd = openDirectoryNoFollow(dir);
  if (fd === undefined) return false;
  try {
    if (HAS_O_PATH) chmodSync(`/proc/self/fd/${fd}`, 0o700);
    else fchmodSync(fd, 0o700);
    return true;
  } catch {
    // Not ours, or already gone. Let the retry report what actually blocks it.
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // An fd we cannot close is not a reason to abandon the walk — and throwing
      // out of here would reach the teardown path this exists to keep safe.
    }
  }
}

/** `undefined` for anything that is not a directory we can open without traversing a link. */
function openDirectoryNoFollow(path: string): number | undefined {
  const handle = HAS_O_PATH ? O_PATH : constants.O_RDONLY;
  try {
    return openSync(
      path,
      handle | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    return undefined;
  }
}
