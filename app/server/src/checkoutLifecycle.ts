/**
 * The filesystem and process work of a checkout's lifecycle — creating its
 * folders, the residue scan and removal ladder, a failed create's discard,
 * deleting a managed clone, stopping what runs in it — on the Worker that
 * places it (`docs/workers.md`, "Checkout lifecycle").
 *
 * {@link checkoutLifecycleOn} takes a typed side, like `checkoutFilesOn`. The
 * Knowledge Base row has no lifecycle: it is never created, removed or
 * provisioned as a checkout, so the server side is a programming error, never
 * a local fallback (B6).
 *
 * Errors keep their origin for `checkoutFailureOf`: a Worker failure is
 * branded by the client, and a filesystem failure the Worker answered is
 * marked `"filesystem"` here. A Worker failure is never a result: never
 * residue, a missing folder or "no processes".
 */
import { markFilesystemFailure } from "./checkoutFileAccess.ts";
import type {
  ManagedTreeRemovalResult,
  TreeReclaimOutcome,
  TreeResidueScan,
} from "./managedTreeRemoval.ts";
import {
  AnsweredFileFailure,
  type WorkerFileLocation,
} from "./workerProtocol/fileMethods.ts";
import type {
  CreateDirResult,
  DiscardTreeResult,
  LifecycleProcessStop,
  RemoveTreeStage,
  RemoveTreeStageResult,
} from "./workerProtocol/lifecycleMethods.ts";
import {
  createDirOnWorker,
  discardTreeOnWorker,
  mkdirOnWorker,
  removeAllOnWorker,
  removeTreeOnWorker,
  scanResidueOnWorker,
  stopProcessesOnWorker,
} from "./workers/lifecycleClient.ts";
import { checkoutSideKey, type CheckoutSide } from "./workers/placement.ts";

/** The lifecycle steps of the checkouts on one Worker. */
export interface CheckoutLifecycle {
  mkdir(path: string): Promise<void>;
  /**
   * Creates `path` exclusively, its leading directories as `mkdir` does. Only
   * `"created"` proves this call made it; a rejection never does.
   */
  createDir(path: string): Promise<CreateDirResult>;
  scanResidue(path: string): Promise<TreeResidueScan>;
  removeTree(
    path: string,
    stage: RemoveTreeStage,
  ): Promise<RemoveTreeStageResult>;
  discardTree(path: string): Promise<DiscardTreeResult>;
  removeAll(path: string): Promise<void>;
  stopProcesses(path: string): Promise<LifecycleProcessStop>;
}

/** One Worker call; only a failure the Worker answered is a filesystem one. */
async function remote<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AnsweredFileFailure) markFilesystemFailure(error);
    throw error;
  }
}

const lifecycleBySide = new Map<string, CheckoutLifecycle>();

/** The lifecycle steps on `side`, one instance per Worker. */
export function checkoutLifecycleOn(side: CheckoutSide): CheckoutLifecycle {
  if (side === "server")
    throw new Error(
      "The Knowledge Base has no checkout lifecycle: it is never created, removed or provisioned on a Worker.",
    );
  const key = checkoutSideKey(side);
  let lifecycle = lifecycleBySide.get(key);
  if (!lifecycle) {
    const at = (path: string): WorkerFileLocation => ({
      workerId: side.workerId,
      path,
    });
    lifecycle = {
      mkdir: (path) => remote(() => mkdirOnWorker(at(path))),
      createDir: (path) => remote(() => createDirOnWorker(at(path))),
      scanResidue: (path) => remote(() => scanResidueOnWorker(at(path))),
      removeTree: (path, stage) =>
        remote(() => removeTreeOnWorker(at(path), stage)),
      discardTree: (path) => remote(() => discardTreeOnWorker(at(path))),
      removeAll: (path) => remote(() => removeAllOnWorker(at(path))),
      stopProcesses: (path) => remote(() => stopProcessesOnWorker(at(path))),
    };
    lifecycleBySide.set(key, lifecycle);
  }
  return lifecycle;
}

/**
 * `removeManagedTree(path, {reclaim})` with its filesystem stages on `side`'s
 * Worker and the reclaim on the server, between them: the same ladder, the
 * same results. A Worker failure at either stage rejects.
 */
export async function removeManagedTreeOn(
  side: CheckoutSide,
  path: string,
  options: { reclaim?: (path: string) => Promise<TreeReclaimOutcome> } = {},
): Promise<ManagedTreeRemovalResult> {
  const lifecycle = checkoutLifecycleOn(side);
  const initial = await lifecycle.removeTree(path, "initial");
  if (initial.removed) return { removed: true };
  const foreign = initial.residue;
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
  const after = await lifecycle.removeTree(path, "afterReclaim");
  if (after.removed) return { removed: true, reclaimed: true };
  return { removed: false, reclaimed: true, residue: after.residue ?? foreign };
}
