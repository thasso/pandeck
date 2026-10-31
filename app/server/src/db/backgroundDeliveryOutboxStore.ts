/**
 * SQL facade for background completions owed to a session: not yet delivered,
 * or delivered into a turn that has not ended cleanly yet. Identities and
 * categories only: `index.ts` rebuilds each notice from its background-work row
 * (`backgroundWorkStore`), which keeps this table free of commands, paths and
 * output.
 *
 * A row's `phase` says how far its handling got (`docs/steering-and-queueing.md`):
 * `owed` (never exposed), `reserved` (claimed by one attempt right before
 * exposure), `handling` (appended into one run, waiting for its outcome) and
 * `interrupted` (that attempt ended any other way). Every transition is a
 * compare-and-set on the phase and the attempt that holds it, so a duplicate,
 * late or foreign callback finds nothing to move.
 */
import type { BackgroundHandlingRef } from "@assistant/shared";
import { getDb, inDbTransaction, withDbTransaction } from "./index.ts";
import { touchSessionRows } from "./sessionListChanges.ts";

type BackgroundHandlingPhase = "owed" | "reserved" | "handling" | "interrupted";

/**
 * Why a handling attempt ended without a clean end of its run: the run failed
 * (`failed`), an abort somebody asked for ended it (`stopped`), the process
 * died while it was reserved or running (`restart`), or what reached the model
 * cannot be told (`unknown`).
 */
export type BackgroundHandlingInterruption =
  "failed" | "stopped" | "restart" | "unknown";

export interface BackgroundDeliveryOutboxRow {
  sessionId: string;
  itemId: string;
  revision: number;
  disposition: "wake" | "defer";
  /**
   * A Stop touched it: saved while its session was held, or owed when a Stop
   * landed. Boot restores it until it is delivered, held or not.
   */
  retained: boolean;
}

export interface BackgroundHandlingRow extends BackgroundDeliveryOutboxRow {
  phase: BackgroundHandlingPhase;
  attemptId?: string;
  runId?: string;
  entryId?: string;
  interruption?: BackgroundHandlingInterruption;
}

interface Row {
  session_id: string;
  item_id: string;
  revision: number;
  disposition: "wake" | "defer";
  retained: number;
  phase: BackgroundHandlingPhase;
  attempt_id: string | null;
  run_id: string | null;
  entry_id: string | null;
  interruption: BackgroundHandlingInterruption | null;
}

const COLUMNS =
  "session_id,item_id,revision,disposition,retained,phase,attempt_id,run_id,entry_id,interruption";

function mapRow(r: Row): BackgroundHandlingRow {
  return {
    sessionId: r.session_id,
    itemId: r.item_id,
    revision: r.revision,
    disposition: r.disposition,
    retained: r.retained === 1,
    phase: r.phase,
    ...(r.attempt_id ? { attemptId: r.attempt_id } : {}),
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(r.entry_id ? { entryId: r.entry_id } : {}),
    ...(r.interruption ? { interruption: r.interruption } : {}),
  };
}

