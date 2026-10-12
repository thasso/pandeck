/**
 * The durable record of failures a coordinator may be owed a notice for
 * (`docs/delegation-failure-notices.md`), kept in a file of its own beside the
 * database rather than in it.
 *
 * A failure is written here FIRST, as safe classified facts, and only then
 * recorded in SQLite; once the database holds it, a `done` line retires it. So
 * a failure survives a database that refuses the write, a crash between the
 * two, and any number of restarts, and it is never read back out of a
 * transcript. Boot and the retry sweep replay what is still pending; the
 * incident key makes a replay of an already-recorded failure write nothing.
 *
 * Only identities and the fixed vocabulary are written: never a provider
 * message, prompt, tool output or credential.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { DelegationFailureCategory } from "./db/delegationFailureNoticeStore.ts";

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

/** Retired lines kept before the next write compacts them away. */
const COMPACT_AFTER_RETIRED = 200;

let retiredSinceCompaction = 0;
/** Something may be pending: set by a write that was not retired, and at boot. */
let mayHavePending = true;

function journalPath(): string {
  return join(DATA_DIR, "delegation-failure-journal.jsonl");
}

function append(line: Line): void {
  const path = journalPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
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
  };
}

/** Write a failure down before anything else records it. Throws if it cannot. */
export function journalFailure(failure: JournaledFailure): void {
  append({ kind: "failed", ...failure });
  mayHavePending = true;
}

/**
 * Retire a failure the database now holds. Best effort: a retirement that is
 * lost only means a later replay finds the incident already recorded.
 */
export function journalDone(incidentKey: string): void {
  try {
    append({ kind: "done", incidentKey });
    retiredSinceCompaction += 1;
    if (retiredSinceCompaction >= COMPACT_AFTER_RETIRED) compactJournal();
  } catch {
    // replayed later, and recognized there by its incident key
  }
}

/** The failures written down and not yet retired, oldest first. */
export function pendingJournaledFailures(): JournaledFailure[] {
  if (!mayHavePending) return [];
  const path = journalPath();
  if (!existsSync(path)) {
    mayHavePending = false;
    return [];
  }
  const failed = new Map<string, JournaledFailure>();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw) continue;
    const line = parse(raw);
    if (!line) continue;
    if (line.kind === "done") failed.delete(line.incidentKey);
    else {
      const { kind: _kind, ...failure } = line;
      failed.set(line.incidentKey, failure);
    }
  }
  if (failed.size === 0) mayHavePending = false;
  return [...failed.values()];
}

/**
 * Rewrite the journal with only what is still pending, atomically (a crash
 * mid-rewrite leaves the old file whole). Run at boot and after enough
 * retirements, so the file stays as small as what is owed.
 */
export function compactJournal(): void {
  const path = journalPath();
  if (!existsSync(path)) return;
  mayHavePending = true;
  const pending = pendingJournaledFailures();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(
    tmp,
    pending
      .map((failure) => `${JSON.stringify({ kind: "failed", ...failure })}\n`)
      .join(""),
    "utf8",
  );
  renameSync(tmp, path);
  retiredSinceCompaction = 0;
}
