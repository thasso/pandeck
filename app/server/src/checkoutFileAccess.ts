/**
 * Every filesystem read the checkout surfaces and the checkout workflows
 * (commit, merge, sync, fetch, rebase repair, triage) make of a checkout, on
 * the side where that checkout's git runs (`docs/workers.md`, "Checkout
 * files").
 *
 * {@link checkoutFilesOn} reads on a given side: the modules that can hold
 * the Knowledge Base row pass the row's typed side (`checkoutSideOf`). The
 * root-taking functions below are the default Worker's, like the string git
 * executors: no path chooses a side, and the server never resolves a path it
 * reads to choose where to read it. The server side reads through
 * `fileReads.ts`; a Worker side goes to its Worker through the file methods
 * (`workers/fileClient.ts`). When the Worker fails, the read fails: there is
 * no local fallback.
 *
 * Callers map errors by where they came from, through
 * {@link checkoutFailureOf}, and by nothing else:
 *
 * - `"worker"`: no answer was obtained (branded by the client). Never a
 *   filesystem answer.
 * - `"filesystem"`: the filesystem call ran and failed. Only established
 *   origins are marked: a failure the Worker answered, an open's failure
 *   outcome, and a local primitive's rejection carrying a string `code` and a
 *   numeric `errno`, as a native one does.
 * - `"verdict"`: this module's own containment verdict, `Invalid file path.`.
 * - `undefined`: anything else, which every caller rethrows.
 */
import { isAbsolute, join, relative, sep } from "node:path";
import {
  existsPath,
  inspectPath,
  openFile,
  readDirectory,
  readlinkPath,
  realpathFile,
  type DirectoryEntry,
  type FileOpenOutcome,
  type PathInspection,
} from "./fileReads.ts";
import {
  AnsweredFileFailure,
  type WorkerFileLocation,
} from "./workerProtocol/fileMethods.ts";
import {
  existsOnWorker,
  inspectOnWorker,
  isWorkerFailure,
  openOnWorker,
  readdirOnWorker,
  readlinkOnWorker,
  realpathOnWorker,
} from "./workers/fileClient.ts";
import {
  DEFAULT_WORKER_SIDE,
  checkoutSideKey,
  type CheckoutSide,
} from "./workers/placement.ts";

/** The server's own verdict on a checkout path: it lies outside the root. */
export class CheckoutPathVerdict extends Error {
  constructor() {
    super("Invalid file path.");
  }
}

const filesystemFailures = new WeakSet<object>();

/** Where a checkout read's error came from; undefined for anything else. */
export function checkoutFailureOf(
  error: unknown,
): "worker" | "filesystem" | "verdict" | undefined {
  if (isWorkerFailure(error)) return "worker";
  if (error instanceof CheckoutPathVerdict) return "verdict";
  if (typeof error === "object" && error !== null)
    if (filesystemFailures.has(error)) return "filesystem";
  return undefined;
}

function filesystemFailure(error: Error): Error {
  filesystemFailures.add(error);
  return error;
}

/** A native failure: a string `code` and a numeric `errno`. */
function isNativeFailure(error: unknown): error is Error {
  const native = error as { code?: unknown; errno?: unknown } | null;
  return (
    typeof native === "object" &&
    native !== null &&
    typeof native.code === "string" &&
    typeof native.errno === "number"
  );
}

/**
 * One local primitive call; only a native rejection is a filesystem failure,
 * so a server-side read never yields a `"worker"` failure. The server side's
 * rule (the Knowledge Base row), and the server's own repositories' reads
 * (`serverRepoGit.ts`).
 */
export async function readLocally<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isNativeFailure(error)) filesystemFailure(error);
    throw error;
  }
}

/** One Worker call; only a failure the Worker answered is a filesystem one. */
async function remote<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AnsweredFileFailure) filesystemFailure(error);
    throw error;
  }
}

/** Runs one primitive for `path` on `side`. */
async function onSide<T>(
  side: CheckoutSide,
  path: string,
  onServer: (path: string) => Promise<T>,
  onWorker: (location: WorkerFileLocation) => Promise<T>,
): Promise<T> {
  return side === "server"
    ? readLocally(() => onServer(path))
    : remote(() => onWorker({ workerId: side.workerId, path }));
}

function existsOn(side: CheckoutSide, path: string): Promise<boolean> {
  return onSide(side, path, existsPath, existsOnWorker);
}

