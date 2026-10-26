/**
 * The filesystem reads behind served files and checkout reads, shared by both
 * sides of the Worker boundary: the Worker's file methods (`worker/files.ts`)
 * and the server-local reads of `DATA_DIR`, the Knowledge Base and session
 * artifacts (`servedFileAccess.ts`, `checkoutFileAccess.ts`). One
 * implementation, so a path answers the same wherever it is read
 * (`docs/workers.md`).
 *
 * Imports only Node built-ins: `worker/` may import it.
 *
 * The `…ForTests` exports are seams for the descriptor-lifetime tests. They
 * are inert unless a test arms them.
 */
import { constants, type BigIntStats } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { constants as osConstants } from "node:os";

/** What a stat answers, as plain values that cross the wire unchanged. */
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

/** An open descriptor, read by position; closed exactly once. */
export interface OpenedFile {
  /**
   * Up to `length` bytes from `position`; fewer only at end of file, and none
   * past it. Memory follows the bytes read, never `length`.
   */
  read(position: number, length: number): Promise<Uint8Array>;
  /** Closes the descriptor once its reads in flight have settled. */
  close(): Promise<void>;
}

/**
 * How an open ended, with the step that failed: `open` when no descriptor
 * was made, `stat` when the descriptor was made and its stat failed. The
 * descriptor is already closed then.
 */
export type FileOpenOutcome<File> =
  { file: File; stat?: FileStat } | { error: Error; phase: "open" | "stat" };

/** The largest piece one positional read asks for. */
const READ_PIECE_BYTES = 1024 * 1024;

function fileStatOf(stats: Awaited<ReturnType<typeof stat>>): FileStat {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    dev: Number(stats.dev),
    ino: Number(stats.ino),
  };
}

/** Stats `path`, following symlinks as `stat` does. */
export async function statFile(path: string): Promise<FileStat> {
  await barrier(path, "stat");
  pathCalls += 1;
  return fileStatOf(await stat(path));
}

export async function realpathFile(path: string): Promise<string> {
  await barrier(path, "realpath");
  const fault = takeFault(path, "realpath");
  if (fault) throw fault;
  pathCalls += 1;
  return realpath(path);
}

/**
 * Whether `path` exists, as `existsSync` answers it: true when
 * `access(path, F_OK)` resolves, false on any rejection. Never rejects.
 */
export async function existsPath(path: string): Promise<boolean> {
  await barrier(path, "exists");
  pathCalls += 1;
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * An entry's kind and identity at full precision, from a `bigint` stat; the
 * numbers are decimal strings so they cross the wire unchanged.
 */
export interface PathInspection {
  kind: "file" | "directory" | "symlink" | "other";
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  /** The mode bits, type included; always set here, optional on the wire. */
  mode?: string;
}

function kindOf(stats: BigIntStats): PathInspection["kind"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

/** Stats `path`, following symlinks with `follow` (`stat`), else `lstat`. */
export async function inspectPath(
  path: string,
  follow: boolean,
): Promise<PathInspection> {
  await barrier(path, "inspect");
  const fault = takeFault(path, "inspect");
  if (fault) throw fault;
  pathCalls += 1;
  const stats = follow
    ? await stat(path, { bigint: true })
    : await lstat(path, { bigint: true });
  return {
    kind: kindOf(stats),
    dev: String(stats.dev),
    ino: String(stats.ino),
    size: String(stats.size),
    mtimeNs: String(stats.mtimeNs),
    mode: String(stats.mode),
  };
}

/** A symlink's target text, as `readlink` decodes it (UTF-8). */
export async function readlinkPath(path: string): Promise<string> {
  await barrier(path, "readlink");
  const fault = takeFault(path, "readlink");
  if (fault) throw fault;
  pathCalls += 1;
  return readlink(path);
}

/** One directory entry; `directory` is the entry's own type, never followed. */
export interface DirectoryEntry {
  name: string;
  directory: boolean;
}

/** The entries of `path` in `readdir` order. */
export async function readDirectory(path: string): Promise<DirectoryEntry[]> {
  await barrier(path, "readdir");
  const fault = takeFault(path, "readdir");
  if (fault) throw fault;
  pathCalls += 1;
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    directory: entry.isDirectory(),
  }));
}

