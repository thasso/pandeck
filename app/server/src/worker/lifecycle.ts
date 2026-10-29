/**
 * The Worker's checkout lifecycle methods: the filesystem and process work of
 * creating and removing a checkout, run here on the Worker's own filesystem
 * and processes (`docs/workers.md`).
 *
 * Each handler runs the base code unchanged, with its production defaults:
 * nothing a request carries widens what it deletes or signals. They hold
 * nothing across requests and ignore cancellation, so on a connection end
 * each runs to its last deletion or signal and settles before the Worker is
 * quiescent; the caller's rejection, and the release of its repo lock, follow
 * that.
 *
 * `stopProcesses` signals only the Worker's own descendants at least two
 * levels down whose cwd is inside the named checkout (`checkoutProcesses.ts`).
 */
import { mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { errorText } from "../errors.ts";
import {
  removeAfterReclaim,
  removeManagedTree,
  restoreOwnerAccess,
  scanTreeResidue,
} from "../managedTreeRemoval.ts";
import { WRONG_WORKER } from "../workerProtocol/checkoutMethods.ts";
import {
  WorkerMethodError,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import {
  encodeFailure,
  type WorkerFileLocation,
} from "../workerProtocol/fileMethods.ts";
import {
  LIFECYCLE_METHODS,
  decodeLifecycleLocation,
  decodeRemoveTree,
  encodeCreateDirResult,
  encodeDiscardTreeResult,
  encodeDone,
  encodeProcessStop,
  encodeRemoveTreeResult,
  encodeResidueScan,
  refuseFilesystemRoot,
} from "../workerProtocol/lifecycleMethods.ts";
import { stopCheckoutProcesses } from "./checkoutProcesses.ts";

/** A failed create's directory removal: `rmSync`'s own retries, then repair. */
const DISCARD_REMOVAL_RETRIES = 10;
const DISCARD_REMOVAL_RETRY_DELAY_MS = 200;

/** The lifecycle methods of the Worker `workerId`. */
export function lifecycleHandlers(workerId: string): MethodHandlers {
  /** The path here; another Worker's location runs nothing. */
  const here = (location: WorkerFileLocation): string => {
    if (location.workerId !== workerId)
      throw new WorkerMethodError(
        WRONG_WORKER,
        `The checkout ${location.path} is placed on Worker "${location.workerId}", not "${workerId}".`,
      );
    return location.path;
  };
  /** A destructive request's path; `/` is refused before any effect. */
  const destructive = (location: WorkerFileLocation): string => {
    const path = here(location);
    refuseFilesystemRoot(location);
    return path;
  };

  return {
    [LIFECYCLE_METHODS.mkdir]: async (payload) => {
      const path = here(decodeLifecycleLocation(payload));
      try {
        mkdirSync(path, { recursive: true });
        return encodeDone();
      } catch (error) {
        return encodeFailure(error);
      }
    },
    [LIFECYCLE_METHODS.createDir]: async (payload) => {
      const path = here(decodeLifecycleLocation(payload));
      try {
        // Only the last mkdir's EEXIST is the path's: an earlier one names a
        // leading directory, and that is a failure like any other.
        mkdirSync(dirname(path), { recursive: true });
        try {
          mkdirSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            return encodeCreateDirResult("exists");
          throw error;
        }
        return encodeCreateDirResult("created");
      } catch (error) {
        return encodeFailure(error);
      }
    },
    [LIFECYCLE_METHODS.scanResidue]: async (payload) => {
      const path = here(decodeLifecycleLocation(payload));
      try {
        return encodeResidueScan(scanTreeResidue(path));
      } catch (error) {
        return encodeFailure(error);
      }
    },
    [LIFECYCLE_METHODS.removeTree]: async (payload) => {
      const { location, stage } = decodeRemoveTree(payload);
      const path = destructive(location);
      try {
        return encodeRemoveTreeResult(
          stage === "initial"
            ? await removeManagedTree(path)
            : removeAfterReclaim(path),
        );
      } catch (error) {
        return encodeFailure(error);
      }
    },
    [LIFECYCLE_METHODS.discardTree]: async (payload) => {
      const path = destructive(decodeLifecycleLocation(payload));
      try {
        rmSync(path, {
          recursive: true,
          force: true,
          maxRetries: DISCARD_REMOVAL_RETRIES,
          retryDelay: DISCARD_REMOVAL_RETRY_DELAY_MS,
        });
        return encodeDiscardTreeResult({});
      } catch (error) {
        // A checkout with read-only directories in it is unlinkable until
        // owner access is back; the caller's next attempt then succeeds.
        restoreOwnerAccess(path);
        return encodeDiscardTreeResult({ failed: errorText(error) });
      }
    },
    [LIFECYCLE_METHODS.removeAll]: async (payload) => {
      const path = destructive(decodeLifecycleLocation(payload));
      try {
        await rm(path, { recursive: true, force: true });
        return encodeDone();
      } catch (error) {
        return encodeFailure(error);
      }
    },
    [LIFECYCLE_METHODS.stopProcesses]: async (payload) => {
      const path = destructive(decodeLifecycleLocation(payload));
      try {
        return encodeProcessStop(await stopCheckoutProcesses(path));
      } catch (error) {
        return encodeFailure(error);
      }
    },
  };
}
