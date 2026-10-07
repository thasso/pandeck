import { useMemo } from "react";
import { Activity, ChevronDown, ChevronUp, Square } from "lucide-react";
import type {
  BackgroundWorkItemSummary,
  SessionBackgroundActivity,
} from "@assistant/shared";
import {
  backgroundActivityText,
  backgroundWorkListView,
} from "../lib/backgroundWork.ts";
import { elapsedLabel } from "../lib/relativeTime.ts";
import { BackgroundWorkRow } from "./BackgroundWorkRow.tsx";
import { useElapsedNow } from "./useElapsedNow.ts";
import { Button } from "@/components/ui/button";

/** How many active rows the ledge lists before pointing at the registry. */
const BACKGROUND_WORK_LEDGE_LIMIT = 10;

export interface BackgroundWorkLedgeProps {
  sessionId: string;
  /** The session-list projection; the ledge exists only while this is set. */
  activity: SessionBackgroundActivity;
  /** The registry rows this browser holds; empty until the ledge subscribes. */
  items: BackgroundWorkItemSummary[];
  open: boolean;
  onToggle: () => void;
  stopPending: ReadonlySet<string>;
  onStop: (itemId: string) => void;
  onStopAll: (ownerSessionId: string) => void;
  /** Open one item's row on the registry page. */
  onOpenRegistry: (itemId: string) => void;
}

/**
 * @component BackgroundWorkLedge
 * @purpose The composer's one-line answer to "what is running in the
 * background for this session", and the list behind it on a tap.
 * @useWhen The session screen's session owns active background work or holds
 * a retained host; the host renders nothing otherwise, so the line costs no
 * space while idle.
 * @avoidWhen Showing finished work — the inspector section and the registry
 * hold history; this strip is LIVE state only.
 * @intent The collapsed line reads from the session list's own projection and
 * subscribes to nothing. Opening it is what subscribes the browser to the
 * registry topic (the host gates that on `open`), so the rows are the
 * authoritative ones the registry shows, with the same Stop control.
 * @related ComposerLedge, BackgroundWorkRow, BackgroundWorkSection
 */
export function BackgroundWorkLedge({
  sessionId,
  activity,
  items,
  open,
  onToggle,
  stopPending,
  onStop,
  onStopAll,
  onOpenRegistry,
}: BackgroundWorkLedgeProps) {
  const now = useElapsedNow(activity.activeCount > 0);
  const active = useMemo(
    () =>
      backgroundWorkListView(items, {
        filter: "active",
        ownerSessionId: sessionId,
        limit: BACKGROUND_WORK_LEDGE_LIMIT,
      }),
    [items, sessionId],
  );
  const summary = backgroundActivityText(activity) ?? "Background work";
  const age =
    activity.activeCount > 0 && activity.oldestStartedAt > 0
      ? elapsedLabel(now - activity.oldestStartedAt)
      : undefined;
  const Chevron = open ? ChevronDown : ChevronUp;
  return (
    <div data-background-ledge className="min-w-0">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`background-ledge-${sessionId}`}
      >
        <Activity aria-hidden="true" className="text-primary" />
        <span className="min-w-0 flex-1 truncate text-left">
          {summary}
          {age ? <span className="text-muted-foreground"> · {age}</span> : null}
        </span>
        <Chevron aria-hidden="true" />
      </Button>
      {open ? (
        <div
          id={`background-ledge-${sessionId}`}
          className="flex max-h-72 flex-col gap-2 overflow-y-auto border-t p-2 text-sm text-muted-foreground"
        >
          {active.total > 0 ? (
            <ul className="flex flex-col gap-2">
              {active.rows.map((item) => (
                <BackgroundWorkRow
                  key={item.id}
                  item={item}
                  now={now}
                  stopPending={stopPending.has(item.id)}
                  onStop={onStop}
                  onOpenRegistry={onOpenRegistry}
                />
              ))}
            </ul>
          ) : activity.activeCount > 0 ? (
            <p>Loading the rows…</p>
          ) : (
            <p>
              Nothing is running; this session still holds a retained background
              host.
            </p>
          )}
          {active.hidden > 0 ? (
            <p>{active.hidden} more in the registry.</p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => onStopAll(sessionId)}
          >
            <Square aria-hidden="true" />
            Stop all background work in this session
          </Button>
        </div>
      ) : null}
    </div>
  );
}
