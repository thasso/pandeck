import { memo, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronRight, Square } from "lucide-react";
import type {
  BackgroundWorkItemSummary,
  SessionBackgroundActivity,
} from "@assistant/shared";
import {
  backgroundActivityCounts,
  backgroundActivityText,
  backgroundWorkAgeLabel,
  backgroundWorkDeadlineLabel,
  backgroundWorkListView,
  backgroundWorkStopDisabledReason,
} from "../lib/backgroundWork.ts";
import { elapsedLabel } from "../lib/relativeTime.ts";
import { IconButton } from "./common/IconButton.tsx";
import { useElapsedNow } from "./useElapsedNow.ts";
import { Button } from "@/components/ui/button";
import { Item, ItemActions } from "@/components/ui/item";

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
  // The line shows counts (`1 job · 2 services`); the sentence they abbreviate
  // is the button's name and tooltip.
  const summary = backgroundActivityText(activity) ?? "Background work";
  const counts = backgroundActivityCounts(activity) ?? "Background work";
  const age =
    activity.activeCount > 0 && activity.oldestStartedAt > 0
      ? elapsedLabel(now - activity.oldestStartedAt)
      : undefined;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div data-background-ledge className="min-w-0">
      <Button
        variant="ghost"
        size="sm"
        // Square, and filled under Button's transparent 1px border
        // (`bg-clip-padding`), so the header fills the strip edge to edge.
        className="w-full justify-start rounded-none bg-clip-border text-sm text-muted-foreground"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`background-ledge-${sessionId}`}
        aria-label={`${summary}${age ? `, oldest started ${age} ago` : ""}`}
        title={summary}
      >
        <Activity aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">
          {counts}
          {age ? <span className="text-muted-foreground"> · {age}</span> : null}
        </span>
        <Chevron aria-hidden="true" />
      </Button>
      {open ? (
        // Rows like the spawned-session strip's: one line each, edge to edge,
        // hairline-separated. The registry page keeps the full card.
        <div
          id={`background-ledge-${sessionId}`}
          className="max-h-72 divide-y overflow-y-auto border-t text-sm text-muted-foreground"
        >
          {active.total > 0 ? (
            <ul className="divide-y">
              {active.rows.map((item) => (
                <BackgroundWorkLedgeRow
                  key={item.id}
                  item={item}
                  now={now}
                  stopPending={stopPending.has(item.id)}
                  onStop={onStop}
                />
              ))}
            </ul>
          ) : (
            <p className="px-2.5 py-1.5">
              {activity.activeCount > 0
                ? "Loading…"
                : "Nothing is running; this session holds a retained host."}
            </p>
          )}
          {active.hidden > 0 ? (
            <p className="px-2.5 py-1.5">
              {active.hidden} more on the Background tasks page
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One background item in the composer strip: what it is, how long it has run,
 * how long it has left, and Stop. The command it runs is one tap away under
 * the title; everything else (host, evidence, facts) is the registry's.
 */
const BackgroundWorkLedgeRow = memo(function BackgroundWorkLedgeRow({
  item,
  now,
  stopPending,
  onStop,
}: {
  item: BackgroundWorkItemSummary;
  now: number;
  stopPending: boolean;
  onStop: (itemId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const command = item.command?.trim();
  const stopBlocked = backgroundWorkStopDisabledReason(item);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li data-background-item={item.id} className="min-w-0">
      <Item
        size="xs"
        className="flex-nowrap gap-1 rounded-none py-0 pr-1.5 pl-0 hover:bg-muted dark:hover:bg-muted/50"
      >
        <Button
          variant="ghost"
          size="sm"
          // The whole row takes the hover (its `Item`), not just this toggle
          // beside the actions; ghost styles `aria-expanded` like hover, so
          // that is reset too.
          className="h-7 min-w-0 flex-1 justify-start rounded-none bg-clip-border text-sm font-normal text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-muted-foreground dark:hover:bg-transparent"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          disabled={!command}
          title={
            command
              ? open
                ? "Hide the command"
                : "Show the command"
              : undefined
          }
        >
          <Chevron aria-hidden="true" className={command ? "" : "invisible"} />
          <span className="min-w-0 truncate text-foreground">{item.label}</span>
        </Button>
        <ItemActions className="gap-1.5">
          <span className="text-xs whitespace-nowrap tabular-nums">
            {backgroundWorkAgeLabel(item, now)} ·{" "}
            {backgroundWorkDeadlineLabel(item, now)}
          </span>
          <IconButton
            label={`Stop ${item.label}`}
            title={stopBlocked ?? "Stop"}
            size="icon-xs"
            busy={stopPending}
            disabled={Boolean(stopBlocked)}
            onClick={() => onStop(item.id)}
          >
            {/* Filled, like the composer's own stop: an outlined square reads
                as a checkbox. */}
            <Square className="size-2.5 fill-current" />
          </IconButton>
        </ItemActions>
      </Item>
      {open && command ? (
        <pre
          // Plain text under the title: `pl-7` is the toggle's own padding
          // plus its chevron and gap, so the command starts where the title
          // does; `pr-2.5` matches the row's other edge.
          className="max-h-40 overflow-auto pt-0.5 pr-2.5 pb-2 pl-7 font-mono text-xs wrap-anywhere whitespace-pre-wrap text-muted-foreground"
        >
          {command}
          {item.commandTruncated ? "\n…" : ""}
        </pre>
      ) : null}
    </li>
  );
});
