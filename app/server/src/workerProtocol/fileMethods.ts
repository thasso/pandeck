/**
 * The file methods of worker protocol 1.3 and their wire shapes, shared by the
 * server's client (`workers/fileClient.ts`) and the Worker's handlers
 * (`worker/files.ts`). Served files and checkout reads go through them
 * (`docs/workers.md`).
 *
 * Every request names its Worker, which refuses another Worker's id before it
 * touches anything. A file is read through a handle: `files.open` makes one,
 * `files.read` pulls a bounded piece by position, `files.close` ends it. A
 * handle belongs to the connection that opened it. The path methods
 * (`files.stat`, `files.realpath`, `files.exists`, `files.inspect`,
 * `files.readdir`, `files.readlink`) hold nothing.
 *
 * A filesystem failure is an answer, not a protocol failure: `{error:{code}}`
 * with the message as text, rebuilt by the client as an
 * {@link AnsweredFileFailure} with the same `code` and `message`. An answer
 * that is not what its method answers is a {@link MalformedWorkerAnswerError}.
 * Paths ride in the JSON body, whose escapes keep lone surrogates.
 */
import type { DirectoryEntry, FileStat, PathInspection } from "../fileReads.ts";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";

export const FILE_METHODS = {
  /** Stat a path, following symlinks. */
  stat: "files.stat",
  /** The canonical path. */
  realpath: "files.realpath",
  /** Open read-only; with `stat`, also stat the descriptor. */
  open: "files.open",
  /** Up to `length` bytes from `position`; empty means end of file. */
  read: "files.read",
  /** Close a handle; an unknown or closed handle is already closed. */
  close: "files.close",
  /** Whether a path exists, as `existsSync` answers; never a failure. */
  exists: "files.exists",
  /** A path's kind and full-precision identity, following links or not. */
  inspect: "files.inspect",
  /** A directory's entries in `readdir` order, each with its own type. */
  readdir: "files.readdir",
  /** A symlink's target text, as `readlink` decodes it. */
  readlink: "files.readlink",
} as const;

/** The error code of a handle the Worker does not hold. */
export const UNKNOWN_HANDLE = "unknown_handle";

/** A file on a Worker: the Worker id, and the path there. */
export interface WorkerFileLocation {
  workerId: string;
  path: string;
}

/** A handle a Worker issued on one connection. */
interface WorkerFileHandleRef {
  workerId: string;
  handle: number;
}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

/** A filesystem failure the Worker answered: the call ran there and failed. */
export class AnsweredFileFailure extends Error {}

/** An answer that is not what its method answers: no answer was obtained. */
export class MalformedWorkerAnswerError extends Error {}

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

export function encodeLocation(location: WorkerFileLocation): Payload {
  return {
    json: { location: { workerId: location.workerId, path: location.path } },
  };
}

function decodeLocationOf(json: unknown): WorkerFileLocation {
  const location = record(record(json)?.location);
  if (
    typeof location?.workerId !== "string" ||
    typeof location.path !== "string"
  )
    invalid("file location");
  return { workerId: location.workerId, path: location.path };
}

export function decodeLocation(payload: Payload): WorkerFileLocation {
  return decodeLocationOf(payload.json);
}

export function encodeOpen(
  location: WorkerFileLocation,
  stat: boolean,
): Payload {
  return {
    json: {
      location: { workerId: location.workerId, path: location.path },
      stat,
    },
  };
}

export function decodeOpen(payload: Payload): {
  location: WorkerFileLocation;
  stat: boolean;
} {
  const location = decodeLocationOf(payload.json);
  const stat = record(payload.json)?.stat;
  if (typeof stat !== "boolean") invalid("stat choice");
  return { location, stat };
}

export function encodeInspect(
  location: WorkerFileLocation,
  follow: boolean,
): Payload {
  return {
    json: {
      location: { workerId: location.workerId, path: location.path },
      follow,
    },
  };
}

export function decodeInspect(payload: Payload): {
  location: WorkerFileLocation;
  follow: boolean;
} {
  const location = decodeLocationOf(payload.json);
  const follow = record(payload.json)?.follow;
  if (typeof follow !== "boolean") invalid("follow choice");
  return { location, follow };
}

export function encodeRead(
  ref: WorkerFileHandleRef,
  position: number,
  length: number,
): Payload {
  return {
    json: { workerId: ref.workerId, handle: ref.handle, position, length },
  };
}

export function decodeRead(payload: Payload): WorkerFileHandleRef & {
  position: number;
  length: number;
} {
  const ref = decodeHandle(payload);
  const json = record(payload.json)!;
  if (!isCount(json.position)) invalid("read position");
  if (!isCount(json.length)) invalid("read length");
  return { ...ref, position: json.position, length: json.length };
}

export function encodeHandle(ref: WorkerFileHandleRef): Payload {
  return { json: { workerId: ref.workerId, handle: ref.handle } };
}

export function decodeHandle(payload: Payload): WorkerFileHandleRef {
  const json = record(payload.json);
  if (typeof json?.workerId !== "string") invalid("Worker id");
  if (!isCount(json.handle) || json.handle === 0) invalid("file handle");
  return { workerId: json.workerId, handle: json.handle };
}

// --- Answers --------------------------------------------------------------

