/**
 * One server per DATA_DIR.
 *
 * Several stores keep process-local state about files under `DATA_DIR` — the
 * Claude record log cursors most of all (`claudeSdk/claudeSdkRecords.ts`) — so
 * two servers on one data directory would silently overwrite each other's
 * writes. The server takes the directory's lock before anything touches it
 * (`serverBootLock.ts`) and refuses to start while a live owner holds it.
 * `docs/deployment.md#one-server-per-data-directory` is the contract.
 *
 * The lock is a sequence of GENERATION files, `server.lock.<n>`, and the owner
 * is whoever holds the highest one. A server takes over only by creating the
 * NEXT generation, exclusively (hard-linked from a finished draft, so it is
 * never seen half-written), so two servers racing for one stale lock cannot
 * both win, and nobody ever removes a file another server could still be
 * judging: a generation is deleted only by its successor, or by its own owner
 * on release. Each file records the owner's pid and, where `/proc` exists, the
 * kernel's start time for that pid, so a pid reused by an unrelated process is
 * not mistaken for the owner.
 */
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** Who holds a DATA_DIR. */
export interface ServerInstanceOwner {
  pid: number;
  /** `/proc/<pid>/stat` field 22 (clock ticks after boot), where available. */
  startTime?: string;
  hostname: string;
  acquiredAt: string;
  /**
   * The canonical (`realpath`) directory this lock is for. A lock file copied
   * elsewhere — a backup restored into another directory while its server
   * still runs — names the original, and does not hold the copy.
   */
  dataDir: string;
}

/** A second server tried to start on a DATA_DIR a live one holds. */
export class ServerInstanceLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly owner: ServerInstanceOwner,
  ) {
    super(
      `Another Pandeck server (pid ${owner.pid} on ${owner.hostname}, since ${owner.acquiredAt}) is using this data directory. Stop it first. If you are sure it is gone, delete ${lockPath}.`,
    );
    this.name = "ServerInstanceLockedError";
  }
}

/** The kernel's start time for `pid`, or undefined where it cannot be read. */
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `comm` (field 2) is parenthesized and may contain spaces or parentheses,
    // so the fields are counted from the LAST `)`: field 3 comes right after.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[22 - 3];
  } catch {
    return undefined;
  }
}

function currentOwner(dataDir: string): ServerInstanceOwner {
  const startTime = processStartTime(process.pid);
  return {
    pid: process.pid,
    ...(startTime !== undefined ? { startTime } : {}),
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
    dataDir,
  };
}

/**
 * A lock file's owner, or undefined when it is malformed — which makes it
 * stale. The pid must be a POSITIVE integer: `process.kill(0 | -1, 0)`
 * signals a process group or every process, and would pass for alive forever.
 */
function parseOwner(raw: string): ServerInstanceOwner | undefined {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    value = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const { pid, startTime, hostname, acquiredAt, dataDir } = value;
  const sound =
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    (startTime === undefined ||
      (typeof startTime === "string" && /^\d+$/.test(startTime))) &&
    typeof hostname === "string" &&
    typeof acquiredAt === "string" &&
    typeof dataDir === "string" &&
    dataDir.length > 0;
  return sound ? (value as unknown as ServerInstanceOwner) : undefined;
}

/**
 * Whether the recorded owner still runs. A pid that exists is the owner only
 * when its start time matches too (where both are known); one we may not
 * signal (`EPERM`) exists.
 */
function ownerIsAlive(owner: ServerInstanceOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (owner.startTime === undefined) return true;
  const now = processStartTime(owner.pid);
  return now === undefined || now === owner.startTime;
}

/** A lock file's content, or undefined when it no longer exists. */
function readLock(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

const GENERATION = /^server\.lock\.(\d+)$/;

/** Every generation file in `dataDir`, highest first. */
function generations(dataDir: string): number[] {
  const found: number[] = [];
  for (const name of readdirSync(dataDir)) {
    const match = GENERATION.exec(name);
    if (match) found.push(Number(match[1]));
  }
  return found.sort((a, b) => b - a);
}

const generationPath = (dataDir: string, n: number) =>
  join(dataDir, `server.lock.${n}`);

/** A held lock; `release` removes this owner's own generation file. */
export interface ServerInstanceLock {
  readonly path: string;
  readonly owner: ServerInstanceOwner;
  release(): void;
}

/**
 * Take `dataDir`'s server lock, or throw {@link ServerInstanceLockedError}
 * when a live server holds it.
 */
export function acquireServerInstanceLock(dataDir: string): ServerInstanceLock {
  mkdirSync(dataDir, { recursive: true });
  const owner = currentOwner(realpathSync(dataDir));
  const content = `${JSON.stringify(owner)}\n`;
  const draft = join(dataDir, `server.lock-draft.${owner.pid}.${Date.now()}`);
  writeFileSync(draft, content, { flag: "wx" });
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const [latest = 0, ...older] = generations(dataDir);
      if (latest > 0) {
        const raw = readLock(generationPath(dataDir, latest));
        // Gone meanwhile: its owner released it, or a successor replaced it.
        if (raw === undefined) continue;
        const holder = parseOwner(raw);
        if (holder && holder.dataDir === owner.dataDir && ownerIsAlive(holder))
          throw new ServerInstanceLockedError(
            generationPath(dataDir, latest),
            holder,
          );
        console.warn(
          `[assistant] taking over a stale server lock: ${raw.trim() || "(empty)"}`,
        );
      }
      const path = generationPath(dataDir, latest + 1);
      try {
        linkSync(draft, path);
      } catch (err) {
        // Another server took this generation first: judge it instead.
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      // Superseded generations: no server creates those names again while a
      // higher one exists, so removing them cannot hit anyone's live lock.
      for (const n of [latest, ...older])
        if (n > 0) rmSync(generationPath(dataDir, n), { force: true });
      return {
        path,
        owner,
        // Our generation's name is ours alone for as long as we run: only a
        // successor, which must first have judged us gone, removes it.
        release: () => rmSync(path, { force: true }),
      };
    }
    throw new Error(`Could not take the server lock in ${dataDir}.`);
  } finally {
    rmSync(draft, { force: true });
  }
}
