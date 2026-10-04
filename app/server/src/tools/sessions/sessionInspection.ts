/**
 * Shared plumbing for read-only cross-session inspection tools
 * (`session_read`, `session_search`, `session_lookup`, `session_send_prompt`).
 *
 * All conversation content comes from the canonical, harness-neutral app log at
 * `DATA_DIR/sessions/<id>/log.jsonl`. SQLite `session_index` provides the
 * metadata and the deleted/internal/archived classification; provider-native
 * files (pi `native.jsonl`, Claude SDK state) are resume artifacts, never
 * inspection sources. The hub is consulted only to overlay live/running state.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { storedSessionState } from "../../harnesses/storage.ts";
import { sessionStore, type SessionMeta } from "../../db/sessionStore.ts";
import { canonicalSessionLogPath } from "../../sessionStorage.ts";
import { splitAttachmentManifest } from "../../serialize.ts";
import { errorText } from "../../errors.ts";

/* ------------------------------ budgets ---------------------------------- */

/** Aggregate hard cap on the serialized `content[0].text` of a search response. */
export const SESSION_SEARCH_MAX_CHARS = 20_000;
/** Aggregate hard cap on the serialized `content[0].text` of a read response. */
export const SESSION_READ_MAX_CHARS = 24_000;
/** Target characters for one search excerpt (the aggregate cap always wins). */
export const SEARCH_EXCERPT_CHARS = 360;
/** Ceiling on any single read record's text (the aggregate cap always wins). */
const READ_RECORD_MAX_CHARS = 4_000;

/* ------------------------------- records --------------------------------- */

type RecordRole = "user" | "assistant" | "tool";
type RecordBlockKind =
  "text" | "thinking" | "tool_call" | "tool_result" | "other";

export interface SessionRecord {
  entryId: string;
  role: RecordRole;
  blockKind: RecordBlockKind;
  timestamp?: string;
  text: string;
}

export interface IncludeOptions {
  includeThinking: boolean;
  includeToolCalls: boolean;
  includeToolResults: boolean;
}

export function includeOptions(params: {
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  includeToolResults?: boolean;
}): IncludeOptions {
  return {
    includeThinking: params.includeThinking === true,
    includeToolCalls: params.includeToolCalls === true,
    includeToolResults: params.includeToolResults === true,
  };
}

/** Whether a record passes the current include flags (visible text is always on). */
function passesInclude(
  record: SessionRecord,
  include: IncludeOptions,
): boolean {
  if (record.blockKind === "thinking") return include.includeThinking;
  if (record.blockKind === "tool_call") return include.includeToolCalls;
  if (record.blockKind === "tool_result") return include.includeToolResults;
  return true;
}

/* ---------------------------- classification ----------------------------- */

export type LogAvailability = "available" | "missing" | "unreadable";

export interface ResolvedSession {
  meta: SessionMeta;
  logAvailability: LogAvailability;
  logPath: string;
  /** Non-fatal note (e.g. index/log mismatch). */
  warning?: string;
}

/** Heuristic starting window for a `latest` tail scan before falling back to a full scan. */
const EDGE_READ_MAX_BYTES = 256 * 1024;

/** A deterministic, actionable rejection for a session that cannot be inspected. */
export class SessionInspectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SessionInspectionError";
  }
}

/** Trim + reject empty/path-like session ids before any store/filesystem work. */
export function cleanSessionId(value: unknown, name = "sessionId"): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text)
    throw new SessionInspectionError("empty-id", `${name} is required.`);
  if (text === "." || text === ".." || /[\\/\0]/.test(text)) {
    throw new SessionInspectionError(
      "path-id",
      `${name} must be a single session identifier, not a path.`,
    );
  }
  return text;
}

/**
 * Resolve a copied session id to inspectable metadata (never reads log
 * content), or throw a {@link SessionInspectionError} for deleted/internal/
 * unknown ids and orphan logs. Archived user sessions resolve successfully
 * (exact reads allowed). Callers scan the log content separately (bounded,
 * streaming) via {@link readSessionWindow}/{@link searchSessionLog}.
 */