/** A filesystem failure as an answer: its code, and its message as text. */
export function encodeFailure(
  error: unknown,
  extra: Record<string, unknown> = {},
): Payload {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return {
    json: {
      error: { code: typeof code === "string" ? code : null, ...extra },
    },
    text: {
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/** The failure an answer carries, rebuilt; undefined when it carries none. */
function decodeFailure(payload: Payload): AnsweredFileFailure | undefined {
  const failure = record(record(payload.json)?.error);
  if (!failure) return undefined;
  const message = payload.text?.message;
  if (
    message === undefined ||
    (typeof failure.code !== "string" && failure.code !== null)
  )
    malformed("file failure");
  const error = new AnsweredFileFailure(message);
  return failure.code === null
    ? error
    : Object.assign(error, { code: failure.code });
}

/** The answer's value, or its rebuilt failure thrown. */
export function settled(payload: Payload): Record<string, unknown> {
  const failure = decodeFailure(payload);
  if (failure) throw failure;
  const json = record(payload.json);
  if (!json) malformed("file answer");
  return json;
}

export function encodeStat(stat: FileStat): Payload {
  return { json: { stat } };
}

function statOf(value: unknown): FileStat {
  const stat = record(value);
  if (
    typeof stat?.isFile !== "boolean" ||
    typeof stat.isDirectory !== "boolean" ||
    typeof stat.size !== "number" ||
    typeof stat.mtimeMs !== "number" ||
    typeof stat.dev !== "number" ||
    typeof stat.ino !== "number"
  )
    malformed("file stat");
  return {
    isFile: stat.isFile,
    isDirectory: stat.isDirectory,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

export function decodeStat(payload: Payload): FileStat {
  return statOf(settled(payload).stat);
}

export function encodeRealpath(path: string): Payload {
  return { json: { path } };
}

export function decodeRealpath(payload: Payload): string {
  const { path } = settled(payload);
  if (typeof path !== "string") malformed("canonical path");
  return path;
}

export function encodeExists(exists: boolean): Payload {
  return { json: { exists } };
}

/** `files.exists` never answers a failure: one is a malformed answer. */
export function decodeExists(payload: Payload): boolean {
  const exists = record(payload.json)?.exists;
  if (typeof exists !== "boolean") malformed("existence answer");
  return exists;
}

export function encodeInspection(inspection: PathInspection): Payload {
  return { json: { inspection } };
}

const INSPECTED_KINDS: readonly string[] = [
  "file",
  "directory",
  "symlink",
  "other",
] satisfies PathInspection["kind"][];

const isDecimal = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);

/**
 * Node's `bigint` stat holds every field in 64 signed bits: a time before 1970
 * is negative, and so is a `dev` or `ino` at or above 2^63. Only `size` is
 * never negative.
 */
const isSignedDecimal = (value: unknown): value is string =>
  typeof value === "string" && /^(0|-?[1-9]\d*)$/.test(value);

/**
 * `mode` is optional (protocol 1.3): an inspection without it decodes, and
 * one whose `mode` is not an unsigned decimal is malformed.
 */
export function decodeInspection(payload: Payload): PathInspection {
  const inspection = record(settled(payload).inspection);
  if (
    typeof inspection?.kind !== "string" ||
    !INSPECTED_KINDS.includes(inspection.kind) ||
    !isSignedDecimal(inspection.dev) ||
    !isSignedDecimal(inspection.ino) ||
    !isDecimal(inspection.size) ||
    !isSignedDecimal(inspection.mtimeNs) ||
    (inspection.mode !== undefined && !isDecimal(inspection.mode))
  )
    malformed("path inspection");
  const decoded: PathInspection = {
    kind: inspection.kind as PathInspection["kind"],
    dev: inspection.dev,
    ino: inspection.ino,
    size: inspection.size,
    mtimeNs: inspection.mtimeNs,
  };
  return inspection.mode === undefined
    ? decoded
    : { ...decoded, mode: inspection.mode };
}

export function encodeLinkTarget(target: string): Payload {
  return { json: { target } };
}

export function decodeLinkTarget(payload: Payload): string {
  const { target } = settled(payload);
  if (typeof target !== "string") malformed("link target");
  return target;
}

export function encodeEntries(entries: DirectoryEntry[]): Payload {
  return { json: { entries } };
}

export function decodeEntries(payload: Payload): DirectoryEntry[] {
  const { entries } = settled(payload);
  if (!Array.isArray(entries)) malformed("directory listing");
  return entries.map((value: unknown) => {
    const entry = record(value);
    if (typeof entry?.name !== "string" || typeof entry.directory !== "boolean")
      malformed("directory entry");
    return { name: entry.name, directory: entry.directory };
  });
}

/** What `files.open` answers: a handle, or the step that failed. */
export type WorkerOpenOutcome =
  | { handle: number; stat?: FileStat }
  | { error: Error; phase: "open" | "stat" };

export function encodeOpened(handle: number, stat?: FileStat): Payload {
  return { json: { opened: stat ? { handle, stat } : { handle } } };
}

export function decodeOpenOutcome(payload: Payload): WorkerOpenOutcome {
  const failure = decodeFailure(payload);
  if (failure) {
    const phase = record(record(payload.json)?.error)?.phase;
    if (phase !== "open" && phase !== "stat") malformed("open failure");
    return { error: failure, phase };
  }
  const opened = record(record(payload.json)?.opened);
  if (!opened || !isCount(opened.handle) || opened.handle === 0)
    malformed("opened file");
  return opened.stat === undefined
    ? { handle: opened.handle }
    : { handle: opened.handle, stat: statOf(opened.stat) };
}

export function encodeBytes(bytes: Uint8Array): Payload {
  return { bytes: { data: bytes } };
}

export function decodeBytes(payload: Payload): Uint8Array {
  const failure = decodeFailure(payload);
  if (failure) throw failure;
  const data = payload.bytes?.data;
  if (!data) malformed("file bytes");
  return data;
}

export function decodeClosed(payload: Payload): void {
  settled(payload);
}
