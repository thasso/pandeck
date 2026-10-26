/**
 * The server's side of the file methods: a served-file read for a path placed
 * on a Worker becomes a request to that Worker (`docs/workers.md`).
 *
 * A handle is bound to the exact connection that opened it. Its reads and its
 * close go only there: never re-resolved, never re-dialed, so a handle from an
 * ended connection can never reach the table of the one that replaced it.
 * Once its connection has ended, a read rejects at once and a close does
 * nothing, because the Worker closed the handle at the end.
 *
 * Any failure to get an answer — the connection ending, an unknown Worker id,
 * a protocol error, the Worker refusing the location — rejects with an error
 * that has no filesystem `code`. There is no local fallback.
 */
import type { FileOpenOutcome, FileStat } from "../fileReads.ts";
import type { WorkerConnection } from "../workerProtocol/connection.ts";
import {
  FILE_METHODS,
  decodeBytes,
  decodeClosed,
  decodeOpenOutcome,
  decodeRealpath,
  decodeStat,
  encodeHandle,
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

export async function statOnWorker(
  location: WorkerFileLocation,
): Promise<FileStat> {
  return decodeStat(
    await workerConnection(location.workerId).request(
      FILE_METHODS.stat,
      encodeLocation(location),
    ),
  );
}

export async function realpathOnWorker(
  location: WorkerFileLocation,
): Promise<string> {
  return decodeRealpath(
    await workerConnection(location.workerId).request(
      FILE_METHODS.realpath,
      encodeLocation(location),
    ),
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
  const connection = workerConnection(location.workerId);
  const outcome = decodeOpenOutcome(
    await connection.request(FILE_METHODS.open, encodeOpen(location, stat)),
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
      return decodeBytes(
        await connection.request(
          FILE_METHODS.read,
          encodeRead(ref, position, length),
        ),
      );
    },
    async close() {
      if (connection.isEnded) return;
      try {
        decodeClosed(
          await connection.request(FILE_METHODS.close, encodeHandle(ref)),
        );
      } catch (error) {
        if (!connection.isEnded) throw error;
      }
    },
  };
}
