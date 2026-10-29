/**
 * The server's side of the checkout lifecycle methods: a lifecycle step for a
 * checkout placed on a Worker becomes a request to that Worker
 * (`docs/workers.md`). Callers reach it through `checkoutLifecycle.ts`.
 *
 * Any failure to get an answer — the connection ending, an unknown Worker id,
 * a refused request of any code, a malformed answer — rejects with an error
 * branded as a Worker failure, as the file client brands one
 * (`fileClient.ts`). A filesystem failure the Worker answered is an
 * `AnsweredFileFailure` and is never branded. Nothing is retried, and there
 * is no local fallback.
 */
import type { TreeResidueScan } from "../managedTreeRemoval.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  MalformedWorkerAnswerError,
  type WorkerFileLocation,
} from "../workerProtocol/fileMethods.ts";
import {
  LIFECYCLE_METHODS,
  decodeCreateDirResult,
  decodeDiscardTreeResult,
  decodeDone,
  decodeProcessStop,
  decodeRemoveTreeResult,
  decodeResidueScan,
  encodeLifecycleLocation,
  encodeRemoveTree,
  type CreateDirResult,
  type DiscardTreeResult,
  type LifecycleProcessStop,
  type RemoveTreeStage,
  type RemoveTreeStageResult,
} from "../workerProtocol/lifecycleMethods.ts";
import { workerConnection } from "./checkoutClient.ts";
import { brandWorkerFailure } from "./fileClient.ts";

async function ask<T>(
  location: WorkerFileLocation,
  method: string,
  payload: Payload,
  decode: (answer: Payload) => T,
): Promise<T> {
  let answer: Payload;
  try {
    answer = await workerConnection(location.workerId).request(method, payload);
  } catch (error) {
    throw brandWorkerFailure(error);
  }
  try {
    return decode(answer);
  } catch (error) {
    if (error instanceof MalformedWorkerAnswerError)
      throw brandWorkerFailure(error);
    throw error;
  }
}

export function mkdirOnWorker(location: WorkerFileLocation): Promise<void> {
  return ask(
    location,
    LIFECYCLE_METHODS.mkdir,
    encodeLifecycleLocation(location),
    decodeDone,
  );
}

export function createDirOnWorker(
  location: WorkerFileLocation,
): Promise<CreateDirResult> {
  return ask(
    location,
    LIFECYCLE_METHODS.createDir,
    encodeLifecycleLocation(location),
    decodeCreateDirResult,
  );
}

export function scanResidueOnWorker(
  location: WorkerFileLocation,
): Promise<TreeResidueScan> {
  return ask(
    location,
    LIFECYCLE_METHODS.scanResidue,
    encodeLifecycleLocation(location),
    decodeResidueScan,
  );
}

export function removeTreeOnWorker(
  location: WorkerFileLocation,
  stage: RemoveTreeStage,
): Promise<RemoveTreeStageResult> {
  return ask(
    location,
    LIFECYCLE_METHODS.removeTree,
    encodeRemoveTree(location, stage),
    decodeRemoveTreeResult,
  );
}

export function discardTreeOnWorker(
  location: WorkerFileLocation,
): Promise<DiscardTreeResult> {
  return ask(
    location,
    LIFECYCLE_METHODS.discardTree,
    encodeLifecycleLocation(location),
    decodeDiscardTreeResult,
  );
}

export function removeAllOnWorker(location: WorkerFileLocation): Promise<void> {
  return ask(
    location,
    LIFECYCLE_METHODS.removeAll,
    encodeLifecycleLocation(location),
    decodeDone,
  );
}

export function stopProcessesOnWorker(
  location: WorkerFileLocation,
): Promise<LifecycleProcessStop> {
  return ask(
    location,
    LIFECYCLE_METHODS.stopProcesses,
    encodeLifecycleLocation(location),
    decodeProcessStop,
  );
}