export function resolveInspectableSession(sessionId: string): ResolvedSession {
  const id = cleanSessionId(sessionId);
  const meta = sessionStore.getIncludingDeleted(id);
  const logPath = canonicalSessionLogPath(id);
  const logExists = existsSync(logPath);

  if (!meta) {
    if (logExists) {
      // Orphan log without an index row: never silently treated as normal.
      throw new SessionInspectionError(
        "orphan-log",
        `Session ${id} has a conversation log but no index metadata; it is not an inspectable session.`,
      );
    }
    throw new SessionInspectionError(
      "unknown",
      `No session found with id ${id}.`,
    );
  }
  if (meta.deletedAt) {
    throw new SessionInspectionError(
      "deleted",
      `Session ${id} was deleted and can no longer be inspected.`,
    );
  }
  if (meta.scope !== "user") {
    throw new SessionInspectionError(
      "internal",
      `Session ${id} is not a user session (${meta.scope}) and is not inspectable.`,
    );
  }

  if (!logExists) {
    return {
      meta,
      logAvailability: "missing",
      logPath,
      warning: `Session ${id} has index metadata but no conversation log yet.`,
    };
  }
  // A cheap readability probe (open+close) without parsing content, so an
  // unreadable log (e.g. permission error) is reported deterministically
  // rather than surfacing mid-scan.
  try {
    closeSync(openSync(logPath, "r"));
    return { meta, logAvailability: "available", logPath };
  } catch (err) {
    return {
      meta,
      logAvailability: "unreadable",
      logPath,
      warning: `Failed to read the conversation log for ${id}: ${errorText(err)}`,
    };
  }
}

/* ----------------------------- runtime state ----------------------------- */

export type RuntimeState = "running" | "idle" | "not_loaded";

/** Best-effort live/running overlay (never opens a log or provider file). */
export async function runtimeStateFor(id: string): Promise<RuntimeState> {
  try {
    const { hub } = await import("../../hub.ts");
    const live = hub.getLiveById(id);
    if (!live) return "not_loaded";
    return live.isRunning ? "running" : "idle";
  } catch {
    return "not_loaded";
  }
}

/** Whether the session can be resumed/prompted from its id alone. */
export function resumableState(
  meta: SessionMeta,
  runtime: RuntimeState,
): { resumable: boolean; reason?: string } {
  if (runtime !== "not_loaded") return { resumable: true };
  const stored = storedSessionState(meta.harness, meta.id);
  return stored.stored
    ? { resumable: true }
    : { resumable: false, reason: stored.reason };
}

/**
 * Log availability from a plain existence check (no read). Used by
 * `session_lookup`, which must never open a canonical/provider log.
 */
export function logAvailabilityByExistence(
  id: string,
): Extract<LogAvailability, "available" | "missing"> {
  return existsSync(canonicalSessionLogPath(id)) ? "available" : "missing";
}

/** Compact, decision-useful metadata projection shared by the inspection tools. */
export async function sessionMetaProjection(resolved: ResolvedSession) {
  const { meta, logAvailability } = resolved;
  const runtime = await runtimeStateFor(meta.id);
  const resumable = resumableState(meta, runtime);
  return {
    sessionId: meta.id,
    title: meta.title,
    harness: meta.harness,
    persona: meta.agentType,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    archived: meta.archivedAt != null,
    runtimeState: runtime,
    resumable: resumable.resumable,
    ...(resumable.reason ? { notResumableReason: resumable.reason } : {}),
    logAvailability,
  };
}

/* --------------------------- log parsing --------------------------------- */

type JsonRow = Record<string, any>;

const LINE_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Byte-safe streaming line reader: reads `path` in fixed-size chunks starting
 * at `startPosition`, splitting on raw `\n` bytes (never corrupting multi-byte
 * UTF-8 by decoding mid-character) so a single JSONL record of ANY size is
 * read in full rather than dropped. `onLine` may return `"stop"` to end the
 * scan early (the fd is closed immediately) so callers never read further than
 * the bounded neighborhood they need.
 *
 * When `startPosition > 0` the first line encountered is a partial fragment
 * (we started reading mid-file) and is discarded rather than parsed.
 *
 * Exported because the session audit report (`../../sessionAudit.ts`) streams
 * whole logs and pi's provider transcript under the same guarantees.
 */
