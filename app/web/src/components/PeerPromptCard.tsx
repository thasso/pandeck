import type { ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock3,
  ClockAlert,
  MessageCircle,
  MessagesSquare,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { PeerPromptCard, PeerPromptState } from "@assistant/shared";
import { activityPreview } from "../lib/activityPreview.ts";
import { isPeerPromptState } from "../lib/peerPromptCard.ts";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { ChatActivityRow } from "./ChatActivityRow.tsx";
import { ErrorNote } from "./common/load.tsx";
import { Markdown } from "./Markdown.tsx";

const STATE_MARK: Record<
  PeerPromptState,
  {
    label: string;
    icon: LucideIcon;
    attention?: boolean;
    tone?: "muted" | "warning" | "danger";
  }
> = {
  queued: { label: "Queued", icon: Clock3 },
  delivered: { label: "Delivered", icon: Check },
  acknowledged: { label: "Acknowledged", icon: CheckCheck },
  completed: { label: "Completed", icon: CircleCheck },
  awaiting_response: { label: "Awaiting response", icon: MessageCircle },
  replied: { label: "Replied", icon: MessagesSquare },
  retrying: {
    label: "Retrying",
    icon: RefreshCw,
    attention: true,
    tone: "warning",
  },
  interrupted: {
    label: "Interrupted",
    icon: TriangleAlert,
    attention: true,
    tone: "warning",
  },
  cancelled: {
    label: "Cancelled",
    icon: CircleSlash,
    attention: true,
    tone: "muted",
  },
  expired: {
    label: "Expired",
    icon: ClockAlert,
    attention: true,
    tone: "warning",
  },
  failed: { label: "Failed", icon: CircleX, attention: true },
};

/** Both halves of a peer exchange, collapsed until the reader opens the message. */
export function PeerPromptCardView({
  card,
  onOpenSession,
  actions,
}: {
  card: PeerPromptCard;
  onOpenSession?: ((id: string) => void) | undefined;
  actions?: ReactNode;
}) {
  const sent = card.direction === "sent";
  const prefix = sent ? "To" : "From";
  const rawTitle = sent ? card.recipientTitle : card.senderTitle;
  const title =
    typeof rawTitle === "string" && rawTitle ? rawTitle : "another session";
  // Persisted cards from another build are still data. Only a usable string
  // may reach the URL builder or the navigation callback.
  const sessionId =
    typeof card.peerSessionId === "string" && card.peerSessionId
      ? card.peerSessionId
      : undefined;
  const message = typeof card.message === "string" ? card.message : "";
  const status = isPeerPromptState(card.state)
    ? STATE_MARK[card.state]
    : undefined;
  return (
    <ChatActivityRow
      icon={sent ? ArrowUpRight : ArrowDownLeft}
      prefix={prefix}
      title={title}
      {...(sessionId ? { href: sessionPath(sessionId) } : {})}
      onOpenSource={
        sessionId && onOpenSession ? () => onOpenSession(sessionId) : undefined
      }
      preview={activityPreview(message)}
      {...(status ? { status } : {})}
    >
      <p className="mb-1 break-words text-sm text-muted-foreground">
        {prefix} {title}
      </p>
      <Markdown text={message} onOpenSession={onOpenSession} />
      {typeof card.failureReason === "string" && card.failureReason ? (
        <ErrorNote className="mt-1" message={card.failureReason} />
      ) : null}
      <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        {typeof card.taskTitle === "string" && card.taskTitle ? (
          <span>Task: {card.taskTitle}</span>
        ) : null}
        {card.responseRequested ? <span>Response requested</span> : null}
      </div>
      {actions}
    </ChatActivityRow>
  );
}
