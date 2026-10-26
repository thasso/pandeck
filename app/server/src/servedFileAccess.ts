/**
 * Every filesystem read the served-file code makes: `/api/files`
 * (`directFileHttp.ts`), document grants (`directFileGrants.ts`,
 * `documentGrantTargets.ts`) and `show_files`.
 *
 * Each read runs on one side. A path placed on a Worker
 * (`workers/placement.ts`) is read there through the file methods
 * (`workers/fileClient.ts`); a path named inside `DATA_DIR` or the Knowledge
 * Base, and every session artifact (by kind, whatever its path), is read on
 * the server through the same `fileReads.ts` the Worker runs. When the Worker
 * fails, the read fails: there is no local fallback (`docs/workers.md`).
 */
import { Readable } from "node:stream";
import {
  openFile,
  realpathFile,
  statFile,
  type FileOpenOutcome,
  type FileStat,
} from "./fileReads.ts";
import { MAX_FRAME_PAYLOAD_BYTES } from "./workerProtocol/codec.ts";
import {
  openOnWorker,
  realpathOnWorker,
  statOnWorker,
} from "./workers/fileClient.ts";
import { placeServedPath } from "./workers/placement.ts";

/** Where a served file is read: on the server, or on one Worker. */
export type ServedSide = "server" | { workerId: string };

/** The side placement gives `path`. */
export function servedSideOf(path: string): ServedSide {
  const location = placeServedPath(path);
  return location ? { workerId: location.workerId } : "server";
}

export function sameServedSide(a: ServedSide, b: ServedSide): boolean {
  return a === "server" || b === "server" ? a === b : a.workerId === b.workerId;
}

/** Stats `path`, following symlinks. */
export function statServedFile(
  path: string,
  side: ServedSide = servedSideOf(path),
): Promise<FileStat> {
  return side === "server"
    ? statFile(path)
    : statOnWorker({ workerId: side.workerId, path });
}

export function realpathServedFile(
  path: string,
  side: ServedSide = servedSideOf(path),
): Promise<string> {
  return side === "server"
    ? realpathFile(path)
    : realpathOnWorker({ workerId: side.workerId, path });
}

/** An open served file, streamed by range; the caller closes it. */
export interface ServedFileHandle {
  /** The bytes `start`..`end` inclusive; ends early at end of file. */
  createReadStream(range: { start: number; end: number }): Readable;
  close(): Promise<void>;
}

/** A served file opened with its descriptor stat. */
export interface StatServedFileHandle extends ServedFileHandle {
  /** The opened descriptor's stat. */
  stat(): Promise<FileStat>;
}

interface OpenOptions {
  side?: ServedSide;
  /** Aborted: the open still settles, and a file it made is closed. */
  signal?: AbortSignal;
}

interface ReadableFile {
  read(position: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Opens `path`, in the two shapes the callers had before.
 *
 * - `stat: true` is `open()` and then `handle.stat()`. A failed open rejects.
 *   A failed descriptor stat resolves to a handle whose `stat()` rejects,
 *   whose `close()` does nothing (the descriptor is already closed), and
 *   which streams nothing.
 * - `stat: false` is `createReadStream(path)`: it opens and never stats the
 *   descriptor. A failed open rejects.
 *
 * Aborting `signal` before the open settles closes any file it made, and only
 * then rejects; no stream starts.
 */
export function openServedFile(
  path: string,
  options: OpenOptions & { stat: true },
): Promise<StatServedFileHandle>;
export function openServedFile(
  path: string,
  options: OpenOptions & { stat: false },
): Promise<ServedFileHandle>;
export async function openServedFile(
  path: string,
  options: OpenOptions & { stat: boolean },
): Promise<ServedFileHandle | StatServedFileHandle> {
  const { stat, signal } = options;
  const side = options.side ?? servedSideOf(path);
  if (signal?.aborted) throw abortError();
  const own = async (outcome: FileOpenOutcome<ReadableFile>) => {
    if (signal?.aborted) {
      if ("file" in outcome) await outcome.file.close();
      throw abortError();
    }
    if ("file" in outcome) return handleOf(outcome.file, outcome.stat);
    if (outcome.phase === "open") throw outcome.error;
    return descriptorless(outcome.error);
  };
  return side === "server"
    ? openFile(path, { stat }, own)
    : own(await openOnWorker({ workerId: side.workerId, path }, stat));
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

function handleOf(
  file: ReadableFile,
  stat: FileStat | undefined,
): ServedFileHandle | StatServedFileHandle {
  const handle: ServedFileHandle = {
    createReadStream: ({ start, end }) => new FileRangeStream(file, start, end),
    close: () => file.close(),
  };
  return stat ? { ...handle, stat: () => Promise.resolve(stat) } : handle;
}

function descriptorless(error: Error): StatServedFileHandle {
  return {
    stat: () => Promise.reject(error),
    close: () => Promise.resolve(),
    createReadStream: () => {
      throw new Error("The file was never opened for reading.");
    },
  };
}

/** One positional read is one `data` frame of the worker protocol. */
const CHUNK_BYTES = MAX_FRAME_PAYLOAD_BYTES;

/**
 * Pulls one chunk at a time, only when the consumer has room: at most one
 * read in flight and one chunk buffered. A read still in flight when the
 * stream is destroyed settles, and its bytes are dropped. The stream never
 * closes the file.
 */
class FileRangeStream extends Readable {
  private position: number;
  private reading = false;

  constructor(
    private readonly file: ReadableFile,
    start: number,
    private readonly end: number,
  ) {
    super({ highWaterMark: CHUNK_BYTES });
    this.position = start;
  }

  override _read(): void {
    if (this.reading) return;
    const length = Math.min(CHUNK_BYTES, this.end - this.position + 1);
    if (length <= 0) {
      this.push(null);
      return;
    }
    this.reading = true;
    this.file.read(this.position, length).then(
      (bytes) => {
        this.reading = false;
        if (this.destroyed) return;
        if (bytes.byteLength === 0) {
          this.push(null);
          return;
        }
        this.position += bytes.byteLength;
        this.push(bytes);
        if (this.position > this.end) this.push(null);
      },
      (error: unknown) => {
        this.reading = false;
        if (!this.destroyed) this.destroy(error as Error);
      },
    );
  }
}
