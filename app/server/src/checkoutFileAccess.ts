/**
 * Every filesystem read the checkout surfaces make of a checkout, on the side
 * where that checkout's git runs (`docs/workers.md`, "Checkout files").
 *
 * Each function takes the checkout root, and the root alone picks the side,
 * through the same placement as checkout git (`placeGitCwd`): the server never
 * resolves a path it reads to choose where to read it. A root kept on the
 * server reads through `fileReads.ts`; any other goes to its Worker through
 * the file methods (`workers/fileClient.ts`). When the Worker fails, the read
 * fails: there is no local fallback.
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
import { placeGitCwd } from "./workers/placement.ts";

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
 * One local primitive call; only a native rejection is a filesystem failure.
 * Also the rule for the server's own repositories' reads (`serverRepoGit.ts`).
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

/** Runs one primitive for `path` on the side of the checkout at `root`. */
async function placed<T>(
  root: string,
  path: string,
  onServer: (path: string) => Promise<T>,
  onWorker: (location: WorkerFileLocation) => Promise<T>,
): Promise<T> {
  const location = placeGitCwd(root);
  return location
    ? remote(() => onWorker({ workerId: location.workerId, path }))
    : readLocally(() => onServer(path));
}

/** Whether `path` exists, as `existsSync` answers it. */
export function checkoutPathExists(
  root: string,
  path: string,
): Promise<boolean> {
  return placed(root, path, existsPath, existsOnWorker);
}

/** With `mode`, the answer carries the mode bits; a Worker must send them. */
export function inspectCheckoutPath(
  root: string,
  path: string,
  options: { follow: boolean; mode?: boolean },
): Promise<PathInspection> {
  return placed(
    root,
    path,
    (path) => inspectPath(path, options.follow),
    (location) =>
      inspectOnWorker(location, options.follow, {
        mode: options.mode === true,
      }),
  );
}

/** A symlink's target text, as `readlink` decodes it. */
export function readCheckoutLink(root: string, path: string): Promise<string> {
  return placed(root, path, readlinkPath, readlinkOnWorker);
}

export function readCheckoutDir(
  root: string,
  dir: string,
): Promise<DirectoryEntry[]> {
  return placed(root, dir, readDirectory, readdirOnWorker);
}

export function realpathInCheckout(
  root: string,
  path: string,
): Promise<string> {
  return placed(root, path, realpathFile, realpathOnWorker);
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
export async function containedRealPath(
  root: string,
  relPath: string,
): Promise<string> {
  const abs = checkLexicalPath(root, relPath);
  let real: string;
  try {
    real = await realpathInCheckout(root, abs);
  } catch (error) {
    if (checkoutFailureOf(error) !== "filesystem") throw error;
    return abs;
  }
  let realRoot: string;
  try {
    realRoot = await realpathInCheckout(root, root);
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
export async function readCheckoutFile(
  root: string,
  path: string,
  limit?: number,
): Promise<Buffer> {
  const armed = readThrow;
  readThrow = undefined;
  const location = placeGitCwd(root);
  const guard = location ? remote : readLocally;
  const outcome: FileOpenOutcome<ReadableFile> = location
    ? await remote(() =>
        openOnWorker({ workerId: location.workerId, path }, false),
      )
    : await openFile(path, { stat: false }, (opened) => opened);
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

// --- Test seams -----------------------------------------------------------

let readThrow: { error: unknown; at: "read" | "close" } | undefined;

/**
 * Test seam: the next {@link readCheckoutFile} throws `error` from its own
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
