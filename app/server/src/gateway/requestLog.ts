/**
 * The edge's request log (Task-1430 PR1, `docs/workers.md` "Request log"):
 * one record per request a client sent the edge, kept in memory for the
 * gateway page, and the set of request identities seen so far.
 *
 * - `record` is the one writer of a request's text line on a client's model
 *   port and of its record. It assigns `seq` (from 1, per start), the edge's
 *   `epoch` (random per start) and `firstSeen`, cuts the path to 200
 *   characters, and keeps the newest `RING_CAPACITY` records.
 * - A record holds what a writer passes, already safe: a class, count or
 *   label, never a header value, query, body, token, lease id or raw session
 *   key. Its `userId` (the client's registry user) filters reads and is never
 *   in a projection.
 * - The seen set holds `(host, method, pathKey)` and nothing else. It persists
 *   in `stateDir` as `seenRequests.json`, at most `SEEN_CAPACITY` entries. Past
 *   that a new identity is flagged but not stored, with one log line. Memory
 *   stays bounded: the unstored identities kept in memory are capped at
 *   `SEEN_CAPACITY` too, so past both caps a repeat may be flagged again. An
 *   unreadable file starts an empty set and is replaced on the next
 *   new identity; a failed write keeps memory and is retried by the next.
 * - `since` answers one user's records after a cursor, oldest first, at most
 *   `PAGE_LIMIT`. A cursor from another epoch reads from the start.
 *
 * Writes are synchronous, so overlapping completions never lose an update.
 * This is observability, not accounting: a restart empties the ring.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createPrivateJsonFile } from "../privateJsonFile.ts";
import type { ClientCredentialClass } from "./requestCredential.ts";

type RequestVia = "gateway" | "relay";
export type RequestOutcome =
  "forwarded" | "refused" | "observed" | "failed" | "overflow";

/** What a writer supplies; the log adds `seq`, `epoch` and `firstSeen`. */
export interface RequestEntry {
  /** The client's registry user: filters reads, never projected. */
  userId: string;
  /** Registry metadata of the authenticated client. */
  client: { id: string; label: string };
  via: RequestVia;
  /**
   * The relay's request id (PR2a). Its hook: PR2a adds the validated id to
   * the `AdmittedClient` that `clientListener.ts` `serveModel` builds, and
   * `forward.ts` `startTrace` copies it here. PR1 sets none.
   */
  rid?: string;
  /** Epoch milliseconds the request started. */
  at: number;
  /** The logical upstream host, or `""` when no route matched. */
  host: string;
  method: string;
  /** Pathname only, never a query; cut to `PATH_CHARS`. */
  path: string;
  /** The matched template (PR3); the path when absent. */
  pathKey?: string;
  /** The status the client was answered, or null when it got none. */
  status: number | null;
  outcome: RequestOutcome;
  /** A fixed code: a refusal case, an error code or a fixed word. */
  reason?: string;
  /** Only on `overflow` and `relay-restarted` notes. */
  count?: number;
  /** Machine requests on token routes only (PR3). */
  listed?: boolean;
  /** The selected account's registry name. */
  account?: string;
  /** The first 12 hex of the session key's SHA-256. */
  session?: string;
  clientCredential: ClientCredentialClass;
  clientCookie: boolean;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
}

/** What a read answers: the entry without `userId`, numbered. */
export interface RequestRecord extends Omit<
  RequestEntry,
  "userId" | "pathKey"
> {
  seq: number;
  epoch: string;
  pathKey: string;
  firstSeen: boolean;
}

export interface RequestLog {
  /** This start's id: 32 lowercase hex. */
  readonly epoch: string;
  /**
   * Records the request and writes its one text line: `text` when given (the
   * forwarder's own line), else a fixed line built from the entry.
   */
  record(entry: RequestEntry, text?: string): RequestRecord;
  /**
   * The user's records with `seq > afterSeq` (from the start when `epoch`
   * is not this one), oldest first, at most `min(limit, PAGE_LIMIT)`.
   */
  since(
    userId: string,
    epoch: string | undefined,
    afterSeq: number,
    limit: number,
  ): { epoch: string; records: RequestRecord[] };
}

export const RING_CAPACITY = 5_000;
export const SEEN_CAPACITY = 4_096;
export const PAGE_LIMIT = 500;
export const PATH_CHARS = 200;
const LOGGED_PATH_CHARS = 80;
const MAX_HOST_CHARS = 253;
const MAX_METHOD_CHARS = 32;

interface SeenIdentity {
  host: string;
  method: string;
  pathKey: string;
}

const identityKey = (identity: SeenIdentity): string =>
  JSON.stringify([identity.host, identity.method, identity.pathKey]);

/** The stored set, bounded; anything else in the file is dropped. */
function normalizeSeen(value: unknown): SeenIdentity[] {
  const seen =
    typeof value === "object" && value !== null
      ? (value as { seen?: unknown }).seen
      : undefined;
  if (!Array.isArray(seen)) return [];
  const out: SeenIdentity[] = [];
  for (const item of seen) {
    if (out.length >= SEEN_CAPACITY) break;
    if (typeof item !== "object" || item === null) continue;
    const { host, method, pathKey } = item as Record<string, unknown>;
    if (
      typeof host === "string" &&
      host.length <= MAX_HOST_CHARS &&
      typeof method === "string" &&
      method !== "" &&
      method.length <= MAX_METHOD_CHARS &&
      typeof pathKey === "string" &&
      pathKey.length <= PATH_CHARS
    )
      out.push({ host, method, pathKey });
  }
  return out;
}

