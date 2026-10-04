import { memo, useEffect, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ArrowUp,
  ArchiveRestore,
  Check,
  ChevronRight,
  ClipboardList,
  FolderKanban,
  GitBranch,
  Hourglass,
  MoreVertical,
  Pencil,
  Play,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  clusterBubbleDismissible,
  clusterLiveSummary,
  sameSessionCardProps,
  sessionCardAge,
  sessionCardMeta,
  worktreeChangesText,
  sessionClusterBubbleLabel,
  sessionClusterSummary,
  sessionStatusBadge,
  sessionStatusDetail,
  stallLabel,
  stallMore,
  stallTitle,
  sessionStatusText,
  type SessionCardMetaItem,
  type SessionCardMetaKind,
  type SessionCardRelations,
  type SessionInboxCard,
} from "../lib/sessionInbox.ts";
import {
  backgroundActivityChip,
  backgroundActivityText,
} from "../lib/backgroundWork.ts";
import { CARD_OUTER_ROW, type RowDensity } from "../lib/rowDensity.ts";
import { sessionDelivery } from "../lib/sessionDelivery.ts";
import { AGENT_TYPE_DISPLAY } from "./agentTypeDisplay.ts";
import { useInertOverflow } from "../hooks/useInertOverflow.ts";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { SessionTitleText } from "./SessionTitleText.tsx";
import {
  SESSION_BADGE_TONE,
  SessionStatusBadge,
  SessionStatusIcon,
} from "./SessionStatusBadge.tsx";
import { identityLabel } from "./SessionRow.tsx";
import { UnreadDot } from "./UnreadDot.tsx";
import { Spinner } from "./ui/load.tsx";

/** Object glyphs for the third line, matching the primary navigation's icons. */
const META_ICON: Partial<Record<SessionCardMetaKind, LucideIcon>> = {
  project: FolderKanban,
  worktree: GitBranch,
  task: ClipboardList,
};

/**
 * The two gutter controls and the actions face share one target size. The
 * `min-h` is the floor rather than the height, so both gutter controls remain
 * usable if a card's three content rows need more room. At `comfortable`
 * density the floor is the 44px a thumb needs; at `tight` it is 36px.
 */
const GUTTER_BUTTON =
  "flex flex-1 cursor-pointer items-center justify-center text-faint transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-faint";
const GUTTER_FLOOR: Record<RowDensity, string> = {
  tight: "min-h-9",
  comfortable: "min-h-11",
};

/** Settle and the actions flip, inline at the end of the status row. */
const INLINE_ACTION =
  "flex shrink-0 cursor-pointer items-center justify-center rounded-md text-faint transition-colors hover:bg-line hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-faint";
const INLINE_ACTION_SIZE: Record<RowDensity, string> = {
  tight: "size-6 -my-0.5",
  comfortable: "size-8 -my-0.5",
};

/**
 * What the session's worktree holds that its base does not: uncommitted lines
 * and unmerged commits. Shown where there is no pull request to speak for it.
 */
