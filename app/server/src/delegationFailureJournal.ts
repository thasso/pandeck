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
 * Records, one per line, each written as `\n{json}\n` so a torn tail left by a
 * process that died mid-append can only invalidate itself:
 * - `plan` — one part of a failure's routing. A plan of any size is split into
 *   parts that each fit the record bound; nothing is left out to fit.
 * - `failed` — the failure's facts and how many plan parts it has, written
 *   AFTER its parts: it is the commit. A failure whose parts are not all
 *   present is treated as having no plan at all, never a partial one.
 * - `done` — the database holds the failure.
 *
 * Bounds: no record is longer than {@link MAX_RECORD_BYTES} encoded bytes. The
 * writer refuses a longer one; the reader measures BYTES before decoding or
 * parsing anything and skips a longer line without keeping it. The file is
 * read once per process in fixed chunks, keeping only pending facts in memory.
 * Nothing pending is ever dropped to fit a bound. Only identities and the fixed
 * vocabulary are written: never a provider message, prompt, tool output or
 * credential.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type {
  DelegationFailureCategory,
  DelegationFailureRoute,
} from "./db/delegationFailureNoticeStore.ts";

/** Who one failure was owed to, as decided when it happened. */
interface JournaledRoute {
  coordinatorId: string;
  route: DelegationFailureRoute;
  /** Every peer prompt from that coordinator the failure left unanswered. */
  requestIds: string[];
}

/** The routing a failure was owed at the moment it happened — all of it. */
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
  /** Absent when the routing could not be read, or not read back whole. */
  plan?: FailurePlan;
}

interface PlanPart {
  routes: JournaledRoute[];
  inTurnIds: string[];
}

type Line =
  | ({ kind: "failed"; planParts?: number } & Omit<JournaledFailure, "plan">)
  | ({ kind: "plan"; incidentKey: string; part: number } & PlanPart)
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

/** No record is longer, in encoded bytes (its framing newlines excluded). */
export const MAX_RECORD_BYTES = 64 * 1024;
/** A plan part is packed to stay well inside the record bound. */
const PLAN_PART_BUDGET = 48 * 1024;
/** No identity in a plan is longer; a longer one is not ours. */
const MAX_ID_BYTES = 256;
const READ_CHUNK_BYTES = 64 * 1024;
/** Retired lines kept before the next write compacts them away. */
const COMPACT_AFTER_RETIRED = 200;

/** The pending failures, once read from disk; undefined until then. */
let pending: Map<string, JournaledFailure> | undefined;
let retiredSinceCompaction = 0;

function journalPath(): string {
  return join(DATA_DIR, "delegation-failure-journal.jsonl");
}

/** One record as written: refused, not truncated, when over the bound. */
function encode(line: Line): string {
  const json = JSON.stringify(line);
  if (Buffer.byteLength(json, "utf8") > MAX_RECORD_BYTES)
    throw new Error("journal record exceeds its bound");
  return `\n${json}\n`;
}

/** Split a plan into parts that each fit the bound; nothing is dropped. */
function planParts(plan: FailurePlan): PlanPart[] {
  const parts: PlanPart[] = [];
  let current: PlanPart = { routes: [], inTurnIds: [] };
  let size = 0;
  const flush = () => {
    if (current.routes.length > 0 || current.inTurnIds.length > 0)
      parts.push(current);
    current = { routes: [], inTurnIds: [] };
    size = 0;
  };
  // The cost of one id inside a part: quotes, comma and the id itself.
  const idCost = (id: string) => Buffer.byteLength(id, "utf8") + 3;
  for (const route of plan.routes) {
    const header =
      Buffer.byteLength(route.coordinatorId, "utf8") + route.route.length + 64;
    if (size + header > PLAN_PART_BUDGET) flush();
    let entry: JournaledRoute = { ...route, requestIds: [] };
    current.routes.push(entry);
    size += header;
    for (const id of route.requestIds) {
      if (size + idCost(id) > PLAN_PART_BUDGET) {
        flush();
        entry = { ...route, requestIds: [] };
        current.routes.push(entry);
        size = header;
      }
      entry.requestIds.push(id);
      size += idCost(id);
    }
  }
  for (const id of plan.inTurnIds) {
    if (size + idCost(id) + 32 > PLAN_PART_BUDGET) flush();
    current.inTurnIds.push(id);
    size += idCost(id);
  }
  flush();
  return parts;
}

/** The lines a failure is written as: its plan parts, then its commit. */
function linesOf(failure: JournaledFailure): string {
  const { plan, ...facts } = failure;
  if (!plan) return encode({ kind: "failed", ...facts });
  const parts = planParts(plan);
  return (
    parts
      .map((part, i) =>
        encode({
          kind: "plan",
          incidentKey: failure.incidentKey,
          part: i,
          ...part,
        }),
      )
      .join("") + encode({ kind: "failed", ...facts, planParts: parts.length })
  );
}

function append(text: string): void {
  const path = journalPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text, "utf8");
}

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(
    (v) =>
      typeof v === "string" && Buffer.byteLength(v, "utf8") <= MAX_ID_BYTES,
  )
    ? (value as string[])
    : undefined;
}

function parsePart(v: Record<string, unknown>): PlanPart | undefined {
  const inTurnIds = idList(v.inTurnIds);
  if (!inTurnIds || !Array.isArray(v.routes)) return undefined;
  const routes: JournaledRoute[] = [];
  for (const raw of v.routes) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    const requestIds = idList(r.requestIds);
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
  if (v.kind === "plan") {
    const part = parsePart(v);
    if (!part || typeof v.part !== "number" || !Number.isInteger(v.part))
      return undefined;
    return { kind: "plan", incidentKey: v.incidentKey, part: v.part, ...part };
  }
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
    ...(typeof v.planParts === "number" &&
    Number.isInteger(v.planParts) &&
    v.planParts > 0
      ? { planParts: v.planParts }
      : {}),
  };
}

