import { memo } from "react";
import { Activity, Users } from "lucide-react";
import { awaitedBackgroundCount } from "@assistant/shared";
import {
  sameClusterChildProps,
  sessionClusterSummary,
  sessionStatusText,
  type SessionInboxCard,
} from "../lib/sessionInbox.ts";
import { relativeAge } from "../lib/relativeTime.ts";
import type { RowDensity } from "../lib/rowDensity.ts";
import { SessionTitleRow } from "./SessionTitleRow.tsx";
import { ListRow } from "./common/ListRow.tsx";
import { identityLabel } from "./SessionRow.tsx";

export interface ClusterChildRowProps {
  card: SessionInboxCard;
  /** Shared ticker value; the row never owns a timer of its own. */
  now: number;
  active: boolean;
  /**
   * The host's row density: one compact line at the rail's `tight`, a thumb's
   * height at a phone's `comfortable`.
   */
  density?: RowDensity;
  /**
   * How this row is related to the item above it, for the spoken label: peers
   * of a spawn cluster are `coordinated`, a Workflow Run's own sessions are
   * `workflow`, the composer ledge's peers — owned or taken over — are
   * `spawned`, and the sessions started from an Initiative's Tasks are
   * `working`. The row is otherwise identical, and the word is the only place
   * the surfaces differ.
   */
  relation?: "coordinated" | "workflow" | "spawned" | "working";
  /**
   * A tab stop of its own. The inbox says no: its rows are reached by arrow
   * key from the item above them, and a second stop per folded peer would put
   * the whole list in the way of the next control. A host with no roving focus
   * — the composer's spawned-session ledge — says yes, because otherwise the
   * link is reachable by pointer alone.
   */
  tabbable?: boolean;
  /**
   * The row's `data-list-row-id`, when it must differ from the session id: a
   * settled peer listed as a fold's history is ALSO a row of the Settled
   * shelf, and two rows with one id would send a scroll restore to the wrong
   * one.
   */
  listRowId?: string;
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
 * when it last moved. A peer is indented by its depth in the spawn tree, and
 * says how many background jobs it runs and how many peers of its own it
 * coordinates.
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
  density = "tight",
  active,
  relation = "coordinated",
  tabbable = false,
  listRowId,
  onOpen,
  onSettle,
  onArchive,
  onDelete,
  onFocusSibling,
}: ClusterChildRowProps) {
  const { session, status } = card;
  const title = session.title.trim() || "Untitled session";
  // The badge counts every process; the words keep the fold's split between
  // jobs somebody waits on and services nobody does.
  const jobs = Math.max(0, session.backgroundActivity?.activeCount ?? 0);
  const services = session.backgroundActivity?.serviceCount ?? 0;
  const awaited = awaitedBackgroundCount(session.backgroundActivity);
  const jobsText = `${[
    ...(awaited > 0
      ? [`${awaited} background job${awaited === 1 ? "" : "s"}`]
      : []),
    ...(services > 0
      ? [`${services} service${services === 1 ? "" : "s"}`]
      : []),
  ].join(" and ")} running`;
  const peers = card.peers;
  // The composer ledge lists what a chat SPAWNED, owned or not, so its rows
  // claim no coordination either.
  const peersText = peers
    ? `${relation === "spawned" ? "spawned" : "coordinating"} ${sessionClusterSummary(peers)}`
    : "";
  // Each level steps in by the row's own leading inset; past six levels the
  // step stops, so a deep chain keeps room for its titles.
  const indent = Math.min(Math.max((card.depth ?? 1) - 1, 0), 5);

  return (
    <ListRow
      density={density}
      active={active}
      divider={false}
      render={<button type="button" />}
      data-session-row
      data-list-row-id={listRowId ?? session.id}
      data-session-row-active={active ? "true" : undefined}
      tabIndex={tabbable ? 0 : -1}
      aria-label={`Open ${relation} ${identityLabel(session)} session: ${title} — ${[
        sessionStatusText(session, status, now),
        jobs > 0 ? jobsText : "",
        peersText,
      ]
        .filter(Boolean)
        .join(", ")}`}
      onOpen={() => onOpen(session.id)}
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
      // Shared content supplies the remaining half-rem inset.
      style={{ paddingLeft: `${0.75 * indent + 0.25}rem` }}
      className="border-t border-border/60"
      identity={<SessionTitleRow session={session} status={status} />}
      trailing={
        <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          {jobs > 0 ? (
            <span title={jobsText} className="flex items-center gap-0.5">
              <Activity className="size-3" aria-hidden />
              {jobs}
            </span>
          ) : null}
          {peers ? (
            <span
              title={sessionClusterSummary(peers)}
              className={`flex items-center gap-0.5 ${peers.working > 0 ? "text-primary" : ""}`}
            >
              <Users className="size-3" aria-hidden />
              {peers.total}
            </span>
          ) : null}
          <span>{relativeAge(session.updatedAt, now)}</span>
        </span>
      }
    />
  );
}

/**
 * Memoized on CONTENT for the same reason the cards are: these rows read the
 * hot session list, which is rebroadcast with brand-new row objects several
 * times a second while any peer runs.
 */
export const ClusterChildRow = memo(ClusterChildRowImpl, sameClusterChildProps);
