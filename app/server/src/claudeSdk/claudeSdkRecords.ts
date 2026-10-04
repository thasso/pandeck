/**
 * The on-disk format of a Claude SDK session record under
 * `DATA_DIR/claude-sdk/`. Every read and write of those files goes through
 * here; `docs/claude-session-records.md` is the contract.
 *
 * A record is two files, so a persist costs what changed rather than what the
 * session holds:
 *
 * - `<id>.json` — the METADATA: everything but the timeline, plus the
 *   `entryLog` extent it vouches for. Small, and replaced whole and atomically
 *   (temp file + rename) on every persist.
 * - `<id>.entries.jsonl` — the committed timeline, one entry per line and
 *   APPEND-ONLY, because the session only ever appends to it. Only the first
 *   `entryLog.bytes` bytes count: anything past them is a tail a crash left
 *   between an append and its metadata rename. Reads ignore it, and the next
 *   append cuts it off first.
 *
 * A LEGACY record is a single `<id>.json` carrying `entries` inline. It stays
 * readable as it is and is rewritten into the two-file form by its session's
 * first persist; until the new metadata replaces it, it is still the record.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentType, SessionForkOrigin } from "@assistant/shared";
import { displayMessageCount } from "@assistant/shared/display";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";

/** One Claude-SDK session record, timeline included. */
export interface ClaudeSdkRecord {
  id: string;
  title: string;
  /** Provider session id for SDK `resume`, captured from the last run. */
  providerSessionId?: string;
  /** Committed normalized conversation timeline, including host-command cards. */
  entries: ClientTimelineEntry[];
  /** Set when this session was branched off another one, for the UI back-link. */
  forkOrigin?: SessionForkOrigin;
  /** A fork still carrying its parent's title, until its own first prompt names it. */
  forkAutoRenamePending?: boolean;
  /** Selected model alias (opus/sonnet/haiku). */
  modelId?: string;
  /** Selected thinking level. */
  thinkingLevel?: string;
  /**
   * Build/Plan ({@link import("@assistant/shared").SessionMode}). Unlike
   * model/thinking this moves during a session's life, and the SERVER record is
   * authoritative: a reopened client renders the mode restored from here.
   */
  mode?: string;
  /** Persona/toolset this session applies (assistant | workshop). Defaults workshop. */
  agentType?: AgentType;
  /** Session-specific instructions appended to the persona system prompt. */
  additionalSystemPrompt?: string;
  /** Where the session executes (its worktree path); absent = app CWD. */
  cwd?: string;
  /** Immutable isolated Claude credential profile id. */
  credentialProfileId?: string;
  /**
   * Cumulative token/cost usage + last-known context size, so the context meter
   * keeps its figures across a server restart (history alone can't reconstruct
   * provider-reported usage or cost).
   */
  usage?: ClaudeSdkUsageRecord;
  createdAt: number;
  updatedAt: number;
}

/** Persisted usage figures for a Claude-SDK session (see {@link ClaudeSdkRecord.usage}). */
export interface ClaudeSdkUsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Last-known context-window occupancy (input + cache) in tokens. */
  contextTokens?: number;
  /** Real model context window learned from the provider. */
  contextWindow?: number;
}

/** A record without its timeline: what the metadata file holds. */
export type ClaudeSdkRecordMeta = Omit<ClaudeSdkRecord, "entries">;

/**
 * What the session list and metadata row need from a timeline, kept in the
 * metadata so neither has to read the timeline. Every figure is additive, so an
 * append only counts the entries it adds.
 */
export interface ClaudeSdkEntryFigures {
  /** `entriesToDisplayMessages(entries).length`. */
  messages: number;
  assistantTurns: number;
  /** Assistant entries that carry provider-reported usage. */
  usageTurns: number;
}

