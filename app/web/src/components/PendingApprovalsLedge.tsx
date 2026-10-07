import { useState } from "react";
import { ArrowDown, ChevronDown, ShieldAlert } from "lucide-react";
import type { ApprovalCard } from "@assistant/shared";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

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
      className="flex max-h-72 min-w-0 flex-col overflow-y-auto"
    >
      {shown.map((card) => (
        <Item
          key={card.id}
          size="xs"
          render={
            <button
              type="button"
              onClick={() => onRevealApproval(card.id)}
              aria-label={`Show the approval card “${card.title}”`}
              title={card.summary ?? card.title}
            />
          }
        >
          <ItemMedia variant="icon">
            <ShieldAlert className="text-warning" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full">
              <span className="text-warning">
                {/* A settings-input card asks for a value, not a yes. */}
                {card.body.kind === "settingsInput" ? "Enter" : "Approve"}
              </span>
              <span className="truncate font-normal">{card.title}</span>
            </ItemTitle>
          </ItemContent>
          <ItemActions className="text-muted-foreground">
            Show card
            <ArrowDown className="size-3.5" />
          </ItemActions>
        </Item>
      ))}
      {hidden > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => setShowAll(true)}
        >
          <ChevronDown aria-hidden="true" />
          Show {hidden} more waiting
        </Button>
      ) : null}
    </div>
  );
}
