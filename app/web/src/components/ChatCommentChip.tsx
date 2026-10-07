import { useState, type ReactNode } from "react";
import { ChevronDown, MessageSquareText, Pencil, Trash2 } from "lucide-react";
import {
  commentDocumentLabel,
  type PendingChatComment,
} from "../lib/chatCommentPrompt.ts";
import type { PendingChatCommentsController } from "../hooks/usePendingChatComments.ts";
import { IconButton } from "./common/IconButton.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx";
import { Separator } from "./ui/separator.tsx";

/**
 * @component ChatCommentChip
 * @purpose The comments riding with the next prompt: how many there are, and —
 *   expanded — a row per comment that goes to it, edits it or removes it.
 * @useWhen Inside the chat composer, whenever pending comments exist.
 * @avoidWhen Writing a comment: that happens in the composer's own field
 *   (`Composer.tsx`'s comment mode), never in a second editor here.
 * @intent A LIST, not a preview. It quotes nothing — the passage each comment
 *   annotates is highlighted in the transcript, which is where the row takes
 *   you, and repeating it here only pushed the comment itself off the line. One
 *   line of the comment, the full text on hover, and the two acts a pending
 *   comment has.
 * @related Composer, hooks/usePendingChatComments, MessageList.
 */
export function ChatCommentChip({
  comments,
  activeCommentId,
  onSelect,
  onRemove,
  onClear,
  onReveal,
  action,
  labelSources = false,
}: Pick<PendingChatCommentsController, "comments" | "activeCommentId"> & {
  /** Load a comment into the composer's field to edit it. */
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  /** Scroll the transcript to the passage this comment annotates. */
  onReveal?: ((comment: PendingChatComment) => void) | undefined;
  /** One control beside the header, for what the list is waiting for. */
  action?: ReactNode;
  /** Name the document a comment is on (a list mixing several sources). */
  labelSources?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Removing EVERY comment is the one act here that cannot be undone one row at
  // a time, so it asks. It used to be a bare ✕ in the header — one tap away from
  // the control that closes the panel, which is not a place to keep it.
  const [confirmingClear, setConfirmingClear] = useState(false);

  if (comments.length === 0) return null;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => {
        setExpanded(open);
        setConfirmingClear(false);
      }}
      className="mb-2"
    >
      <Card size="sm" className="gap-1 py-1">
        <div className="flex min-w-0 items-center px-1">
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="sm" className="min-w-0 flex-1" />
            }
          >
            <MessageSquareText data-icon="inline-start" />
            <span className="min-w-0 flex-1 text-left">Comments</span>
            <Badge variant="secondary">{comments.length}</Badge>
            <ChevronDown
              data-icon="inline-end"
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </CollapsibleTrigger>
          {action ? <div className="shrink-0 pl-1">{action}</div> : null}
        </div>
        <CollapsibleContent className="flex flex-col gap-1 px-1">
          <Separator />
          <ul className="flex flex-col">
            {comments.map((comment) => {
              const editing = comment.id === activeCommentId;
              return (
                <li
                  key={comment.id}
                  className="flex min-w-0 items-center gap-1"
                >
                  <Button
                    variant={editing ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => onReveal?.(comment)}
                    disabled={!onReveal}
                    // The whole comment on hover: the row shows one line, and
                    // the rest is worth reading without opening the editor.
                    title={comment.body}
                    className="min-w-0 flex-1 justify-start font-normal"
                  >
                    <span className="truncate">
                      {labelSources && comment.anchor.kind === "document" ? (
                        <span className="text-muted-foreground">
                          {commentDocumentLabel(comment.anchor.document)} ·{" "}
                        </span>
                      ) : null}
                      {comment.body}
                    </span>
                  </Button>
                  <IconButton
                    label={editing ? "Editing in the composer" : "Edit comment"}
                    aria-pressed={editing || undefined}
                    onClick={() => onSelect(editing ? null : comment.id)}
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    label="Remove comment"
                    onClick={() => onRemove(comment.id)}
                  >
                    <Trash2 />
                  </IconButton>
                </li>
              );
            })}
          </ul>
          <Separator />
          <div className="flex items-center justify-end gap-1.5 text-sm">
            {confirmingClear ? (
              <>
                <span className="mr-auto pl-1 text-muted-foreground">
                  Remove all {comments.length}?
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    onClear();
                    setConfirmingClear(false);
                  }}
                >
                  Remove all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingClear(false)}
                >
                  Keep
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingClear(true)}
              >
                Remove all
              </Button>
            )}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
