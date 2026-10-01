import { memo } from "react";
import {
  sameClusterChildProps,
  sessionStatusBadge,
  sessionStatusText,
  type SessionInboxCard,
} from "../lib/sessionInbox.ts";
import { relativeAge } from "../lib/relativeTime.ts";
import type { RowDensity } from "../lib/rowDensity.ts";
import { AGENT_TYPE_DISPLAY } from "./agentTypeDisplay.ts";
import { SessionStatusBadge } from "./SessionStatusBadge.tsx";
import { SessionTitleText } from "./SessionTitleText.tsx";
import { identityLabel } from "./SessionRow.tsx";

export interface ClusterChildRowProps {
  card: SessionInboxCard;
  /** Shared ticker value; the row never owns a timer of its own. */
  now: number;
  active: boolean;
  /** The host's row density: both variants stay compact inside the parent fold. */
  density?: RowDensity;
  /**
   * How this row is related to the item above it, for the spoken label: peers
   * of a spawn cluster are `coordinated`, a Workflow Run's own sessions are
   * `workflow`. The row is otherwise identical, and the word is the only place
   * the two folds differ.
   */
  relation?: "coordinated" | "workflow";
  /**
   * A tab stop of its own. The inbox says no: its rows are reached by arrow
   * key from the item above them, and a second stop per folded peer would put
   * the whole list in the way of the next control. A host with no roving focus
   * — the composer's spawned-session ledge — says yes, because otherwise the
   * link is reachable by pointer alone.
   */
  tabbable?: boolean;
  /** Every callback takes the id it acts on, so the memo below survives. */
  onOpen: (sessionId: string) => void;
  /**
   * The row's keyboard lifecycle actions. Absent where the host offers none
   * (the ledge lists live peers and owns no Settle, Archive or Delete), and the
   * shortcut is then simply not bound — a row must never appear to acknowledge
   * or destroy something its surface cannot undo.
   */
  onSettle?: ((sessionId: string) => void) | undefined;
  onArchive?: ((sessionId: string, archived: boolean) => void) | undefined;
  onDelete?: ((sessionId: string) => void) | undefined;
  onFocusSibling?: (delta: 1 | -1) => void;
}

/**
 * @component ClusterChildRow
 * @purpose One session inside an EXPANDED fold — a spawn cluster's peer or a
 * Workflow Run's role session: the agent glyph, the title, its state badge, and
 * when it last moved.
 * @useWhen The Sessions inbox has expanded a cluster card or a Workflow Run
 * item — by the user, or because a search matched inside it — or the composer
 * ledge has opened the peers the current session spawned.
 * @avoidWhen A session standing on its own; that is an `ActiveSessionCard`,
 * with the whole card's width and its relations.
 * @intent A cluster exists to spend ONE compact row on work the user did not
 * start personally, even on a phone: no relations, no jump buttons, no actions
 * face. It is still a first-class row —
 * focusable, swipeable, and openable — because the fold may never make a live
 * session unreachable.
 * @related SessionInbox, ActiveSessionCard, SpawnedSessionsLedge, sessionInbox
 * (lib)
 */
function ClusterChildRowImpl({
  card,
  now,
  active,
  density = "tight",
  relation = "coordinated",
  tabbable = false,
  onOpen,
  onSettle,
  onArchive,
  onDelete,
  onFocusSibling,
}: ClusterChildRowProps) {
  const { session, status } = card;
  const title = session.title.trim() || "Untitled session";
  const badge = sessionStatusBadge(session, status, now);
  const agent =
    AGENT_TYPE_DISPLAY[session.agentType ?? "assistant"] ??
    AGENT_TYPE_DISPLAY.assistant;
  const AgentIcon = agent.Icon;

  return (
    <div
      data-session-row
      data-list-row-id={session.id}
      data-session-row-active={active ? "true" : undefined}
      role="button"
      tabIndex={tabbable ? 0 : -1}
      aria-label={`Open ${relation} ${identityLabel(session)} session: ${title} — ${sessionStatusText(
        session,
        status,
        now,
      )}`}
      onClick={() => onOpen(session.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(session.id);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          onFocusSibling?.(e.key === "ArrowDown" ? 1 : -1);
        } else if (
          e.key.toLowerCase() === "s" &&
          onSettle &&
          !card.settleBlocked
        ) {
          e.preventDefault();
          onSettle(session.id);
        } else if (e.key.toLowerCase() === "e" && onArchive) {
          e.preventDefault();
          onArchive(session.id, !session.archived);
        } else if ((e.key === "#" || e.key === "Delete") && onDelete) {
          e.preventDefault();
          onDelete(session.id);
        }
      }}
      // The parent fold and slight indent carry the relationship in both the
      // inbox cluster and composer ledge; a vertical rail adds a needless edge.
      className={`group flex min-w-0 cursor-pointer select-none items-center gap-1.5 py-0.5 pl-3 pr-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
        density === "comfortable" ? "min-h-8" : "min-h-7"
      } ${active ? "bg-accent-soft/60" : "hover:bg-raised"}`}
    >
      <AgentIcon
        size={12}
        className={`shrink-0 ${agent.activeColor}`}
        aria-hidden
      />
      {/* The state reads before the title; a quiet row keeps the slot empty
          so every sibling's title starts at the same x. */}
      {badge ? (
        <SessionStatusBadge badge={badge} status={status} display="icon-only" />
      ) : (
        <span aria-hidden className="size-5 shrink-0" />
      )}
      <span
        className={`min-w-0 flex-1 truncate text-caption text-muted ${status === "unread" ? "font-semibold" : ""}`}
      >
        <SessionTitleText
          title={title}
          pending={session.titleGenerationPending}
        />
      </span>
      <span className="shrink-0 text-micro tabular-nums text-faint">
        {relativeAge(session.updatedAt, now)}
      </span>
    </div>
  );
}

/**
 * Memoized on CONTENT for the same reason the cards are: these rows read the
 * hot session list, which is rebroadcast with brand-new row objects several
 * times a second while any peer runs.
 */
export const ClusterChildRow = memo(ClusterChildRowImpl, sameClusterChildProps);
