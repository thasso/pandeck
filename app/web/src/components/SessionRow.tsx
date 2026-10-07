import { memo } from "react";
import {
  Archive,
  ArchiveRestore,
  CircleHelp,
  MessageSquare,
  Terminal,
  Wrench,
} from "lucide-react";
import type { SessionListItem } from "@assistant/shared";
import { isWorkspaceAware } from "../lib/sessionCapabilities.ts";
import { relativeTime, sameSessionRowProps } from "../lib/sessionRows.ts";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { SessionTitleText } from "./SessionTitleText.tsx";
import { Spinner } from "./common/load.tsx";
import { UnreadDot } from "./UnreadDot.tsx";

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
  const identity = { harness: session.harness, agentType: session.agentType };
  const running = Boolean(session.isStreaming);
  const awaitingInput = Boolean(session.awaitingInput);
  // ONE glyph for every human-blocking state, but the wording says which
  // decision it is: "your answer" is wrong in front of a `/pr` Task chooser.
  const awaitingWhat =
    session.attention === "approval"
      ? "your approval"
      : session.attention === "task-choice"
        ? "you to pick a Task"
        : "your answer";
  const showUnread = Boolean(unread ?? session.unread);
  const rowTitle = session.title.trim() || "Untitled session";

  return (
    <span className="group/session-content flex min-w-0 flex-1 items-center gap-1">
      <span
        className={`relative flex size-5 shrink-0 items-center justify-center rounded-md ${
          isWorkspaceAware(identity)
            ? "bg-amber-400/10 text-amber-500"
            : "bg-accent text-primary"
        }`}
        aria-hidden
      >
        {running ? (
          <Spinner size="sm" />
        ) : identity.agentType === "workshop" ? (
          <Wrench size={12} />
        ) : identity.agentType === "developer" ? (
          <Terminal size={12} />
        ) : (
          <MessageSquare size={12} />
        )}
        {showUnread ? (
          <UnreadDot title="Unread response" placement="avatar" />
        ) : null}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-sm text-fg ${showUnread ? "font-semibold" : ""}`}
      >
        <SessionTitleText
          title={rowTitle}
          pending={session.titleGenerationPending}
        />
      </span>
      {awaitingInput ? (
        <span
          className="flex size-4 shrink-0 items-center justify-center rounded bg-primary/15 text-primary"
          title={`This session is waiting for ${awaitingWhat}`}
          aria-label={`Waiting for ${awaitingWhat}`}
        >
          <CircleHelp size={11} />
        </span>
      ) : null}
      {/* The pull request the session opened. A GLYPH here: the row is one line
          deep in a tree, so the state travels as tone and accessible name, and
          the row itself is what opens the session holding the card. */}
      <SessionDeliveryMark session={session} variant="glyph" />
      <span
        className={`shrink-0 text-xs tabular-nums text-faint ${onArchive ? "group-hover/session-content:hidden group-focus-within/session-content:hidden" : ""}`}
      >
        {relativeTime(session.updatedAt)}
      </span>
      {onArchive ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onArchive(session.id, !session.archived);
          }}
          className="hidden size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-line/60 hover:text-fg group-hover/session-content:flex group-focus-within/session-content:flex"
          title={session.archived ? "Unarchive session" : "Archive session"}
          aria-label={
            session.archived ? "Unarchive session" : "Archive session"
          }
        >
          {session.archived ? (
            <ArchiveRestore size={12} />
          ) : (
            <Archive size={12} />
          )}
        </button>
      ) : null}
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
