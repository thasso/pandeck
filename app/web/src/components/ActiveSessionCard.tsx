import { runtimeLabel } from "./common/runtimeLabel.ts";
import { Fragment, memo } from "react";
import {
  Activity,
  ArrowUp,
  Check,
  ChevronRight,
  ClipboardList,
  FolderKanban,
  GitBranch,
  Hourglass,
  Play,
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
  interruptedRunTitle,
  stallLabel,
  stallMore,
  stallParts,
  stallTarget,
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
import type { RowDensity } from "../lib/rowDensity.ts";
import { sessionDelivery } from "../lib/sessionDelivery.ts";
import { AGENT_TYPE_DISPLAY } from "./agentTypeDisplay.ts";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { IntegratedBadge } from "./IntegratedBadge.tsx";
import { SessionTitleRow } from "./SessionTitleRow.tsx";
import { SessionStatusIcon } from "./SessionStatusBadge.tsx";
import { identityLabel } from "./SessionRow.tsx";
import {
  ListRowActions,
  type ListRowAction,
} from "./common/ListRowActions.tsx";
import { Spinner } from "./common/load.tsx";
import { ProviderIcon } from "./common/ProviderIcon.tsx";
import { TONE_BADGE } from "./common/statusBadge.ts";
import { Badge } from "@/components/ui/badge";
import { ListRow, ListRowContent } from "./common/ListRow.tsx";

/** Object glyphs for the third line, matching the primary navigation's icons. */
const META_ICON: Partial<Record<SessionCardMetaKind, LucideIcon>> = {
  project: FolderKanban,
  worktree: GitBranch,
  task: ClipboardList,
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
          <span className="text-destructive">−{deletions}</span>
        </>
      ) : null}
      {ahead ? (
        <span className="flex items-center text-muted-foreground">
          <ArrowUp size={12} aria-hidden />
          {ahead}
        </span>
      ) : null}
    </span>
  );
}

export interface ActiveSessionCardProps {
  card: SessionInboxCard;
  /** Shared ticker value; the card never owns a timer of its own. */
  now: number;
  active: boolean;
  /** Project/Worktree/Task metadata resolved once by the browser. */
  relations: SessionCardRelations;
  /** Uncommitted changes in the session's worktree, from the existing status projection. */
  worktreeDirty?: boolean | undefined;
  /** Confirmed containment from the linked worktree's existing Git status. */
  worktreeIntegrated?: boolean;
  /**
   * The host's content density. Shared actions independently use touch-safe
   * targets on mobile layouts and coarse-pointer devices.
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
  /** Dismiss the bubbled peer's rendered failure identity. */
  onDismissFailure: (
    sessionId: string,
    errorAt: number | undefined,
    outcomeRevision: number,
  ) => void;
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
 * session hangs off, with Settle as its only row action.
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
  worktreeIntegrated = false,
  density = "tight",
  clusterExpanded = false,
  onOpen,
  onSettle,
  onDismissFailure,
  onOpenProject,
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
  const title = session.title.trim() || "Untitled session";
  const badge = sessionStatusBadge(session, status, now);
  const detail = sessionStatusDetail(session, status);
  const sentence =
    status === "quiet" || status === "interrupted" ? detail : undefined;
  const sentenceTitle =
    status === "interrupted" && session.interruptedRun
      ? interruptedRunTitle(session.interruptedRun)
      : sentence;
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
  // The group label summarizes live state; its nested controls remain accessible.
  const delivery = sessionDelivery(session);
  // The signal row states the pull request when there is one, else the diff;
  // the card's label says the same.
  const changesText = delivery ? undefined : worktreeChangesText(relations);
  const settleLabel = card.settleBlocked
    ? `Cannot settle: ${card.settleBlocked}`
    : "Settle — move out of the working set";
  const agent =
    AGENT_TYPE_DISPLAY[session.agentType ?? "assistant"] ??
    AGENT_TYPE_DISPLAY.assistant;
  const AgentIcon = agent.Icon;
  // Who the session is, for a context row with no linked object to name:
  // always true, so the row never holds the age alone.
  const identity = [
    agent.label,
    runtimeLabel({
      model: session.model
        ? (session.model.name ?? session.model.id)
        : undefined,
      thinkingLevel: session.thinkingLevel,
    }),
  ]
    .filter(Boolean)
    .join(" · ");
  // The status line's fallback: with no signal to show, it says the state in
  // words (the title's glyph says it as an icon), so the row is not just the
  // row's buttons.
  const hasSignals = Boolean(cluster || backgroundChip || delivery || worktreeIntegrated || sentence);
  const stateWords =
    status === "quiet"
      ? "Idle"
      : (badge?.label ?? sessionStatusText(session, status, now));

