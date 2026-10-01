import type {
  TempoProposalRow,
  TempoProposalStatus,
} from "../db/tempoPlanStore.ts";

/**
 * Pure Tempo-plan projection + reconciliation (plan § Tempo logging assistant).
 * The structured rows in `db/tempoPlanStore.ts` are the source of truth; this
 * renders the "My day" Markdown projection and deterministically reconciles a
 * plan against REAL Tempo worklogs (Tempo stays the source of truth on the next
 * collection run). No I/O.
 */

const STATUS_LABEL: Record<TempoProposalStatus, string> = {
  proposed: "proposed",
  "user-edited": "edited",
  dropped: "dropped",
  "pending-approval": "awaiting approval",
  executing: "submitting…",
  executed: "logged",
  partial: "partially logged",
  failed: "failed",
  cancelled: "cancelled",
  declined: "declined",
};

function hoursLabel(seconds: number): string {
  const h = seconds / 3600;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(2)}h`;
}

/** Rendered projection for the "My day" Tempo section. Dropped/cancelled/declined rows are hidden. */
export function renderTempoPlan(rows: TempoProposalRow[]): string {
  const visible = rows.filter(
    (r) =>
      r.status !== "dropped" &&
      r.status !== "cancelled" &&
      r.status !== "declined",
  );
  if (visible.length === 0) return "";
  const lines = ["### Tempo", ""];
  let total = 0;
  for (const row of visible) {
    total += row.durationSeconds;
    const start = row.startTime ? `${row.startTime} · ` : "";
    const worklog = row.resultWorklogId
      ? ` (worklog ${row.resultWorklogId})`
      : "";
    lines.push(
      `- **${row.issueKey}** — ${start}${hoursLabel(row.durationSeconds)} — _${STATUS_LABEL[row.status]}_${worklog}${row.description ? `: ${row.description}` : ""}`,
    );
  }
  lines.push("", `Total: ${hoursLabel(total)}.`);
  return lines.join("\n");
}

/** One observed Tempo worklog for reconciliation. */
export interface ObservedWorklog {
  worklogId: string;
  /** The clientId we passed on submission, when Tempo echoes it back. */
  clientId?: string | null;
  issueKey: string;
  date: string;
  startTime?: string | null;
  durationSeconds: number;
}

export interface ReconcileMatch {
  rowId: string;
  worklogId: string;
  /** How the row matched a worklog: durable clientId vs. the field-tuple fallback. */
  via: "clientId" | "field-tuple";
}

function fieldTuple(
  issueKey: string,
  date: string,
  startTime: string | null | undefined,
  durationSeconds: number,
): string {
  return `${issueKey}|${date}|${startTime ?? ""}|${durationSeconds}`;
}

/**
 * Deterministically match plan rows to real worklogs. The durable `clientId`
 * (= row id) wins; field-tuple (issueKey+date+start+duration) is only the
 * FALLBACK for worklogs whose clientId Tempo did not echo. Each worklog matches
 * at most one row.
 */
export function reconcileAgainstWorklogs(
  rows: TempoProposalRow[],
  worklogs: ObservedWorklog[],
): ReconcileMatch[] {
  const matches: ReconcileMatch[] = [];
  const usedWorklogs = new Set<string>();
  const byId = new Map(rows.map((r) => [r.id, r]));

  // 1. Durable clientId matches first.
  for (const worklog of worklogs) {
    if (!worklog.clientId) continue;
    const row = byId.get(worklog.clientId);
    if (row && !usedWorklogs.has(worklog.worklogId)) {
      matches.push({
        rowId: row.id,
        worklogId: worklog.worklogId,
        via: "clientId",
      });
      usedWorklogs.add(worklog.worklogId);
    }
  }
  const matchedRows = new Set(matches.map((m) => m.rowId));

  // 2. Field-tuple fallback for still-unmatched rows.
  const worklogsByTuple = new Map<string, ObservedWorklog[]>();
  for (const worklog of worklogs) {
    if (usedWorklogs.has(worklog.worklogId)) continue;
    const key = fieldTuple(
      worklog.issueKey,
      worklog.date,
      worklog.startTime,
      worklog.durationSeconds,
    );
    (worklogsByTuple.get(key) ?? worklogsByTuple.set(key, []).get(key)!).push(
      worklog,
    );
  }
  for (const row of rows) {
    if (matchedRows.has(row.id)) continue;
    const key = fieldTuple(
      row.issueKey,
      row.date,
      row.startTime,
      row.durationSeconds,
    );
    const candidate = (worklogsByTuple.get(key) ?? []).find(
      (w) => !usedWorklogs.has(w.worklogId),
    );
    if (candidate) {
      matches.push({
        rowId: row.id,
        worklogId: candidate.worklogId,
        via: "field-tuple",
      });
      usedWorklogs.add(candidate.worklogId);
    }
  }
  return matches;
}

/** The learned Tempo-logging profile (plan § Tempo learning) — a durable KB reference entry. */
export const TEMPO_PROFILE_ENTRY_PATH = "references/tempo-logging-profile";
export const TEMPO_PROFILE_ENTRY_ID = "tempo-logging-profile";
