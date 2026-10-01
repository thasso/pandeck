/**
 * Durable persistence for the app-owned log: one append-only JSONL file per
 * session at `DATA_DIR/sessions/<id>/log.jsonl` (session metadata lives in the
 * SQLite `sessionStore`, not alongside the log). Append atomicity comes from a
 * single `appendFileSync` of one `line\n`; restore tolerates a torn final line
 * (parse up to the last complete `\n`).
 *
 * The file opens with a header line `{"v":1,...}` so a future format change is
 * detectable. The header is NOT a log entry; loaders skip it.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { canonicalSessionLogPath } from "../../sessionStorage.ts";
import type { SessionLogEntry } from "./rawEntry.ts";

const LOG_FORMAT_VERSION = 1;

interface LogHeader {
  v: number;
  sessionId: string;
  createdAt: string;
}

/**
 * Read size per step when walking a log backwards for its newest run marker.
 *
 * A fixed single tail would be a bug waiting to happen: nothing bounds how much
 * follows an opener. The prompt that drove the turn is appended after it and has
 * no size limit of its own, and provider-retry notices and steering prompts land
 * during the turn too. So this walks backwards a chunk at a time and stops at the
 * first marker, which is one read in every ordinary case.
 */
const RUN_MARKER_CHUNK_BYTES = 64 * 1024;

/**
 * The longest line this walk will hold on to while looking for a marker.
 *
 * The walk is COMPLETE — it has no overall byte cap, because a cap is a bound on
 * the wrong thing: it would answer "no marker" for exactly the interrupted
 * session it exists to find, whenever one big enough prompt sat after the
 * opener. What is bounded instead is a single LINE, which is sound rather than
 * arbitrary: a marker entry is a couple of hundred bytes, so a line past this is
 * provably not one and is dropped rather than accumulated. That is also what
 * keeps the walk linear — carrying a multi-megabyte line across every chunk
 * boundary would copy it once per chunk.
 */
const MAX_RUN_MARKER_LINE_BYTES = 64 * 1024;

/** The newest run-lifecycle marker in a log. */
export interface LastRunMarker {
  type: "run.started" | "run.ended" | "run.aborted";
  runId: string;
  at: number;
}

export interface LogPersistence {
  /** Append one finalized entry as a single JSONL line (atomic per line). */
  append(entry: SessionLogEntry): void;
  /** Load all persisted entries in file order, tolerating a torn final line. */
  load(): SessionLogEntry[];
  /** Whether a log file already exists for this session. */
  exists(): boolean;
  /**
   * The newest run marker, WITHOUT loading the log. Boot asks this of every
   * session, and rehydrating ~800MB of transcripts to read the last line of each
   * is not a boot step.
   */
  lastRunMarker(): LastRunMarker | undefined;
  /** The on-disk path (for diagnostics / deletion). */
  readonly path: string;
}

export function logPathFor(sessionId: string): string {
  return canonicalSessionLogPath(sessionId);
}