/** The durable extent of a timeline log, with its figures. */
interface ClaudeSdkEntryLog extends ClaudeSdkEntryFigures {
  /** Entries (lines) the metadata vouches for. */
  count: number;
  /** Bytes of the log file those entries occupy. */
  bytes: number;
}

/** What the metadata file stores. */
interface StoredMeta extends ClaudeSdkRecordMeta {
  entryLog: ClaudeSdkEntryLog;
}

/**
 * How a loaded record's log may be written next. `append` continues the file
 * after `log` (`tailChecked: false` until the file's size has been checked
 * against it); `rewrite` replaces it whole — a legacy record, or a log with an
 * unreadable line in the middle.
 */
export type ClaudeSdkLogCursor =
  | { kind: "append"; log: ClaudeSdkEntryLog; tailChecked: boolean }
  | { kind: "rewrite" };

function metaPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function logPath(dir: string, id: string): string {
  return join(dir, `${id}.entries.jsonl`);
}

/**
 * An existing record that cannot be read: an I/O error other than a missing
 * file, or metadata that does not parse. It is NEVER treated as absent — a
 * caller that did would start the session empty and its next persist would
 * replace the unreadable transcript for good.
 */
export class ClaudeSdkRecordReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaudeSdkRecordReadError";
  }
}

/** Whether `err` says the file does not exist — the ONLY error that means "absent". */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function unreadable(path: string, err: unknown): ClaudeSdkRecordReadError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return new ClaudeSdkRecordReadError(
    `Cannot read ${path}${code ? ` (${code})` : ""}; leaving it untouched.`,
    { cause: err },
  );
}

/**
 * Whether a record is PRESENT — its metadata file exists, readable or not —
 * without reading it. Never throws: a file that cannot even be stat'ed for a
 * reason other than being missing is present too, so routing still sends the
 * id to this harness, where loading it fails with the real error instead of a
 * fresh session being started over it.
 */
export function claudeSdkRecordPresent(dir: string, id: string): boolean {
  try {
    statSync(metaPath(dir, id));
    return true;
  } catch (err) {
    return !isMissing(err);
  }
}

/** Ids of every record in `dir`, without reading any of them. */
export function claudeSdkRecordIds(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length));
  } catch (err) {
    if (isMissing(err)) return [];
    throw unreadable(dir, err);
  }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEntryLog(value: unknown): value is ClaudeSdkEntryLog {
  if (!isRecordObject(value)) return false;
  return (
    ["count", "bytes", "messages", "assistantTurns", "usageTurns"] as const
  ).every(
    (key) =>
      typeof value[key] === "number" &&
      Number.isSafeInteger(value[key]) &&
      (value[key] as number) >= 0,
  );
}

type ParsedMeta =
  | { kind: "split"; meta: ClaudeSdkRecordMeta; log: ClaudeSdkEntryLog }
  | { kind: "legacy"; record: ClaudeSdkRecord };

/**
 * The metadata file, or undefined when there is none. A file that exists but
 * cannot be read or does not hold a record throws {@link ClaudeSdkRecordReadError}.
 */
function readMetaFile(dir: string, id: string): ParsedMeta | undefined {
  const path = metaPath(dir, id);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw unreadable(path, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw unreadable(path, err);
  }
  if (!isRecordObject(parsed))
    throw new ClaudeSdkRecordReadError(`${path} does not hold a record.`);
  if (Array.isArray(parsed.entries))
    return { kind: "legacy", record: parsed as unknown as ClaudeSdkRecord };
  if (!isEntryLog(parsed.entryLog))
    throw new ClaudeSdkRecordReadError(`${path} has no valid timeline extent.`);
  const { entryLog, ...meta } = parsed as unknown as StoredMeta;
  return { kind: "split", meta, log: entryLog };
}

/** The figures of a timeline, counted in one pass without projecting it. */
export function claudeSdkEntryFigures(
  entries: readonly ClientTimelineEntry[],
): ClaudeSdkEntryFigures {
  let assistantTurns = 0;
  let usageTurns = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.role !== "assistant") continue;
    assistantTurns++;
    if (entry.usage !== undefined) usageTurns++;
  }
  return {
    messages: displayMessageCount(entries),
    assistantTurns,
    usageTurns,
  };
}

