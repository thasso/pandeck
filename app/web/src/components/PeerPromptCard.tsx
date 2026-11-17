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
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type {
  PeerPromptCard,
  PeerPromptState,
  PeerPromptToolRow,
} from "@assistant/shared";
import { Button } from "@/components/ui/button";
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
  withdrawn: { label: "Withdrawn", icon: Undo2, tone: "muted" },
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
  onWithdraw,
  actions,
}: {
  card: PeerPromptCard;
  onOpenSession?: ((id: string) => void) | undefined;
  /** Offered on a sent card the server marks `withdrawable`. */
  onWithdraw?: ((messageKey: string) => void) | undefined;
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
  // The server's call, never the displayed state: a request answered by a
  // reply that was lost before delivery reads "Replied" yet is still owed.
  const withdrawable =
    sent && card.withdrawable === true && card.messageKey !== "";
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
      {typeof card.withdrawnReason === "string" && card.withdrawnReason ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          Withdrawn:{" "}
          <Markdown
            inline
            text={card.withdrawnReason}
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
      {withdrawable && onWithdraw ? (
        <Button
          variant="outline"
          size="xs"
          className="mt-1"
          title="Close this request without a reply; the other session is not told"
          onClick={() => onWithdraw(card.messageKey)}
        >
          <Undo2 aria-hidden />
          Withdraw request
        </Button>
      ) : null}
      {actions}
    </ChatActivityRow>
  );
}

/**
 * A `session_send_prompt` result: one card per message it sent, one row per
 * settle or withdraw naming the requests it closed, and each failed row's
 * error in place.
 */
export function PeerPromptToolRowsView({
  rows,
  onOpenSession,
  onWithdrawRequest,
}: {
  rows: PeerPromptToolRow[];
  onOpenSession?: ((id: string) => void) | undefined;
  /** Close one of these sent requests (the viewed session's own). */
  onWithdrawRequest?: ((messageKey: string) => void) | undefined;
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
              onWithdraw={onWithdrawRequest}
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
          <PeerPromptClosedRow
            key={`${row.kind}-${i}`}
            row={row}
            onOpenSession={onOpenSession}
          />
        );
      })}
    </div>
  );
}

/**
 * A settle or withdraw row: the requests it closed without a reply, each named
 * by its other party, under the reason it gave.
 */
function PeerPromptClosedRow({
  row,
  onOpenSession,
}: {
  row: Extract<PeerPromptToolRow, { kind: "settle" | "withdraw" }>;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  const settle = row.kind === "settle";
  const requests = settle
    ? row.settled.map((r) => ({
        party: r.senderTitle,
        peerSessionId: r.peerSessionId,
        message: r.message,
        beforeDelivery: false,
      }))
    : row.withdrawn.map((r) => ({
        party: r.recipientTitle,
        peerSessionId: r.peerSessionId,
        message: r.message,
        beforeDelivery: r.beforeDelivery === true,
      }));
  const verb = settle ? "Settled" : "Withdrawn";
  const only = requests.length === 1 ? requests[0] : undefined;
  const sessionId = only?.peerSessionId;
  return (
    <ChatActivityRow
      icon={settle ? CircleCheckBig : Undo2}
      prefix={verb}
      title={
        only
          ? `request ${settle ? "from" : "to"} ${only.party}`
          : `${requests.length} requests`
      }
      {...(sessionId ? { href: sessionPath(sessionId) } : {})}
      onOpenSource={
        sessionId && onOpenSession ? () => onOpenSession(sessionId) : undefined
      }
      preview={activityPreview(row.reason)}
    >
      <p className="mb-1 break-words text-xs text-muted-foreground">
        {verb}:{" "}
        <Markdown inline text={row.reason} onOpenSession={onOpenSession} />
      </p>
      <ul className="flex flex-col gap-1">
        {requests.map((request, i) => (
          <li key={i} className="break-words">
            <span className="text-xs">{settle ? "From " : "To "}</span>
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
                {request.party}
              </a>
            ) : (
              <span className="text-xs font-medium">{request.party}</span>
            )}
            {request.beforeDelivery ? (
              <span className="text-xs text-muted-foreground">
                {" "}
                (before delivery)
              </span>
            ) : null}
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
