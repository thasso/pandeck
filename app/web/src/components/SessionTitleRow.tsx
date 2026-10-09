import type { SessionListItem } from "@assistant/shared";
import {
  sessionStatusBadge,
  tierForStatus,
  type SessionInboxStatus,
} from "../lib/sessionInbox.ts";
import { AGENT_TYPE_DISPLAY } from "./agentTypeDisplay.ts";
import { SessionStatusBadge } from "./SessionStatusBadge.tsx";
import { SessionTitleText } from "./SessionTitleText.tsx";

/**
 * @component SessionTitleRow
 * @purpose A session's title line, the same wherever a session is listed: the
 *   attention cards, the Projects tree (sidebar and Project page), the
 *   inspectors' session rows.
 * @useWhen Drawing a session's leading mark and title; the host owns the row
 *   around it (its age, its actions, its second line).
 * @intent ONE leading 16px slot: an idle session shows what it IS (its agent's
 *   glyph), any other state shows what it needs (the coloured status badge).
 *   Fixed width, so every title starts at the same x. The title is bright only
 *   where it asks for the user — unread, or needing them; a read one recedes.
 *   Renders two flex children for the host's row.
 */
export function SessionTitleRow({
  session,
  status,
}: {
  session: SessionListItem;
  status: SessionInboxStatus;
}) {
  const title = session.title.trim() || "Untitled session";
  // The badge's label never reads the clock, so no `now` is needed here.
  const badge = sessionStatusBadge(session, status, 0);
  const agent =
    AGENT_TYPE_DISPLAY[session.agentType ?? "assistant"] ??
    AGENT_TYPE_DISPLAY.assistant;
  const AgentIcon = agent.Icon;
  const bright = status === "unread" || tierForStatus(status) === "needs-you";
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {status === "quiet" || !badge ? (
          <AgentIcon
            size={13}
            className={`shrink-0 ${agent.activeColor}`}
            aria-hidden
          />
        ) : (
          <SessionStatusBadge badge={badge} status={status} display="slot" />
        )}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-left text-sm ${status === "unread" ? "font-semibold" : "font-medium"} ${bright ? "text-foreground" : "text-muted-foreground"}`}
      >
        <SessionTitleText
          title={title}
          pending={session.titleGenerationPending}
        />
      </span>
    </>
  );
}
