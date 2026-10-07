import { memo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  LocateFixed,
  MessageSquareText,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  commentDocumentLabel,
  type PendingChatComment,
} from "../lib/chatCommentPrompt.ts";
import { IconButton } from "./common/IconButton.tsx";
import { Button } from "@/components/ui/button";
import { Item, ItemActions } from "@/components/ui/item";

/**
 * @component PendingCommentsLedge
 * @purpose The comments riding with the next prompt, as a strip on the
 * composer's shelf: how many there are, and — opened — one row per comment
 * that unfolds its text, goes to its passage, edits or removes it.
 * @useWhen The chat composer has pending (not yet sent) comments; the host
 * renders nothing otherwise, so the strip costs no space without them.
 * @avoidWhen Writing a comment — that is the composer's own field (comment
 * mode); this strip lists what has been written.
 * @intent The same object as the session and background-work strips
 * (`ComposerLedge`): a one-line header, edge-to-edge rows, hairline-separated,
 * square fills. It quotes nothing on the row — the passage is highlighted in
 * the transcript, which is where its locate button goes.
 * @related ComposerLedge, BackgroundWorkLedge, SpawnedSessionsLedge,
 * ChatCommentChip (the document surfaces' form of the same list)
 */
export function PendingCommentsLedge({
  comments,
  activeCommentId,
  onSelect,
  onRemove,
  onClear,
  onReveal,
}: {
  comments: readonly PendingChatComment[];
  activeCommentId: string | null;
  /** Load a comment into the composer's field to edit it, or put it back. */
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  /** Scroll to the passage (or open the document) a comment annotates. */
  onReveal?: ((comment: PendingChatComment) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  // Removing EVERY comment is the one act here that cannot be undone a row at
  // a time, so it asks first.
  const [confirmingClear, setConfirmingClear] = useState(false);
  if (comments.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  const count = `${comments.length} comment${comments.length === 1 ? "" : "s"}`;
  return (
    <div data-pending-comments-ledge className="min-w-0">
      <Button
        variant="ghost"
        size="sm"
        // As the other strips' headers: square, filled under Button's
        // transparent border, muted.
        className="w-full justify-start rounded-none bg-clip-border text-sm text-muted-foreground"
        onClick={() => {
          setOpen((value) => !value);
          setConfirmingClear(false);
        }}
        aria-expanded={open}
        title={`${count} will go with your next message`}
      >
        <MessageSquareText aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{count}</span>
        <Chevron aria-hidden="true" />
      </Button>
      {open ? (
        <div className="max-h-72 divide-y overflow-y-auto border-t text-sm text-muted-foreground">
          <ul className="divide-y">
            {comments.map((comment) => (
              <PendingCommentRow
                key={comment.id}
                comment={comment}
                editing={comment.id === activeCommentId}
                onSelect={onSelect}
                onRemove={onRemove}
                onReveal={onReveal}
              />
            ))}
          </ul>
          {confirmingClear ? (
            <div className="flex items-center justify-end gap-1.5 py-1 pr-1.5 pl-2.5">
              <span>Remove all {comments.length}?</span>
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
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-end rounded-none bg-clip-border text-sm text-muted-foreground"
              onClick={() => setConfirmingClear(true)}
            >
              <Trash2 aria-hidden="true" />
              Remove all
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One pending comment: its first line (and document, for a document comment)
 * unfolding to the whole text, then locate, edit and remove — in the order of
 * how far they go.
 */
const PendingCommentRow = memo(function PendingCommentRow({
  comment,
  editing,
  onSelect,
  onRemove,
  onReveal,
}: {
  comment: PendingChatComment;
  editing: boolean;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onReveal?: ((comment: PendingChatComment) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const source =
    comment.anchor.kind === "document"
      ? commentDocumentLabel(comment.anchor.document)
      : undefined;
  return (
    <li className="min-w-0">
      <Item
        size="xs"
        className="flex-nowrap gap-1 rounded-none py-0 pr-1.5 pl-0 hover:bg-muted dark:hover:bg-muted/50"
      >
        <Button
          variant="ghost"
          size="sm"
          // The whole row takes the hover (its `Item`), not just this toggle
          // beside the actions; open is not a hover state.
          className="h-8 min-w-0 flex-1 justify-start rounded-none bg-clip-border text-sm font-normal text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-muted-foreground dark:hover:bg-transparent"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? "Hide the comment" : comment.body}
        >
          <Chevron aria-hidden="true" />
          <span className="min-w-0 truncate">
            {source ? <span>{source} · </span> : null}
            <span className="text-foreground">{comment.body}</span>
          </span>
        </Button>
        <ItemActions className="gap-0.5">
          {onReveal ? (
            <IconButton
              label="Show the commented passage"
              size="icon-xs"
              onClick={() => onReveal(comment)}
            >
              <LocateFixed />
            </IconButton>
          ) : null}
          <IconButton
            label={editing ? "Editing in the composer" : "Edit comment"}
            size="icon-xs"
            aria-pressed={editing || undefined}
            onClick={() => onSelect(editing ? null : comment.id)}
          >
            <Pencil />
          </IconButton>
          <IconButton
            label="Remove comment"
            size="icon-xs"
            onClick={() => onRemove(comment.id)}
          >
            <Trash2 />
          </IconButton>
        </ItemActions>
      </Item>
      {open ? (
        // Under the title (`pl-7`: the toggle's padding, chevron and gap):
        // the passage it is on, quoted, then the whole comment.
        <div className="flex flex-col gap-1.5 pt-0.5 pr-2.5 pb-2 pl-7 text-xs">
          {comment.quote !== undefined ? (
            <blockquote className="border-l-2 pl-2 wrap-anywhere whitespace-pre-wrap text-muted-foreground italic">
              {comment.quote}
            </blockquote>
          ) : (
            <span className="text-muted-foreground italic">
              On the whole document
            </span>
          )}
          <p className="wrap-anywhere whitespace-pre-wrap text-foreground">
            {comment.body}
          </p>
        </div>
      ) : null}
    </li>
  );
});
