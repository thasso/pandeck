import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity } from "lucide-react";
import type {
  BackgroundWorkItemSummary,
  SessionListItem,
} from "@assistant/shared";
import {
  backgroundWorkListView,
  isActiveBackgroundWork,
  BACKGROUND_WORK_PAGE_SIZE,
  type BackgroundWorkFilter,
} from "../lib/backgroundWork.ts";
import { useElapsedNow } from "./useElapsedNow.ts";
import { useListScroll } from "../hooks/useListScroll.ts";
import { BackgroundWorkRow } from "./BackgroundWorkRow.tsx";
import { PageHeader, type PageHeaderBack } from "./PageHeader.tsx";
import { EmptyBox } from "./common/load.tsx";

const FILTERS: { id: BackgroundWorkFilter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "recent", label: "Recent" },
  { id: "all", label: "All" },
];

export interface BackgroundTasksPageProps {
  /** The `background` topic's rows, held only while this route is open. */
  items: BackgroundWorkItemSummary[];
  /**
   * The server's snapshot was a window over a longer history. The page says so
   * rather than letting "Show N more of M" pass a partial list off as the whole
   * registry — the counts here are counts of what this browser HAS.
   */
  truncated?: boolean;
  /** Session summaries, for owner titles and the both-ways link. */
  sessions: SessionListItem[];
  /** The item the `?task=` anchor addressed, if any. */
  anchoredId?: string | undefined;
  /** Ids this browser has sent a Stop for and not yet seen an answer for. */
  stopPending: ReadonlySet<string>;
  onStop: (itemId: string) => void;
  onStopAllForOwner: (ownerSessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  back?: PageHeaderBack | undefined;
}

/**
 * @component BackgroundTasksPage
 * @purpose The canonical registry of session-owned background work: every
 * active and recent item across every session, filtered and paged, each row
 * linking back to the session that owns it, with Stop and per-owner Stop-all.
 * @useWhen The `/background-tasks` route is open.
 * @avoidWhen Listing delegated agents — those are subagent threads and stay
 * their own surface — or showing one session's work inside its own inspector.
 * @intent A human can find and stop running work WITHOUT opening the session
 * that started it. Nothing here is lifecycle authority: filtering and paging are
 * views over the authoritative rows, Stop calls the server's domain service, and
 * a row changes only when an event says it did.
 * @related BackgroundWorkRow, BackgroundWorkSection, backgroundWork (lib)
 */
export function BackgroundTasksPage({
  items,
  truncated = false,
  sessions,
  anchoredId,
  stopPending,
  onStop,
  onStopAllForOwner,
  onOpenSession,
  back,
}: BackgroundTasksPageProps) {
  // The page owns its own ticker (ages and deadlines re-label every second
  // while anything runs) rather than taking one from the shell: no other surface
  // shares it, and every row memoizes on the RENDERED label.
  const now = useElapsedNow(items.some(isActiveBackgroundWork));
  // An anchored item is the reason this route was opened, so the filter starts
  // wide enough to show it — decided in the initial state rather than corrected
  // by an effect, so a direct reload never paints an empty Active list first.
  const [filter, setFilter] = useState<BackgroundWorkFilter>(() =>
    anchoredId ? "all" : "active",
  );
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(BACKGROUND_WORK_PAGE_SIZE);
  // A deep link is its own reading position, so it OVERRIDES the remembered one:
  // restoring where this browser last left the list would fight the scroll below
  // and could land the reader anywhere but on the row they followed a link to.
  const scrollRef = useListScroll({
    listKey: anchoredId ? null : `background-tasks:${filter}`,
  });
  const anchorRef = useRef<HTMLElement | null>(null);
  const scrolledTo = useRef<string | null>(null);

  const ownerTitles = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );

  // Arriving at another anchor while the page is already open widens it again.
  useEffect(() => {
    if (anchoredId) setFilter("all");
  }, [anchoredId]);

  const view = useMemo(
    () =>
      backgroundWorkListView(items, {
        filter,
        query,
        limit,
        ownerTitles,
        ...(anchoredId ? { pinnedId: anchoredId } : {}),
      }),
    [items, filter, query, limit, ownerTitles, anchoredId],
  );
  const anchorRendered = anchoredId
    ? view.rows.some((item) => item.id === anchoredId)
    : false;

