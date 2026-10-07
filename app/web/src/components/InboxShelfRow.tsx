import { ArchiveRestore, RotateCcw } from "lucide-react";
import type { SessionListItem } from "@assistant/shared";
import { relativeAge } from "../lib/relativeTime.ts";
import type { RowDensity } from "../lib/rowDensity.ts";
import { sessionDelivery } from "../lib/sessionDelivery.ts";
import { AGENT_TYPE_DISPLAY } from "./agentTypeDisplay.ts";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { SessionTitleText } from "./SessionTitleText.tsx";
import { identityLabel } from "./SessionRow.tsx";
import { IconButton } from "./common/IconButton.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

export type InboxShelfKind = "settled" | "archived";

/**
 * @component InboxShelfRow
 * @purpose The Sessions inbox's compact history row, shared by BOTH shelves:
 * a session you settled out of the working set and one you archived. Agent
 * glyph, title, when it was put down, and the one action that brings it back.
 * @useWhen Rendering the Settled or Archived group under the inbox's cards.
 * @avoidWhen Rendering unsettled work (that gets a rich `ActiveSessionCard`) or
 * a session nested under another object (that stays a `SessionRow`).
 * @intent Settled and archived are different STATES but the same kind of row —
 * finished work you can still reach — so they are one component: two lists that
 * looked different implied a difference that does not exist. Neither ever shows
 * an unread marker: putting a session down marks it read (the server does this
 * on archive and settle), so a marker here would be a contradiction with no
 * control to clear it. Row height follows lifecycle value: one line — at the
 * rail's 28px, or a thumb's 44px on a phone screen.
 * @related SessionInbox, ActiveSessionCard, sessionInbox (lib)
 */
export function InboxShelfRow({
  session,
  kind,
  active,
  now,
  density = "tight",
  onOpen,
  onRestore,
  onArchive,
  onDelete,
  onFocusSibling,
}: {
  session: SessionListItem;
  kind: InboxShelfKind;
  active: boolean;
  /** Shared ticker value; the row never owns a timer of its own. */
  now: number;
  /** The host's row density: a thumb-height row and restore target on a phone. */
  density?: RowDensity;
  onOpen: () => void;
  /** Bring it back: unsettle a settled row, restore an archived one. */
  onRestore: () => void;
  /** `e` on the focused row, matching the inbox's cards. */
  onArchive: () => void;
  /** `#` / Delete on the focused row. The caller confirms. */
  onDelete: () => void;
  onFocusSibling?: (delta: 1 | -1) => void;
}) {
  const title = session.title.trim() || "Untitled session";
  const agent =
    AGENT_TYPE_DISPLAY[session.agentType ?? "assistant"] ??
    AGENT_TYPE_DISPLAY.assistant;
  const AgentIcon = agent.Icon;
  const settled = kind === "settled";
  const restoreLabel = settled
    ? "Bring back into the working set"
    : "Restore from the archive";
  const RestoreIcon = settled ? RotateCcw : ArchiveRestore;
  const at = settled
    ? (session.settledAt ?? session.updatedAt)
    : session.updatedAt;
  // Put down is not the same as finished: the pull request a settled session
  // opened can still be waiting for a review. The row's own `aria-label`
  // replaces its content, so the state is named there as well as shown.
  const delivery = sessionDelivery(session);
  const comfortable = density === "comfortable";

  return (
    <Item
      size="xs"
      variant={active ? "muted" : "default"}
      data-session-row
      data-list-row-id={session.id}
      data-session-row-active={active ? "true" : undefined}
      role="button"
      tabIndex={-1}
      aria-label={`Open ${settled ? "settled" : "archived"} ${identityLabel(session)} session: ${title}${
        delivery ? ` — pull request: ${delivery.title}` : ""
      }`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          onFocusSibling?.(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key.toLowerCase() === "s" && settled) {
          e.preventDefault();
          onRestore();
        } else if (e.key.toLowerCase() === "e") {
          e.preventDefault();
          onArchive();
        } else if (e.key === "#" || e.key === "Delete") {
          e.preventDefault();
          onDelete();
        }
      }}
      className={`cursor-pointer select-none flex-nowrap hover:bg-muted ${
        comfortable ? "min-h-11" : ""
      }`}
    >
      <ItemMedia variant="icon" className={agent.activeColor} aria-hidden>
        <AgentIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <span className="truncate">
            <SessionTitleText
              title={title}
              pending={session.titleGenerationPending}
            />
          </span>
        </ItemTitle>
      </ItemContent>
      <ItemActions className="gap-1">
        <SessionDeliveryMark session={session} variant="glyph" />
        <span className="text-xs tabular-nums text-muted-foreground">
          {relativeAge(at, now)}
        </span>
        <IconButton
          label={restoreLabel}
          size={comfortable ? "icon-lg" : "icon-xs"}
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
        >
          <RestoreIcon />
        </IconButton>
      </ItemActions>
    </Item>
  );
}
