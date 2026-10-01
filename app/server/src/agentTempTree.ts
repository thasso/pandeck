import { rmSync } from "node:fs";
import { isPermissionError, restoreOwnerAccess } from "./managedTreeRemoval.ts";

/**
 * Remove a private temp tree the app handed to an agent process, and NEVER
 * THROW doing it.
 *
 * Not throwing is the load-bearing part. These trees are removed during session
 * teardown — inside a `finally` on the query-consumption path — where an
 * exception reaches the process-wide `uncaughtException` handler, which exits
 * the process and takes EVERY live session down with it. Whatever an agent left
 * in its own scratch directory must not be able to do that.
 *
 * And it usually CAN, because the tree is exported to the agent as `TMPDIR`:
 * everything its tools run writes there, and some of that is deliberately
 * read-only (pytest's `tmp_path` fixtures leave `dr-xr-xr-x` artifact
 * directories behind). Unlinking a file is governed by its PARENT directory's
 * mode, so one such directory makes the whole tree undeletable, and
 * `force: true` only ignores ENOENT — the plain `rmSync` fails with EACCES.
 * Restoring owner access and retrying is what actually reclaims the tree; the
 * alternative, swallowing the error, trades a crash for an unbounded `/tmp`
 * leak. The repair itself lives in `managedTreeRemoval.ts`, which worktree
 * removal shares — see it for the foreign-owner case this path cannot answer.
 *
 * This stays SYNCHRONOUS, and therefore cannot reclaim a tree some other uid
 * owns: reclaiming means asking the container runtime, teardown has no turn to
 * await one in, and a temp tree is bounded leakage where a worktree is a record
 * the user cannot delete. A foreign-owned tree is reported and left behind.
 *
 * Returns whether the tree is gone. A `false` is reported once, here, so a
 * caller that only counts successes still leaves a trace of what leaked.
 */
export function removeAgentTempTree(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (!isPermissionError(error)) return reportLeftBehind(path, error);
    restoreOwnerAccess(path);
    try {
      rmSync(path, { recursive: true, force: true });
      return true;
    } catch (retryError) {
      return reportLeftBehind(path, retryError);
    }
  }
}

function reportLeftBehind(path: string, error: unknown): false {
  console.warn(
    `[temp] agent temp tree left behind at ${path}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  return false;
}
