/**
 * The durable record of failures a coordinator may be owed a notice for
 * (`docs/delegation-failure-notices.md`), kept in a file of its own beside the
 * database rather than in it.
 *
 * A failure is written here FIRST, as safe classified facts plus the routing it
 * was owed AT the failure, and only then recorded in SQLite; once the database
 * holds it, a `done` line retires it. So a failure survives a database that
 * refuses the write, a crash between the two, and any number of restarts, and
 * it is never read back out of a transcript. Boot and the retry sweep replay
 * what is still pending.
 *
 * Framing: every record is written as `\n{json}\n`, so a torn tail left by a
 * process that died mid-append can only invalidate itself — never the record
 * appended after it. A line that does not parse, or is longer than any record
 * can be, is skipped.
 *
 * Bounds: the file is read once per process (at boot, or lazily), in fixed
 * chunks, keeping only the pending facts in memory; replay takes a bounded
 * batch per sweep. Nothing pending is ever dropped to fit a bound. Only
 * identities and the fixed vocabulary are written: never a provider message,
 * prompt, tool output or credential.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DATA_DIR } from "./config.ts";
import type {
  DelegationFailureCategory,
  DelegationFailureRoute,
} from "./db/delegationFailureNoticeStore.ts";

/** Who one failure was owed to, as decided when it happened. */
interface JournaledRoute {
  coordinatorId: string;
  route: DelegationFailureRoute;
  /** Peer prompts from that coordinator the failure left unanswered. */
  requestIds: string[];
}

/** The routing a failure was owed at the moment it happened. */
export interface FailurePlan {
  routes: JournaledRoute[];
  /** Requested replies that were being answered IN the failed turn. */
  inTurnIds: string[];
}

/** One failure as the journal keeps it: everything a notice needs, no text. */
export interface JournaledFailure {
  incidentKey: string;
  sessionId: string;
  runId: string;
  category: DelegationFailureCategory;
  resetAt?: number;
  /** When the runtime first saw the failure. */
  at: number;
  /** The failed turn was itself a server-generated notice turn. */
  noticeTurn: boolean;
  /** Absent when the routing could not be read at the failure. */
  plan?: FailurePlan;
}

type Line =
  | ({ kind: "failed" } & JournaledFailure)
  | { kind: "done"; incidentKey: string };

const CATEGORIES: ReadonlySet<string> = new Set<DelegationFailureCategory>([
  "auth",
  "usage_limit",
  "rate_limit",
  "content_policy",
  "provider_error",
  "delivery",
]);
const ROUTES: ReadonlySet<string> = new Set<DelegationFailureRoute>([
  "spawn",
  "request",
]);

/** Most routes and request ids one plan may name; more is not a real plan. */
export const MAX_PLAN_ROUTES = 32;
export const MAX_PLAN_IDS = 32;
/** No record is longer; a longer line is skipped unparsed. */
const MAX_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
/** Retired lines kept before the next write compacts them away. */
const COMPACT_AFTER_RETIRED = 200;

/** The pending failures, once read from disk; undefined until then. */
let pending: Map<string, JournaledFailure> | undefined;
let retiredSinceCompaction = 0;

function journalPath(): string {
  return join(DATA_DIR, "delegation-failure-journal.jsonl");
}

function append(line: Line): void {
  const path = journalPath();
  mkdirSync(dirname(path), { recursive: true });
  // The leading newline ends whatever torn line a dead process left behind.
  appendFileSync(path, `\n${JSON.stringify(line)}\n`, "utf8");
}

function stringList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  return value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

/** A plan exactly as written, or undefined: never a partial one. */
function parsePlan(value: unknown): FailurePlan | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const inTurnIds = stringList(v.inTurnIds, MAX_PLAN_IDS);
  if (
    !inTurnIds ||
    !Array.isArray(v.routes) ||
    v.routes.length > MAX_PLAN_ROUTES
  )
    return undefined;
  const routes: JournaledRoute[] = [];
  for (const raw of v.routes) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    const requestIds = stringList(r.requestIds, MAX_PLAN_IDS);
    if (
      typeof r.coordinatorId !== "string" ||
      typeof r.route !== "string" ||
      !ROUTES.has(r.route) ||
      !requestIds
    )
      return undefined;
    routes.push({
      coordinatorId: r.coordinatorId,
      route: r.route as DelegationFailureRoute,
      requestIds,
    });
  }
  return { routes, inTurnIds };
}