/** Whole plan parts merged in order: routes by coordinator, ids appended. */
function mergeParts(parts: PlanPart[]): FailurePlan {
  const routes = new Map<string, JournaledRoute>();
  const inTurnIds: string[] = [];
  for (const part of parts) {
    for (const r of part.routes) {
      const known = routes.get(r.coordinatorId);
      if (known) known.requestIds.push(...r.requestIds);
      else routes.set(r.coordinatorId, { ...r, requestIds: [...r.requestIds] });
    }
    inTurnIds.push(...part.inTurnIds);
  }
  return { routes: [...routes.values()], inTurnIds };
}

/** Collects records into the pending failures, plans only when whole. */
class JournalReader {
  private readonly failed = new Map<
    string,
    Omit<JournaledFailure, "plan"> & { planParts?: number }
  >();
  private readonly parts = new Map<string, Map<number, PlanPart>>();

  apply(raw: string): void {
    const line = parse(raw);
    if (!line) return;
    if (line.kind === "done") {
      this.failed.delete(line.incidentKey);
      this.parts.delete(line.incidentKey);
    } else if (line.kind === "plan") {
      const { kind: _kind, incidentKey, part, ...body } = line;
      const known = this.parts.get(incidentKey) ?? new Map<number, PlanPart>();
      known.set(part, body);
      this.parts.set(incidentKey, known);
    } else {
      const { kind: _kind, ...failure } = line;
      this.failed.set(line.incidentKey, failure);
    }
  }

  result(): Map<string, JournaledFailure> {
    const out = new Map<string, JournaledFailure>();
    for (const [key, { planParts: count, ...facts }] of this.failed) {
      const parts = this.parts.get(key);
      const ordered =
        count === undefined || parts === undefined
          ? undefined
          : Array.from({ length: count }, (_, i) => parts.get(i));
      out.set(
        key,
        ordered && ordered.every((p) => p !== undefined)
          ? { ...facts, plan: mergeParts(ordered as PlanPart[]) }
          : facts,
      );
    }
    return out;
  }
}

/**
 * Read the journal into memory in fixed chunks, measuring every line in BYTES
 * before it is decoded or parsed. Throws when the file cannot be read — which
 * is never the same as an empty journal.
 */
function load(): Map<string, JournaledFailure> {
  const reader = new JournalReader();
  const path = journalPath();
  if (!existsSync(path)) return reader.result();
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    // The bytes of the line still being read, and their total.
    let held: Buffer[] = [];
    let heldBytes = 0;
    let skipping = false;
    const take = (segment: Buffer, ends: boolean): void => {
      if (!skipping && heldBytes + segment.length > MAX_RECORD_BYTES) {
        skipping = true;
        held = [];
        heldBytes = 0;
      }
      if (!skipping && segment.length > 0) {
        held.push(Buffer.from(segment));
        heldBytes += segment.length;
      }
      if (!ends) return;
      if (!skipping && heldBytes > 0)
        reader.apply(Buffer.concat(held, heldBytes).toString("utf8"));
      held = [];
      heldBytes = 0;
      skipping = false;
    };
    for (;;) {
      const read = readSync(fd, buffer, 0, READ_CHUNK_BYTES, null);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline === -1) {
          take(chunk.subarray(start), false);
          break;
        }
        take(chunk.subarray(start, newline), true);
        start = newline + 1;
      }
    }
    take(Buffer.alloc(0), true);
  } finally {
    closeSync(fd);
  }
  return reader.result();
}

function loaded(): Map<string, JournaledFailure> {
  pending ??= load();
  return pending;
}

/**
 * Write a failure down — its plan parts, then its commit — before anything
 * else records it. Throws if it cannot.
 */
export function journalFailure(failure: JournaledFailure): void {
  append(linesOf(failure));
  pending?.set(failure.incidentKey, failure);
}

/**
 * Retire a failure the database now holds. It stays pending until the
 * retirement is actually written: one that fails is tried again by the next
 * replay, which finds the incident recorded and only retires it.
 */
export function journalDone(incidentKey: string): void {
  try {
    append(encode({ kind: "done", incidentKey }));
  } catch {
    return;
  }
  pending?.delete(incidentKey);
  retiredSinceCompaction += 1;
  // When nothing is owed any more (the rewrite is empty), or once the retired
  // lines outnumber what a rewrite keeps — so draining a large backlog costs a
  // linear amount of writing, not a quadratic one.
  if (
    pending?.size === 0 ||
    retiredSinceCompaction >=
      Math.max(COMPACT_AFTER_RETIRED, pending?.size ?? 0)
  ) {
    try {
      compactJournal();
    } catch {
      // the retired lines stay until the next compaction
    }
  }
}

/** Send a failure to the back of the line, so others get their turn first. */
export function deferJournaledFailure(incidentKey: string): void {
  const failure = pending?.get(incidentKey);
  if (!pending || !failure) return;
  pending.delete(incidentKey);
  pending.set(incidentKey, failure);
}

/**
 * The failures written down and not yet retired, longest unattempted first,
 * at most `limit` of them. Reads the file the first time it is asked; throws
 * when it cannot be read.
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

/** How many failures are pending; 0 for a journal that cannot be read. */
export function pendingJournalCount(): number {
  try {
    return loaded().size;
  } catch {
    return 0;
  }
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
  writeFileSync(tmp, [...map.values()].map(linesOf).join(""), "utf8");
  renameSync(tmp, path);
  retiredSinceCompaction = 0;
}
