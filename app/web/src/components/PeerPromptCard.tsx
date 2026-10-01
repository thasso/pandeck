import { Bot } from "lucide-react";
import type { PeerPromptCard, PeerPromptState } from "@assistant/shared";
import { isPeerPromptState } from "../lib/peerPromptCard.ts";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { Markdown } from "./Markdown.tsx";
import { DASHED_EDGE } from "./ui/load.tsx";

const STATE_LABEL: Record<PeerPromptState, string> = {
  queued: "Queued",
  delivered: "Delivered",
  acknowledged: "Acknowledged",
  completed: "Completed",
  awaiting_response: "Awaiting response",
  replied: "Replied",
  retrying: "Retrying",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Failed",
};

/**
 * The other party, as an in-app link to its session when the card carries one
 * (older cards do not). A real `<a href>` so the ordinary browser gestures —
 * middle-click, cmd/ctrl-click, "open in new tab" — keep working.
 *
 * The id is validated HERE, not by the caller: this is what builds the href and
 * what calls `onOpenSession`, so a non-string on a durable card written by
 * another build would otherwise reach both as `/sessions/%5Bobject%20Object%5D`.
 */
function PeerSessionLink({
  title,
  sessionId: rawSessionId,
  onOpenSession,
}: {
  title: string;
  sessionId?: string | undefined;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId ? rawSessionId : undefined;
  if (!sessionId) return <span>{title}</span>;
  return (
    <a
      href={sessionPath(sessionId)}
      title={`${title} — ${sessionId}`}
      className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
      onClick={(event) => {
        if (
          !onOpenSession ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onOpenSession(sessionId);
      }}
    >
      {title}
    </a>
  );
}

/**
 * Sanitized peer-prompt card. Rendered as the sender's tool result
 * (`direction: "sent"`) and the recipient's transcript block
 * (`direction: "received"`), so both halves of a peer conversation read the
 * same way in either transcript. The message is agent-authored Markdown; the
 * card shows no other ids, paths, reply syntax, or envelope.
 *
 * Total by construction: the tool-result path validates its payload first
 * (`lib/peerPromptCard.ts`), and the fields below are still read defensively so
 * a durable card written by an older build cannot throw a transcript row.
 */
export function PeerPromptCardView({
  card,
  onOpenSession,
}: {
  card: PeerPromptCard;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  const title =
    card.direction === "sent" ? card.recipientTitle : card.senderTitle;
  const peer = (
    <PeerSessionLink
      title={typeof title === "string" && title ? title : "another session"}
      sessionId={card.peerSessionId}
      onOpenSession={onOpenSession}
    />
  );
  const stateLabel = isPeerPromptState(card.state)
    ? STATE_LABEL[card.state]
    : undefined;
  return (
    <section
      className={`min-w-0 max-w-[80%] rounded-2xl rounded-br-md border ${DASHED_EDGE} border-accent/30 bg-accent-soft px-3.5 py-2 text-body text-fg shadow-sm`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-micro font-medium text-accent">
        <Bot size={11} />
        <span className="min-w-0 truncate">
          {card.direction === "sent" ? (
            <>Peer prompt to {peer}</>
          ) : (
            <>Peer prompt from {peer}</>
          )}
        </span>
        {stateLabel ? (
          <span className="ml-auto shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-micro uppercase tracking-wide">
            {stateLabel}
          </span>
        ) : null}
      </div>
      <Markdown
        text={typeof card.message === "string" ? card.message : ""}
        onOpenSession={onOpenSession}
      />
      {typeof card.failureReason === "string" && card.failureReason ? (
        <details className="mt-1 text-micro">
          <summary className="cursor-pointer text-muted">Details</summary>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-danger">
            {card.failureReason}
          </p>
        </details>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-x-2 text-micro text-muted">
        {typeof card.taskTitle === "string" && card.taskTitle ? (
          <span>Task: {card.taskTitle}</span>
        ) : null}
        {card.responseRequested ? <span>Response requested</span> : null}
      </div>
    </section>
  );
}
