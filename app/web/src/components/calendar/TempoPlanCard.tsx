import { useState } from "react";
import { AlertTriangle, Check, Clock, X } from "lucide-react";
import type { CalendarDayTempoRow } from "@assistant/shared";
import { approveTempoRow, declineTempoRow } from "../../lib/calendarApi.ts";
import { ErrorNote, Spinner } from "../ui/load.tsx";

/**
 * The "My day" Tempo logging card (Daily Scanner v2 phase 6 + Task 144). Renders
 * derived proposals with per-row Approve/Decline. Approve drives the server's
 * serialized state machine + the real Tempo write; Decline is the user's
 * deliberate "don't log this" (a terminal decision the row is never re-proposed
 * from). The card reflects the returned status and refreshes the day so a re-run
 * reconciles.
 */
function hoursLabel(seconds: number): string {
  const h = seconds / 3600;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(2)}h`;
}

const STATUS_TONE: Record<CalendarDayTempoRow["status"], string> = {
  proposed: "text-muted",
  "user-edited": "text-muted",
  dropped: "text-faint",
  "pending-approval": "text-yellow-600 dark:text-yellow-300",
  executing: "text-yellow-600 dark:text-yellow-300",
  executed: "text-emerald-600 dark:text-emerald-400",
  partial: "text-yellow-600 dark:text-yellow-300",
  failed: "text-danger",
  cancelled: "text-faint",
  declined: "text-faint",
};

const STATUS_LABEL: Record<CalendarDayTempoRow["status"], string> = {
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

export function TempoPlanCard({
  date,
  rows,
  onChanged,
}: {
  date: string;
  rows: CalendarDayTempoRow[];
  onChanged: () => void;
}) {
  // WHICH decision is running, not just which row: the spinner belongs in the
  // control the user pressed (R5), and both stay on screen while it runs.
  const [running, setRunning] = useState<{
    rowId: string;
    action: "approve" | "decline";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (rows.length === 0) return null;

  const total = rows.reduce((sum, row) => sum + row.durationSeconds, 0);
  const act = async (rowId: string, action: "approve" | "decline") => {
    setRunning({ rowId, action });
    setError(null);
    try {
      const result =
        action === "approve"
          ? await approveTempoRow(date, rowId)
          : await declineTempoRow(date, rowId);
      if (!result.ok && result.error) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
      onChanged();
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-caption font-medium text-fg">
        <Clock size={13} className="text-muted" />
        Tempo
        <span className="ml-auto text-micro font-normal text-faint">
          {hoursLabel(total)} across {rows.length}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => {
          const actionable =
            row.status === "proposed" || row.status === "user-edited";
          const pressed = running?.rowId === row.id ? running.action : null;
          // `executing` is the SERVER's own state for a row nobody pressed here
          // (a reload, another tab): there is no control to busy, so the row
          // says it instead.
          const busy = pressed !== null || row.status === "executing";
          return (
            <div
              key={row.id}
              className="rounded-lg border border-line bg-surface px-2 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 text-caption font-medium text-fg">
                  {row.issueKey}
                </span>
                <span className="shrink-0 text-micro tabular-nums text-muted">
                  {row.startTime ? `${row.startTime} · ` : ""}
                  {hoursLabel(row.durationSeconds)}
                </span>
                <span
                  className={`ml-auto shrink-0 text-micro ${STATUS_TONE[row.status]}`}
                >
                  {STATUS_LABEL[row.status]}
                </span>
                {actionable && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      aria-busy={pressed === "approve" || undefined}
                      onClick={() => void act(row.id, "approve")}
                      title="Log to Tempo"
                      className="flex size-5 items-center justify-center rounded text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-400"
                    >
                      {pressed === "approve" ? (
                        <Spinner size="sm" />
                      ) : (
                        <Check size={13} />
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-busy={pressed === "decline" || undefined}
                      onClick={() => void act(row.id, "decline")}
                      title="Decline — don't log this"
                      className="flex size-5 items-center justify-center rounded text-faint hover:bg-raised hover:text-fg disabled:opacity-40"
                    >
                      {pressed === "decline" ? (
                        <Spinner size="sm" />
                      ) : (
                        <X size={13} />
                      )}
                    </button>
                  </>
                )}
                {busy && pressed === null && (
                  <Spinner size="sm" className="text-faint" />
                )}
              </div>
              {row.description && (
                <div className="mt-0.5 truncate text-micro text-faint">
                  {row.description}
                </div>
              )}
              {!row.activityKey && actionable && (
                <div className="mt-0.5 flex items-center gap-1 text-micro text-yellow-600 dark:text-yellow-300">
                  <AlertTriangle size={10} /> no activity key — set one in the
                  Tempo profile before approving
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <ErrorNote message={error} />}
    </div>
  );
}
