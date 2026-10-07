import { memo, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Hourglass,
  Users,
  X,
} from "lucide-react";
import type { SessionListItem } from "@assistant/shared";
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
  type SessionInboxCard,
  type SpawnedSessionsView,
} from "../lib/sessionInbox.ts";
import { relativeAge } from "../lib/relativeTime.ts";
import { THINKING_LABELS } from "./common/ModelThinkingSelect.tsx";
import { ProviderIcon } from "./common/ProviderIcon.tsx";
import { SessionStatusBadge } from "./SessionStatusBadge.tsx";
import { SessionTitleText } from "./SessionTitleText.tsx";
import { Item, ItemActions } from "@/components/ui/item";
import { Spinner } from "./common/load.tsx";
import { useElapsedNow } from "./useElapsedNow.ts";
import { Button } from "@/components/ui/button";
import { IconButton } from "./common/IconButton.tsx";

/** What the host can resolve about a peer beyond its list row. */
export interface SpawnedSessionDetails {
  /** The account (credential profile) name it runs on. */
  account?: string | undefined;
  /** Its worktree's branch, when it has one and the host knows it. */
  branch?: string | undefined;
}

export interface SpawnedSessionsLedgeProps {
  sessionId: string;
  /**
   * Account and branch for a peer's expanded details. Must be referentially
   * stable while its answers are: the rows are memoized on it.
   */
  describeSession?:
    ((session: SessionListItem) => SpawnedSessionDetails) | undefined;
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
  describeSession,
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
  const Chevron = open ? ChevronDown : ChevronRight;
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
        // Square, and filled under Button's transparent 1px border
        // (`bg-clip-padding`), so the header fills the strip edge to edge.
        className="w-full justify-start rounded-none bg-clip-border text-sm text-muted-foreground"
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
            spinner REPLACES the peer glyph, in the accent; the line itself
            stays muted like every strip on the composer, so only the motion
            draws the eye. The
            session you are typing into is often quiet while its peers work, so
            this strip is the only place that run is visible, and a static count
            reads as a stalled cluster. */}
        {working ? (
          <Spinner size="xs" className="text-primary" />
        ) : (
          <Users aria-hidden="true" />
        )}
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
            className="max-h-72 overflow-y-auto border-b"
          >
            <ul className="divide-y">
              {view.rows.map((card) => (
                <SpawnedSessionLedgeRow
                  key={card.session.id}
                  card={card}
                  now={now}
                  onOpen={onOpenSession}
                  describeSession={describeSession}
                />
              ))}
            </ul>
          </div>
          {/* Under the list, always in view: the rows above are what is
              going on now, and this is where what already ended is. */}
          {view.settled > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              // Edge to edge like the strip's header (see above).
              className="w-full justify-start rounded-none bg-clip-border text-sm text-muted-foreground"
              aria-expanded={view.settledShown}
              onClick={onToggleSettled}
            >
              <ChevronDown
                aria-hidden="true"
                className={view.settledShown ? "" : "-rotate-90"}
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

/**
 * One peer in the composer strip, styled like the background-work rows: a
 * chevron and the title (with its state glyph) that unfold the peer's runtime
 * and worktree, how long ago it moved, and Open. Indented by its depth in the
 * spawn tree, so the strip still reads as a tree.
 */
const SpawnedSessionLedgeRow = memo(function SpawnedSessionLedgeRow({
  card,
  now,
  onOpen,
  describeSession,
}: {
  card: SessionInboxCard;
  now: number;
  onOpen: (sessionId: string) => void;
  describeSession?:
    ((session: SessionListItem) => SpawnedSessionDetails) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { session, status } = card;
  const title = session.title.trim() || "Untitled session";
  const badge = sessionStatusBadge(session, status, now);
  const details = describeSession?.(session) ?? {};
  const model = session.model;
  const runtime = [
    details.account,
    model ? (model.name ?? model.id) : undefined,
    session.thinkingLevel && session.thinkingLevel !== "off"
      ? THINKING_LABELS[session.thinkingLevel]
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const depth = Math.min(Math.max((card.depth ?? 1) - 1, 0), 5);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li data-list-row-id={session.id} className="min-w-0">
      <Item
        size="xs"
        className="flex-nowrap gap-1 rounded-none py-0 pr-1.5 pl-0"
        style={{ paddingLeft: `${0.75 * depth}rem` }}
      >
        <Button
          variant="ghost"
          size="sm"
          // As the background rows: square, filled under the transparent
          // border, and open is not a hover state.
          className="h-8 min-w-0 flex-1 justify-start rounded-none bg-clip-border text-sm text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted dark:aria-expanded:hover:bg-muted/50"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? "Hide details" : "Show details"}
        >
          <Chevron aria-hidden="true" />
          {badge ? (
            <SessionStatusBadge
              badge={badge}
              status={status}
              display="icon-only"
            />
          ) : null}
          <span
            className={`min-w-0 truncate text-foreground ${status === "unread" ? "font-semibold" : ""}`}
          >
            <SessionTitleText
              title={title}
              pending={session.titleGenerationPending}
            />
          </span>
        </Button>
        <ItemActions className="gap-1.5">
          <span className="text-xs whitespace-nowrap tabular-nums">
            {relativeAge(session.updatedAt, now)}
          </span>
          <IconButton
            label={`Open ${title}`}
            title="Open session"
            size="icon-xs"
            onClick={() => onOpen(session.id)}
          >
            <ArrowUpRight />
          </IconButton>
        </ItemActions>
      </Item>
      {open ? (
        // Aligned under the title, like a background row's command.
        <div
          className="flex flex-col gap-0.5 pt-0.5 pr-2.5 pb-2 text-xs text-muted-foreground"
          style={{ paddingLeft: `calc(${0.75 * depth}rem + 1.75rem)` }}
        >
          {runtime ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {model ? (
                <ProviderIcon
                  provider={model.provider}
                  size={12}
                  className="shrink-0"
                />
              ) : null}
              <span className="min-w-0 truncate">{runtime}</span>
            </span>
          ) : null}
          {details.branch ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <GitBranch className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate font-mono">
                {details.branch}
              </span>
            </span>
          ) : session.worktreeId ? null : (
            <span>No worktree</span>
          )}
        </div>
      ) : null}
    </li>
  );
});
