/**
 * The server's side of the file methods: a served-file or checkout read for a
 * path placed on a Worker becomes a request to that Worker
 * (`docs/workers.md`).
 *
 * A handle is bound to the exact connection that opened it. Its reads and its
 * close go only there: never re-resolved, never re-dialed, so a handle from an
 * ended connection can never reach the table of the one that replaced it.
 * Once its connection has ended, a read rejects at once and a close does
 * nothing, because the Worker closed the handle at the end.
 *
 * Any failure to get an answer — the connection ending, an unknown Worker id,
 * a refused request of any code, a malformed answer — rejects with an error
 * branded as a Worker failure ({@link isWorkerFailure}): the brand marks where
 * the error came from, never what `code` it carries. A filesystem failure the
 * Worker answered is an `AnsweredFileFailure` and is never branded. There is
 * no local fallback.
 */
import type {
  DirectoryEntry,
  FileOpenOutcome,
  FileStat,
  PathInspection,
} from "../fileReads.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import type { WorkerConnection } from "../workerProtocol/connection.ts";
import {
  FILE_METHODS,
  MalformedWorkerAnswerError,
  decodeBytes,
  decodeClosed,
  decodeEntries,
  decodeExists,
  decodeInspection,
  decodeLinkTarget,
  decodeOpenOutcome,
  decodeRealpath,
  decodeStat,
  encodeHandle,
  encodeInspect,
  encodeLocation,
  encodeOpen,
  encodeRead,
  type WorkerFileLocation,
} from "../workerProtocol/fileMethods.ts";
import { workerConnection } from "./checkoutClient.ts";

/** A file a Worker holds open for this server. */
export interface WorkerFileHandle {
  read(position: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

const workerFailures = new WeakSet<object>();

/** Whether `error` is a Worker failure: no answer was obtained for it. */
export function isWorkerFailure(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && workerFailures.has(error)
  );
}

/** Brands `error` in place; a non-object is wrapped in an `Error` first. */
export function brandWorkerFailure(error: unknown): unknown {
  const failure =
    typeof error === "object" && error !== null
      ? error
      : new Error(String(error));
  workerFailures.add(failure);
  return failure;
}

function connectionTo(workerId: string): WorkerConnection {
  try {
    return workerConnection(workerId);
  } catch (error) {
    throw brandWorkerFailure(error);
  }
}

async function requestOn(
  connection: WorkerConnection,
  method: string,
  payload: Payload,
): Promise<Payload> {
  try {
    return await connection.request(method, payload);
  } catch (error) {
    throw brandWorkerFailure(error);
  }
}

/** The decoded answer; a malformed one is branded, anything else rethrown. */
function decoded<T>(answer: Payload, decode: (answer: Payload) => T): T {
  try {
    return decode(answer);
  } catch (error) {
    if (error instanceof MalformedWorkerAnswerError)
      throw brandWorkerFailure(error);
    throw error;
  }
}

async function ask<T>(
  location: WorkerFileLocation,
  method: string,
  payload: Payload,
  decode: (answer: Payload) => T,
): Promise<T> {
  const connection = connectionTo(location.workerId);
  return decoded(await requestOn(connection, method, payload), decode);
}

export function statOnWorker(location: WorkerFileLocation): Promise<FileStat> {
  return ask(location, FILE_METHODS.stat, encodeLocation(location), decodeStat);
}

export function realpathOnWorker(
  location: WorkerFileLocation,
): Promise<string> {
  return ask(
    location,
    FILE_METHODS.realpath,
    encodeLocation(location),
    decodeRealpath,
  );
}

export function existsOnWorker(location: WorkerFileLocation): Promise<boolean> {
  return ask(
    location,
    FILE_METHODS.exists,
    encodeLocation(location),
    decodeExists,
  );
}

/**
 * With `mode` required, an inspection without it is a malformed answer: a
 * Worker older than protocol 1.3 never sends one.
 */
export function inspectOnWorker(
  location: WorkerFileLocation,
  follow: boolean,
  options: { mode?: boolean } = {},
): Promise<PathInspection> {
  return ask(
    location,
    FILE_METHODS.inspect,
    encodeInspect(location, follow),
    (answer) => {
      const inspection = decodeInspection(answer);
      if (options.mode && inspection.mode === undefined)
        throw new MalformedWorkerAnswerError(
          "The Worker answered a path inspection without its mode.",
        );
      return inspection;
    },
  );
}

export function readlinkOnWorker(
  location: WorkerFileLocation,
): Promise<string> {
  return ask(
    location,
    FILE_METHODS.readlink,
    encodeLocation(location),
    decodeLinkTarget,
  );
}

export function readdirOnWorker(
  location: WorkerFileLocation,
): Promise<DirectoryEntry[]> {
  return ask(
    location,
    FILE_METHODS.readdir,
    encodeLocation(location),
    decodeEntries,
  );
}

/**
 * Opens `location` on its Worker. Sent without an abort signal, so it always
 * settles with the Worker's real answer and no handle goes unclaimed.
 */
export async function openOnWorker(
  location: WorkerFileLocation,
  stat: boolean,
): Promise<FileOpenOutcome<WorkerFileHandle>> {
  const connection = connectionTo(location.workerId);
  const outcome = decoded(
    await requestOn(connection, FILE_METHODS.open, encodeOpen(location, stat)),
    decodeOpenOutcome,
  );
  if ("error" in outcome) return outcome;
  const file = boundHandle(connection, {
    workerId: location.workerId,
    handle: outcome.handle,
  });
  return outcome.stat ? { file, stat: outcome.stat } : { file };
}

function boundHandle(
  connection: WorkerConnection,
  ref: { workerId: string; handle: number },
): WorkerFileHandle {
  return {
    async read(position, length) {
      return decoded(
        await requestOn(
          connection,
          FILE_METHODS.read,
          encodeRead(ref, position, length),
        ),
        decodeBytes,
      );
    },
    async close() {
      if (connection.isEnded) return;
      try {
        decoded(
          await requestOn(connection, FILE_METHODS.close, encodeHandle(ref)),
          decodeClosed,
        );
      } catch (error) {
        if (!connection.isEnded) throw error;
      }
    },
  };
}