  // The registry arrives on the topic AFTER the route renders, so the scroll
  // waits for the row rather than for the mount, and runs once per anchor: a
  // later rebroadcast must not yank a reader who has since scrolled away.
  useEffect(() => {
    if (!anchoredId || !anchorRendered) return;
    if (scrolledTo.current === anchoredId) return;
    scrolledTo.current = anchoredId;
    const node = anchorRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    // Focus follows the scroll so a keyboard reader lands on the row too, not
    // merely at its pixels.
    node.focus({ preventScroll: true });
  }, [anchoredId, anchorRendered]);

  // Paging resets when the question changes: "show 75" answers the previous
  // filter, and carrying it over silently widens the next one.
  useEffect(() => setLimit(BACKGROUND_WORK_PAGE_SIZE), [filter, query]);

  const owners = useMemo(
    () =>
      [...new Set(view.rows.map((item) => item.ownerSessionId))].filter(
        (ownerSessionId) =>
          view.rows.some(
            (item) =>
              item.ownerSessionId === ownerSessionId &&
              (item.state === "running" || item.state === "pending-launch"),
          ),
      ),
    [view.rows],
  );

  const handleOpenOwner = useCallback(
    (sessionId: string) => onOpenSession(sessionId),
    [onOpenSession],
  );

  return (
    <div className="flex h-full w-full flex-col bg-surface text-fg">
      <PageHeader
        back={back}
        icon={<Activity size={16} />}
        iconTone="accent"
        title="Background processes"
        subtitle={
          view.activeTotal === 1 ? "1 running" : `${view.activeTotal} running`
        }
      />
      <div className="border-b border-line px-4 py-3">
        <div
          role="tablist"
          aria-label="Filter background work"
          className="flex flex-wrap items-center gap-2"
        >
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={filter === entry.id}
              onClick={() => setFilter(entry.id)}
              className={`h-9 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                filter === entry.id
                  ? "bg-accent text-primary"
                  : "text-muted-foreground hover:bg-panel hover:text-fg"
              }`}
            >
              {entry.label}
            </button>
          ))}
          <label className="ml-auto min-w-0 flex-1 sm:max-w-xs">
            <span className="sr-only">Search background work</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search label or session"
              className="settings-input h-9 w-full"
            />
          </label>
        </div>
        {owners.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {owners.map((ownerSessionId) => (
              <button
                key={ownerSessionId}
                type="button"
                onClick={() => onStopAllForOwner(ownerSessionId)}
                className="h-9 rounded-lg border border-line px-3 text-sm text-muted-foreground transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Stop all in {ownerTitles.get(ownerSessionId) || "this session"}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl">
          {view.total === 0 ? (
            <EmptyBox>
              {filter === "active"
                ? "No background work is running. Agents start it from an owning session; nothing resumes after a server restart."
                : "No background work matches this view."}
            </EmptyBox>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {view.rows.map((item) => (
                  <BackgroundWorkRow
                    key={item.id}
                    item={item}
                    now={now}
                    ownerTitle={ownerTitles.get(item.ownerSessionId)}
                    anchored={item.id === anchoredId}
                    {...(item.id === anchoredId ? { rowRef: anchorRef } : {})}
                    stopPending={stopPending.has(item.id)}
                    onStop={onStop}
                    onOpenOwner={handleOpenOwner}
                  />
                ))}
              </ul>
              {view.hidden > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    setLimit((value) => value + BACKGROUND_WORK_PAGE_SIZE)
                  }
                  className="mt-3 h-9 w-full rounded-lg border border-line text-sm text-muted-foreground transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Show {Math.min(view.hidden, BACKGROUND_WORK_PAGE_SIZE)} more
                  of {view.total}
                </button>
              ) : null}
            </>
          )}
          {/* The server sent a window, not the whole registry, so the end of
              this list is the end of what ARRIVED, not the end of the history —
              including when the window holds nothing this filter matches. Said
              plainly, because paging further is a request this surface cannot
              make yet. */}
          {truncated ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Only the most recent background work is loaded; older items are
              not shown.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
