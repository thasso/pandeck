import type {
  CalendarDayMinutesSummary,
  CalendarDayRunHealth,
  CalendarDaySourceHealth,
} from "@assistant/shared";

/**
 * Pure projection of the last collection run's manifest health into the compact
 * data-health header (Daily Scanner v2 phase 5). Disposition-aware: a SKIPPED
 * source (disabled/unconfigured) is never counted as a failure, so the header
 * reads "5/6 sources fresh · 1 skipped" rather than inflating a failure count.
 * All stats come from the manifest via the day-state API — never markdown
 * parsing.
 */
export interface DayHealthSummary {
  asOf: string;
  total: number;
  attempted: number;
  fresh: number;
  partial: number;
  failed: number;
  skipped: number;
  changes: number;
  /** Overall tone for the header dot: everything fresh, some degradation, or a failure. */
  tone: "fresh" | "partial" | "failed";
  headline: string;
}

export function summarizeDayHealth(
  run: CalendarDayRunHealth | null | undefined,
): DayHealthSummary | null {
  if (!run) return null;
  const sources = run.sources ?? [];
  const attemptedSources = sources.filter((s) => s.disposition === "attempted");
  const fresh = attemptedSources.filter((s) => s.result === "complete").length;
  const partial = attemptedSources.filter((s) => s.result === "partial").length;
  const failed = attemptedSources.filter((s) => s.result === "failed").length;
  const skipped = sources.filter((s) => s.disposition === "skipped").length;

  const parts: string[] = [];
  if (attemptedSources.length > 0)
    parts.push(`${fresh}/${attemptedSources.length} sources fresh`);
  if (partial > 0) parts.push(`${partial} partial`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (parts.length === 0) parts.push("no sources");

  return {
    asOf: run.asOf,
    total: sources.length,
    attempted: attemptedSources.length,
    fresh,
    partial,
    failed,
    skipped,
    changes: run.changesSinceLastRun ?? 0,
    tone: failed > 0 ? "failed" : partial > 0 ? "partial" : "fresh",
    headline: parts.join(" · "),
  };
}

/** Compact minutes-substage summary for the panel; null when nothing was discovered. */
export function minutesSummaryLabel(
  minutes: CalendarDayMinutesSummary | undefined | null,
): string | null {
  if (!minutes || minutes.discovered === 0) return null;
  const parts: string[] = [];
  if (minutes.processed > 0) parts.push(`${minutes.processed} processed`);
  if (minutes.tasksCreated > 0)
    parts.push(
      `${minutes.tasksCreated} task${minutes.tasksCreated === 1 ? "" : "s"}`,
    );
  if (minutes.cached > 0) parts.push(`${minutes.cached} cached`);
  if (minutes.deferred > 0) parts.push(`${minutes.deferred} deferred`);
  if (minutes.failed > 0) parts.push(`${minutes.failed} failed`);
  return parts.length > 0
    ? parts.join(" · ")
    : `${minutes.discovered} discovered`;
}

/** Per-source one-line label for the expandable panel, disposition-aware. */
export function sourceHealthLabel(source: CalendarDaySourceHealth): string {
  if (source.disposition === "skipped")
    return `skipped${source.skipReason ? ` (${source.skipReason})` : ""}`;
  const result = source.result ?? "—";
  const delta =
    source.added !== undefined || source.changed !== undefined
      ? ` · +${source.added ?? 0}/~${source.changed ?? 0}`
      : "";
  return source.error ? `${result} — ${source.error}` : `${result}${delta}`;
}
