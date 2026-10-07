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
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`background-ledge-${sessionId}`}
        className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-sm text-muted-foreground transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <Activity
          size={13}
          className="shrink-0 text-primary"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">
          {summary}
          {age ? <span className="text-faint"> · {age}</span> : null}
        </span>
        <Chevron size={14} className="shrink-0 text-faint" aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={`background-ledge-${sessionId}`}
          className="max-h-[40vh] overflow-y-auto border-t border-line px-2 py-2"
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
            <p className="px-1 text-sm text-faint">Loading the rows…</p>
          ) : (
            <p className="px-1 text-sm text-muted-foreground">
              Nothing is running; this session still holds a retained background
              host.
            </p>
          )}
          {active.hidden > 0 ? (
            <p className="mt-2 px-1 text-sm text-faint">
              {active.hidden} more in the registry.
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => onStopAll(sessionId)}
            className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-line text-sm text-muted-foreground transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Square size={12} aria-hidden="true" />
            Stop all background work in this session
          </button>
        </div>
      ) : null}
    </div>
  );
}