/**
 * Opens `path` read-only and, with `stat`, stats the descriptor. The outcome
 * goes to `dispose`, which owns it from then on — registers the file, closes
 * it, or reports the failure — and whose result this answers. With
 * `orphanOnEnd`, a native open still awaiting a descriptor is abandoned when
 * the connection ends. Its eventual descriptor is closed here, never passed
 * to `dispose`. This does not cancel the native call or ordinary caller aborts.
 */
export async function openFile<T>(
  path: string,
  options: { stat: boolean; orphanOnEnd?: AbortSignal },
  dispose: (outcome: FileOpenOutcome<OpenedFile>) => Promise<T> | T,
): Promise<T> {
  let held: Barrier | undefined;
  let orphaned: Promise<void> | undefined;
  try {
    held = await barrier(path, "before-open");
    const outcome = await openOutcome(path, options.stat, options.orphanOnEnd);
    if ("orphaned" in outcome) {
      orphaned = outcome.orphaned;
      return await dispose({ error: connectionEnded(), phase: "open" });
    }
    if (!("error" in outcome && outcome.phase === "open"))
      held = (await barrier(path, "after-open")) ?? held;
    return await dispose(outcome);
  } finally {
    // A test's disposal receipt includes the late native descriptor's close,
    // even though that orphan no longer holds the Worker's handler settlement.
    if (orphaned) void orphaned.then(() => held?.disposed.resolve());
    else held?.disposed.resolve();
  }
}

function connectionEnded(): Error {
  return new Error("The Worker connection ended.");
}

interface OrphanedOpen {
  orphaned: Promise<void>;
}

/** Only the wait for a native open, before any descriptor is returned. */
async function openNative(
  path: string,
  orphanOnEnd?: AbortSignal,
): Promise<FileHandle | OrphanedOpen> {
  if (orphanOnEnd?.aborted) throw connectionEnded();
  const opening = open(path, "r");
  if (!orphanOnEnd) return opening;
  let onEnd!: () => void;
  const ended = new Promise<undefined>((resolve) => {
    onEnd = () => resolve(undefined);
    orphanOnEnd.addEventListener("abort", onEnd, { once: true });
  });
  try {
    const handle = await Promise.race([opening, ended]);
    if (handle) return handle;
    return {
      orphaned: opening
        .then(async (late) => {
          live += 1;
          await openedFile(late).close();
        })
        .catch(() => undefined),
    };
  } finally {
    orphanOnEnd.removeEventListener("abort", onEnd);
  }
}

async function openOutcome(
  path: string,
  withStat: boolean,
  orphanOnEnd?: AbortSignal,
): Promise<FileOpenOutcome<OpenedFile> | OrphanedOpen> {
  let handle: FileHandle;
  try {
    const fault = takeFault(path, "open");
    if (fault) throw fault;
    const result = await openNative(path, orphanOnEnd);
    if ("orphaned" in result) return result;
    handle = result;
  } catch (error) {
    return { error: error as Error, phase: "open" };
  }
  live += 1;
  const file = openedFile(handle);
  if (!withStat) return { file };
  try {
    descriptorStats += 1;
    const fault = takeFault(path, "stat");
    if (fault) throw fault;
    return { file, stat: fileStatOf(await handle.stat()) };
  } catch (error) {
    await file.close().catch(() => undefined);
    return { error: error as Error, phase: "stat" };
  }
}

function openedFile(handle: FileHandle): OpenedFile {
  const reading = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const readAt = async (
    position: number,
    length: number,
  ): Promise<Uint8Array> => {
    const pieces: Buffer[] = [];
    let total = 0;
    while (total < length) {
      const want = Math.min(READ_PIECE_BYTES, length - total);
      const piece = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(piece, 0, want, position + total);
      if (bytesRead === 0) break;
      pieces.push(piece.subarray(0, bytesRead));
      total += bytesRead;
    }
    return pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, total);
  };
  return {
    read(position, length) {
      if (closing) return Promise.reject(new Error("The file is closed."));
      const read = readAt(position, length);
      reading.add(read);
      const settled = () => reading.delete(read);
      read.then(settled, settled);
      return read;
    },
    close() {
      closing ??= (async () => {
        await Promise.allSettled([...reading]);
        try {
          await handle.close();
        } finally {
          live -= 1;
        }
      })();
      return closing;
    },
  };
}

