import { ChevronDown, ChevronUp, Hourglass, Users, X } from "lucide-react";
import {
  clusterBubbleDismissible,
  sessionClusterBubbleLabel,
  spawnedSessionsSummary,
  stallLabel,
  stallMore,
  stallParts,
  stallTarget,
  stallTitle,
  sessionStatusBadge,
  type SpawnedSessionsView,
} from "../lib/sessionInbox.ts";
import { ClusterChildRow } from "./ClusterChildRow.tsx";
import { Spinner } from "./common/load.tsx";
import { useElapsedNow } from "./useElapsedNow.ts";
import { Button } from "@/components/ui/button";
import { IconButton } from "./common/IconButton.tsx";

export interface SpawnedSessionsLedgeProps {
  sessionId: string;
  /** The peers of this session; the ledge exists only while it has some. */
  view: SpawnedSessionsView;
  open: boolean;
  onToggle: () => void;
  /** Open one peer, exactly as its row in the Sessions inbox does. */
  onOpenSession: (sessionId: string) => void;
  /**
   * Show or hide the settled peers in the tree. The host answers by handing
   * back a view built with or without them (`settledShown`).
   */
  onToggleSettled: () => void;
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
 * as a tree of every peer at every depth, newest activity first among
 * siblings, in a list that scrolls in place. Dormant settled peers are
 * history: never counted, and listed only behind a "Show N settled" at the
 * foot of the list. A settled peer running or holding jobs again is live, and
 * is listed and counted like any other.
 * A peer waiting on a human or holding a failure is NAMED on the collapsed
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
  onToggleSettled,
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
  // The tree has stopped and a peer still owes this chat a reply: on a line
  // of its own, like the bubble, naming the peer to poke.
  const stallLine = view.stall ? (
    <div className="flex min-w-0 items-center gap-1 px-3 pb-1.5">
      <Button
        variant="secondary"
        size="xs"
        className="min-w-0"
        title={`Open “${stallTitle(view.stall)}”`}
        aria-label={`Stalled: ${stallLabel(view.stall)}`}
        onClick={() => {
          if (view.stall) onOpenSession(stallTarget(view.stall).id);
        }}
      >
        <Hourglass aria-hidden="true" className="text-warning" />
        {stallParts(view.stall).before ? (
          <span>{stallParts(view.stall).before}</span>
        ) : null}
        <span className="min-w-0 truncate">{stallParts(view.stall).title}</span>
        {stallParts(view.stall).after ? (
          <span>{stallParts(view.stall).after}</span>
        ) : null}
        {stallMore(view.stall) ? <span>{stallMore(view.stall)}</span> : null}
      </Button>
    </div>
  ) : null;
  // A chat that spawned nothing can still be owed a reply by a session it
  // asked: then the strip is that one line, and claims to have spawned no one.
  if (view.counts.total === 0 && view.settled === 0)
    return (
      <div data-spawned-sessions-ledge className="min-w-0 pt-1.5">
        {stallLine}
      </div>
    );
  return (
    <div data-spawned-sessions-ledge className="min-w-0">
      <Button
        variant="ghost"
        size="sm"
        className={
          working ? "w-full justify-start text-primary" : "w-full justify-start"
        }
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
      >
        {/* Same treatment as the cluster card's fold: while a peer runs, the
            spinner REPLACES the peer glyph and the line runs in the accent. The
            session you are typing into is often quiet while its peers work, so
            this strip is the only place that run is visible, and a static count
            reads as a stalled cluster. */}
        {working ? <Spinner size="xs" /> : <Users aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        <Chevron aria-hidden="true" />
      </Button>
      {/* Under the summary rather than beside it, exactly as the cluster card
          places it: a line of its own costs height only while a peer needs
          answering, and it keeps the two strips' chevrons in one column. */}
      {bubbled ? (
        <div className="flex min-w-0 items-center gap-1 px-3 pb-1.5">
          <Button
            variant={bubbleTone === "danger" ? "destructive" : "secondary"}
            size="xs"
            className="min-w-0"
            title={`Open “${bubbleTitle}”`}
            onClick={() => onOpenSession(bubbled.session.id)}
          >
            <span className="min-w-0 truncate">
              {sessionClusterBubbleLabel(bubbled, now)}
            </span>
          </Button>
          {/* A peer failure the user has moved on from is dismissed WHERE it is
              shown, exactly as on the cluster card: it sends that peer's own
              Settle, so the peer lands on the Settled shelf and the bubble goes
              with it. Nothing is archived and nothing is deleted. */}
          {dismissBubble ? (
            <IconButton
              size="icon-xs"
              label={`Dismiss the failure in “${bubbleTitle}”`}
              onClick={() => onSettleSession(bubbled.session.id, true)}
            >
              <X aria-hidden />
            </IconButton>
          ) : null}
        </div>
      ) : null}
      {stallLine}
      {open ? (
        <div id={`spawned-sessions-ledge-${sessionId}`} className="border-t">
          {/* The rows scroll in a box of bounded height, so listing every
              peer changes what is in the box and never how tall the
              composer's shelf is. The settled toggle below is OUTSIDE it: at
              the foot of the scroll box it would sit past the fold, and a
              control the user has to know to scroll for is not offered. */}
          <div
            data-spawned-sessions-rows
            className="max-h-72 overflow-y-auto border-b py-1"
          >
            {view.rows.map((card) => (
              <ClusterChildRow
                key={card.session.id}
                card={card}
                now={now}
                active={false}
                relation="spawned"
                tabbable
                onOpen={onOpenSession}
              />
            ))}
          </div>
          {/* Under the list, always in view: the rows above are what is
              going on now, and this is where what already ended is. */}
          {view.settled > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              aria-expanded={view.settledShown}
              onClick={onToggleSettled}
            >
              <ChevronDown
                aria-hidden="true"
                className={view.settledShown ? "rotate-180" : ""}
              />
              <span className="min-w-0 truncate">
                {view.settledShown
                  ? "Hide settled"
                  : `Show ${view.settled} settled`}
              </span>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