  /**
   * Where a metadata item leads; `undefined` renders it as plain text. Only the
   * Project opens from context. Other object actions live in the session.
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
  const rowActions: ListRowAction[] = [
    {
      id: "settle",
      label: "Settle",
      accessibleLabel: settleLabel,
      icon: <Check />,
      disabled: Boolean(card.settleBlocked),
      onSelect: () => onSettle(session.id),
    },
  ];
  return (
    <ListRow
      interaction="content"
      active={active}
      divider={false}
      data-session-row
      data-list-row-id={session.id}
      data-session-row-active={active ? "true" : undefined}
      role="group"
      tabIndex={-1}
      aria-label={`Open ${identityLabel(session)} session: ${title} — ${sessionStatusText(session, status, now)}${
        delivery
          ? ` — pull request: ${delivery.title}`
          : changesText
            ? ` — ${changesText}`
            : ""
      }${worktreeIntegrated ? " — branch changes integrated into base" : ""}${backgroundText ? ` — ${backgroundText}` : ""}${
        clusterSummary ? ` — coordinating ${clusterSummary}` : ""
      }${bubbleLabel ? ` — ${bubbleLabel}` : ""}${
        card.stall ? ` — stalled: ${stallLabel(card.stall)}` : ""
      }`}
      onOpen={() => onOpen(session.id)}
      onFocusSibling={onFocusSibling}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key.toLowerCase() === "s" && !card.settleBlocked) {
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
    >
      <ListRowContent
        density={density}
        context={
          <>
            {meta.length === 0 ? (
              // No linked object: the row names who the session is, so
              // the card keeps three filled rows.
              <span className="flex min-w-0 items-center gap-1">
                {session.model ? (
                  <ProviderIcon provider={session.model.provider} size={12} />
                ) : (
                  <AgentIcon size={12} className="shrink-0" aria-hidden />
                )}
                <span className="min-w-0 truncate">{identity}</span>
              </span>
            ) : (
              meta.map((item, index) => (
                <Fragment key={`${item.kind}:${item.label}`}>
                  <MetaItem
                    item={item}
                    first={index === 0}
                    onOpen={openMetaItem(item)}
                  />
                  {/* The worktree's own changes stand beside it — what it
                          holds that its base does not — unless a pull request
                          speaks for them on the status row. */}
                  {item.kind === "worktree" && !delivery ? (
                    <WorktreeChanges relations={relations} />
                  ) : null}
                </Fragment>
              ))
            )}
          </>
        }
        age={age.label}
        ageTitle={age.title}
        identity={<SessionTitleRow session={session} status={status} />}
        signals={
          <>
            {cluster ? (
              <Badge
                variant="ghost"
                render={<button type="button" />}
                title={clusterSummary}
                aria-expanded={clusterExpanded}
                aria-label={`${clusterExpanded ? "Hide" : "Show"} the ${cluster.counts.total} coordinated session${
                  cluster.counts.total === 1 ? "" : "s"
                }${clusterLive ? ` — ${clusterLive}` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCluster?.(session.id);
                }}
                // Plain, muted text like the context row above: a
                // neutral fact, not a pill. Only what needs the user
                // keeps a badge's chrome.
                className={`cursor-pointer gap-1 rounded-none border-0 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent`}
              >
                <ChevronRight
                  aria-hidden
                  className={`transition-transform ${clusterExpanded ? "rotate-90" : ""}`}
                />
                {clusterWorking ? <Spinner size="xs" /> : <Users aria-hidden />}
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
                    <Play className="size-3" aria-hidden />
                    {cluster.counts.running}
                  </span>
                ) : null}
                {cluster.counts.jobs > 0 ? (
                  <span className="flex items-center gap-0.5">
                    <Activity className="size-3" aria-hidden />
                    {cluster.counts.jobs}
                  </span>
                ) : null}
              </Badge>
            ) : null}
            {backgroundChip ? (
              // The count stays when the line compacts, as the cluster's
              // does: an icon alone said "something", not how much.
              <span
                role="img"
                aria-label={backgroundText}
                title={backgroundText}
                className="flex shrink-0 items-center gap-1 whitespace-nowrap"
              >
                <Activity aria-hidden="true" className="size-3" />
                <span>
                  {backgroundChip.count}
                  <span className="session-status-badge-label">
                    {" running"}
                    {backgroundChip.age ? ` · ${backgroundChip.age}` : ""}
                  </span>
                </span>
              </span>
            ) : null}
            {/* What the work has produced, once it is a pull request;
                  until then the worktree's changes sit beside it above. */}
            {delivery ? (
              <span className="flex shrink-0 items-center">
                <SessionDeliveryMark
                  session={session}
                  variant="reference"
                />
              </span>
            ) : null}
            {worktreeIntegrated ? <IntegratedBadge /> : null}
            {/* The badge already names the state; the sentences it
                  cannot say are an Idle card's queued work and what a cut
                  turn needs from you. */}
            {sentence ? (
              <span
                className="min-w-0 flex-1 basis-0 truncate text-muted-foreground"
                title={sentenceTitle}
              >
                {sentence}
              </span>
            ) : null}
            {hasSignals ? null : (
              <span className="min-w-0 flex-1 basis-0 truncate">
                {stateWords}
              </span>
            )}
          </>
        }
        pinned={
          <>
            {bubbled ? (
              <Badge
                variant={TONE_BADGE[bubbleTone ?? "accent"]}
                render={<button type="button" />}
                title={`Open “${bubbleTitle}”`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(bubbled.session.id);
                }}
                aria-label={bubbleLabel}
                // Capped, so a long peer title truncates inside the badge
                // instead of wrapping the whole badge off the line.
                className="session-status-responsive-badge min-w-0 max-w-32 shrink cursor-pointer"
              >
                <SessionStatusIcon status={bubbled.status} />
                <span className="session-status-badge-label min-w-0 truncate">
                  {bubbleLabel}
                </span>
              </Badge>
            ) : null}
            {dismissBubble ? (
              <Badge
                variant="ghost"
                render={<button type="button" />}
                title={`Dismiss the failure in “${bubbleTitle}”`}
                aria-label={`Dismiss the failure in “${bubbleTitle}”`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (bubbled)
                    onDismissFailure(
                      bubbled.session.id,
                      bubbled.session.lastError?.at,
                      bubbled.session.outcomeAttention?.revision ?? 0,
                    );
                }}
                className="cursor-pointer"
              >
                <X aria-hidden />
              </Badge>
            ) : null}
            {/* The tree has stopped and a peer still owes a reply: the
                      one fact that says "this needs a poke" rather than "this
                      is done". Named and openable, like the bubble; capped so a
                      long title truncates inside it. */}
            {card.stall ? (
              <Badge
                variant="warning"
                render={<button type="button" />}
                title={`Open “${stallTitle(card.stall)}”`}
                aria-label={`Stalled: ${stallLabel(card.stall)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (card.stall) onOpen(stallTarget(card.stall).id);
                }}
                className="session-status-responsive-badge min-w-0 max-w-32 shrink cursor-pointer"
              >
                <Hourglass aria-hidden />
                {stallParts(card.stall).before ? (
                  <span className="session-status-badge-label shrink-0">
                    {stallParts(card.stall).before}
                  </span>
                ) : null}
                <span className="session-status-badge-label min-w-0 truncate">
                  {stallParts(card.stall).title}
                </span>
                {stallParts(card.stall).after ? (
                  <span className="session-status-badge-label shrink-0">
                    {stallParts(card.stall).after}
                  </span>
                ) : null}
                {stallMore(card.stall) ? (
                  <span className="session-status-badge-label shrink-0">
                    {stallMore(card.stall)}
                  </span>
                ) : null}
              </Badge>
            ) : null}
          </>
        }
        actions={
          <ListRowActions actions={rowActions} label="Session actions" />
        }
      />
    </ListRow>
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
 * actions live in the menu.
 *
 * It states WHICH object, never that object's state. The dirty marker belongs
 * to the Worktree action in the menu.
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
  const icon = Icon ? (
    <Icon
      size={12}
      className={`shrink-0 ${item.missing ? "text-warning" : ""}`}
      style={item.color ? { color: item.color } : undefined}
      aria-hidden
    />
  ) : null;
  const body = (
    <>
      {icon}
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
    <Badge
      variant="ghost"
      render={<button type="button" />}
      // No pill padding or fill: an openable item starts where a plain one
      // does, flush with the title and status rows below, and says it opens
      // by its colour on hover.
      // One text line tall like the plain items: a 20px badge in the row's
      // one-line box pushed every item 2px below the age beside them.
      className={`${shape} h-auto cursor-pointer border-0 px-0 py-0 hover:bg-transparent hover:text-foreground dark:hover:bg-transparent`}
      title={`Open ${item.title ?? item.label}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {body}
    </Badge>
  );
}