// --- Test seams -----------------------------------------------------------

let live = 0;
let descriptorStats = 0;
let pathCalls = 0;

/**
 * Test seam: descriptors open now, descriptor stats ever made, and native
 * path calls ever made (stat, realpath, exists, inspect, readdir, readlink).
 */
export function fileReadsCountsForTests(): {
  liveDescriptors: number;
  descriptorStats: number;
  pathCalls: number;
} {
  return { liveDescriptors: live, descriptorStats, pathCalls };
}

type BarrierPhase =
  | "stat"
  | "realpath"
  | "exists"
  | "inspect"
  | "readdir"
  | "readlink"
  | "before-open"
  | "after-open";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Barrier {
  phase: BarrierPhase;
  reached: Deferred;
  released: Deferred;
  disposed: Deferred;
}

const barriers = new Map<string, Barrier>();

/** A held call on one path, which the test releases. */
export interface FileBarrierForTests {
  /** Resolves when a call reaches the barrier. */
  reached: Promise<void>;
  release(): void;
  /**
   * For the open phases: resolves once the owner has disposed of that open's
   * outcome (registered the file, closed it, or reported the failure).
   */
  disposed: Promise<void>;
}

/**
 * Test seam: hold the next call on `path` at `phase` — `stat`, `realpath`,
 * `exists`, `inspect`, `readdir` or `readlink` before that path call,
 * `before-open` before the native open, `after-open` once the descriptor (and
 * with `stat: true` its stat) exists and before the outcome goes to its
 * owner. One-shot.
 */
export function holdFileForTests(
  path: string,
  phase: BarrierPhase,
): FileBarrierForTests {
  const armed: Barrier = {
    phase,
    reached: deferred(),
    released: deferred(),
    disposed: deferred(),
  };
  barriers.set(path, armed);
  return {
    reached: armed.reached.promise,
    release: () => armed.released.resolve(),
    disposed: armed.disposed.promise,
  };
}

/** Holds the call when `path` is armed at `phase`; answers the barrier it held. */
async function barrier(
  path: string,
  phase: BarrierPhase,
): Promise<Barrier | undefined> {
  const armed = barriers.get(path);
  if (armed?.phase !== phase) return undefined;
  barriers.delete(path);
  armed.reached.resolve();
  await armed.released.promise;
  return armed;
}

type FaultPhase =
  "open" | "stat" | "realpath" | "inspect" | "readdir" | "readlink";

interface Fault {
  phase: FaultPhase;
  code: string;
  /** Leave out the native `errno`, so only the `code` is set. */
  bare?: boolean;
}

const faults = new Map<string, Fault>();

const FAULT_SYSCALLS: Record<FaultPhase, string> = {
  open: "open",
  stat: "fstat",
  realpath: "realpath",
  inspect: "stat",
  readdir: "scandir",
  readlink: "readlink",
};

/**
 * Test seam: fail the next native open (`open`), descriptor stat (`stat`),
 * `realpath`, `inspect`, `readdir` or `readlink` of `path` with `code`. The
 * error carries the negative `errno` of `code`, as a native one does, unless
 * `bare`. One-shot; an open that makes no descriptor stat leaves a `stat`
 * fault armed.
 */
export function failFileForTests(path: string, fault: Fault): void {
  if (
    !fault.bare &&
    osConstants.errno[fault.code as keyof typeof osConstants.errno] ===
      undefined
  )
    throw new Error(`No errno for ${fault.code}; arm it bare.`);
  faults.set(path, fault);
}

/** Test seam: whether a fault armed on `path` is still unconsumed. */
export function fileFaultArmedForTests(path: string): boolean {
  return faults.has(path);
}

function takeFault(path: string, phase: FaultPhase): Error | undefined {
  const fault = faults.get(path);
  if (fault?.phase !== phase) return undefined;
  faults.delete(path);
  const error = Object.assign(
    new Error(
      `${fault.code}: injected fault, ${FAULT_SYSCALLS[phase]} '${path}'`,
    ),
    { code: fault.code },
  );
  if (fault.bare) return error;
  const errno = osConstants.errno[fault.code as keyof typeof osConstants.errno];
  return Object.assign(error, { errno: -errno });
}
