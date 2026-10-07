import { useState } from "react";
import { ArrowDown, ChevronDown, ShieldAlert } from "lucide-react";
import type { ApprovalCard } from "@assistant/shared";

/**
 * How many pending cards the strip names before folding the rest behind
 * "Show N more". A session rarely holds more than one — a proposing tool ends
 * the agent's turn — so the bound only keeps a pile-up from growing the
 * composer's shelf; opening the fold names every card, in a box that scrolls
 * in place.
 */
const PENDING_APPROVALS_LEDGE_LIMIT = 3;

export interface PendingApprovalsLedgeProps {
  /** The viewed session's cards still waiting on the user, oldest first. */
  cards: readonly ApprovalCard[];
  /** Jump to one card in the transcript and flash it. */
  onRevealApproval: (approvalId: string) => void;
}

/**
 * @component PendingApprovalsLedge
 * @purpose Names every approval card the session on screen is waiting on, and
 * takes the reader to it in one tap.
 * @useWhen The viewed session holds a PENDING approval card; the host renders
 * nothing otherwise.
 * @avoidWhen Deciding the card: Approve and Reject stay on the card, which is
 * where its body can be read. This strip finds the card; it never answers it.
 * @intent A card is anchored at the tool call that proposed it, and an agent
 * that keeps talking afterwards buries it under its own reply. Waiting on the
 * user is a CONDITION (`docs/messaging.md`), so it stays in view on the
 * surface the user is typing into until the card is answered — the same
 * shelf that holds the session's peers and background work. It sits on top of
 * that shelf so it appearing and going away does not move the lines below it.
 * @related ComposerLedge, ApprovalCard, SpawnedSessionsLedge,
 * BackgroundWorkLedge
 */
export function PendingApprovalsLedge({
  cards,
  onRevealApproval,
}: PendingApprovalsLedgeProps) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? cards : cards.slice(0, PENDING_APPROVALS_LEDGE_LIMIT);
  const hidden = cards.length - shown.length;
  return (
    <div
      data-pending-approvals-ledge
      className="max-h-[40vh] min-w-0 overflow-y-auto"
    >
      {shown.map((card) => (
        <button
          key={card.id}
          type="button"
          onClick={() => onRevealApproval(card.id)}
          aria-label={`Show the approval card “${card.title}”`}
          title={card.summary ?? card.title}
          className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-caption text-muted-foreground transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <ShieldAlert
            size={13}
            className="shrink-0 text-warning"
            aria-hidden="true"
          />
          <span className="shrink-0 font-medium text-warning">
            {/* A settings-input card asks for a value, not a yes. */}
            {card.body.kind === "settingsInput" ? "Enter" : "Approve"}
          </span>
          <span className="min-w-0 flex-1 truncate text-fg">{card.title}</span>
          <span className="flex shrink-0 items-center gap-1 text-faint">
            Show card
            <ArrowDown size={12} aria-hidden="true" />
          </span>
        </button>
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-caption text-faint transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
          Show {hidden} more waiting
        </button>
      ) : null}
    </div>
  );
}
