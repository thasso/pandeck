import { ChevronDown, ChevronUp, Users, X } from "lucide-react";
import {
  clusterBubbleDismissible,
  sessionClusterBubbleLabel,
  spawnedSessionsSummary,
  sessionStatusBadge,
  type SessionStatusTone,
  type SpawnedSessionsView,
} from "../lib/sessionInbox.ts";
import { ClusterChildRow } from "./ClusterChildRow.tsx";
import { Spinner } from "./ui/load.tsx";
import { useElapsedNow } from "./useElapsedNow.ts";

/**
 * How many peers the ledge lists before folding the rest behind "Show N more".
 * Same bound, and the same reason, as the background ledge's: a strip on the
 * composer states a session's work, and a list that grows without limit is
 * what turns it into a second browser. The rest are one tap away rather than
 * off in the Sessions inbox, because a coordinator with many peers is exactly
 * the session whose user wants them all on the surface they are typing into —
 * and the opened list scrolls in place, so showing them all never pushes the
 * composer off the screen.
 */
export const SPAWNED_SESSIONS_LEDGE_LIMIT = 10;

/** Same semantic tones the cards and rows use, at the bubble badge's weight. */
const BADGE_TONE: Record<SessionStatusTone, string> = {
  accent: "bg-accent-soft text-accent",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
  muted: "bg-line text-muted",
};

export interface SpawnedSessionsLedgeProps {
  sessionId: string;
  /** The peers of this session; the ledge exists only while it has some. */
  view: SpawnedSessionsView;
  open: boolean;
  onToggle: () => void;
  /** Open one peer, exactly as its row in the Sessions inbox does. */
  onOpenSession: (sessionId: string) => void;
  /**
   * List every peer, not just the first {@link SPAWNED_SESSIONS_LEDGE_LIMIT}.
   * The host answers by handing back a view with no `hidden` rows.
   */
  onShowAll: () => void;
  /**
   * Settle one peer. The strip's ONE lifecycle action, and only ever on a
   * bubbled failure the user has moved on from — the same dismissal the
   * cluster card offers, in the same place the failure is shown.
   */
  onSettleSession: (sessionId: string, settled: boolean) => void;
}

/**
 * @component SpawnedSessionsLedge
 * @purpose The composer's one-line answer to "what did this chat spawn", and
 * the peers themselves on a tap.
 * @useWhen The session on screen has spawned peer sessions
 * (`session_spawn`); the host renders nothing otherwise, so a chat that
 * delegated nothing pays no line.
 * @avoidWhen Listing a session's lineage or its whole relation graph — that is
 * the inspector's "Spawned sessions" group, which holds the durable edges
 * whether or not anything is live.
 * @intent It reads the session LIST this browser already holds and subscribes
 * to nothing: the peers are rows of the same list the Sessions inbox shapes,
 * so the ledge shows the same state, in the same words, through the same row —
 * newest activity first, so what a peer just did is at the top, with the
 * older ones folded behind a "Show N more" at the foot of a list that scrolls
 * in place. A peer waiting on a human or holding a failure is NAMED on the collapsed
 * line, because a summary may hide how much is running and never what needs
 * answering — and, when that is a failure the user has moved on from, dismissed
 * from here, which is the cluster card's own dismissal (that peer's Settle).
 * Nothing else lifecycle-shaped is here: Archive, Delete and a peer's own
 * Settle stay in the inbox, and what this strip owns is the link.
 * @related ComposerLedge, ClusterChildRow, BackgroundWorkLedge, sessionInbox
 * (lib)
 */
