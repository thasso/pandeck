import type { ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  CircleCheck,
  CircleCheckBig,
  CircleSlash,
  CircleStop,
  CircleX,
  Clock3,
  ClockAlert,
  MessageCircle,
  MessagesSquare,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type {
  PeerPromptCard,
  PeerPromptState,
  PeerPromptToolRow,
} from "@assistant/shared";
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
  settled: { label: "Settled", icon: CircleCheckBig },
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

/**
 * A turn the user or the coordinator stopped on purpose: no failure, so it
 * reads as what happened rather than as "Interrupted". A stopped request still
 * owed keeps its "Awaiting response" mark and says why below it.
 */
const STOPPED_MARK = {
  label: "Stopped",
  icon: CircleStop,
  attention: true,
  tone: "muted",
} as const;

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
  const stopped = card.interruption === "stopped";
  const status = !isPeerPromptState(card.state)
    ? undefined
    : stopped && card.state === "interrupted"
      ? STOPPED_MARK
      : STATE_MARK[card.state];
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
      {typeof card.replyTo === "string" && card.replyTo ? (
        <p className="mb-1 break-words text-xs text-muted-foreground">
          In reply to:{" "}
          <Markdown inline text={card.replyTo} onOpenSession={onOpenSession} />
        </p>
      ) : null}
      <Markdown text={message} onOpenSession={onOpenSession} />
      {typeof card.settledReason === "string" && card.settledReason ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          Settled:{" "}
          <Markdown
            inline
            text={card.settledReason}
            onOpenSession={onOpenSession}
          />
        </p>
      ) : null}
      {typeof card.failureReason === "string" && card.failureReason ? (
        <ErrorNote className="mt-1" message={card.failureReason} />
      ) : null}
      {stopped ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {card.state === "awaiting_response"
            ? "Its turn was stopped before it finished; the reply is still owed."
            : "Its turn was stopped before it finished."}
        </p>
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

/**
 * A `session_send_prompt` result: one card per message it sent, one row per
 * settle naming the requests it closed, and each failed row's error in place.
 */
export function PeerPromptToolRowsView({
  rows,
  onOpenSession,
}: {
  rows: PeerPromptToolRow[];
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      {rows.map((row, i) => {
        if (row.kind === "message")
          return (
            <PeerPromptCardView
              key={row.card.messageKey || i}
              card={row.card}
              onOpenSession={onOpenSession}
            />
          );
        if (row.kind === "error")
          return (
            <ErrorNote
              key={`error-${row.index}`}
              message={`Row ${row.index + 1} not sent: ${row.error}`}
            />
          );
        return (
          <PeerPromptSettleRow
            key={`settle-${i}`}
            row={row}
            onOpenSession={onOpenSession}
          />
        );
      })}
    </div>
  );
}

function PeerPromptSettleRow({
  row,
  onOpenSession,
}: {
  row: Extract<PeerPromptToolRow, { kind: "settle" }>;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  const only = row.settled.length === 1 ? row.settled[0] : undefined;
  const sessionId = only?.peerSessionId;
  return (
    <ChatActivityRow
      icon={CircleCheckBig}
      prefix="Settled"
      title={
        only
          ? `request from ${only.senderTitle}`
          : `${row.settled.length} requests`
      }
      {...(sessionId ? { href: sessionPath(sessionId) } : {})}
      onOpenSource={
        sessionId && onOpenSession ? () => onOpenSession(sessionId) : undefined
      }
      preview={activityPreview(row.reason)}
    >
      <p className="mb-1 break-words text-xs text-muted-foreground">
        Settled:{" "}
        <Markdown inline text={row.reason} onOpenSession={onOpenSession} />
      </p>
      <ul className="flex flex-col gap-1">
        {row.settled.map((request, i) => (
          <li key={i} className="break-words">
            <span className="text-xs">From </span>
            {request.peerSessionId ? (
              <a
                href={sessionPath(request.peerSessionId)}
                className="text-xs font-medium underline-offset-4 hover:text-primary hover:underline"
                onClick={(event) => {
                  const id = request.peerSessionId;
                  if (
                    !id ||
                    !onOpenSession ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onOpenSession(id);
                }}
              >
                {request.senderTitle}
              </a>
            ) : (
              <span className="text-xs font-medium">{request.senderTitle}</span>
            )}
            <Markdown
              density="compact"
              text={request.message}
              onOpenSession={onOpenSession}
            />
          </li>
        ))}
      </ul>
    </ChatActivityRow>
  );
}
