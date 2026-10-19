import { memo } from "react";
import type { SessionListItem } from "@assistant/shared";
import { relativeTime, sameSessionRowProps } from "../lib/sessionRows.ts";
import { classifySessionStatus } from "../lib/sessionInbox.ts";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { SessionTitleRow } from "./SessionTitleRow.tsx";
import { ListRowContent } from "./common/ListRow.tsx";
import type { RowDensity } from "../lib/rowDensity.ts";

/**
 * @component SessionRowContent
 * @purpose Compact single-line session row chrome for sidebar trees.
 * @useWhen Rendering a session under a Project or worktree: one truncated title
 * line, shared status mark, PR glyph and age, without row actions. The tree
 * owns selection, navigation and indentation, without an empty chevron gutter.
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
  density?: RowDensity;
}

function SessionRowContentImpl({
  session,
  unread,
  density = "tight",
}: SessionRowContentProps) {
  // The attention cards' state, with the host's word on unread: the open
  // session reads as read even before the server says so.
  const status = classifySessionStatus(
    unread === undefined ? session : { ...session, unread },
  );

  return (
    <ListRowContent
      density={density}
      identity={<SessionTitleRow session={session} status={status} />}
      trailing={
        <>
          <SessionDeliveryMark session={session} variant="glyph" />
          <span className="text-xs tabular-nums text-muted-foreground">
            {relativeTime(session.updatedAt)}
          </span>
        </>
      }
    />
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