export function SpawnedSessionsLedge({
  sessionId,
  view,
  open,
  onToggle,
  onOpenSession,
  onShowAll,
  onSettleSession,
}: SpawnedSessionsLedgeProps) {
  const working = view.counts.working > 0;
  const now = useElapsedNow(working);
  const summary = spawnedSessionsSummary(view);
  const bubbled = view.bubbled;
  const bubbleTone = bubbled
    ? sessionStatusBadge(bubbled.session, bubbled.status, now)?.tone
    : undefined;
  const bubbleTitle = bubbled
    ? bubbled.session.title.trim() || "Untitled session"
    : "";
  const dismissBubble = bubbled ? clusterBubbleDismissible(bubbled) : false;
  const Chevron = open ? ChevronDown : ChevronUp;
  return (
    <div data-spawned-sessions-ledge className="min-w-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`spawned-sessions-ledge-${sessionId}`}
        // The line carries no verb (`sessionClusterSummary`), and unlike a
        // cluster card there is no title above it to supply one, so the spoken
        // label says whose sessions these are. SPAWNED, not "coordinated": this
        // strip deliberately keeps a peer the user has taken over, and claiming
        // to coordinate one the user now drives would be a relation that no
        // longer holds.
        aria-label={`${open ? "Hide" : "Show"} the sessions this chat spawned — ${summary}`}
        className={`flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          working ? "text-accent hover:text-accent" : "text-muted hover:text-fg"
        }`}
      >
        {/* Same treatment as the cluster card's fold: while a peer runs, the
            spinner REPLACES the peer glyph and the line runs in the accent. The
            session you are typing into is often quiet while its peers work, so
            this strip is the only place that run is visible, and a static count
            reads as a stalled cluster. */}
        {working ? (
          <Spinner size="xs" className="shrink-0" />
        ) : (
          <Users size={13} className="shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <Chevron size={14} className="shrink-0 text-faint" aria-hidden="true" />
      </button>
      {/* Under the summary rather than beside it, exactly as the cluster card
          places it: a line of its own costs height only while a peer needs
          answering, and it keeps the two strips' chevrons in one column. */}
      {bubbled ? (
        <div className="flex min-w-0 items-center gap-1 px-3 pb-1.5">
          <button
            type="button"
            title={`Open “${bubbleTitle}”`}
            onClick={() => onOpenSession(bubbled.session.id)}
            className={`flex min-w-0 items-center rounded-full px-1.5 py-px text-micro font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              BADGE_TONE[bubbleTone ?? "accent"]
            }`}
          >
            <span className="min-w-0 truncate">
              {sessionClusterBubbleLabel(bubbled, now)}
            </span>
          </button>
          {/* A peer failure the user has moved on from is dismissed WHERE it is
              shown, exactly as on the cluster card: it sends that peer's own
              Settle, so the peer lands on the Settled shelf and the bubble goes
              with it. Nothing is archived and nothing is deleted. */}
          {dismissBubble ? (
            <button
              type="button"
              title={`Dismiss — settle “${bubbleTitle}”`}
              aria-label={`Dismiss the failure in “${bubbleTitle}”`}
              onClick={() => onSettleSession(bubbled.session.id, true)}
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint transition-colors hover:bg-panel hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X size={12} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div
          id={`spawned-sessions-ledge-${sessionId}`}
          className="border-t border-line"
        >
          {/* The rows scroll in a box of bounded height, so listing every
              peer changes what is in the box and never how tall the
              composer's shelf is. Ten rows fill it on a laptop, which is why
              the button below is OUTSIDE it: at the foot of the scroll box it
              would sit past the fold, and a control the user has to know to
              scroll for is not offered. */}
          <div
            data-spawned-sessions-rows
            className="max-h-[40vh] overflow-y-auto py-1"
          >
            {view.rows.map((card) => (
              <ClusterChildRow
                key={card.session.id}
                card={card}
                now={now}
                active={false}
                tabbable
                onOpen={onOpenSession}
              />
            ))}
          </div>
          {/* Under the list, always in view: the rows above are the newest,
              and this is where the older ones are. */}
          {view.hidden > 0 ? (
            <button
              type="button"
              onClick={onShowAll}
              className="flex h-8 w-full items-center gap-2 border-t border-line px-3 text-left text-caption text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            >
              <ChevronDown
                size={13}
                className="shrink-0 text-faint"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">Show {view.hidden} more</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
