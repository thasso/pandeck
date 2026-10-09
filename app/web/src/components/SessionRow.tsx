import { memo } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import type { SessionListItem } from "@assistant/shared";
import { relativeTime, sameSessionRowProps } from "../lib/sessionRows.ts";
import {
  classifySessionStatus,
  type SessionInboxStatus,
} from "../lib/sessionInbox.ts";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { SessionTitleRow } from "./SessionTitleRow.tsx";
import { IconButton } from "./common/IconButton.tsx";

/**
 * @component SessionRowContent
 * @purpose Compact single-line session row chrome for sidebar trees.
 * @useWhen Rendering a session in the sidebar session tree or as a nested related-session row under another object: one truncated title line, inline
 * running/awaiting/unread indicators, and a relative timestamp that swaps to an
 * archive action on hover/focus. The host owns the row's tree chrome (depth
 * indent, expand/collapse chevron).
 * @avoidWhen Rendering full chat headers or rich session detail panels; those need more
 * context-specific layout.
 * @intent Rows stay one line tall so deep hierarchies scan quickly; secondary detail
 * (identity, task progress) lives in the row tooltip instead of a second line.
 * @related SessionInbox, ProjectTreePane, WorktreeBrowser, UnreadDot
 * @perf The row is memoized on `lib/sessionRows.ts`'s content key, and every
 * callback prop therefore carries the session id instead of closing over the row —
 * a per-row arrow would be a fresh identity on every parent render and defeat the
 * memo unconditionally.
 */
interface SessionRowContentProps {
  session: SessionListItem;
  unread?: boolean | undefined;
  /** When provided, hovering the row swaps the timestamp for an archive/restore action. */
  onArchive?: ((id: string, archived: boolean) => void) | undefined;
}

function SessionRowContentImpl({
  session,
  unread,
  onArchive,
}: SessionRowContentProps) {
  // The attention cards' state, with the host's word on unread: the open
  // session reads as read even before the server says so.
  const classified = classifySessionStatus(session);
  const status: SessionInboxStatus =
    unread === false && classified === "unread"
      ? "quiet"
      : unread === true && classified === "quiet"
        ? "unread"
        : classified;

  return (
    <span className="group/session-content flex min-w-0 flex-1 items-center gap-1.5">
      {/* The attention cards' title line: the agent's glyph when idle, the
          coloured status badge when it is doing or needs anything. */}
      <SessionTitleRow session={session} status={status} />
      {/* The pull request the session opened. A GLYPH here: the row is one line
          deep in a tree, so the state travels as tone and accessible name, and
          the row itself is what opens the session holding the card. */}
      <SessionDeliveryMark session={session} variant="glyph" />
      {/* The age and the archive action share ONE slot: the button is laid
          over the age and they trade places by opacity, so hovering never
          changes the row's height or pushes the title (it used to swap a
          16px line for a 24px button and the row wobbled). */}
      <span className="relative flex h-5 min-w-5 shrink-0 items-center justify-end">
        <span
          className={`text-xs tabular-nums text-muted-foreground ${onArchive ? "group-hover/session-content:opacity-0 group-focus-within/session-content:opacity-0" : ""}`}
        >
          {relativeTime(session.updatedAt)}
        </span>
        {onArchive ? (
          <IconButton
            label={session.archived ? "Unarchive session" : "Archive session"}
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              onArchive(session.id, !session.archived);
            }}
            className="absolute top-1/2 right-0 size-5 -translate-y-1/2 opacity-0 group-hover/session-content:opacity-100 group-focus-within/session-content:opacity-100 focus-visible:opacity-100"
          >
            {session.archived ? <ArchiveRestore /> : <Archive />}
          </IconButton>
        ) : null}
      </span>
    </span>
  );
}

export const SessionRowContent = memo(
  SessionRowContentImpl,
  sameSessionRowProps,
);

/**
 * Identity label keyed on the PERSONA (agentType), independent of harness:
 * "Workshop" for the app-modifying persona, "Assistant" otherwise. The harness /
 * provider (pi vs Claude SDK) is a model detail, not the session's persona, so a
 * Claude-SDK assistant reads as an "Assistant" — matching the chat header.
 */
export function identityLabel(identity: {
  agentType?: SessionListItem["agentType"];
}): string {
  if (identity.agentType === "workshop") return "Workshop";
  if (identity.agentType === "developer") return "Developer";
  return "Assistant";
}
