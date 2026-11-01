/**
 * The `sessions` state topic (`docs/state-sync.md`, Adopted domains; the
 * session-list contract is `docs/session-list.md`): the live session list on
 * the state topic kernel. Every row change is a revisioned `upsert`/`delete`
 * whose revision a write stamped at the touch seam
 * (`db/sessionListChanges.ts`); the subscribe answer is the live projection
 * with its revision sidecar and the archived count.
 *
 * It also owns the missed-reporter safety net: a public change not covered by
 * a stamp newer than the row's last delivered publication or capture is an
 * unreported change. Under test it is recorded as a
 * {@link StateTopicInvariantError} at every flush, `items` read and snapshot;
 * in production a 60 s sweep logs and repairs it.
 */
import type { SessionListItem, StateDigestEntry } from "@assistant/shared";
import { dbIsOpen } from "./db/index.ts";
import { advancePeerDeadlines } from "./db/peerDeadlineClock.ts";
import { currentId } from "./db/sequences.ts";
import {
  sessionListRevisions,
  sessionsWrites,
  setSessionListHooks,
  tombstonedSessionIds,
  touchSessionRows,
} from "./db/sessionListChanges.ts";
import { errorText } from "./errors.ts";
import { liveSessionIds, mergedSessionList } from "./harnesses/sessionList.ts";
import { sessionListHiddenProbe } from "./permanentAssistantVisibility.ts";
import { archivedSessionCount } from "./sessions.ts";
import { createStateTopic, StateTopicInvariantError } from "./stateTopicKernel.ts";

type SessionRow = ReturnType<typeof mergedSessionList>[number];

/** The `sessions` subscribe answer. */
interface SessionListSnapshot {
  type: "sessionList";
  seq: number;
  sessions: SessionListItem[];
  revisions: StateDigestEntry[];
  archivedSessionCount: number;
}

/** Backstop interval of the production sweep; tests run without it. */
const SESSION_LIST_SWEEP_MS = 60_000;
/**
 * Under test, every flush, `items` read and snapshot first checks for an
 * unreported row change (`docs/session-list.md`, "Audit").
 */
let auditEnabled = process.env.VITEST === "true";
/** Events per `stateEvents` frame; tests lower it to split a flush. */
let batchMax = 100;

/** What a row shows a client: the internal transcript path stripped. */
function publicSessionRow(row: SessionRow): SessionListItem {
  const { file: _file, ...publicRow } = row;
  return publicRow;
}

/** One built row as the audit compares it. */
interface AuditRow {
  json: string;
  archived: boolean;
}

/**
 * The archived-inclusive public projection, by id: every listed row the hidden
 * probe admits. `onlyIds` bounds the build to those ids.
 */
function auditRows(onlyIds?: ReadonlySet<string>): Map<string, AuditRow> {
  const hidden = sessionListHiddenProbe();
  const rows = new Map<string, AuditRow>();
  for (const row of mergedSessionList({
    includeArchived: true,
    ...(onlyIds ? { onlyIds } : {}),
  })) {
    if (hidden(row)) continue;
    rows.set(row.id, {
      json: JSON.stringify(publicSessionRow(row)),
      archived: Boolean(row.archived),
    });
  }
  return rows;
}

