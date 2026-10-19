import { useState } from "react";
import { ArrowDown, ChevronDown, MessageCircleQuestion } from "lucide-react";
import type { AgentQuestionRequest } from "@assistant/shared";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

/**
 * How many pending flows the strip names before folding the rest behind
 * "Show N more". A driver relaying several children's decisions posts a few
 * at once; the bound keeps the composer's shelf short, and opening the fold
 * names every flow in a box that scrolls in place.
 */
const PENDING_QUESTIONS_LEDGE_LIMIT = 3;

/** What the strip draws of a flow; its content key is the same two fields. */
type PendingQuestionLedgeFlow = Pick<
  AgentQuestionRequest,
  "requestId" | "title"
>;

/** Finds each pending question; answering stays on its transcript form. */
export function PendingQuestionLedge({
  questions,
  onRevealQuestion,
}: {
  /** The viewed session's open flows, oldest first. */
  questions: readonly PendingQuestionLedgeFlow[];
  /** Jump to one flow's form in the transcript and flash it. */
  onRevealQuestion: (requestId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll
    ? questions
    : questions.slice(0, PENDING_QUESTIONS_LEDGE_LIMIT);
  const hidden = questions.length - shown.length;
  return (
    <div
      data-pending-questions-ledge
      className="flex max-h-72 min-w-0 flex-col overflow-y-auto"
    >
      {shown.map((question) => (
        <Item
          key={question.requestId}
          size="xs"
          render={
            <button
              type="button"
              onClick={() => onRevealQuestion(question.requestId)}
              aria-label={`Show the question "${question.title}"`}
              title={question.title}
            />
          }
        >
          <ItemMedia variant="icon">
            <MessageCircleQuestion />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full">
              <span>Answer</span>
              <span className="truncate font-normal">{question.title}</span>
            </ItemTitle>
          </ItemContent>
          <ItemActions className="text-muted-foreground">
            Show question
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

/** The strip's visible content, so its host rebuilds it only when that changes. */
export function pendingQuestionsLedgeKey(
  questions: readonly PendingQuestionLedgeFlow[],
): string {
  return JSON.stringify(questions.map((q) => [q.requestId, q.title]));
}