function WorktreeChanges({ relations }: { relations: SessionCardRelations }) {
  const text = worktreeChangesText(relations);
  if (!text) return null;
  const additions = relations.worktreeAdditions ?? 0;
  const deletions = relations.worktreeDeletions ?? 0;
  const ahead = relations.worktreeAhead ?? 0;
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      className="flex shrink-0 items-center gap-1 tabular-nums"
    >
      {additions || deletions ? (
        <>
          <span className="text-success">+{additions}</span>
          <span className="text-danger">−{deletions}</span>
        </>
      ) : null}
      {ahead ? (
        <span className="flex items-center text-faint">
          <ArrowUp size={10} aria-hidden />
          {ahead}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The rotator's own duration, written as a literal class below. Only a
 * FALLBACK: the turn ends on `transitionend`, and this covers the cases that
 * never send one — reduced motion (no transition at all), a background tab, a
 * turn interrupted before it starts. The margin keeps it clear of the real
 * event. Not "FLIP", which in this feature means First-Last-Invert-Play.
 */
const TURN_MS = 300;
const TURN_FALLBACK_MS = TURN_MS + 100;

export interface ActiveSessionCardProps {
  card: SessionInboxCard;
  /** Shared ticker value; the card never owns a timer of its own. */
  now: number;
  active: boolean;
  /** Project/Worktree/Task metadata resolved once by the browser. */
  relations: SessionCardRelations;
  /** Uncommitted changes in the session's worktree, from the existing status projection. */
  worktreeDirty?: boolean | undefined;
  /**
   * The host's row density (`lib/rowDensity.ts`): `comfortable` on a phone
   * screen, where the gutter controls have to be thumb targets; `tight` on the
   * rail. A string prop, so the memo comparator covers it.
   */
  density?: RowDensity;
  /**
   * Whether the user has OPENED this cluster's disclosure — not whether rows
   * are visible under it, which a search decides on its own. The two are
   * separate for one reason: the button states what clicking it does, and a
   * disclosure that says "Hide" while the click would reveal more peers is a
   * lie the search puts in the user's way. Owned by the browser, since the rows
   * themselves are the browser's to lay out, focus and swipe.
   */
  clusterExpanded?: boolean;
  /**
   * Every callback takes the ID it acts on rather than closing over the row: a
   * per-card arrow is a fresh identity on each parent render and would defeat
   * the memo below unconditionally (`lib/sessionRows.ts` learned this the
   * expensive way on the session rows).
   */
  onOpen: (sessionId: string) => void;
  onSettle: (sessionId: string) => void;
  onOpenProject?: (projectId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onOpenWorktree?: (worktreeId: string) => void;
  onRename: (sessionId: string) => void;
  onArchive: (sessionId: string, archived: boolean) => void;
  onDelete: (sessionId: string) => void;
  /** Show or hide this cluster's folded peers. */
  onToggleCluster?: (sessionId: string) => void;
  /** Move keyboard focus to the previous/next row in the browser. */
  onFocusSibling?: (delta: 1 | -1) => void;
}

/**
 * @component ActiveSessionCard
 * @purpose The Sessions inbox's rich card for ONE unsettled session: title +
 * age, a coloured state badge with what it cannot say, and the objects the
 * session hangs off — plus a right gutter carrying Settle and the flip to this
 * card's own actions face. Worktree and Task jumps stay on that back face so
 * the front can spend its full width on identifying the linked objects.
 * @useWhen Rendering the Sessions section's working set.
 * @avoidWhen Listing sessions UNDER another object (a worktree's or project's
 * related sessions); those stay one-line `SessionRow`s.
 * @intent Every active card has three stable rows: identity, time plus every
 * live signal, then linked objects. The state is a SHORT coloured badge so
 * waiting/failed/done are told apart without reading, and every object the
 * card names is opened from exactly ONE target — nothing on the card is
 * decoration and nothing is offered twice. No card reads a transcript, issues a
 * git query, or owns a timer.
 * @related SessionInbox, InboxShelfRow, sessionInbox (lib)
 */
function ActiveSessionCardImpl({
  card,
  now,
  active,
  relations,
  worktreeDirty,
  density = "tight",
  clusterExpanded = false,
  onOpen,
  onSettle,
  onOpenProject,
  onOpenTask,
  onOpenWorktree,
  onRename,
  onArchive,
  onDelete,
  onToggleCluster,
  onFocusSibling,
}: ActiveSessionCardProps) {
  const { session, status } = card;
  const backgroundChip = backgroundActivityChip(
    session.backgroundActivity,
    now,
  );
  const backgroundText = backgroundActivityText(session.backgroundActivity);
  const [showActions, setShowActions] = useState(false);
  // The card's 3D rendering context, and the actions face itself, exist only
  // while it is turning or turned. The measured reason is DOM size: the face is
  // 35 of a card's 82 elements, 43% of it, on every idle row of a list built to
  // be scrolled (`ActiveSessionCard.test.tsx` holds the count). The 3D
  // properties come and go with it because they are meaningless without a
  // second face — NOT on a measured claim about compositing, which was never
  // profiled. Both arrive in the SAME commit that starts the rotation, which is
  // what keeps the transition itself intact, and leave on its `transitionend`.
  const [turning, setTurning] = useState(false);
  const turnTimer = useRef<number | undefined>(undefined);
  const flipped = showActions || turning;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const title = session.title.trim() || "Untitled session";
  const badge = sessionStatusBadge(session, status, now);
  const detail = sessionStatusDetail(session, status);
  const meta = sessionCardMeta(session, relations);
  const age = sessionCardAge(session, status, now);
  // What the fold states instead of six cards: the aggregate line, and the one
  // child that is actually waiting on the user.
  const cluster = card.cluster;
  const clusterSummary = cluster ? sessionClusterSummary(cluster.counts) : "";
  // A quiet coordinator still shows motion in the permanent middle row while
  // peers run, even though the coordinator has no provider state of its own.
  const clusterWorking = (cluster?.counts.working ?? 0) > 0;
  const clusterLive = cluster ? clusterLiveSummary(cluster.counts) : "";
  const bubbled = cluster?.bubbled;
  const bubbleLabel = bubbled ? sessionClusterBubbleLabel(bubbled, now) : "";
  const bubbleTone = bubbled
    ? sessionStatusBadge(bubbled.session, bubbled.status, now)?.tone
    : undefined;
  const bubbleTitle = bubbled
    ? bubbled.session.title.trim() || "Untitled session"
    : "";
  const dismissBubble = bubbled ? clusterBubbleDismissible(bubbled) : false;
  // The card is one `role="button"`, so its `aria-label` REPLACES everything
  // inside it: a chip that is not named here is not announced at all.
  const delivery = sessionDelivery(session);
  // The signal row states the pull request when there is one, else the diff;
  // the card's label says the same.
  const changesText = delivery ? undefined : worktreeChangesText(relations);
  const metaRowRef = useInertOverflow<HTMLDivElement>();
  const signalRowRef = useInertOverflow<HTMLDivElement>();
  const settleLabel = card.settleBlocked
    ? `Cannot settle: ${card.settleBlocked}`
    : "Settle — move out of the working set";
  const agent =
    AGENT_TYPE_DISPLAY[session.agentType ?? "assistant"] ??
    AGENT_TYPE_DISPLAY.assistant;
  const AgentIcon = agent.Icon;

  const endTurn = () => {
    window.clearTimeout(turnTimer.current);
    turnTimer.current = undefined;
    setTurning(false);
  };
  const turnTo = (next: boolean) => {
    setShowActions(next);
    setTurning(true);
    window.clearTimeout(turnTimer.current);
    // A timer started HERE cannot time the transition: the transition does not
    // begin until the next style recalc, so any timer of exactly `TURN_MS`
    // fires at least a frame early — and tearing the 3D context out mid-turn
    // is a pop at the end of every close. `transitionend` is the real signal.
    turnTimer.current = window.setTimeout(endTurn, TURN_FALLBACK_MS);
  };
  useEffect(() => () => window.clearTimeout(turnTimer.current), []);

  const closeActions = () => {
    turnTo(false);
    rowRef.current?.focus({ preventScroll: true });
  };
  const runAction = (action: () => void) => {
    turnTo(false);
    action();
  };

  /**
   * Where a metadata item leads; `undefined` renders it as plain text. Only the
   * Project opens from the front. Worktree and Task actions live on the back so
   * the metadata line keeps the full card width without duplicating targets.
   */
  const openMetaItem = (
    item: SessionCardMetaItem,
  ): (() => void) | undefined => {
    if (item.kind === "project" && relations.projectId && onOpenProject) {
      const projectId = relations.projectId;
      return () => onOpenProject(projectId);
    }
    return undefined;
  };
  // Time anchors the middle row even when the session has no state to report,
  // so every front keeps the same title / status / context rhythm.
  const comfortable = density === "comfortable";

  return (
    <div
      ref={rowRef}
      data-session-row
      data-list-row-id={session.id}
      data-session-row-active={active ? "true" : undefined}
      role="button"
      tabIndex={-1}
      aria-label={`Open ${identityLabel(session)} session: ${title} — ${sessionStatusText(session, status, now)}${
        delivery
          ? ` — pull request: ${delivery.title}`
          : changesText
            ? ` — ${changesText}`
            : ""
      }${backgroundText ? ` — ${backgroundText}` : ""}${
        clusterSummary ? ` — coordinating ${clusterSummary}` : ""
      }${bubbleLabel ? ` — ${bubbleLabel}` : ""}${
        card.stall ? ` — stalled: ${stallLabel(card.stall)}` : ""
      }`}
      onClick={showActions ? undefined : () => onOpen(session.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Escape" && showActions) {
          e.preventDefault();
          turnTo(false);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (showActions) turnTo(false);
          else onOpen(session.id);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          onFocusSibling?.(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key.toLowerCase() === "s" && !card.settleBlocked) {
          e.preventDefault();
          onSettle(session.id);
        } else if (e.key.toLowerCase() === "e") {
          e.preventDefault();
          onArchive(session.id, !session.archived);
        } else if (e.key === "#" || e.key === "Delete") {
          e.preventDefault();
          onDelete(session.id);
        }
      }}
      className={`group w-full cursor-pointer select-none overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
        flipped ? "[perspective:900px]" : ""
      } ${active ? "bg-accent-soft/60" : "hover:bg-raised"}`}
    >
      {/* One rotator, two faces: the front stays in flow so the card keeps its
          content height, and the actions face is absolutely laid over it at
          exactly the same box. `backface-visibility` is what hides the face
          turned away; `inert` is what keeps it out of focus and hit-testing.
          Both only matter once there IS a second face, so they come and go with
          it rather than sitting on every idle card. */}
      <div
        onTransitionEnd={(e) => {
          // Only this element's own rotation: a `transition-colors` finishing
          // on a button inside the card bubbles through here too.
          if (e.target !== e.currentTarget || e.propertyName !== "transform")
            return;
          endTurn();
        }}
        className={`relative transition-transform duration-300 motion-reduce:transition-none ${
          flipped ? "[transform-style:preserve-3d]" : ""
        } ${showActions ? "[transform:rotateY(180deg)]" : ""}`}
      >
        <div
          className={`flex ${flipped ? "[backface-visibility:hidden]" : ""}`}
          inert={showActions}
        >
          {/* Every front is exactly three rows: context, identity, live state.
              The row's own controls close the live-state row, so the front
              has no gutter and every row spans the card's width. */}
          <div
            className={`flex min-w-0 flex-1 flex-col justify-center gap-0.5 pl-2 pr-1 ${comfortable ? "py-2.5" : "py-2"}`}
          >
            {/* Items keep `sessionCardMeta`'s priority order. The row is one
                line tall and wraps, so an item that does not fit drops to the
                hidden second line instead of being cut; only the branch
                shortens, into whatever width the others leave. Worktree and
                Task actions live on the back, leaving this whole line to
                identify the objects. The time closes the row outside that
                area. The row is as tall as the live-state row below the
                title, so the title sits centred between the two. */}
            <div
              className={`flex ${CARD_OUTER_ROW[density].row} min-w-0 items-center gap-2 whitespace-nowrap text-micro text-faint`}
            >
              <div
                ref={metaRowRef}
                className="flex h-lh min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-4 overflow-hidden"
              >
                {meta.length === 0 ? (
                  // Keep the first row's line box when this session has no linked
                  // objects. Stable means three rows even in the empty case.
                  <span aria-hidden>{"\u00a0"}</span>
                ) : (
                  meta.map((item, index) => (
                    <MetaItem
                      key={`${item.kind}:${item.label}`}
                      item={item}
                      first={index === 0}
                      onOpen={openMetaItem(item)}
                    />
                  ))
                )}
              </div>
              <span className="shrink-0 tabular-nums" title={age.title}>
                {age.label}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              {/* One leading slot: an Idle session shows what it IS, any
                  other state shows what it needs. Fixed width, so every
                  title starts at the same x. */}
              <span className="flex size-4 shrink-0 items-center justify-center">
                {status === "quiet" || !badge ? (
                  <AgentIcon
                    size={13}
                    className={`shrink-0 ${agent.activeColor}`}
                    aria-hidden
                  />
                ) : (
                  <SessionStatusBadge
                    badge={badge}
                    status={status}
                    display="slot"
                  />
                )}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-caption text-fg ${status === "unread" ? "font-semibold" : "font-medium"}`}
              >
                <SessionTitleText
                  title={title}
                  pending={session.titleGenerationPending}
                />
              </span>
            </div>

            {/* Badges lead and time closes the row at the right edge; time
                makes this row permanent. Every changing signal stays on this
                one line, so activity can change without changing the card's
                geometry. Fixed badges survive; prose yields and clips. */}
            <div
              className={`flex ${CARD_OUTER_ROW[density].min} min-w-0 items-center gap-1.5 text-micro`}
            >
              {/* Signals show whole or not at all: the area is one line tall,
                  and whatever does not fit wraps onto a hidden second line. DOM
                  order is the drop order, so the peer that needs you outlasts
                  the diff. The row's controls sit outside it and never do. */}
              <div
                ref={signalRowRef}
                className="session-card-status-line flex h-5 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-4 overflow-hidden"
              >
                {cluster ? (
                  <button
                    type="button"
                    title={clusterSummary}
                    aria-expanded={clusterExpanded}
                    aria-label={`${clusterExpanded ? "Hide" : "Show"} the ${cluster.counts.total} coordinated session${
                      cluster.counts.total === 1 ? "" : "s"
                    }${clusterLive ? ` — ${clusterLive}` : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleCluster?.(session.id);
                    }}
                    className={`-mx-0.5 flex shrink-0 items-center gap-1 rounded px-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      clusterWorking
                        ? "text-accent hover:text-accent"
                        : "text-muted hover:text-fg"
                    }`}
                  >
                    {clusterWorking ? (
                      <Spinner size="xs" className="shrink-0" />
                    ) : (
                      <Users size={11} className="shrink-0" aria-hidden />
                    )}
                    {/* On a narrow card the word goes, like every label on
                        this line, so the live counts keep room. */}
                    <span>
                      {cluster.counts.total}
                      <span className="session-status-badge-label">
                        {cluster.counts.total === 1 ? " session" : " sessions"}
                      </span>
                    </span>
                    {/* What the tree is doing right now — agents running a
                        turn, and background jobs — over every peer at every
                        depth, so a quiet coordinator still says whether its
                        tree is moving. Inside the disclosure rather than after
                        it: this button is the line's first item and never
                        wraps out of sight, where anything behind a long named
                        badge would. Icon and number only; the words are in the
                        label and the tooltip. */}
                    {cluster.counts.running > 0 ? (
                      <span className="flex items-center gap-0.5">
                        <Play size={9} aria-hidden />
                        {cluster.counts.running}
                      </span>
                    ) : null}
                    {cluster.counts.jobs > 0 ? (
                      <span className="flex items-center gap-0.5">
                        <Activity size={10} aria-hidden />
                        {cluster.counts.jobs}
                      </span>
                    ) : null}
                    <ChevronRight
                      size={11}
                      aria-hidden
                      className={`shrink-0 transition-transform ${clusterExpanded ? "rotate-90" : ""}`}
                    />
                  </button>
                ) : null}
                {bubbled ? (
                  <button
                    type="button"
                    title={`Open “${bubbleTitle}”`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(bubbled.session.id);
                    }}
                    aria-label={bubbleLabel}
                    // Capped, so a long peer title truncates inside the badge
                    // instead of wrapping the whole badge off the line.
                    className={`session-status-responsive-badge flex min-w-0 max-w-32 shrink-0 items-center gap-1 rounded-full px-1.5 py-px font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      SESSION_BADGE_TONE[bubbleTone ?? "accent"]
                    }`}
                  >
                    <SessionStatusIcon status={bubbled.status} />
                    <span className="session-status-badge-label min-w-0 truncate">
                      {bubbleLabel}
                    </span>
                  </button>
                ) : null}
                {dismissBubble ? (
                  <button
                    type="button"
                    title={`Dismiss — settle “${bubbleTitle}”`}
                    aria-label={`Dismiss the failure in “${bubbleTitle}”`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (bubbled) onSettle(bubbled.session.id);
                    }}
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint transition-colors hover:bg-panel hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <X size={12} aria-hidden />
                  </button>
                ) : null}
                {/* The tree has stopped and a peer still owes a reply: the
                    one fact that says "this needs a poke" rather than "this
                    is done". Named and openable, like the bubble; capped so a
                    long title truncates inside it. */}
                {card.stall ? (
                  <button
                    type="button"
                    title={`Open “${stallTitle(card.stall)}”`}
                    aria-label={`Stalled: ${stallLabel(card.stall)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const peer = card.stall?.peers[0];
                      if (peer) onOpen(peer.id);
                    }}
                    className={`session-status-responsive-badge flex min-w-0 max-w-32 shrink-0 items-center gap-1 rounded-full px-1.5 py-px font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${SESSION_BADGE_TONE.warning}`}
                  >
                    <Hourglass size={10} className="shrink-0" aria-hidden />
                    <span className="session-status-badge-label shrink-0">
                      No reply from
                    </span>
                    <span className="session-status-badge-label min-w-0 truncate">
                      {`“${stallTitle(card.stall)}”`}
                    </span>
                    {stallMore(card.stall) ? (
                      <span className="session-status-badge-label shrink-0">
                        {stallMore(card.stall)}
                      </span>
                    ) : null}
                  </button>
                ) : null}
                {backgroundChip ? (
                  <span
                    role="img"
                    aria-label={backgroundText}
                    className="session-status-responsive-badge flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 py-px font-medium text-muted"
                    title={backgroundText}
                  >
                    <Activity size={10} aria-hidden="true" />
                    <span className="session-status-badge-label">
                      {backgroundChip}
                    </span>
                  </span>
                ) : null}
                {/* What the work has produced: its pull request when there is
                  one, otherwise the worktree's own changes. */}
                <span className="flex shrink-0 items-center">
                  {delivery ? (
                    <SessionDeliveryMark
                      session={session}
                      variant="responsive"
                      showNumber
                    />
                  ) : (
                    <WorktreeChanges relations={relations} />
                  )}
                </span>
                {/* The badge already names the state; the one sentence it
                  cannot say is an Idle card's queued work. */}
                {status === "quiet" && detail ? (
                  <span className="min-w-0 flex-1 basis-0 truncate text-faint">
                    {detail}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className={`${INLINE_ACTION} ${INLINE_ACTION_SIZE[density]}`}
                title="Session actions"
                aria-label="Session actions"
                aria-expanded={showActions}
                onClick={(e) => {
                  e.stopPropagation();
                  turnTo(true);
                }}
              >
                <MoreVertical size={14} />
              </button>
              <button
                type="button"
                className={`${INLINE_ACTION} ${INLINE_ACTION_SIZE[density]}`}
                title={settleLabel}
                aria-label={settleLabel}
                disabled={Boolean(card.settleBlocked)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSettle(session.id);
                }}
              >
                <Check size={14} />
              </button>
            </div>
          </div>
        </div>

        {flipped ? (
          <div
            className="absolute inset-0 flex bg-raised [backface-visibility:hidden] [transform:rotateY(180deg)]"
            inert={!showActions}
            aria-label={`Actions for ${title}`}
          >
            {/* The face spans the card's whole height, but the tiles keep ONE
                fixed size and sit centred in it: a hover tone that changes
                shape with the card it is on reads as a different control. */}
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2">
              {/* Object jumps live only on this action face. The front keeps
                  their names in context without spending width on controls. */}
              {session.worktreeId && onOpenWorktree ? (
                <ActionTile
                  icon={GitBranch}
                  label="Worktree"
                  accessibleLabel={
                    worktreeDirty
                      ? "Open worktree — uncommitted changes"
                      : "Open worktree"
                  }
                  dirty={worktreeDirty}
                  onClick={() =>
                    runAction(() =>
                      onOpenWorktree(session.worktreeId as string),
                    )
                  }
                />
              ) : null}
              {relations.taskId && onOpenTask ? (
                <ActionTile
                  icon={ClipboardList}
                  label={`#${relations.taskId}`}
                  onClick={() =>
                    runAction(() => onOpenTask(relations.taskId as string))
                  }
                />
              ) : null}
              <ActionTile
                icon={Pencil}
                label="Rename"
                onClick={() => runAction(() => onRename(session.id))}
              />
              <ActionTile
                icon={session.archived ? ArchiveRestore : Archive}
                label={session.archived ? "Restore" : "Archive"}
                onClick={() =>
                  runAction(() => onArchive(session.id, !session.archived))
                }
              />
              <ActionTile
                icon={Trash2}
                label="Delete"
                danger
                onClick={() => runAction(() => onDelete(session.id))}
              />
            </div>

            <div className="flex w-10 shrink-0 flex-col">
              <button
                type="button"
                className={`${GUTTER_BUTTON} ${GUTTER_FLOOR[density]}`}
                title="Back to the session"
                aria-label="Close session actions"
                onClick={(e) => {
                  e.stopPropagation();
                  closeActions();
                }}
              >
                <X size={15} />
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Memoized on CONTENT, not on identity: the card's inputs come from the session
 * list, which is rebroadcast up to ~4x/second with brand-new row objects while
 * any agent runs, and from the shared ticker underneath it — so without this
 * every card re-renders on every one of those, and the failure is silent:
 * nothing breaks, the list just gets expensive whenever anything moves, which
 * is exactly when it is being scrolled.
 *
 * The comparator itself lives in `lib/sessionInbox.ts` beside the keys it uses,
 * pure and unit-tested, exactly as `sameSessionRowProps` does for the rows.
 */
export const ActiveSessionCard = memo(
  ActiveSessionCardImpl,
  sameSessionCardProps,
);

/**
 * One third-line item: its object glyph plus the label, as a BUTTON only for
 * the Project. Worktree and Task names stay as context on the front while their
 * actions live on the back.
 *
 * It states WHICH object, never that object's state. The dirty marker belongs
 * to the Worktree action on the back.
 */
function MetaItem({
  item,
  first,
  onOpen,
}: {
  item: SessionCardMetaItem;
  first: boolean;
  onOpen?: (() => void) | undefined;
}) {
  const Icon = META_ICON[item.kind];
  const body = (
    <>
      {Icon ? (
        <Icon
          size={11}
          className={`shrink-0 ${item.missing ? "text-warning" : ""}`}
          style={item.color ? { color: item.color } : undefined}
          aria-hidden
        />
      ) : null}
      <span
        className={`min-w-0 truncate ${item.missing ? "text-warning" : ""}`}
      >
        {item.label}
      </span>
    </>
  );
  // Items show whole or not at all, except the branch: it takes whatever width
  // the others leave (never more than its own) and shortens with an ellipsis.
  const shape = `flex min-w-0 items-center gap-1 ${
    item.kind === "worktree"
      ? "max-w-max flex-1 basis-0"
      : first
        ? "max-w-full shrink-0"
        : "shrink-0"
  }`;

  if (!onOpen) {
    return (
      <span className={shape} title={item.title ?? item.label}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${shape} -mx-1 cursor-pointer rounded px-1 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
      title={`Open ${item.title ?? item.label}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {body}
    </button>
  );
}

/** One fixed-size target on the actions face; icon over label. */
function ActionTile({
  icon: Icon,
  label,
  onClick,
  danger = false,
  dirty = false,
  accessibleLabel,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
  dirty?: boolean | undefined;
  accessibleLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      className={`flex h-14 w-16 shrink-0 cursor-pointer flex-col items-center justify-center rounded-lg text-micro font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        danger
          ? "text-danger hover:bg-danger-soft"
          : "text-muted hover:bg-panel hover:text-fg"
      }`}
    >
      {/* Match the mobile dock action exactly: an 18px glyph centred in a
          36px marker stage, with the dot inset from that stage's top-right. */}
      <span className="relative flex size-9 items-center justify-center">
        <Icon size={18} />
        {dirty ? <UnreadDot title="Uncommitted changes" /> : null}
      </span>
      <span>{label}</span>
    </button>
  );
}
