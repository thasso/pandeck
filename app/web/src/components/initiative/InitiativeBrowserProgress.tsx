import type { InitiativeProgress } from "@assistant/shared";
import type { InitiativeBrowserCounts } from "../../lib/initiativeBrowserCounts.ts";
import { Skeleton } from "../common/load.tsx";
import { Progress } from "../ui/progress.tsx";

/** Browser-only state counts. Blocked is state, not an alert. */
export function InitiativeBrowserProgress({ progress, counts, countChars, label, loading = false }: {
  progress: Pick<InitiativeProgress, "done" | "total">;
  counts?: InitiativeBrowserCounts | undefined;
  countChars: number;
  label: string;
  loading?: boolean;
}) {
  const { done, total } = counts ?? progress;
  const description = counts
    ? `${label}: ${counts.startable} ready, ${counts.doing} in progress, ${counts.blocked} blocked, ${done} done or archived, ${total} total Tasks`
    : `${label}: ${done} of ${total} Tasks done; state breakdown ${loading ? "loading" : "unavailable"}`;
  return (
    <span
      role="img"
      aria-label={description}
      title={description}
      className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
    >
      {total > 0 ? (
        <Progress
          value={(done / total) * 100}
          className={`w-10 ${done === total ? "[&_[data-slot=progress-indicator]]:bg-success" : ""}`}
          aria-hidden
        />
      ) : null}
      <span aria-hidden className="shrink-0 whitespace-nowrap text-right" style={{ width: `${countChars}ch` }}>
        {counts ? (
          <>
            <span className={counts.startable > 0 ? "text-primary/80" : "text-muted-foreground"}>{counts.startable}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className={counts.doing > 0 ? "text-info/80" : "text-muted-foreground"}>{counts.doing}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className={counts.blocked > 0 ? "text-warning/80" : "text-muted-foreground"}>{counts.blocked}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className={done > 0 ? "text-success/80" : "text-muted-foreground"}>{done}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-muted-foreground">{total}</span>
          </>
        ) : loading ? <Skeleton className="inline-block h-3 w-full" /> : `${done}/${total}`}
      </span>
    </span>
  );
}