function parse(raw: string): Line | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.incidentKey !== "string") return undefined;
  if (v.kind === "done") return { kind: "done", incidentKey: v.incidentKey };
  if (
    v.kind !== "failed" ||
    typeof v.sessionId !== "string" ||
    typeof v.runId !== "string" ||
    typeof v.category !== "string" ||
    !CATEGORIES.has(v.category) ||
    typeof v.at !== "number" ||
    !Number.isFinite(v.at)
  )
    return undefined;
  const plan = v.plan === undefined ? undefined : parsePlan(v.plan);
  return {
    kind: "failed",
    incidentKey: v.incidentKey,
    sessionId: v.sessionId,
    runId: v.runId,
    category: v.category as DelegationFailureCategory,
    ...(typeof v.resetAt === "number" && Number.isFinite(v.resetAt)
      ? { resetAt: v.resetAt }
      : {}),
    at: v.at,
    noticeTurn: v.noticeTurn === true,
    ...(plan ? { plan } : {}),
  };
}

function apply(map: Map<string, JournaledFailure>, raw: string): void {
  if (!raw) return;
  const line = parse(raw);
  if (!line) return;
  if (line.kind === "done") map.delete(line.incidentKey);
  else {
    const { kind: _kind, ...failure } = line;
    map.set(line.incidentKey, failure);
  }
}

/**
 * Read the journal into memory, in fixed chunks. Throws when the file cannot
 * be read — which is never the same as an empty journal.
 */
function load(): Map<string, JournaledFailure> {
  const map = new Map<string, JournaledFailure>();
  const path = journalPath();
  if (!existsSync(path)) return map;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let skipping = false;
    for (let offset = 0; offset < size;) {
      const read = readSync(fd, buffer, 0, READ_CHUNK_BYTES, offset);
      if (read === 0) break;
      offset += read;
      const parts = decoder.write(buffer.subarray(0, read)).split("\n");
      const last = parts.pop()!;
      for (const part of parts) {
        if (!skipping) apply(map, carry + part);
        carry = "";
        skipping = false;
      }
      if (skipping) continue;
      carry += last;
      // Longer than any record: skip the rest of it without keeping it.
      if (carry.length > MAX_LINE_BYTES) {
        carry = "";
        skipping = true;
      }
    }
    if (!skipping) apply(map, carry);
  } finally {
    closeSync(fd);
  }
  return map;
}

function loaded(): Map<string, JournaledFailure> {
  pending ??= load();
  return pending;
}

/** Write a failure down before anything else records it. Throws if it cannot. */
export function journalFailure(failure: JournaledFailure): void {
  append({ kind: "failed", ...failure });
  pending?.set(failure.incidentKey, failure);
}

/**
 * Retire a failure the database now holds. Best effort: a retirement that is
 * lost only means a later replay finds the incident already recorded.
 */
export function journalDone(incidentKey: string): void {
  pending?.delete(incidentKey);
  try {
    append({ kind: "done", incidentKey });
    retiredSinceCompaction += 1;
    // Only once the retired lines outnumber what a rewrite keeps, so draining
    // a large backlog costs a linear amount of writing, not a quadratic one.
    if (
      retiredSinceCompaction >=
      Math.max(COMPACT_AFTER_RETIRED, pending?.size ?? 0)
    )
      compactJournal();
  } catch {
    // replayed later, and recognized there as already recorded
  }
}

/**
 * The failures written down and not yet retired, oldest first, at most
 * `limit` of them. Reads the file the first time it is asked; throws when it
 * cannot be read.
 */
export function pendingJournaledFailures(
  limit = Number.POSITIVE_INFINITY,
): JournaledFailure[] {
  const out: JournaledFailure[] = [];
  for (const failure of loaded().values()) {
    if (out.length >= limit) break;
    out.push(failure);
  }
  return out;
}

/** Forget what memory holds and read the file again, as a new process would. */
export function reloadJournal(): void {
  pending = undefined;
  loaded();
}

/**
 * Rewrite the journal with only what is still pending, atomically (a crash
 * mid-rewrite leaves the old file whole). Only from a journal that was READ:
 * one that could not be read is left exactly as it is.
 */
export function compactJournal(): void {
  const path = journalPath();
  const map = loaded();
  if (!existsSync(path)) return;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(
    tmp,
    [...map.values()]
      .map((failure) => `${JSON.stringify({ kind: "failed", ...failure })}\n`)
      .join(""),
    "utf8",
  );
  renameSync(tmp, path);
  retiredSinceCompaction = 0;
}
