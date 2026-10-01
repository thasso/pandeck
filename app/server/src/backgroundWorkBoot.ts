import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAgentTempTree } from "./agentTempTree.ts";
import { backgroundWorkStore } from "./db/backgroundWorkStore.ts";

/**
 * This server process's boot epoch. Every background work item and retained
 * host epoch is stamped with it, which is what makes restart HONEST: a row from
 * another epoch cannot still be executing, because the process that owned its
 * child processes and provider query is gone.
 *
 * Deliberately random per process rather than derived from a pid or start time:
 * both are reusable, and a collision would silently adopt dead work.
 */
const BACKGROUND_WORK_BOOT_EPOCH = `boot_${randomUUID()}`;

/** The epoch every admission stamps onto its row. Constant for this process. */
export function backgroundWorkBootEpoch(): string {
  return BACKGROUND_WORK_BOOT_EPOCH;
}

/** Remove private provider temp trees whose owning PA process is provably dead. */
export function sweepBackgroundTaskOutputTemps(): number {
  const uid = process.getuid?.();
  if (uid === undefined) return 0;
  let removed = 0;
  try {
    for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
      const match = entry.name.match(
        /^pa-(?:claude|pi|background-delivery)-(\d+)-/u,
      );
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        // Only ESRCH proves that the owner is dead. EPERM and every other
        // failure are ambiguous, so leave the tree in place.
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ESRCH"
        )
          continue;
      }
      const path = join(tmpdir(), entry.name);
      try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.uid !== uid) continue;
        // A dead owner's tree is routinely undeletable as it stands: whatever
        // the agent ran left read-only directories in it. Repair-and-retry is
        // what makes this sweep reclaim anything at all, rather than silently
        // skipping every tree that a test run touched.
        if (removeAgentTempTree(path)) removed += 1;
      } catch {
        // A concurrent replacement or inaccessible entry is left alone.
      }
    }
  } catch {
    // Temporary-directory cleanup is best effort; admission remains fail-closed.
  }
  return removed;
}

/**
 * Mark everything left nonterminal by a previous process lost, idempotently. A
 * planned deployment drain that already recorded its reason keeps it — that
 * outcome is more specific than "the server restarted". Nothing is replayed:
 * background commands are never re-run on the app's initiative.
 */
export function reconcileBackgroundWorkOnBoot(): {
  items: number;
  hosts: number;
} {
  return backgroundWorkStore.reconcileBoot({
    bootEpoch: BACKGROUND_WORK_BOOT_EPOCH,
  });
}

/**
 * Tombstone the history of sessions that were deleted without it, idempotently.
 * Deletion tombstones its owner's rows itself; this repairs what older builds
 * left behind and any row a delete could not take. It runs after
 * {@link reconcileBackgroundWorkOnBoot}, so no earlier process's work is live.
 * Membership is all it changes: rows stay, and so do evidence artifacts.
 */
export function tombstoneDeletedOwnersOnBoot(): {
  items: number;
  owners: number;
  blockedOwners: number;
} {
  const result = backgroundWorkStore.tombstoneDeletedOwners();
  return {
    items: result.itemIds.length,
    owners: result.ownerSessionIds.length,
    blockedOwners: result.blockedOwnerSessionIds.length,
  };
}