function inspectOn(
  side: CheckoutSide,
  path: string,
  options: { follow: boolean; mode?: boolean },
): Promise<PathInspection> {
  return onSide(
    side,
    path,
    (path) => inspectPath(path, options.follow),
    (location) =>
      inspectOnWorker(location, options.follow, {
        mode: options.mode === true,
      }),
  );
}

function readLinkOn(side: CheckoutSide, path: string): Promise<string> {
  return onSide(side, path, readlinkPath, readlinkOnWorker);
}

function readDirOn(side: CheckoutSide, dir: string): Promise<DirectoryEntry[]> {
  return onSide(side, dir, readDirectory, readdirOnWorker);
}

function realpathOn(side: CheckoutSide, path: string): Promise<string> {
  return onSide(side, path, realpathFile, realpathOnWorker);
}

/** Whether `path` exists, as `existsSync` answers it. */
export function checkoutPathExists(
  root: string,
  path: string,
): Promise<boolean> {
  return onDefaultWorker().pathExists(root, path);
}

/** With `mode`, the answer carries the mode bits; a Worker must send them. */
export function inspectCheckoutPath(
  root: string,
  path: string,
  options: { follow: boolean; mode?: boolean },
): Promise<PathInspection> {
  return onDefaultWorker().inspect(root, path, options);
}

/** A symlink's target text, as `readlink` decodes it. */
export function readCheckoutLink(root: string, path: string): Promise<string> {
  return onDefaultWorker().readLink(root, path);
}

export function readCheckoutDir(
  root: string,
  dir: string,
): Promise<DirectoryEntry[]> {
  return onDefaultWorker().readDir(root, dir);
}

export function realpathInCheckout(
  root: string,
  path: string,
): Promise<string> {
  return onDefaultWorker().realpath(root, path);
}

/**
 * `relPath` joined to `root`, lexically only; a verdict when it is empty,
 * absolute, or escapes the root.
 */
export function checkLexicalPath(root: string, relPath: string): string {
  if (!relPath || isAbsolute(relPath)) throw new CheckoutPathVerdict();
  const abs = join(root, relPath);
  const back = relative(root, abs);
  if (!back || back.startsWith("..") || isAbsolute(back))
    throw new CheckoutPathVerdict();
  return abs;
}

/**
 * Resolve a repo-relative path for READING file content.
 * {@link checkLexicalPath} is lexical only; file reads follow symlinks, so a
 * repo containing `secret -> /etc/passwd` would otherwise leak content outside
 * the worktree. The resolved real path must stay inside the (real) worktree
 * root. Each realpath falls back only on a filesystem failure: a missing file
 * answers its lexical path (the read then fails naturally), an unresolvable
 * root itself.
 */
export function containedRealPath(
  root: string,
  relPath: string,
): Promise<string> {
  return onDefaultWorker().containedRealPath(root, relPath);
}

async function containedRealPathOn(
  side: CheckoutSide,
  root: string,
  relPath: string,
): Promise<string> {
  const abs = checkLexicalPath(root, relPath);
  let real: string;
  try {
    real = await realpathOn(side, abs);
  } catch (error) {
    if (checkoutFailureOf(error) !== "filesystem") throw error;
    return abs;
  }
  let realRoot: string;
  try {
    realRoot = await realpathOn(side, root);
  } catch (error) {
    if (checkoutFailureOf(error) !== "filesystem") throw error;
    realRoot = root;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep))
    throw new CheckoutPathVerdict();
  return real;
}

/** One uncapped read request; a shorter answer is the end of the file. */
const READ_REQUEST_BYTES = 8 * 1024 * 1024;

