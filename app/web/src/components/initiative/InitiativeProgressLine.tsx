import type { InitiativeProgress } from "@assistant/shared";
import { Progress } from "../ui/progress.tsx";

/**
 * @component InitiativeProgressLine
 * @purpose An Initiative's counts in one line: done of total on a bar, then
 *   what is in progress, ready to start and blocked.
 * @useWhen The Initiative page's toolbar and each row of the Initiatives index.
 * @intent The counts are the summary's own (`docs/initiatives.md`, Progress):
 *   in progress and blocked overlap, so they are stated side by side and never
 *   summed. A zero bucket is left out rather than drawn as noise. "Ready to
 *   start" is the map's Ready.
 */
export function InitiativeProgressLine({
  progress,
}: {
  progress: InitiativeProgress;
}) {
  const { total, done, doing, startable, blocked } = progress;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-2">
        <Progress
          value={total === 0 ? 0 : (done / total) * 100}
          aria-label={`${done} of ${total} Tasks done`}
          className="w-24"
        />
        <span className="text-foreground tabular-nums">
          {done}/{total} done
        </span>
      </span>
      {/* The counts are one group, so a narrow screen wraps them together
          rather than leaving one stranded on its own line. */}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {doing > 0 ? (
          <span className="tabular-nums">{doing} in progress</span>
        ) : null}
        {startable > 0 ? (
          // The same token as a node's Ready chip: one word, one colour.
          <span className="font-medium text-primary tabular-nums">
            {startable} ready to start
          </span>
        ) : null}
        {blocked > 0 ? (
          <span className="text-warning tabular-nums">{blocked} blocked</span>
        ) : null}
      </span>
    </span>
  );
}
