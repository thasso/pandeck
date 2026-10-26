/**
 * The Worker's file methods: served files read here, through `fileReads.ts`,
 * from a table of handles that belongs to one connection.
 *
 * A handle's descriptor is closed exactly once: by `files.close`, after the
 * handle's reads in flight have settled; at once, by an open that finishes
 * after the connection ended; or by the sweep once the connection has ended
 * and every non-orphaned request has settled. A native open still awaiting a
 * descriptor is orphaned on end: its handler settles, and its eventual
 * descriptor closes without registration. Ids count up and are never reused
 * within a table. A cancel cannot interrupt a filesystem call: the handler
 * finishes and answers (`docs/workers.md`).
 */
import {
  openFile,
  realpathFile,
  statFile,
  type OpenedFile,
} from "../fileReads.ts";
import { WRONG_WORKER } from "../workerProtocol/checkoutMethods.ts";
import {
  WorkerMethodError,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import {
  FILE_METHODS,
  UNKNOWN_HANDLE,
  decodeHandle,
  decodeLocation,
  decodeOpen,
  decodeRead,
  encodeBytes,
  encodeFailure,
  encodeOpened,
  encodeRealpath,
  encodeStat,
} from "../workerProtocol/fileMethods.ts";

export interface FileTable {
  readonly handlers: MethodHandlers;
  /** The connection ended: an open finishing from now on closes its file. */
  end(): void;
  /** Closes every handle still held; call once every request has settled. */
  sweep(): Promise<void>;
  /** Test seam: how many handles the table holds. */
  readonly size: number;
}

/** The file methods of the Worker `workerId`, with one connection's table. */
export function fileHandlers(workerId: string): FileTable {
  const table = new Map<number, OpenedFile>();
  let nextHandle = 1;
  let ended = false;
  const pendingOpens = new Set<AbortController>();

  const here = (id: string, what: string): void => {
    if (id !== workerId)
      throw new WorkerMethodError(
        WRONG_WORKER,
        `The file ${what} is on Worker "${id}", not "${workerId}".`,
      );
  };
  const held = (handle: number): OpenedFile => {
    const file = table.get(handle);
    if (!file)
      throw new WorkerMethodError(
        UNKNOWN_HANDLE,
        `This Worker holds no file handle ${handle}.`,
      );
    return file;
  };

  const handlers: MethodHandlers = {
    [FILE_METHODS.stat]: async (payload) => {
      const location = decodeLocation(payload);
      here(location.workerId, location.path);
      try {
        return encodeStat(await statFile(location.path));
      } catch (error) {
        return encodeFailure(error);
      }
    },
    [FILE_METHODS.realpath]: async (payload) => {
      const location = decodeLocation(payload);
      here(location.workerId, location.path);
      try {
        return encodeRealpath(await realpathFile(location.path));
      } catch (error) {
        return encodeFailure(error);
      }
    },
    [FILE_METHODS.open]: async (payload) => {
      const { location, stat } = decodeOpen(payload);
      here(location.workerId, location.path);
      const connectionEnd = new AbortController();
      pendingOpens.add(connectionEnd);
      if (ended) connectionEnd.abort();
      try {
        return await openFile(
          location.path,
          { stat, orphanOnEnd: connectionEnd.signal },
          async (outcome) => {
            if ("error" in outcome)
              return encodeFailure(outcome.error, { phase: outcome.phase });
            if (ended) {
              await outcome.file.close();
              return encodeFailure(new Error("The Worker connection ended."), {
                phase: "open",
              });
            }
            const handle = nextHandle++;
            table.set(handle, outcome.file);
            return encodeOpened(handle, outcome.stat);
          },
        );
      } finally {
        pendingOpens.delete(connectionEnd);
      }
    },
    [FILE_METHODS.read]: async (payload) => {
      const { workerId: id, handle, position, length } = decodeRead(payload);
      here(id, `handle ${handle}`);
      const file = held(handle);
      try {
        return encodeBytes(await file.read(position, length));
      } catch (error) {
        return encodeFailure(error);
      }
    },
    [FILE_METHODS.close]: async (payload) => {
      const { workerId: id, handle } = decodeHandle(payload);
      here(id, `handle ${handle}`);
      const file = table.get(handle);
      if (!file) return { json: {} };
      table.delete(handle);
      try {
        await file.close();
        return { json: {} };
      } catch (error) {
        return encodeFailure(error);
      }
    },
  };

  return {
    handlers,
    end() {
      ended = true;
      for (const open of pendingOpens) open.abort();
    },
    async sweep() {
      const files = [...table.values()];
      table.clear();
      await Promise.allSettled(files.map((file) => file.close()));
    },
    get size() {
      return table.size;
    },
  };
}
