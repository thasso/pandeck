/**
 * A `SessionStore` rooted at ONE credential profile's Claude config directory.
 *
 * Interactive queries reach a profile's transcripts through the environment:
 * `claudeProfileEnvironment` sets `CLAUDE_CONFIG_DIR` on the subprocess, so a
 * named profile's sessions live under
 * `DATA_DIR/credential-profiles/<id>/claude/projects/<projectKey>/`. The SDK's
 * session MUTATION helpers (`forkSession`, `deleteSession`) take no env: they
 * run in this process and resolve the local root from OUR environment, which is
 * the default profile's. Their `dir` option only picks the project key WITHIN a
 * root, so it cannot reach another profile's transcripts.
 *
 * Mutating `process.env.CLAUDE_CONFIG_DIR` around each call would be the obvious
 * shortcut and is not safe here: sessions on different profiles run
 * concurrently, so a global flip races every other in-flight call. Instead we
 * hand the SDK an explicit store bound to one profile's root, which is the
 * supported override and stays correct under concurrency.
 *
 * The on-disk layout mirrors the CLI's exactly — `<root>/projects/<projectKey>/
 * <sessionId>.jsonl`, one JSON object per line — because the CLI itself reads
 * and writes these files whenever the session next runs.
 */
import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  claudeConfigDir,
  DEFAULT_CLAUDE_PROFILE_ID,
} from "../credentialProfiles.ts";

/** The SDK's `SessionKey`, minimally typed (we only key on these fields). */
interface SessionKeyLike {
  projectKey: string;
  sessionId: string;
  /** Set for subagent transcripts; undefined is the main one. */
  subpath?: string;
}

type StoreEntry = Record<string, unknown>;

function transcriptPath(root: string, key: SessionKeyLike): string {
  const base = join(root, "projects", key.projectKey);
  return key.subpath
    ? join(base, key.sessionId, `${key.subpath}.jsonl`)
    : join(base, `${key.sessionId}.jsonl`);
}

function readEntries(path: string): StoreEntry[] | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const out: StoreEntry[] = [];
  // Tolerate a torn final line: the CLI may be mid-append.
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as StoreEntry);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The store for `profileId`'s transcripts. Only the operations the session
 * mutations actually use are implemented: `load` + `append` (fork) and `delete`.
 * The listing operations stay unimplemented on purpose — PA never lists native
 * sessions, and the SDK treats a missing optional member as "unsupported"
 * rather than as an empty result, which is the honest answer here.
 *
 * ASYMMETRY worth knowing: without `listSubkeys` the SDK materializes only the
 * MAIN transcript, so a fork copies the conversation but not the session's
 * subagent/sidechain transcripts, while `delete` DOES remove the whole subagent
 * directory. Deleting more than we copy is the safe direction — a child never
 * inherits subagent history it cannot resume, and a deleted session leaves
 * nothing behind — but implement `listSubkeys` here if forks ever need it.
 */
export function claudeProfileSessionStore(profileId: string | undefined) {
  const root = claudeConfigDir(profileId ?? DEFAULT_CLAUDE_PROFILE_ID);
  return {
    root,
    async load(key: SessionKeyLike): Promise<StoreEntry[] | null> {
      return readEntries(transcriptPath(root, key));
    },
    async append(key: SessionKeyLike, entries: StoreEntry[]): Promise<void> {
      const path = transcriptPath(root, key);
      mkdirSync(dirname(path), { recursive: true });
      const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
      if (!body) return;
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      const needsNewline = existing.length > 0 && !existing.endsWith("\n");
      writeFileSync(path, `${needsNewline ? "\n" : ""}${body}\n`, {
        flag: existing ? "a" : "w",
      });
    },
    async delete(key: SessionKeyLike): Promise<void> {
      // The main transcript AND the session's subagent directory, matching what
      // the SDK's own local deletion removes.
      rmSync(transcriptPath(root, key), { force: true });
      rmSync(join(root, "projects", key.projectKey, key.sessionId), {
        recursive: true,
        force: true,
      });
    },
  };
}

/** How far back from a transcript's end a saved `cost-state` is looked for. */
const COST_STATE_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const COST_STATE_SCAN_CHUNK_BYTES = 256 * 1024;
/** Far beyond one `cost-state` entry (a few hundred bytes per model). */
const COST_STATE_LINE_MAX_BYTES = 256 * 1024;