/**
 * A record's metadata and timeline figures. The log itself is read only when
 * it is SHORTER than the metadata's extent — a backup copied while the server
 * ran can pair new metadata with an older log — and the figures are then
 * recounted over the entries it still holds. A legacy record has only one
 * file, so it is parsed whole. Throws like {@link readClaudeSdkRecord}.
 */
export function readClaudeSdkRecordMeta(
  dir: string,
  id: string,
): { meta: ClaudeSdkRecordMeta; figures: ClaudeSdkEntryFigures } | undefined {
  const parsed = readMetaFile(dir, id);
  if (!parsed) return undefined;
  if (parsed.kind === "legacy") {
    const { entries, ...meta } = parsed.record;
    return { meta, figures: claudeSdkEntryFigures(entries) };
  }
  const log =
    fileSize(logPath(dir, id)) >= parsed.log.bytes
      ? parsed.log
      : readLog(dir, id, parsed.log).log;
  return { meta: parsed.meta, figures: figuresOf(log) };
}

function figuresOf(log: ClaudeSdkEntryLog): ClaudeSdkEntryFigures {
  return {
    messages: log.messages,
    assistantTurns: log.assistantTurns,
    usageTurns: log.usageTurns,
  };
}

/** A file's size, 0 when it does not exist; any other error throws. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (err) {
    if (isMissing(err)) return 0;
    throw unreadable(path, err);
  }
}

/** The first `bytes` bytes of a file (all of it when omitted), or fewer if it is shorter. */
function readPrefix(path: string, bytes?: number): Buffer {
  if (bytes === undefined) return readFileSync(path);
  const buffer = Buffer.allocUnsafe(bytes);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < bytes) {
      const n = readSync(fd, buffer, read, bytes - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Split a log buffer into its complete lines, in BYTES: the extent is a byte
 * count, and UTF-8 never puts a newline byte inside a multi-byte character. A
 * last line without its newline was cut short and is not returned.
 */
function completeLines(buffer: Buffer): Array<{ text: string; end: number }> {
  const lines: Array<{ text: string; end: number }> = [];
  let start = 0;
  for (;;) {
    const newline = buffer.indexOf(0x0a, start);
    if (newline === -1) return lines;
    lines.push({
      text: buffer.toString("utf8", start, newline),
      end: newline + 1,
    });
    start = newline + 1;
  }
}

/**
 * Parse a log up to its vouched extent. The result's `log` is the vouched
 * extent when the log holds all of it, and otherwise the extent of what it
 * does hold, with its figures recounted: a log cut short (a torn tail, a backup
 * of an older log) is salvaged entry by entry, never dropped. `clean` is false
 * when a complete line did not parse; it is skipped, so the entries are no
 * longer a byte prefix of the file and the log must be rewritten.
 */
function readLog(
  dir: string,
  id: string,
  vouched: ClaudeSdkEntryLog,
): { entries: ClientTimelineEntry[]; log: ClaudeSdkEntryLog; clean: boolean } {
  // A MISSING log is salvaged as empty; one that exists but cannot be read
  // fails the load, never passes for an empty transcript.
  const path = logPath(dir, id);
  let buffer: Buffer;
  try {
    buffer = readPrefix(path, vouched.bytes);
  } catch (err) {
    if (!isMissing(err)) throw unreadable(path, err);
    buffer = Buffer.alloc(0);
  }
  const entries: ClientTimelineEntry[] = [];
  let consumed = 0;
  let clean = true;
  for (const line of completeLines(buffer)) {
    try {
      entries.push(JSON.parse(line.text) as ClientTimelineEntry);
    } catch {
      clean = false;
    }
    consumed = line.end;
  }
  if (clean && entries.length === vouched.count && consumed === vouched.bytes)
    return { entries, log: vouched, clean };
  return {
    entries,
    log: {
      ...claudeSdkEntryFigures(entries),
      count: entries.length,
      bytes: consumed,
    },
    clean,
  };
}

/**
 * A whole record, timeline included, with the cursor its next write continues
 * from. Reading never changes a file. A log that holds less than its metadata
 * vouches for loads with every complete entry it has, and the next write
 * continues from there (or rewrites it, when a line in the middle was bad).
 * Undefined only when there is no record; a record that exists but cannot be
 * read throws {@link ClaudeSdkRecordReadError}.
 */
export function readClaudeSdkRecord(
  dir: string,
  id: string,
): { record: ClaudeSdkRecord; cursor: ClaudeSdkLogCursor } | undefined {
  const parsed = readMetaFile(dir, id);
  if (!parsed) return undefined;
  if (parsed.kind === "legacy")
    return { record: parsed.record, cursor: { kind: "rewrite" } };
  const { entries, log, clean } = readLog(dir, id, parsed.log);
  if (log !== parsed.log)
    console.warn(
      `[claude-sdk] record ${id}: its log holds ${log.count} of the ${parsed.log.count} entries its metadata vouches for; loading those`,
    );
  return {
    record: { ...parsed.meta, entries },
    cursor: clean
      ? { kind: "append", log, tailChecked: false }
      : { kind: "rewrite" },
  };
}

function serializeEntries(entries: readonly ClientTimelineEntry[]): string {
  let text = "";
  for (const entry of entries) text += `${JSON.stringify(entry)}\n`;
  return text;
}

function replaceFile(path: string, text: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, path);
}

function writeMeta(
  dir: string,
  meta: ClaudeSdkRecordMeta,
  log: ClaudeSdkEntryLog,
): void {
  const stored: StoredMeta = { ...meta, entryLog: log };
  replaceFile(metaPath(dir, meta.id), `${JSON.stringify(stored, null, 2)}\n`);
}

/** Whether every complete line of the log on disk is the matching committed entry. */
function logIsPrefixOf(
  path: string,
  committed: readonly ClientTimelineEntry[],
): boolean {
  let buffer: Buffer;
  try {
    buffer = readPrefix(path);
  } catch (err) {
    // Only a log verified missing holds nothing the session lacks.
    if (isMissing(err)) return true;
    throw unreadable(path, err);
  }
  const lines = completeLines(buffer);
  return (
    lines.length <= committed.length &&
    lines.every((line, i) => line.text === JSON.stringify(committed[i]))
  );
}

/**
 * Whether the bytes of a `size`-byte log past `extent` are a tail no metadata
 * commits, and so may be cut off: the metadata on disk vouches for no more
 * than `extent` (a crash or failed write between an append and its rename), or
 * it vouches for bytes the file does not even hold (a salvaged log, whose last
 * line was cut short). Bytes another writer appended AND published are
 * neither.
 */
function isUncommittedTail(
  dir: string,
  id: string,
  extent: number,
  size: number,
): boolean {
  const onDisk = readMetaFile(dir, id);
  if (onDisk?.kind !== "split") return false;
  return onDisk.log.bytes <= extent || size < onDisk.log.bytes;
}

/**
 * A persist that did not complete. `next` is the cursor the following write
 * must start from (undefined: as for a record never written); `conflict` marks
 * a refusal to overwrite a log that changed outside this writer.
 */
export class ClaudeSdkRecordWriteError extends Error {
  constructor(
    message: string,
    readonly next: ClaudeSdkLogCursor | undefined,
    readonly conflict: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ClaudeSdkRecordWriteError";
  }
}

/**
 * Persist a record, writing only the entries its log does not hold yet.
 *
 * `committed` is the session's whole timeline, which only ever grows; `cursor`
 * says how much of it is already durable. The metadata is renamed into place
 * LAST, so a crash at any point leaves the previous record readable: before
 * the rename the old metadata still vouches only for what it did.
 *
 * Before appending, the log's size must be exactly the cursor's extent. The
 * one expected difference is a longer file on the first write after a load or
 * a failed write (`tailChecked: false`) whose extra bytes no metadata on disk
 * commits: they are cut off. Any other difference means something else wrote
 * the log. It is replaced from memory only when every entry it holds is one the
 * session holds too; otherwise the write is refused, never clobbered.
 *
 * Throws {@link ClaudeSdkRecordWriteError}, whose `next` the caller keeps.
 */
export function writeClaudeSdkRecord(
  dir: string,
  meta: ClaudeSdkRecordMeta,
  committed: readonly ClientTimelineEntry[],
  cursor: ClaudeSdkLogCursor | undefined,
): ClaudeSdkLogCursor {
  const path = logPath(dir, meta.id);
  // What the NEXT write continues from if this one fails part-way. Until a
  // file changes, that is the cursor this write started from: a check that
  // could not read the disk must not turn into a rewrite of it.
  let onFailure = cursor;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let log =
      cursor?.kind === "append" && cursor.log.count <= committed.length
        ? cursor.log
        : undefined;
    if (log && cursor?.kind === "append") {
      const size = fileSize(path);
      if (
        size > log.bytes &&
        !cursor.tailChecked &&
        isUncommittedTail(dir, meta.id, log.bytes, size)
      )
        truncateSync(path, log.bytes);
      else if (size !== log.bytes) {
        if (!logIsPrefixOf(path, committed)) {
          onFailure = cursor;
          throw new ClaudeSdkRecordWriteError(
            `Refusing to persist Claude session ${meta.id}: its timeline log changed on disk outside this writer (expected ${log.bytes} bytes, found ${size}) and holds entries this session does not. Is another server using this DATA_DIR?`,
            cursor,
            true,
          );
        }
        console.warn(
          `[claude-sdk] record ${meta.id}: its timeline log is ${size} bytes, not the ${log.bytes} last written; rewriting it from the session, which holds every entry it has`,
        );
        log = undefined;
      }
    }
    if (!log) {
      onFailure = { kind: "rewrite" };
      const text = serializeEntries(committed);
      replaceFile(path, text);
      const written: ClaudeSdkEntryLog = {
        ...claudeSdkEntryFigures(committed),
        count: committed.length,
        bytes: Buffer.byteLength(text),
      };
      writeMeta(dir, meta, written);
      return { kind: "append", log: written, tailChecked: true };
    }
    // A failed append may leave part of a line past the extent.
    onFailure = { kind: "append", log, tailChecked: false };
    const added = committed.slice(log.count);
    let next = log;
    if (added.length > 0) {
      const text = serializeEntries(added);
      appendFileSync(path, text, "utf8");
      const counts = claudeSdkEntryFigures(added);
      next = {
        count: log.count + added.length,
        bytes: log.bytes + Buffer.byteLength(text),
        messages: log.messages + counts.messages,
        assistantTurns: log.assistantTurns + counts.assistantTurns,
        usageTurns: log.usageTurns + counts.usageTurns,
      };
    }
    writeMeta(dir, meta, next);
    return { kind: "append", log: next, tailChecked: true };
  } catch (err) {
    if (err instanceof ClaudeSdkRecordWriteError) throw err;
    throw new ClaudeSdkRecordWriteError(
      `Could not persist Claude session ${meta.id}: ${(err as Error).message}`,
      onFailure,
      false,
      { cause: err },
    );
  }
}

/** Delete every file of a record, legacy or split. */
export function removeClaudeSdkRecord(dir: string, id: string): void {
  for (const path of [metaPath(dir, id), logPath(dir, id)])
    for (const file of [path, `${path}.tmp`]) rmSync(file, { force: true });
}
