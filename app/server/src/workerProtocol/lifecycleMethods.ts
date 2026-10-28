/**
 * The checkout lifecycle methods of worker protocol 1.5 and their wire shapes,
 * shared by the server's client (`workers/lifecycleClient.ts`) and the
 * Worker's handlers (`worker/lifecycle.ts`): the filesystem and process work
 * of creating and removing a checkout (`docs/workers.md`).
 *
 * Every request names its Worker, which refuses another Worker's id before it
 * touches anything. A path is a non-empty string used as given: a relative one
 * resolves against the Worker's cwd, as the file methods and `node:fs` do. The
 * four destructive methods (`removeTree`, `discardTree`, `removeAll`,
 * `stopProcesses`) also refuse a path that resolves to `/`. No option of the
 * effect itself crosses the wire: the Worker runs it with its own defaults.
 *
 * A filesystem failure is an answer, encoded and rebuilt as the file methods
 * do (`fileMethods.ts`). `discardTree` answers its removal failure as a value
 * instead, because the discard goes on past it.
 */
import { resolve } from "node:path";
import type { TreeResidue, TreeResidueScan } from "../managedTreeRemoval.ts";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";
import {
  MalformedWorkerAnswerError,
  settled,
  type WorkerFileLocation,
} from "./fileMethods.ts";

export const LIFECYCLE_METHODS = {
  /** `mkdirSync(path, {recursive: true})`. */
  mkdir: "lifecycle.mkdir",
  /** The residue scan, with the Worker's own uid and the default budget. */
  scanResidue: "lifecycle.scanResidue",
  /** One stage of the managed tree removal (`managedTreeRemoval.ts`). */
  removeTree: "lifecycle.removeTree",
  /** The bounded removal of a failed create's directory. */
  discardTree: "lifecycle.discardTree",
  /** `rm(path, {recursive: true, force: true})`. */
  removeAll: "lifecycle.removeAll",
  /** Stops the Worker's processes running in the checkout. */
  stopProcesses: "lifecycle.stopProcesses",
} as const;

/**
 * The stages of a managed tree removal the Worker runs. The reclaim between
 * them stays on the server.
 */
export type RemoveTreeStage = "initial" | "afterReclaim";

/** What one stage answers: removed, or what still blocks the tree. */
export type RemoveTreeStageResult =
  { removed: true } | { removed: false; residue?: TreeResidue };

/** What a discard attempt answers: nothing, or its removal failure's text. */
export interface DiscardTreeResult {
  failed?: string;
}

