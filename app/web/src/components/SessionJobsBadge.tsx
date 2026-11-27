import { Activity } from "lucide-react";
import {
  awaitedBackgroundCount,
  type SessionListItem,
} from "@assistant/shared";

/**
 * How many background processes a session runs, and the words for them. The
 * count covers every process; the words keep the fold's split between jobs
 * somebody waits on and services nobody does. Zero when nothing runs.
 */
export function sessionJobs(activity: SessionListItem["backgroundActivity"]): {
  count: number;
  text: string;
} {
  const count = Math.max(0, activity?.activeCount ?? 0);
  const services = activity?.serviceCount ?? 0;
  const awaited = awaitedBackgroundCount(activity);
  const text = `${[
    ...(awaited > 0
      ? [`${awaited} background job${awaited === 1 ? "" : "s"}`]
      : []),
    ...(services > 0
      ? [`${services} service${services === 1 ? "" : "s"}`]
      : []),
  ].join(" and ")} running`;
  return { count, text };
}

/**
 * @component SessionJobsBadge
 * @purpose The running-jobs marker on a session row: the activity glyph and
 * the count, with the words as its tooltip. Nothing while no job runs.
 * @useWhen A one-line session row that must say WHICH session owns the jobs a
 * cluster's summary counts — the Sessions fold (`ClusterChildRow`) and the
 * composer strip (`SpawnedSessionLedgeRow`) alike.
 */
export function SessionJobsBadge({
  activity,
  labelled = false,
}: {
  activity: SessionListItem["backgroundActivity"];
  /**
   * Speak the words. Off where the row's own accessible name already says
   * them (`ClusterChildRow`).
   */
  labelled?: boolean;
}) {
  const { count, text } = sessionJobs(activity);
  if (count === 0) return null;
  return (
    <span
      title={text}
      className="flex items-center gap-0.5 text-xs tabular-nums text-muted-foreground"
      {...(labelled ? { role: "img", "aria-label": text } : {})}
    >
      <Activity className="size-3" aria-hidden />
      {count}
    </span>
  );
}
