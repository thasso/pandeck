import type {
  ApprovalCard,
  ApprovalStatus,
  DisplayMessage,
} from "@assistant/shared";

/**
 * The approval cards the viewed session holds, oldest first. `useAssistant`
 * keeps them as one-block transcript messages (`state.approvals`), so this is
 * the card out of each.
 */
export function approvalCardsOf(
  messages: readonly DisplayMessage[],
): ApprovalCard[] {
  const cards: ApprovalCard[] = [];
  for (const message of messages)
    for (const block of message.blocks)
      if (block.kind === "approval") cards.push(block.approval);
  return cards.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The cards still waiting on the user, oldest first: what the strip names. A
 * card a session grant already covers (`autoApproved`) is pending only until
 * the session's next idle edge runs it, so it waits on nobody.
 */
export function pendingApprovalCards(
  messages: readonly DisplayMessage[],
): ApprovalCard[] {
  return approvalCardsOf(messages).filter(
    (card) => card.status === "pending" && !card.autoApproved,
  );
}

/**
 * Everything the pending strip draws, as a string: ids and titles. The approval
 * list is rebuilt on every card update and snapshot, so the strip's host gates
 * its identity on this rather than on the array (`src/CLAUDE.md`).
 */
export function pendingApprovalsKey(cards: readonly ApprovalCard[]): string {
  return JSON.stringify(cards.map((card) => [card.id, card.title]));
}

/**
 * The live state a `pa://approval/<id>` link shows after its label, in the
 * card's own words (its status badge), lower-cased to read as a suffix.
 */
export function approvalStatusDetail(status: ApprovalStatus): string {
  switch (status) {
    case "pending":
      return "pending approval";
    case "executing":
      return "executing";
    case "executed":
      return "done";
    case "failed":
      return "failed";
    case "rejected":
      return "rejected";
    case "superseded":
      return "superseded";
  }
}