/** A Node error code, never an error message. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "failed";
}

/** The fixed text line of a record whose writer gave none. */
function standardLine(record: RequestRecord): string {
  const parts = [
    `request via=${record.via}`,
    `client=${record.client.id}`,
    record.method,
    JSON.stringify(record.path.slice(0, LOGGED_PATH_CHARS)),
    record.status === null ? "-" : String(record.status),
    `outcome=${record.outcome}`,
  ];
  if (record.reason !== undefined) parts.push(`reason=${record.reason}`);
  if (record.count !== undefined) parts.push(`count=${record.count}`);
  if (record.rid !== undefined) parts.push(`rid=${record.rid}`);
  parts.push(`${record.durationMs}ms`);
  return parts.join(" ");
}

/** The ring's first index whose `seq` is above `after`; the ring is sorted. */
function firstAfter(
  ring: readonly { record: RequestRecord }[],
  after: number,
): number {
  let low = 0;
  let high = ring.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ring[mid]!.record.seq > after) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * The record of an entry, field by field, so nothing a writer adds beyond
 * the contract reaches a read; frozen, so a reader cannot change the ring.
 */
function project(
  entry: RequestEntry,
  seq: number,
  epoch: string,
  firstSeen: (identity: SeenIdentity) => boolean,
): RequestRecord {
  const path = entry.path.slice(0, PATH_CHARS);
  const pathKey = (entry.pathKey ?? path).slice(0, PATH_CHARS);
  const record: RequestRecord = {
    seq,
    epoch,
    at: entry.at,
    client: Object.freeze({ id: entry.client.id, label: entry.client.label }),
    via: entry.via,
    ...(entry.rid === undefined ? {} : { rid: entry.rid }),
    host: entry.host,
    method: entry.method,
    path,
    pathKey,
    status: entry.status,
    outcome: entry.outcome,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.count === undefined ? {} : { count: entry.count }),
    ...(entry.listed === undefined ? {} : { listed: entry.listed }),
    ...(entry.account === undefined ? {} : { account: entry.account }),
    ...(entry.session === undefined ? {} : { session: entry.session }),
    clientCredential: entry.clientCredential,
    clientCookie: entry.clientCookie,
    requestBytes: entry.requestBytes,
    responseBytes: entry.responseBytes,
    durationMs: entry.durationMs,
    firstSeen: firstSeen({
      host: entry.host.slice(0, MAX_HOST_CHARS),
      method: entry.method.slice(0, MAX_METHOD_CHARS),
      pathKey,
    }),
  };
  return Object.freeze(record);
}

export function createRequestLog(options: {
  /** Where the seen set persists; without it, memory only. */
  stateDir?: string | undefined;
  log: (line: string) => void;
}): RequestLog {
  const { log } = options;
  const epoch = randomBytes(16).toString("hex");
  const file = options.stateDir
    ? createPrivateJsonFile(
        join(options.stateDir, "seenRequests.json"),
        "seen requests",
      )
    : undefined;

  let stored: SeenIdentity[] = [];
  if (file)
    try {
      stored = file.read(normalizeSeen);
    } catch {
      // Never its contents: the set starts empty and the file is replaced.
      log("request log: seen set unreadable; starting empty");
    }
  const seen = new Set(stored.map(identityKey));
  /**
   * Identities past the cap, flagged and never stored; bounded too, so past
   * this cap a repeat may be flagged again.
   */
  const unstored = new Set<string>();
  let capNoted = false;
  let writeFailed = false;

  /** Whether the identity is new, storing it while there is room. */
  const firstSeen = (identity: SeenIdentity): boolean => {
    const key = identityKey(identity);
    if (seen.has(key) || unstored.has(key)) return false;
    if (seen.size >= SEEN_CAPACITY) {
      if (unstored.size < SEEN_CAPACITY) unstored.add(key);
      if (!capNoted) {
        capNoted = true;
        log(
          `request log: seen set full (${SEEN_CAPACITY}); new paths are flagged, not stored`,
        );
      }
      return true;
    }
    seen.add(key);
    stored.push(identity);
    if (file)
      try {
        file.write({ seen: stored });
        writeFailed = false;
      } catch (err) {
        // Memory stays in force; the next new identity writes again.
        if (!writeFailed)
          log(`request log: seen set not saved (${codeOf(err)})`);
        writeFailed = true;
      }
    return true;
  };

  /** The newest records, oldest first, with their users. */
  const ring: { userId: string; record: RequestRecord }[] = [];
  let seq = 0;

  return {
    epoch,

    record(entry, text) {
      const record = project(entry, (seq += 1), epoch, firstSeen);
      ring.push({ userId: entry.userId, record });
      if (ring.length > RING_CAPACITY) ring.shift();
      log(text ?? standardLine(record));
      return record;
    },

    since(userId, askedEpoch, afterSeq, limit) {
      const after =
        askedEpoch === epoch && Number.isSafeInteger(afterSeq) ? afterSeq : 0;
      const max = Number.isSafeInteger(limit)
        ? Math.max(0, Math.min(limit, PAGE_LIMIT))
        : 0;
      const records: RequestRecord[] = [];
      for (let i = firstAfter(ring, after); i < ring.length; i += 1) {
        if (records.length >= max) break;
        const item = ring[i]!;
        if (item.userId === userId) records.push(item.record);
      }
      return { epoch, records };
    },
  };
}
