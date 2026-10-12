import { createContext, useContext, useMemo } from "react";
import { useNow } from "../hooks/useNow.ts";
import {
  runProgressView,
  type LiveRunProgress,
  type RunProgressQueues,
} from "../lib/runProgress.ts";
import { ProgressIndicator } from "./ProgressIndicator.tsx";
import { Spinner } from "./common/load.tsx";

/** What the viewed session's run is observed doing, for the transcript's progress lines. */
export interface RunProgressContextValue {
  live: LiveRunProgress | null;
  queues: RunProgressQueues;
}

const NO_PROGRESS: RunProgressContextValue = {
  live: null,
  queues: { peers: 0, background: 0 },
};

/**
 * Provided by the transcript host. A context rather than a prop so a progress
 * update re-renders the one line that shows it, never the memoized message
 * rows between the host and that line.
 */
export const RunProgressContext =
  createContext<RunProgressContextValue>(NO_PROGRESS);

/**
 * @component RunProgressLine
 * @purpose The running turn's progress line: what the run is doing, for how
 * long, and what waits behind it — from the runtime's observed progress, with
 * the transcript's own guess (`fallback`) only until that arrives.
 * @useWhen Where the transcript shows a turn is running: under the streaming
 * assistant message, or alone below a prompt no reply has opened for yet.
 * @avoidWhen Anything not running; the line has no idle, held or failed state.
 * @intent "Thinking" for minutes says nothing about whether anything is
 * happening. The line names the observed state instead — a tool running, the
 * model being waited on, a provider retry — and ages it, so a quiet provider
 * reads as quiet and a busy one as busy without opening native logs.
 */
export function RunProgressLine({
  fallback,
  lastBlock,
}: {
  /** The label shown before any progress arrives. */
  fallback: string;
  /** Kind of the streaming message's newest block, when there is one. */
  lastBlock?: string | undefined;
}) {
  const { live, queues } = useContext(RunProgressContext);
  if (!live) return <ProgressIndicator label={fallback} />;
  return <ObservedProgress live={live} lastBlock={lastBlock} queues={queues} />;
}

function ObservedProgress({
  live,
  lastBlock,
  queues,
}: {
  live: LiveRunProgress;
  lastBlock: string | undefined;
  queues: RunProgressQueues;
}) {
  // Ages are shown in whole seconds, so a one-second clock is exact.
  const now = useNow(1000);
  const view = useMemo(
    () => runProgressView(live, now, { lastBlock, queues }),
    [live, now, lastBlock, queues],
  );
  // No `role="status"`, as `ProgressIndicator`: a live region repeating every
  // second would talk over the transcript. The description is the tooltip.
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-1 text-sm"
      title={view.description}
      data-run-progress={view.tone}
    >
      <Spinner
        size="sm"
        className={view.tone === "warning" ? "text-warning" : "text-primary"}
      />
      <span
        className={`shimmer shrink-0 font-medium ${view.tone === "warning" ? "text-warning" : ""}`}
      >
        {view.label}
      </span>
      {view.elapsed !== undefined && (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {view.elapsed}
        </span>
      )}
      {view.details.length > 0 && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {view.details.join(" · ")}
        </span>
      )}
    </div>
  );
}