/** The processes a stop signalled: every SIGTERM, and the SIGKILL subset. */
export interface LifecycleProcessStop {
  terminated: number[];
  killed: number[];
}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function malformed(what: string): never {
  throw new MalformedWorkerAnswerError(
    `The Worker answered a malformed ${what}.`,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPid = (value: unknown): value is number => isCount(value) && value > 0;

// --- Requests -------------------------------------------------------------

export function encodeLifecycleLocation(location: WorkerFileLocation): Payload {
  return {
    json: { location: { workerId: location.workerId, path: location.path } },
  };
}

export function decodeLifecycleLocation(payload: Payload): WorkerFileLocation {
  const location = record(record(payload.json)?.location);
  if (
    typeof location?.workerId !== "string" ||
    typeof location.path !== "string" ||
    location.path === ""
  )
    invalid("lifecycle location");
  return { workerId: location.workerId, path: location.path };
}

/**
 * Refuses a destructive request for `/`. Called after the Worker id check, so
 * a foreign id is refused as `wrong_worker` whatever its path.
 */
export function refuseFilesystemRoot(location: WorkerFileLocation): void {
  if (resolve(location.path) === "/") invalid("lifecycle path: it is /");
}

export function encodeRemoveTree(
  location: WorkerFileLocation,
  stage: RemoveTreeStage,
): Payload {
  return {
    json: {
      location: { workerId: location.workerId, path: location.path },
      stage,
    },
  };
}

export function decodeRemoveTree(payload: Payload): {
  location: WorkerFileLocation;
  stage: RemoveTreeStage;
} {
  const location = decodeLifecycleLocation(payload);
  const stage = record(payload.json)?.stage;
  if (stage !== "initial" && stage !== "afterReclaim") invalid("removal stage");
  return { location, stage };
}

// --- Answers --------------------------------------------------------------

/** An answer with nothing to say beyond success. */
export function encodeDone(): Payload {
  return { json: {} };
}

export function decodeDone(payload: Payload): void {
  settled(payload);
}

function encodeResidue(residue: TreeResidue): Record<string, unknown> {
  return { path: residue.path, reason: residue.reason, uid: residue.uid };
}

function residueOf(value: unknown): TreeResidue {
  const residue = record(value);
  if (
    typeof residue?.path !== "string" ||
    (residue.reason !== "foreign-owner" && residue.reason !== "owner-locked") ||
    !isCount(residue.uid)
  )
    malformed("tree residue");
  return { path: residue.path, reason: residue.reason, uid: residue.uid };
}

export function encodeResidueScan(scan: TreeResidueScan): Payload {
  return {
    json: {
      scan: {
        complete: scan.complete,
        directoriesVisited: scan.directoriesVisited,
        ...(scan.foreign ? { foreign: encodeResidue(scan.foreign) } : {}),
      },
    },
  };
}

export function decodeResidueScan(payload: Payload): TreeResidueScan {
  const scan = record(settled(payload).scan);
  if (typeof scan?.complete !== "boolean" || !isCount(scan.directoriesVisited))
    malformed("residue scan");
  return {
    complete: scan.complete,
    directoriesVisited: scan.directoriesVisited,
    ...(scan.foreign !== undefined ? { foreign: residueOf(scan.foreign) } : {}),
  };
}

export function encodeRemoveTreeResult(result: RemoveTreeStageResult): Payload {
  return {
    json: {
      removal: result.removed
        ? { removed: true }
        : {
            removed: false,
            ...(result.residue
              ? { residue: encodeResidue(result.residue) }
              : {}),
          },
    },
  };
}

export function decodeRemoveTreeResult(
  payload: Payload,
): RemoveTreeStageResult {
  const removal = record(settled(payload).removal);
  if (typeof removal?.removed !== "boolean") malformed("tree removal");
  if (removal.removed) {
    if (removal.residue !== undefined) malformed("tree removal");
    return { removed: true };
  }
  return removal.residue === undefined
    ? { removed: false }
    : { removed: false, residue: residueOf(removal.residue) };
}

export function encodeDiscardTreeResult(result: DiscardTreeResult): Payload {
  return {
    json: { discard: result.failed === undefined ? {} : { failed: true } },
    ...(result.failed === undefined ? {} : { text: { failed: result.failed } }),
  };
}

export function decodeDiscardTreeResult(payload: Payload): DiscardTreeResult {
  const discard = record(settled(payload).discard);
  if (!discard) malformed("tree discard");
  if (discard.failed === undefined) return {};
  const failed = payload.text?.failed;
  if (discard.failed !== true || failed === undefined)
    malformed("tree discard");
  return { failed };
}

export function encodeProcessStop(stop: LifecycleProcessStop): Payload {
  return {
    json: { stop: { terminated: stop.terminated, killed: stop.killed } },
  };
}

/** `killed` is a subset of `terminated`, or the answer is malformed. */
export function decodeProcessStop(payload: Payload): LifecycleProcessStop {
  const stop = record(settled(payload).stop);
  const { terminated, killed } = stop ?? {};
  if (
    !Array.isArray(terminated) ||
    !terminated.every(isPid) ||
    !Array.isArray(killed) ||
    !killed.every((pid) => isPid(pid) && terminated.includes(pid))
  )
    malformed("process stop");
  return { terminated: [...terminated], killed: [...killed] };
}