/**
 * The last valid `cost-state` entry `providerSessionId`'s transcript saved, if
 * any. A resumed or forked CLI continues its running totals from it, so the
 * first `result` of that query already carries what the entry holds. The
 * entry is the CLI's own record and its shape is not part of the SDK's types;
 * callers treat it as a hint to verify, never as billing truth. The project
 * key is found by looking, not by re-deriving the CLI's path sanitizing.
 *
 * Read like the CLI reads it: backwards from the end, where it is appended at
 * each exit, in bounded chunks and at most {@link COST_STATE_SCAN_MAX_BYTES}.
 * Only a regular file is read — opened non-blocking and without following a
 * link, so a FIFO or a link planted under the name can neither hang nor
 * redirect the turn that is starting.
 */
export async function lastSavedCostState(
  profileId: string | undefined,
  providerSessionId: string,
): Promise<StoreEntry | undefined> {
  const projects = join(
    claudeConfigDir(profileId ?? DEFAULT_CLAUDE_PROFILE_ID),
    "projects",
  );
  let keys: string[];
  try {
    keys = await readdir(projects);
  } catch {
    return undefined;
  }
  const name = `${providerSessionId}.jsonl`;
  for (const projectKey of keys) {
    let handle: FileHandle;
    try {
      handle = await open(
        join(projects, projectKey, name),
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
    } catch {
      continue;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return undefined;
      return await scanBackForCostState(handle, stat.size, providerSessionId);
    } finally {
      await handle.close();
    }
  }
  return undefined;
}

async function scanBackForCostState(
  handle: FileHandle,
  size: number,
  providerSessionId: string,
): Promise<StoreEntry | undefined> {
  // Lines are cut on newline BYTES and decoded whole, so a chunk boundary
  // inside a multi-byte character never corrupts the line holding it. Each
  // chunk is searched natively and only once; the line still open to its
  // left is carried as pieces, and dropped once it outgrows any `cost-state`
  // entry, so a multi-megabyte tool result costs one pass, not one per chunk.
  let end = size;
  let open: Buffer[] = [];
  let openBytes = 0;
  const carry = (piece: Buffer): void => {
    if (openBytes > COST_STATE_LINE_MAX_BYTES) return;
    open.unshift(piece);
    openBytes += piece.length;
  };
  const closeOpenLine = (head: Buffer): StoreEntry | undefined => {
    const entry =
      openBytes + head.length > COST_STATE_LINE_MAX_BYTES
        ? undefined
        : costStateLine(Buffer.concat([head, ...open]), providerSessionId);
    open = [];
    openBytes = 0;
    return entry;
  };
  while (end > 0 && size - end < COST_STATE_SCAN_MAX_BYTES) {
    const start = Math.max(0, end - COST_STATE_SCAN_CHUNK_BYTES);
    const chunk = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
    const block = chunk.subarray(0, bytesRead);
    end = start;
    let lineEnd = block.length;
    let newline = lineEnd > 0 ? block.lastIndexOf(0x0a, lineEnd - 1) : -1;
    if (newline !== -1) {
      const entry = closeOpenLine(block.subarray(newline + 1, lineEnd));
      if (entry) return entry;
      lineEnd = newline;
      newline = lineEnd > 0 ? block.lastIndexOf(0x0a, lineEnd - 1) : -1;
    }
    while (newline !== -1) {
      const line = block.subarray(newline + 1, lineEnd);
      if (line.length <= COST_STATE_LINE_MAX_BYTES) {
        const entry = costStateLine(line, providerSessionId);
        if (entry) return entry;
      }
      lineEnd = newline;
      newline = lineEnd > 0 ? block.lastIndexOf(0x0a, lineEnd - 1) : -1;
    }
    carry(block.subarray(0, lineEnd));
  }
  return end === 0 ? closeOpenLine(Buffer.alloc(0)) : undefined;
}

/** A transcript line that is this session's well-formed `cost-state`, if so. */
function costStateLine(
  line: Buffer,
  providerSessionId: string,
): StoreEntry | undefined {
  if (!line.includes('"cost-state"')) return undefined;
  let entry: StoreEntry;
  try {
    entry = JSON.parse(line.toString("utf8")) as StoreEntry;
  } catch {
    // A torn final line: the CLI may be mid-append.
    return undefined;
  }
  if (entry.type !== "cost-state") return undefined;
  if (entry.sessionId !== providerSessionId) return undefined;
  if (!isCount(entry.totalCostUSD)) return undefined;
  const models = entry.modelUsage;
  if (!models || typeof models !== "object") return undefined;
  for (const usage of Object.values(models as Record<string, unknown>)) {
    if (!usage || typeof usage !== "object") return undefined;
    for (const value of Object.values(usage as Record<string, unknown>))
      if (typeof value === "number" && !isCount(value)) return undefined;
  }
  return entry;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