interface ReadableFile {
  read(position: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * The bytes of `path` in the checkout at `root`, as production's `readFile`
 * reads them: no descriptor stat and no size limit, reading until a read
 * comes back short. With `limit`, one read of at most `limit` bytes; pass a
 * cap + 1 to tell a file over the cap from one at it.
 *
 * The file is always closed. When the read and the close both fail, the
 * error thrown is the first of: a Worker failure, an unclassified error, the
 * read's filesystem failure, the close's.
 */
export function readCheckoutFile(
  root: string,
  path: string,
  limit?: number,
): Promise<Buffer> {
  return onDefaultWorker().readFile(root, path, limit);
}

async function readFileOn(
  side: CheckoutSide,
  path: string,
  limit?: number,
): Promise<Buffer> {
  const armed = readThrow;
  readThrow = undefined;
  const guard = side === "server" ? readLocally : remote;
  const outcome: FileOpenOutcome<ReadableFile> =
    side === "server"
      ? await openFile(path, { stat: false }, (opened) => opened)
      : await remote(() =>
          openOnWorker({ workerId: side.workerId, path }, false),
        );
  if ("error" in outcome) throw filesystemFailure(outcome.error);
  const { file } = outcome;
  let bytes: Buffer | undefined;
  let readFailure: { error: unknown } | undefined;
  try {
    bytes = await readFrom(file, limit, guard);
    if (armed?.at === "read") throw armed.error;
  } catch (error) {
    readFailure = { error };
  }
  let closeFailure: { error: unknown } | undefined;
  try {
    await guard(() => file.close());
  } catch (error) {
    closeFailure = { error };
  }
  if (armed?.at === "close") closeFailure = { error: armed.error };
  // The read's before the close's within each rank.
  const failures = [readFailure, closeFailure].filter((failure) => !!failure);
  const thrown =
    failures.find(({ error }) => checkoutFailureOf(error) === "worker") ??
    failures.find(({ error }) => checkoutFailureOf(error) === undefined) ??
    failures[0];
  if (thrown) throw thrown.error;
  return bytes!;
}

async function readFrom(
  file: ReadableFile,
  limit: number | undefined,
  guard: <T>(call: () => Promise<T>) => Promise<T>,
): Promise<Buffer> {
  if (limit !== undefined)
    return asBuffer(await guard(() => file.read(0, limit)));
  const pieces: Uint8Array[] = [];
  let position = 0;
  for (;;) {
    const at = position;
    const piece = await guard(() => file.read(at, READ_REQUEST_BYTES));
    pieces.push(piece);
    position += piece.byteLength;
    if (piece.byteLength < READ_REQUEST_BYTES) break;
  }
  return pieces.length === 1 ? asBuffer(pieces[0]!) : Buffer.concat(pieces);
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The reads of the checkouts on one side, each taking `(root, path, …)` as the
 * root-taking functions above do; the side, not the root, says where they run.
 */
export interface CheckoutFiles {
  pathExists(root: string, path: string): Promise<boolean>;
  inspect(
    root: string,
    path: string,
    options: { follow: boolean; mode?: boolean },
  ): Promise<PathInspection>;
  readLink(root: string, path: string): Promise<string>;
  readDir(root: string, dir: string): Promise<DirectoryEntry[]>;
  realpath(root: string, path: string): Promise<string>;
  containedRealPath(root: string, relPath: string): Promise<string>;
  readFile(root: string, path: string, limit?: number): Promise<Buffer>;
}

const filesBySide = new Map<string, CheckoutFiles>();

/**
 * The default Worker's reads, behind the root-taking functions: a checkout
 * reached by a bare root is never the Knowledge Base row.
 */
function onDefaultWorker(): CheckoutFiles {
  return checkoutFilesOn(DEFAULT_WORKER_SIDE);
}

/** The checkout reads on `side`, one instance per side. */
export function checkoutFilesOn(side: CheckoutSide): CheckoutFiles {
  const key = checkoutSideKey(side);
  let files = filesBySide.get(key);
  if (!files) {
    // A copy: the caller's object is not this instance's to keep.
    const bound: CheckoutSide =
      side === "server" ? "server" : { workerId: side.workerId };
    files = {
      pathExists: (_root, path) => existsOn(bound, path),
      inspect: (_root, path, options) => inspectOn(bound, path, options),
      readLink: (_root, path) => readLinkOn(bound, path),
      readDir: (_root, dir) => readDirOn(bound, dir),
      realpath: (_root, path) => realpathOn(bound, path),
      containedRealPath: (root, relPath) =>
        containedRealPathOn(bound, root, relPath),
      readFile: (_root, path, limit) => readFileOn(bound, path, limit),
    };
    filesBySide.set(key, files);
  }
  return files;
}

// --- Test seams -----------------------------------------------------------

let readThrow: { error: unknown; at: "read" | "close" } | undefined;

/**
 * Test seam: the next whole-file checkout read ({@link readCheckoutFile} or
 * a side's `readFile`) throws `error` from its own
 * logic — at `read`, once the read primitive answered, before the bytes are
 * returned; at `close`, as the close step's error once the primitive close
 * settled. One-shot, taken by that call even when it never reaches the point.
 */
export function throwInCheckoutReadForTests(
  error: unknown,
  options: { at: "read" | "close" },
): void {
  readThrow = { error, at: options.at };
}