/** The top-level fields that differ between a baseline row and a fresh one. */
function changedSessionRowFields(
  before: string | undefined,
  after: string | undefined,
): string[] {
  if (before === undefined) return ["(added)"];
  if (after === undefined) return ["(removed)"];
  const old = JSON.parse(before) as Record<string, unknown>;
  const next = JSON.parse(after) as Record<string, unknown>;
  return [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(
    (key) => JSON.stringify(old[key]) !== JSON.stringify(next[key]),
  );
}

/**
 * What the audit compares against: each id's public content and the stamped
 * revision at which that state, present or absent, was established. An id
 * never captured or published is judged against `highWater`, the revision
 * counter at the last full capture.
 */
interface AuditBaseline {
  rows: Map<string, string>;
  rev: Map<string, number>;
  archived: Set<string>;
  highWater: number;
}

let baseline: AuditBaseline | undefined;
/** A global touch stamped the live superset; its publication is owed. */
let globalPending = false;
/** The current flush's built rows, for the rebaseline at its publication. */
let flushRows = new Map<string, AuditRow>();

function fullCapture(rows: Map<string, AuditRow> = auditRows()): void {
  const revisions = sessionListRevisions([...rows.keys()]);
  baseline = {
    rows: new Map([...rows].map(([id, row]) => [id, row.json])),
    rev: new Map([...rows.keys()].map((id) => [id, revisions.get(id) ?? 0])),
    archived: new Set(
      [...rows].filter(([, row]) => row.archived).map(([id]) => id),
    ),
    highWater: currentId(sessionsWrites.sequence),
  };
}

/**
 * Public changes since the baseline that no stamp covers: content or presence
 * differs while the id's current revision is not above its baseline revision
 * (or, for an id never baselined, above the high-water). While a global
 * publication is owed, a row archived in both is excused: the global touch
 * does not stamp archived rows.
 */
function unreportedChanges(
  current: Map<string, AuditRow>,
  from: AuditBaseline,
): { id: string; fields: string[] }[] {
  const ids = [...new Set([...current.keys(), ...from.rows.keys()])];
  const revisions = sessionListRevisions(ids);
  const changes: { id: string; fields: string[] }[] = [];
  for (const id of ids) {
    const before = from.rows.get(id);
    const after = current.get(id);
    if (before === after?.json) continue;
    const revision = revisions.get(id) ?? 0;
    const established = from.rev.get(id);
    if (revision > (established ?? from.highWater)) continue;
    if (globalPending && from.archived.has(id) && after?.archived) continue;
    changes.push({ id, fields: changedSessionRowFields(before, after?.json) });
  }
  return changes;
}

function describe(changes: { id: string; fields: string[] }[]): string {
  return changes
    .map(({ id, fields }) => `${id} ${fields.join(",")}`)
    .join("; ");
}

/**
 * The test-mode check, run first by every flush, `items` read and snapshot.
 * The first run captures; a clean run recaptures; an unreported change is
 * recorded and thrown, the baseline left as it was.
 */
function auditForTests(): void {
  const rows = auditRows();
  if (baseline) {
    const changes = unreportedChanges(rows, baseline);
    if (changes.length > 0)
      throw new StateTopicInvariantError(
        `unreported session row change: ${describe(changes)}`,
      );
  }
  fullCapture(rows);
}

/** Production: log the drift, recapture, then re-stamp so the repair publishes. */
function repair(changes: { id: string; fields: string[] }[]): void {
  for (const { id, fields } of changes)
    console.warn(
      `[sessions] unreported row change: ${id} (${fields.join(", ")})`,
    );
  touchSessionRows(changes.map((change) => change.id));
}

/**
 * The kernel's delivered publication moves the baseline of every id it
 * published, from the build the flush already did; a failed one moves
 * nothing, so retained ids stay excused by their newer stamp. A delivered
 * flush owed by a global touch then checks everything with the archived
 * excuse and recaptures, which ends the excuse.
 */
function rebaseline(
  events: readonly { id: string; revision: number }[],
  delivered: boolean,
): void {
  const built = flushRows;
  flushRows = new Map();
  if (!delivered || !baseline) return;
  for (const { id, revision } of events) {
    const row = built.get(id);
    if (row) baseline.rows.set(id, row.json);
    else baseline.rows.delete(id);
    if (row?.archived) baseline.archived.add(id);
    else baseline.archived.delete(id);
    baseline.rev.set(id, revision);
  }
  if (!globalPending) return;
  const rows = auditRows();
  const changes = unreportedChanges(rows, baseline);
  fullCapture(rows);
  globalPending = false;
  if (changes.length === 0) return;
  if (auditEnabled)
    throw new StateTopicInvariantError(
      `unreported session row change at a global publication: ${describe(changes)}`,
    );
  repair(changes);
}

/**
 * One build for the batch, archived rows included so the audit can rebaseline
 * them. A member is listed, unarchived and not hidden; anything else is
 * `null`, published as a `delete`.
 */
function summaries(
  ids: readonly string[],
): Map<string, SessionListItem | null> {
  const hidden = sessionListHiddenProbe();
  const built = new Map(
    mergedSessionList({ includeArchived: true, onlyIds: new Set(ids) }).map(
      (row) => [row.id, row],
    ),
  );
  const items = new Map<string, SessionListItem | null>();
  for (const id of ids) {
    const row = built.get(id);
    if (!row || hidden(row)) {
      items.set(id, null);
      continue;
    }
    const item = publicSessionRow(row);
    flushRows.set(id, {
      json: JSON.stringify(item),
      archived: Boolean(row.archived),
    });
    items.set(id, row.archived ? null : item);
  }
  return items;
}

/** The live session list on the kernel. */
export const sessionsStateTopic = createStateTopic({
  topic: "sessions",
  revisions(ids) {
    if (auditEnabled) auditForTests();
    flushRows = new Map();
    const revisions = sessionListRevisions(ids);
    const tombstoned = tombstonedSessionIds(ids);
    return new Map(
      [...revisions].map(([id, revision]) => [
        id,
        { revision, live: !tombstoned.has(id) },
      ]),
    );
  },
  summary: (id) => summaries([id]).get(id) ?? undefined,
  summaries,
  snapshot(seq): SessionListSnapshot {
    if (auditEnabled) auditForTests();
    const hidden = sessionListHiddenProbe();
    const sessions = mergedSessionList()
      .filter((row) => !hidden(row))
      .map(publicSessionRow);
    const revisions = sessionListRevisions(sessions.map((row) => row.id));
    return {
      type: "sessionList",
      seq,
      sessions,
      revisions: sessions.map(({ id }) => ({
        id,
        revision: revisions.get(id) ?? 0,
      })),
      archivedSessionCount: archivedSessionCount(),
    };
  },
  get batchMax() {
    return batchMax;
  },
});

// Registered first, so the archived-count and unread listeners the hub adds
// run after the baseline moved.
sessionsStateTopic.onPublished(({ events, delivered }) =>
  rebaseline(events, delivered),
);

setSessionListHooks({
  liveIds: liveSessionIds,
  globalTouched: () => {
    globalPending = true;
  },
  invalidated: () => {
    baseline = undefined;
    globalPending = false;
  },
});

/**
 * Boot, right after the boot touch: capture the production baseline. The
 * capture postdates the touch, so the publication it owes is no longer an
 * excuse.
 */
export function captureSessionListBaseline(): void {
  fullCapture();
  globalPending = false;
}

/**
 * The production backstop: advance the deadline watermark, then compare a full
 * build with the baseline and log and repair any row no write reported, and
 * retry ids a failed flush retained. It is not a reporter: nothing relies on
 * it, and tests run without it.
 */
export function sweepSessionRows(): void {
  advancePeerDeadlines();
  if (!dbIsOpen()) return;
  const rows = auditRows();
  const changes = baseline ? unreportedChanges(rows, baseline) : [];
  fullCapture(rows);
  repair(changes);
  sessionsStateTopic.report([]);
}

/** Starts the sweep (production); returns its stop. */
export function startSessionListSweep(): () => void {
  if (auditEnabled) return () => {};
  const timer = setInterval(() => {
    try {
      sweepSessionRows();
    } catch (err) {
      console.warn("[sessions] row sweep failed:", errorText(err));
    }
  }, SESSION_LIST_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Test seam for fixtures that seed rows behind the stores' backs: forget the
 * baseline, so the next check only captures.
 */
export function resetSessionListAuditBaselineForTests(): void {
  baseline = undefined;
  globalPending = false;
}

/**
 * Test seam: run as production does (no per-flush check; the sweep and the
 * global publication log and repair) while a test exercises the sweep.
 */
export function setSessionListAuditForTests(on: boolean): void {
  auditEnabled = on;
}

/** Test seam: split a flush into frames of `max` events (default 100). */
export function setSessionsBatchMaxForTests(max = 100): void {
  batchMax = max;
}