/** File-backed persistence. Pass a custom `path` in tests; defaults to the per-id location. */
export function createFileLogPersistence(
  sessionId: string,
  path = logPathFor(sessionId),
): LogPersistence {
  let initialized = existsSync(path);

  function ensureFile(): void {
    if (initialized) return;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      const header: LogHeader = {
        v: LOG_FORMAT_VERSION,
        sessionId,
        createdAt: new Date().toISOString(),
      };
      // Header write is best-effort atomic via temp+rename so a crash can't leave
      // a half-written first line that breaks every later append.
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(header)}\n`, "utf8");
      renameSync(tmp, path);
    }
    initialized = true;
  }

  return {
    path,
    exists: () => existsSync(path),
    lastRunMarker: () => readLastRunMarker(path),
    append(entry: SessionLogEntry): void {
      ensureFile();
      appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    },
    load(): SessionLogEntry[] {
      if (!existsSync(path)) return [];
      const raw = readFileSync(path, "utf8");
      // Parse only COMPLETE lines; a trailing partial (torn write) is ignored.
      const lastNl = raw.lastIndexOf("\n");
      const complete = lastNl >= 0 ? raw.slice(0, lastNl) : "";
      const out: SessionLogEntry[] = [];
      for (const line of complete.split("\n")) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // skip a corrupt line rather than failing the whole load
        }
        if (!parsed || typeof parsed !== "object") continue;
        const obj = parsed as Record<string, unknown>;
        // Skip the header line (it has `v` but no entry `type`/`seq`).
        if (typeof obj.type !== "string" || typeof obj.seq !== "number")
          continue;
        out.push(parsed as SessionLogEntry);
      }
      return out;
    },
  };
}

/** In-memory persistence for tests that should not touch disk. */
export function createMemoryLogPersistence(): LogPersistence {
  const entries: SessionLogEntry[] = [];
  return {
    path: "<memory>",
    exists: () => entries.length > 0,
    lastRunMarker: () => {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const marker = asRunMarker(entries[i]);
        if (marker) return marker;
      }
      return undefined;
    },
    append: (entry) => {
      entries.push(entry);
    },
    load: () => entries.slice(),
  };
}

function asRunMarker(entry: unknown): LastRunMarker | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  if (
    e.type !== "run.started" &&
    e.type !== "run.ended" &&
    e.type !== "run.aborted"
  )
    return undefined;
  if (typeof e.runId !== "string" || typeof e.createdAt !== "string")
    return undefined;
  const at = new Date(e.createdAt).getTime();
  return {
    type: e.type,
    runId: e.runId,
    at: Number.isFinite(at) ? at : 0,
  };
}

/**
 * Walk a log backwards and return its newest run marker.
 *
 * Never throws: a missing, unreadable or marker-less log answers `undefined`,
 * which every caller must read as "nothing to report" rather than as an
 * interrupted run.
 */
function readLastRunMarker(path: string): LastRunMarker | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    let end = fstatSync(fd).size;
    // The left-hand part of the line that continues into the chunk already read.
    // A line straddling a boundary is split across two reads, and without
    // rejoining it here it would be dropped from both.
    let pending: string = "";
    // That line is already longer than any marker can be, so its remaining bytes
    // are skipped rather than kept — the difference between linear and quadratic.
    let pendingTooLong: boolean = false;
    while (end > 0) {
      const length = Math.min(RUN_MARKER_CHUNK_BYTES, end);
      const start = end - length;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      const parts = buffer.toString("utf8").split("\n");
      // The chunk's own tail continues into `pending`: together they are ONE line.
      const tail = parts.pop() ?? "";
      const joined: string = pendingTooLong ? "" : `${tail}${pending}`;
      const joinedTooLong: boolean =
        pendingTooLong || joined.length > MAX_RUN_MARKER_LINE_BYTES;

      // A newline in this chunk (or reaching byte 0) completes that joined line.
      if (parts.length > 0 || start === 0) {
        if (!joinedTooLong) {
          const marker = parseRunMarkerLine(joined);
          if (marker) return marker;
        }
        // Everything but `parts[0]` is a complete line; `parts[0]` only is when
        // this read reached the start of the file.
        const floor = start > 0 ? 1 : 0;
        for (let i = parts.length - 1; i >= floor; i -= 1) {
          const marker = parseRunMarkerLine(parts[i]!);
          if (marker) return marker;
        }
        pending = start > 0 ? parts[0]! : "";
        pendingTooLong = pending.length > MAX_RUN_MARKER_LINE_BYTES;
        if (pendingTooLong) pending = "";
      } else {
        // No newline at all: the whole chunk belongs to the line still pending.
        pending = joinedTooLong ? "" : joined;
        pendingTooLong = joinedTooLong;
      }
      end = start;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing actionable; the read already answered
    }
  }
}

function parseRunMarkerLine(line: string): LastRunMarker | undefined {
  // Cheap reject before parsing: most lines are tool results.
  if (!line.includes('"run.')) return undefined;
  try {
    return asRunMarker(JSON.parse(line.trim()));
  } catch {
    return undefined; // torn or corrupt line
  }
}