export function forEachJsonlLine(
  path: string,
  startPosition: number,
  onLine: (line: string) => "continue" | "stop",
): void {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(LINE_SCAN_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let position = startPosition;
    let sawAnyLine = false;
    let firstLineIsPartial = startPosition > 0;
    for (;;) {
      const bytesRead = readSync(fd, buf, 0, LINE_SCAN_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const combined =
        carry.length > 0
          ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
          : Buffer.from(buf.subarray(0, bytesRead));
      let start = 0;
      for (;;) {
        const nl = combined.indexOf(0x0a, start);
        if (nl === -1) break;
        const raw = combined.toString("utf8", start, nl);
        start = nl + 1;
        if (firstLineIsPartial) {
          firstLineIsPartial = false; // discard: partial fragment from a non-zero start
          continue;
        }
        sawAnyLine = true;
        if (onLine(raw) === "stop") return;
      }
      carry = Buffer.from(combined.subarray(start));
    }
    // A trailing line with no terminating newline (last line of file, or an
    // in-progress write). Only trust it if we started from the true beginning,
    // or already found a real line boundary after our start position — a giant
    // single-line file with startPosition > 0 and no boundary ever found is
    // ambiguous and must NOT be parsed as data (callers detect this via an
    // empty/insufficient result and fall back to a full scan from position 0).
    if (carry.length > 0 && (startPosition === 0 || sawAnyLine)) {
      onLine(carry.toString("utf8"));
    }
  } finally {
    closeSync(fd);
  }
}

function parseLine(line: string): JsonRow | null | undefined {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse one canonical-log row into stable inspection records. Entry ids MUST
 * stay byte-stable so a `session_search` result hands off to
 * `session_read({ at })`.
 */
function recordsForRow(row: JsonRow, lineIndex: number): SessionRecord[] {
  if (row.type !== "message") return [];
  const role = stringValue(row.role);
  const timestamp = stringValue(row.createdAt);
  const baseId = stringValue(row.id) ?? `line-${lineIndex}`;
  const out: SessionRecord[] = [];
  if (role === "user") {
    // A delivered peer prompt stores the routing envelope in `content` but a
    // sanitized card in `peerPrompt`; inspection must surface the sanitized
    // prompt, never the envelope/reply-cue/routing syntax.
    const peer = isRecord(row.peerPrompt) ? row.peerPrompt : undefined;
    if (peer && typeof peer.message === "string") {
      const who =
        typeof peer.senderTitle === "string" && peer.senderTitle
          ? `Peer prompt from ${peer.senderTitle}: `
          : "";
      const text = `${who}${peer.message}`.trim();
      if (text)
        out.push({
          entryId: baseId,
          role: "user",
          blockKind: "text",
          ...(timestamp !== undefined ? { timestamp } : {}),
          text,
        });
      return out;
    }
    const text = userText(row.content).trim();
    if (text)
      out.push({
        entryId: baseId,
        role: "user",
        blockKind: "text",
        ...(timestamp !== undefined ? { timestamp } : {}),
        text,
      });
    return out;
  }
  if (role === "assistant") {
    for (const [blockIndex, part] of arrayValue(row.content).entries()) {
      if (!isRecord(part)) continue;
      if (
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim()
      ) {
        out.push({
          entryId: `${baseId}:text:${blockIndex}`,
          role: "assistant",
          blockKind: "text",
          ...(timestamp !== undefined ? { timestamp } : {}),
          text: part.text,
        });
      } else if (
        part.type === "thinking" &&
        typeof part.text === "string" &&
        part.text.trim()
      ) {
        out.push({
          entryId: `${baseId}:thinking:${blockIndex}`,
          role: "assistant",
          blockKind: "thinking",
          ...(timestamp !== undefined ? { timestamp } : {}),
          text: part.text,
        });
      } else if (part.type === "toolCall") {
        out.push({
          entryId: `${baseId}:tool:${blockIndex}`,
          role: "assistant",
          blockKind: "tool_call",
          ...(timestamp !== undefined ? { timestamp } : {}),
          text: formatToolCall(part),
        });
      }
    }
    return out;
  }
  if (role === "toolResult") {
    const toolName = stringValue(row.toolName) ?? "tool";
    const text = textFromContent(row.content).trim();
    if (text)
      out.push({
        entryId: `${baseId}:result`,
        role: "tool",
        blockKind: "tool_result",
        ...(timestamp !== undefined ? { timestamp } : {}),
        text: `${toolName}\n${text}`,
      });
  }
  return out;
}

/* ---------------------------- windowed reads ------------------------------ */

export interface WindowResult {
  records: SessionRecord[];
  /** False only for an explicit entry-id anchor that was not found. */
  anchorFound: boolean;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  previousEntryId?: string;
  nextEntryId?: string;
  malformedCount: number;
}

/**
 * Read a bounded, chronological window of a session log without ever
 * materializing the whole file/record set in memory: `"start"`/`"latest"`
 * stream from the corresponding edge (bounded memory via a ring buffer,
 * early-exit for `"start"`; `"latest"` tries a heuristic tail-byte window first
 * and falls back to a full streaming scan only when that window is ambiguous),
 * and an explicit entry id streams from the beginning, tracking only a bounded
 * neighborhood, stopping as soon as the after-side is filled. A single oversized
 * JSONL record is still read in full (never dropped) because line reads have no
 * fixed byte cap — only the STARTING POSITION heuristic is bounded.
 */
export function readSessionWindow(
  logPath: string,
  at: string,
  limit: number,
  include: IncludeOptions,
): WindowResult {
  if (at === "start") return scanForward(logPath, limit, include);
  if (at === "latest") return scanTail(logPath, limit, include);
  return scanForAnchor(logPath, at, limit, include);
}

function scanForward(
  logPath: string,
  limit: number,
  include: IncludeOptions,
): WindowResult {
  const collected: SessionRecord[] = [];
  let nextEntryId: string | undefined;
  let malformedCount = 0;
  let lineIndex = 0;
  forEachJsonlLine(logPath, 0, (line) => {
    lineIndex++;
    const row = parseLine(line);
    if (row === undefined) {
      malformedCount++;
      return "continue";
    }
    if (row === null) return "continue";
    for (const r of recordsForRow(row, lineIndex)) {
      if (!passesInclude(r, include)) continue;
      if (collected.length < limit) {
        collected.push(r);
      } else {
        nextEntryId = r.entryId;
        return "stop";
      }
    }
    return "continue";
  });
  return {
    records: collected,
    anchorFound: true,
    hasMoreBefore: false,
    hasMoreAfter: nextEntryId !== undefined,
    ...(nextEntryId ? { nextEntryId } : {}),
    malformedCount,
  };
}

interface RingScanResult {
  records: SessionRecord[];
  evicted: boolean;
  previousEntryId?: string;
  malformedCount: number;
}

function collectRingBufferFromPosition(
  logPath: string,
  startPosition: number,
  limit: number,
  include: IncludeOptions,
): RingScanResult {
  const ring: SessionRecord[] = [];
  let evicted = false;
  let previousEntryId: string | undefined;
  let malformedCount = 0;
  let lineIndex = 0;
  forEachJsonlLine(logPath, startPosition, (line) => {
    lineIndex++;
    const row = parseLine(line);
    if (row === undefined) {
      malformedCount++;
      return "continue";
    }
    if (row === null) return "continue";
    for (const r of recordsForRow(row, lineIndex)) {
      if (!passesInclude(r, include)) continue;
      if (ring.length >= limit) {
        const dropped = ring.shift();
        if (dropped) previousEntryId = dropped.entryId;
        evicted = true;
      }
      ring.push(r);
    }
    return "continue";
  });
  return {
    records: ring,
    evicted,
    ...(previousEntryId ? { previousEntryId } : {}),
    malformedCount,
  };
}

function scanTail(
  logPath: string,
  limit: number,
  include: IncludeOptions,
): WindowResult {
  const size = statSync(logPath).size;
  const heuristicStart = Math.max(0, size - EDGE_READ_MAX_BYTES);
  let result = collectRingBufferFromPosition(
    logPath,
    heuristicStart,
    limit,
    include,
  );
  if (heuristicStart > 0 && !result.evicted) {
    // Ambiguous: we can't tell whether more exists before our heuristic start
    // (e.g. very few, very large records). Fall back to a full scan from the
    // true beginning — still memory-bounded via the ring buffer.
    result = collectRingBufferFromPosition(logPath, 0, limit, include);
  }
  return {
    records: result.records,
    anchorFound: true,
    hasMoreBefore: result.evicted,
    hasMoreAfter: false,
    ...(result.evicted && result.previousEntryId
      ? { previousEntryId: result.previousEntryId }
      : {}),
    malformedCount: result.malformedCount,
  };
}

interface AnchorPassResult {
  anchorRecord?: SessionRecord;
  beforeRecords: SessionRecord[];
  beforeEvicted: boolean;
  previousEntryId?: string;
  afterRecords: SessionRecord[];
  afterHasMore: boolean;
  nextEntryId?: string;
  malformedCount: number;
}

function scanAnchorPass(
  logPath: string,
  anchorEntryId: string,
  beforeCap: number,
  afterCap: number,
  include: IncludeOptions,
): AnchorPassResult {
  const beforeBuf: SessionRecord[] = [];
  let beforeEvicted = false;
  let previousEntryId: string | undefined;
  let anchorRecord: SessionRecord | undefined;
  const afterBuf: SessionRecord[] = [];
  let afterHasMore = false;
  let nextEntryId: string | undefined;
  let malformedCount = 0;
  let lineIndex = 0;

  forEachJsonlLine(logPath, 0, (line) => {
    lineIndex++;
    const row = parseLine(line);
    if (row === undefined) {
      malformedCount++;
      return "continue";
    }
    if (row === null) return "continue";
    for (const r of recordsForRow(row, lineIndex)) {
      if (!anchorRecord) {
        // The anchor itself is retained regardless of include flags (an
        // explicit entry id is itself an explicit request for that record).
        if (r.entryId === anchorEntryId) {
          anchorRecord = r;
          continue;
        }
        if (!passesInclude(r, include)) continue;
        if (beforeCap === 0) {
          // No capacity to hold any "before" record, but the anchor still has
          // a real predecessor: track the latest one seen so far (it ends up
          // being the record immediately preceding the anchor once the scan
          // reaches it), rather than leaving previousEntryId undefined.
          previousEntryId = r.entryId;
          beforeEvicted = true;
        } else if (beforeBuf.length >= beforeCap) {
          const dropped = beforeBuf.shift();
          if (dropped) previousEntryId = dropped.entryId;
          beforeEvicted = true;
          beforeBuf.push(r);
        } else {
          beforeBuf.push(r);
        }
      } else {
        if (!passesInclude(r, include)) continue;
        if (afterBuf.length < afterCap) {
          afterBuf.push(r);
        } else {
          afterHasMore = true;
          nextEntryId = r.entryId;
          return "stop";
        }
      }
    }
    return "continue";
  });

  return {
    ...(anchorRecord !== undefined ? { anchorRecord } : {}),
    beforeRecords: beforeBuf,
    beforeEvicted,
    ...(previousEntryId !== undefined ? { previousEntryId } : {}),
    afterRecords: afterBuf,
    afterHasMore,
    ...(nextEntryId !== undefined ? { nextEntryId } : {}),
    malformedCount,
  };
}

/**
 * Balanced entry-centered scan: one pass with the anchor centered, then (only
 * when one side has spare unused capacity because the anchor is near an edge)
 * a second pass redistributing that spare capacity to the other side.
 */
function scanForAnchor(
  logPath: string,
  anchorEntryId: string,
  limitTotal: number,
  include: IncludeOptions,
): WindowResult {
  const initialBefore = Math.floor((limitTotal - 1) / 2);
  const initialAfter = limitTotal - 1 - initialBefore;
  const pass1 = scanAnchorPass(
    logPath,
    anchorEntryId,
    initialBefore,
    initialAfter,
    include,
  );
  if (!pass1.anchorRecord) {
    return {
      records: [],
      anchorFound: false,
      hasMoreBefore: false,
      hasMoreAfter: false,
      malformedCount: pass1.malformedCount,
    };
  }
  const spareBefore = pass1.beforeEvicted
    ? 0
    : Math.max(0, initialBefore - pass1.beforeRecords.length);
  const spareAfter = pass1.afterHasMore
    ? 0
    : Math.max(0, initialAfter - pass1.afterRecords.length);
  const final =
    spareBefore > 0 || spareAfter > 0
      ? scanAnchorPass(
          logPath,
          anchorEntryId,
          initialBefore + spareAfter,
          initialAfter + spareBefore,
          include,
        )
      : pass1;
  return {
    records: [
      ...final.beforeRecords,
      final.anchorRecord!,
      ...final.afterRecords,
    ],
    anchorFound: true,
    hasMoreBefore: final.beforeEvicted,
    hasMoreAfter: final.afterHasMore,
    ...(final.previousEntryId
      ? { previousEntryId: final.previousEntryId }
      : {}),
    ...(final.nextEntryId ? { nextEntryId: final.nextEntryId } : {}),
    malformedCount: final.malformedCount,
  };
}

/* ------------------------------- search ----------------------------------- */

export interface SearchScanResult {
  results: SessionRecord[];
  totalMatches: number;
  malformedCount: number;
}

/**
 * Stream-search a canonical log for a case-insensitive literal substring.
 * Bounded MEMORY (never holds the full record set or raw file text at once)
 * even though matching requires scanning every record to report an accurate
 * `totalMatches`.
 */
export function searchSessionLog(
  logPath: string,
  needle: string,
  maxResults: number,
  include: IncludeOptions,
): SearchScanResult {
  const lower = needle.toLowerCase();
  const results: SessionRecord[] = [];
  let totalMatches = 0;
  let malformedCount = 0;
  let lineIndex = 0;
  forEachJsonlLine(logPath, 0, (line) => {
    lineIndex++;
    const row = parseLine(line);
    if (row === undefined) {
      malformedCount++;
      return "continue";
    }
    if (row === null) return "continue";
    for (const r of recordsForRow(row, lineIndex)) {
      if (!passesInclude(r, include)) continue;
      if (!r.text.toLowerCase().includes(lower)) continue;
      totalMatches++;
      if (results.length < maxResults) results.push(r);
    }
    return "continue";
  });
  return { results, totalMatches, malformedCount };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object";
}

function arrayValue(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function userText(content: unknown): string {
  return splitAttachmentManifest(textFromContent(content)).text;
}

function formatToolCall(part: Record<string, any>): string {
  const name = typeof part.name === "string" ? part.name : "tool";
  const input = part.arguments ?? part.input;
  if (input === undefined) return name;
  try {
    return `${name}\n${JSON.stringify(input, null, 2)}`;
  } catch {
    return `${name}\n${String(input)}`;
  }
}

/* ------------------------------- text ------------------------------------ */

function clip(text: string, max: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/\s+$/g, "");
  if (normalized.length <= max) return { text: normalized, truncated: false };
  return {
    text: `${normalized.slice(0, Math.max(0, max - 1))}…`,
    truncated: true,
  };
}

export function excerpt(text: string, query: string, max: number): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(query.toLowerCase());
  if (at < 0) return clip(text, max).text;
  const radius = Math.max(20, Math.floor((max - query.length) / 2));
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

export function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.min(Math.max(n, min), max);
}

/* ---------------------------- budget allocators -------------------------- */

function serialize(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export interface ReadRecordOut {
  entryId: string;
  role: RecordRole;
  blockKind: RecordBlockKind;
  timestamp?: string;
  text: string;
  textTruncated: boolean;
  anchor?: boolean;
}

/**
 * Build the final `session_read` payload string, guaranteed at or below
 * {@link SESSION_READ_MAX_CHARS}. Records are pre-clipped to
 * {@link READ_RECORD_MAX_CHARS}; if the whole payload still exceeds the cap,
 * records are dropped from the edge farthest from the anchor (tracked as
 * `omittedBefore`/`omittedAfter`), and finally the anchor itself is clipped
 * visibly rather than dropped. Chronological order is preserved throughout.
 */
export function buildReadResponse(input: {
  metadata: Record<string, unknown>;
  records: ReadRecordOut[];
  anchorEntryId?: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  previousEntryId?: string;
  nextEntryId?: string;
  warnings: string[];
  guidance?: string;
}): { text: string; details: Record<string, unknown> } {
  const records = input.records.map((r) => ({ ...r }));
  for (const r of records) {
    const clipped = clip(r.text, READ_RECORD_MAX_CHARS);
    r.text = clipped.text;
    r.textTruncated = r.textTruncated || clipped.truncated;
  }
  let omittedBefore = 0;
  let omittedAfter = 0;
  let responseTruncated = false;

  const build = (): Record<string, unknown> => {
    const anchorPos = input.anchorEntryId
      ? records.findIndex((r) => r.entryId === input.anchorEntryId)
      : -1;
    return {
      ...input.metadata,
      ...(input.anchorEntryId ? { anchorEntryId: input.anchorEntryId } : {}),
      records,
      hasMoreBefore: input.hasMoreBefore || omittedBefore > 0,
      hasMoreAfter: input.hasMoreAfter || omittedAfter > 0,
      omittedBefore,
      omittedAfter,
      ...(omittedBefore === 0 && input.previousEntryId
        ? { previousEntryId: input.previousEntryId }
        : {}),
      ...(omittedAfter === 0 && input.nextEntryId
        ? { nextEntryId: input.nextEntryId }
        : {}),
      anchorRetained: anchorPos >= 0 || !input.anchorEntryId,
      responseTruncated,
      ...(input.warnings.length ? { warnings: input.warnings } : {}),
      ...(input.guidance ? { guidance: input.guidance } : {}),
    };
  };

  let text = serialize(build());
  let guard = 0;
  while (text.length > SESSION_READ_MAX_CHARS && guard++ < 10_000) {
    responseTruncated = true;
    if (records.length > 1) {
      // Drop the record farthest from the anchor; keep the anchor. Front ties first.
      const anchorPos = input.anchorEntryId
        ? records.findIndex((r) => r.entryId === input.anchorEntryId)
        : records.length - 1;
      const protectedIndex = anchorPos >= 0 ? anchorPos : records.length - 1;
      const frontDist = protectedIndex;
      const backDist = records.length - 1 - protectedIndex;
      if (frontDist >= backDist && protectedIndex > 0) {
        records.shift();
        omittedBefore++;
      } else if (protectedIndex < records.length - 1) {
        records.pop();
        omittedAfter++;
      } else {
        records.shift();
        omittedBefore++;
      }
    } else {
      // Single (anchor) record left: clip it down to fit rather than drop it.
      const only = records[0];
      if (!only) break;
      const over = text.length - SESSION_READ_MAX_CHARS;
      const newLen = Math.max(0, only.text.length - over - 16);
      only.text = newLen <= 1 ? "…" : `${only.text.slice(0, newLen - 1)}…`;
      only.textTruncated = true;
      if (newLen <= 1) {
        text = serialize(build());
        break;
      }
    }
    text = serialize(build());
  }
  return { text, details: build() };
}

export interface SearchResultOut {
  entryId: string;
  role: RecordRole;
  blockKind: RecordBlockKind;
  timestamp?: string;
  excerpt: string;
}

/**
 * Build the final `session_search` payload string, guaranteed at or below
 * {@link SESSION_SEARCH_MAX_CHARS}. Excerpts are already bounded to
 * {@link SEARCH_EXCERPT_CHARS}; if the payload still exceeds the cap, results
 * are dropped from the end (most recent kept order) until it fits.
 */
export function buildSearchResponse(input: {
  metadata: Record<string, unknown>;
  results: SearchResultOut[];
  totalMatches: number;
  warnings: string[];
  guidance: string;
}): { text: string; details: Record<string, unknown> } {
  let results = input.results.map((r) => ({ ...r }));
  let responseTruncated = false;
  const build = () => ({
    ...input.metadata,
    resultCount: results.length,
    totalMatches: input.totalMatches,
    truncated: input.totalMatches > results.length,
    responseTruncated,
    results,
    ...(input.warnings.length ? { warnings: input.warnings } : {}),
    guidance: input.guidance,
  });
  let text = serialize(build());
  let guard = 0;
  while (text.length > SESSION_SEARCH_MAX_CHARS && guard++ < 10_000) {
    responseTruncated = true;
    if (results.length > 1) {
      results = results.slice(0, -1);
    } else if (results.length === 1 && results[0]) {
      const over = text.length - SESSION_SEARCH_MAX_CHARS;
      const only = results[0];
      const newLen = Math.max(0, only.excerpt.length - over - 16);
      only.excerpt =
        newLen <= 1 ? "…" : `${only.excerpt.slice(0, newLen - 1)}…`;
      if (newLen <= 1) {
        text = serialize(build());
        break;
      }
    } else {
      break;
    }
    text = serialize(build());
  }
  return { text, details: build() };
}
