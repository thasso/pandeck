import { ArrowDown, MessageCircleQuestion } from "lucide-react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

/** Finds the pending question; answering stays on its transcript form. */
export function PendingQuestionLedge({
  title,
  onReveal,
}: {
  title: string;
  onReveal: () => void;
}) {
  return (
    <Item
      size="xs"
      render={
        <button
          type="button"
          onClick={onReveal}
          aria-label={`Show the question "${title}"`}
          title={title}
        />
      }
    >
      <ItemMedia variant="icon">
        <MessageCircleQuestion />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <span>Answer</span>
          <span className="truncate font-normal">{title}</span>
        </ItemTitle>
      </ItemContent>
      <ItemActions className="text-muted-foreground">
        Show question
        <ArrowDown className="size-3.5" />
      </ItemActions>
    </Item>
  );
}