export const backgroundDeliveryOutboxStore = {
  /**
   * Record a fact owed to `sessionId`. Once retained, a row stays retained.
   *
   * One item is ONE debt: a row already standing for it — at the revision it
   * was first owed under, in any phase — is the debt, and a later revision of
   * the same terminal item is metadata (a retained host re-stamps its
   * children). Saving again never adds a second row, never reopens an exposed
   * one and never moves its phase.
   */
  save(row: BackgroundDeliveryOutboxRow): void {
    inDbTransaction(() => {
      const db = getDb();
      touchSessionRows([row.sessionId]);
      const existing = db
        .prepare(
          "SELECT revision, phase FROM background_delivery_outbox WHERE session_id=? AND item_id=? ORDER BY revision LIMIT 1",
        )
        .get(row.sessionId, row.itemId) as
        { revision: number; phase: BackgroundHandlingPhase } | undefined;
      if (existing) {
        db.prepare(
          "UPDATE background_delivery_outbox SET retained=MAX(retained,?), disposition=CASE WHEN phase='owed' AND revision=? THEN ? ELSE disposition END WHERE session_id=? AND item_id=? AND revision=?",
        ).run(
          row.retained ? 1 : 0,
          row.revision,
          row.disposition,
          row.sessionId,
          row.itemId,
          existing.revision,
        );
        return;
      }
      db.prepare(
        "INSERT INTO background_delivery_outbox(session_id,item_id,revision,disposition,retained,created_at_ms,phase,phase_at_ms) VALUES(?,?,?,?,?,?,'owed',?)",
      ).run(
        row.sessionId,
        row.itemId,
        row.revision,
        row.disposition,
        row.retained ? 1 : 0,
        Date.now(),
        Date.now(),
      );
    });
  },

  /** A Stop landed: everything this session is owed now outlives a restart. */
  retainSession(sessionId: string): void {
    getDb()
      .prepare(
        "UPDATE background_delivery_outbox SET retained=1 WHERE session_id=?",
      )
      .run(sessionId);
    touchSessionRows([sessionId]);
  },

  /**
   * Forget a fact nothing exposed: dropped by the bounded queue, or no longer
   * naming its item at boot. A row an attempt claimed or exposed is not this
   * call's to erase.
   */
  remove(sessionId: string, itemId: string, revision: number): void {
    getDb()
      .prepare(
        "DELETE FROM background_delivery_outbox WHERE session_id=? AND item_id=? AND revision=? AND phase='owed'",
      )
      .run(sessionId, itemId, revision);
    touchSessionRows([sessionId]);
  },

  /**
   * Claim every listed row for `attemptId`, all or nothing, right before the
   * prompt carrying them is exposed. Each must still stand in `from` (owed for
   * a delivery, interrupted for the user's Recover); otherwise nothing moves
   * and the answer is false. An owed fact whose row never reached the table
   * (`unrecorded`: its save was refused) is recorded here, claimed: the claim
   * is the receipt that must exist before anything is exposed. Any other
   * absent row was retired, and stays so.
   */
  reserve(
    sessionId: string,
    attemptId: string,
    items: readonly {
      itemId: string;
      revision: number;
      unrecorded?: boolean;
      /** For `interrupted`: the attempt it must still stand under. */
      attemptId?: string | null;
    }[],
    from: "owed" | "interrupted",
  ): boolean {
    if (items.length === 0) return false;
    try {
      withDbTransaction(() => {
        const db = getDb();
        touchSessionRows([sessionId]);
        const claim = db.prepare(
          "UPDATE background_delivery_outbox SET prior_attempt_id=CASE WHEN phase='interrupted' THEN attempt_id END, prior_run_id=CASE WHEN phase='interrupted' THEN run_id END, prior_entry_id=CASE WHEN phase='interrupted' THEN entry_id END, phase='reserved', attempt_id=?, run_id=NULL, entry_id=NULL, phase_at_ms=? WHERE session_id=? AND item_id=? AND revision=? AND phase=?",
        );
        const reclaim = db.prepare(
          "UPDATE background_delivery_outbox SET prior_attempt_id=CASE WHEN phase='interrupted' THEN attempt_id END, prior_run_id=CASE WHEN phase='interrupted' THEN run_id END, prior_entry_id=CASE WHEN phase='interrupted' THEN entry_id END, phase='reserved', attempt_id=?, run_id=NULL, entry_id=NULL, phase_at_ms=? WHERE session_id=? AND item_id=? AND revision=? AND phase='interrupted' AND attempt_id IS ?",
        );
        const standing = db.prepare(
          "SELECT 1 FROM background_delivery_outbox WHERE session_id=? AND item_id=?",
        );
        const record = db.prepare(
          "INSERT INTO background_delivery_outbox(session_id,item_id,revision,disposition,retained,created_at_ms,phase,attempt_id,phase_at_ms) VALUES(?,?,?,'wake',0,?,'reserved',?,?)",
        );
        const now = Date.now();
        for (const item of items) {
          const changed = Number(
            (from === "interrupted" && item.attemptId !== undefined
              ? reclaim.run(
                  attemptId,
                  now,
                  sessionId,
                  item.itemId,
                  item.revision,
                  item.attemptId,
                )
              : claim.run(
                  attemptId,
                  now,
                  sessionId,
                  item.itemId,
                  item.revision,
                  from,
                )
            ).changes,
          );
          if (changed === 1) continue;
          if (
            from === "owed" &&
            item.unrecorded === true &&
            !standing.get(sessionId, item.itemId)
          ) {
            record.run(
              sessionId,
              item.itemId,
              item.revision,
              now,
              attemptId,
              now,
            );
            continue;
          }
          throw new ReservationLost();
        }
      });
    } catch (err) {
      if (err instanceof ReservationLost) return false;
      throw err;
    }
    return true;
  },

  /** The attempt's prompt was appended as `entryId` into run `runId`. */
  bind(
    sessionId: string,
    attemptId: string,
    runId: string,
    entryId: string,
  ): number {
    touchSessionRows([sessionId]);
    return Number(
      getDb()
        .prepare(
          "UPDATE background_delivery_outbox SET phase='handling', run_id=?, entry_id=?, phase_at_ms=? WHERE session_id=? AND attempt_id=? AND phase='reserved'",
        )
        .run(runId, entryId, Date.now(), sessionId, attemptId).changes,
    );
  },

  /**
   * Nothing of the attempt reached the model: each row goes back to where the
   * attempt took it from — `owed`, or `interrupted` with the interruption it
   * already had and under the attempt, run and entry it was interrupted in (a
   * Recover that never ran), so the receipt the user was shown and its
   * transcript locator are exactly as before. A row already bound to a run the
   * provider then refused to join comes back too, unbound. Fenced by the
   * attempt: a newer one's claim is untouched.
   */
  release(sessionId: string, attemptId: string): number {
    touchSessionRows([sessionId]);
    return Number(
      getDb()
        .prepare(
          "UPDATE background_delivery_outbox SET phase=CASE WHEN interruption IS NULL THEN 'owed' ELSE 'interrupted' END, attempt_id=prior_attempt_id, run_id=prior_run_id, entry_id=prior_entry_id, prior_attempt_id=NULL, prior_run_id=NULL, prior_entry_id=NULL, phase_at_ms=? WHERE session_id=? AND attempt_id=? AND phase IN ('reserved','handling')",
        )
        .run(Date.now(), sessionId, attemptId).changes,
    );
  },

  /**
   * How run `runId` ended, for every row bound to it: a clean end retires
   * them; any other end interrupts them. Rows of another run, session or
   * phase are untouched.
   */
  settleRun(
    sessionId: string,
    runId: string,
    interruption: BackgroundHandlingInterruption | undefined,
  ): BackgroundHandlingRow[] {
    return inDbTransaction(() => {
      const rows = (
        getDb()
          .prepare(
            `SELECT ${COLUMNS} FROM background_delivery_outbox WHERE session_id=? AND run_id=? AND phase='handling'`,
          )
          .all(sessionId, runId) as unknown as Row[]
      ).map(mapRow);
      if (rows.length === 0) return rows;
      if (interruption === undefined)
        getDb()
          .prepare(
            "DELETE FROM background_delivery_outbox WHERE session_id=? AND run_id=? AND phase='handling'",
          )
          .run(sessionId, runId);
      else
        getDb()
          .prepare(
            "UPDATE background_delivery_outbox SET phase='interrupted', interruption=?, entry_id=COALESCE(entry_id, prior_entry_id), prior_attempt_id=NULL, prior_run_id=NULL, prior_entry_id=NULL, phase_at_ms=? WHERE session_id=? AND run_id=? AND phase='handling'",
          )
          .run(interruption, Date.now(), sessionId, runId);
      touchSessionRows([sessionId]);
      return rows;
    });
  },

  /**
   * As {@link settleRun}, for an attempt whose binding never reached the
   * table: its rows are still `reserved` under `attemptId`, or `handling` if a
   * later retry bound them.
   */
  settleAttempt(
    sessionId: string,
    attemptId: string,
    interruption: BackgroundHandlingInterruption | undefined,
  ): number {
    const db = getDb();
    touchSessionRows([sessionId]);
    return Number(
      interruption === undefined
        ? db
            .prepare(
              "DELETE FROM background_delivery_outbox WHERE session_id=? AND attempt_id=? AND phase IN ('reserved','handling')",
            )
            .run(sessionId, attemptId).changes
        : db
            .prepare(
              "UPDATE background_delivery_outbox SET phase='interrupted', interruption=?, entry_id=COALESCE(entry_id, prior_entry_id), prior_attempt_id=NULL, prior_run_id=NULL, prior_entry_id=NULL, phase_at_ms=? WHERE session_id=? AND attempt_id=? AND phase IN ('reserved','handling')",
            )
            .run(interruption, Date.now(), sessionId, attemptId).changes,
    );
  },

  /**
   * Boot: no run survives a restart, so every claimed or running attempt was
   * cut off. Whatever it exposed stays owed, as `restart`, for the user to
   * recover; nothing is offered again on its own. The affected sessions.
   */
  interruptUnfinished(): string[] {
    return inDbTransaction(() => {
      const sessions = (
        getDb()
          .prepare(
            "SELECT DISTINCT session_id FROM background_delivery_outbox WHERE phase IN ('reserved','handling')",
          )
          .all() as { session_id: string }[]
      ).map((r) => r.session_id);
      getDb()
        .prepare(
          "UPDATE background_delivery_outbox SET phase='interrupted', interruption='restart', entry_id=COALESCE(entry_id, prior_entry_id), prior_attempt_id=NULL, prior_run_id=NULL, prior_entry_id=NULL, phase_at_ms=? WHERE phase IN ('reserved','handling')",
        )
        .run(Date.now());
      touchSessionRows(sessions);
      return sessions;
    });
  },

  /** The oldest `limit` interrupted rows of one session, in the order owed. */
  interrupted(sessionId: string, limit: number): BackgroundHandlingRow[] {
    return (
      getDb()
        .prepare(
          `SELECT ${COLUMNS} FROM background_delivery_outbox WHERE session_id=? AND phase='interrupted' ORDER BY created_at_ms, rowid LIMIT ?`,
        )
        .all(sessionId, limit) as unknown as Row[]
    ).map(mapRow);
  },

  interruptedCount(sessionId: string): number {
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM background_delivery_outbox WHERE session_id=? AND phase='interrupted'",
      )
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  /**
   * Per session, in one read: how many rows are interrupted, and how many are
   * claimed or bound to a run whose outcome is not recorded yet.
   */
  handlingCounts(): Map<string, { interrupted: number; handling: number }> {
    const rows = getDb()
      .prepare(
        "SELECT session_id, phase, COUNT(*) AS n FROM background_delivery_outbox WHERE phase <> 'owed' GROUP BY session_id, phase",
      )
      .all() as {
      session_id: string;
      phase: BackgroundHandlingPhase;
      n: number;
    }[];
    const counts = new Map<string, { interrupted: number; handling: number }>();
    for (const row of rows) {
      const entry = counts.get(row.session_id) ?? {
        interrupted: 0,
        handling: 0,
      };
      if (row.phase === "interrupted") entry.interrupted += row.n;
      else entry.handling += row.n;
      counts.set(row.session_id, entry);
    }
    return counts;
  },

  /**
   * The rows among `refs` still interrupted under the attempt each names, in
   * the order they were owed: what the user's Recover may take.
   */
  interruptedRefs(
    sessionId: string,
    refs: readonly BackgroundHandlingRef[],
  ): BackgroundHandlingRow[] {
    const read = getDb().prepare(
      `SELECT ${COLUMNS}, created_at_ms, rowid FROM background_delivery_outbox WHERE session_id=? AND item_id=? AND revision=? AND phase='interrupted' AND attempt_id IS ?`,
    );
    const found = new Map<
      number,
      Row & { created_at_ms: number; rowid: number }
    >();
    for (const ref of refs) {
      const row = read.get(
        sessionId,
        ref.itemId,
        ref.revision,
        ref.attemptId,
      ) as (Row & { created_at_ms: number; rowid: number }) | undefined;
      if (row) found.set(row.rowid, row);
    }
    return [...found.values()]
      .sort((a, b) => a.created_at_ms - b.created_at_ms || a.rowid - b.rowid)
      .map(mapRow);
  },

  /**
   * The user let exactly these go: each is deleted only while it is still
   * interrupted under the attempt it names, so a Recover under way, a newer
   * attempt or a fact interrupted since is untouched.
   */
  dismissRefs(
    sessionId: string,
    refs: readonly BackgroundHandlingRef[],
  ): number {
    return withDbTransaction(() => {
      const drop = getDb().prepare(
        "DELETE FROM background_delivery_outbox WHERE session_id=? AND item_id=? AND revision=? AND phase='interrupted' AND attempt_id IS ?",
      );
      let dismissed = 0;
      for (const ref of refs)
        dismissed += Number(
          drop.run(sessionId, ref.itemId, ref.revision, ref.attemptId).changes,
        );
      touchSessionRows([sessionId]);
      return dismissed;
    });
  },

  /**
   * The output artifacts no cap may evict for this session: those of its
   * background work not yet terminal (evidence is recorded before the end is),
   * and those of every fact it is owed or has not finished handling, in any
   * phase — the sources a delivery or a Recover points the agent at. Work
   * that ended with no debt keeps no protection.
   */
  protectedArtifactIds(sessionId: string): Set<string> {
    const rows = getDb()
      .prepare(
        `SELECT DISTINCT i.evidence_artifact_id AS id FROM background_work_items i
         WHERE i.owner_session_id = ? AND i.evidence_artifact_id IS NOT NULL
           AND (i.state NOT IN ('completed','failed','stopped','lost','not-started')
                OR EXISTS (SELECT 1 FROM background_delivery_outbox o
                           WHERE o.session_id = i.owner_session_id AND o.item_id = i.id))`,
      )
      .all(sessionId) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  },

  /** Every row not yet exposed, oldest first. */
  list(): BackgroundHandlingRow[] {
    return (
      getDb()
        .prepare(
          `SELECT ${COLUMNS} FROM background_delivery_outbox WHERE phase='owed' ORDER BY created_at_ms, rowid`,
        )
        .all() as unknown as Row[]
    ).map(mapRow);
  },

  deleteSession(sessionId: string): void {
    getDb()
      .prepare("DELETE FROM background_delivery_outbox WHERE session_id=?")
      .run(sessionId);
    touchSessionRows([sessionId]);
  },
};

/** A row of the claim moved since it was read: the whole claim rolls back. */
class ReservationLost extends Error {
  constructor() {
    super("background delivery reservation lost");
    this.name = "ReservationLost";
  }
}
