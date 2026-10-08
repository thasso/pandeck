import { memo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  LocateFixed,
  MessageSquareText,
  Pencil,
  Trash2,
} from "lucide-react";
import { IconButton } from "./common/IconButton.tsx";
import { Button } from "@/components/ui/button";
import { Item, ItemActions } from "@/components/ui/item";

/** One comment as the strip shows it, whatever surface it was written on. */
export interface CommentLedgeItem {
  id: string;
  body: string;
  /** Where it was written, before its text on the row: a document, `path:line`. */
  source?: string | undefined;
  /** The passage it is on, quoted when the row unfolds. */
  quote?: string | undefined;
  /** It annotates a whole document rather than a passage. */
  wholeDocument?: boolean | undefined;
  /**
   * Code it was made on (a review thread on a diff): the commented lines with
   * a little of what surrounds them, shown as an excerpt when the row unfolds.
   */
  code?: { before: string; exact: string; after: string } | undefined;
}

/** How many lines of context the excerpt keeps on either side. */
const CODE_CONTEXT_LINES = 2;

/**
 * @component PendingCommentsLedge
 * @purpose The comments riding with the next prompt, as a strip on the
 * composer's shelf: how many there are, and — opened — one row per comment
 * that unfolds its text, goes to its passage, edits or removes it.
 * @useWhen The composer has comments still to be sent: the chat's pending
 * comments, or a worktree review's threads staged for a new session. The host
 * renders nothing otherwise, so the strip costs no space without them.
 * @avoidWhen Writing a comment — that is the composer's own field (comment
 * mode); this strip lists what has been written.
 * @intent The same object as the session and background-work strips
 * (`ComposerLedge`): a one-line header, edge-to-edge rows, hairline-separated,
 * square fills. It quotes nothing on the row — the passage is highlighted where
 * it lives, which is where its locate button goes. A row offers only what its
 * host can do: a review thread is removed from the handoff, never edited here.
 * @related ComposerLedge, BackgroundWorkLedge, SpawnedSessionsLedge,
 * ChatCommentChip (the document surfaces' form of the same list)
 */
export function PendingCommentsLedge({
  items,
  noun = "comment",
  activeCommentId = null,
  onSelect,
  onRemove,
  onClear,
  onReveal,
}: {
  items: readonly CommentLedgeItem[];
  /** What the header counts: `3 comments`, `3 review comments`. */
  noun?: string;
  activeCommentId?: string | null;
  /** Load a comment into the composer's field to edit it, or put it back. */
  onSelect?: ((id: string | null) => void) | undefined;
  onRemove: (id: string) => void;
  onClear: () => void;
  /** Scroll to the passage (or open the document) a comment annotates. */
  onReveal?: ((id: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  // Removing EVERY comment is the one act here that cannot be undone a row at
  // a time, so it asks first.
  const [confirmingClear, setConfirmingClear] = useState(false);
  if (items.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  const count = `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;
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
            {items.map((item) => (
              <PendingCommentRow
                key={item.id}
                item={item}
                editing={item.id === activeCommentId}
                onSelect={onSelect}
                onRemove={onRemove}
                onReveal={onReveal}
              />
            ))}
          </ul>
          {confirmingClear ? (
            // The same 28px as the "Remove all" row it replaces, so asking does
            // not move anything: xs buttons inside it, no vertical padding.
            <div className="flex h-7 items-center justify-end gap-1.5 pr-1.5 pl-2.5">
              <span>Remove all?</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setConfirmingClear(false)}
              >
                Keep
              </Button>
              {/* The destructive answer takes the far end, where the "Remove
                  all" that asked the question sat. */}
              <Button
                variant="destructive"
                size="xs"
                onClick={() => {
                  onClear();
                  setConfirmingClear(false);
                }}
              >
                Remove
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
 * One pending comment: its first line (and where it was written) unfolding to
 * the whole text, then locate, edit and remove — in the order of how far they
 * go, each only where the host offers it.
 */
const PendingCommentRow = memo(function PendingCommentRow({
  item,
  editing,
  onSelect,
  onRemove,
  onReveal,
}: {
  item: CommentLedgeItem;
  editing: boolean;
  onSelect?: ((id: string | null) => void) | undefined;
  onRemove: (id: string) => void;
  onReveal?: ((id: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
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
          className="h-7 min-w-0 flex-1 justify-start rounded-none bg-clip-border text-sm font-normal text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-muted-foreground dark:hover:bg-transparent"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? "Hide the comment" : item.body}
        >
          <Chevron aria-hidden="true" />
          <span className="min-w-0 truncate">
            {item.source ? <span>{item.source} · </span> : null}
            <span className="text-foreground">{item.body}</span>
          </span>
        </Button>
        <ItemActions className="gap-0.5">
          {onReveal ? (
            <IconButton
              label="Show the commented passage"
              size="icon-xs"
              onClick={() => onReveal(item.id)}
            >
              <LocateFixed />
            </IconButton>
          ) : null}
          {onSelect ? (
            <IconButton
              label={editing ? "Editing in the composer" : "Edit comment"}
              size="icon-xs"
              aria-pressed={editing || undefined}
              onClick={() => onSelect(editing ? null : item.id)}
            >
              <Pencil />
            </IconButton>
          ) : null}
          <IconButton
            label="Remove comment"
            size="icon-xs"
            onClick={() => onRemove(item.id)}
          >
            <Trash2 />
          </IconButton>
        </ItemActions>
      </Item>
      {open ? (
        // Under the title (`pl-7`: the toggle's padding, chevron and gap):
        // the passage it is on, quoted, then the whole comment.
        <div className="flex flex-col gap-1.5 pt-0.5 pr-2.5 pb-2 pl-7 text-xs">
          {item.code ? (
            <CodeExcerpt code={item.code} />
          ) : item.quote !== undefined ? (
            <blockquote className="border-l-2 pl-2 wrap-anywhere whitespace-pre-wrap text-muted-foreground italic">
              {item.quote}
            </blockquote>
          ) : item.wholeDocument ? (
            <span className="text-muted-foreground italic">
              On the whole document
            </span>
          ) : null}
          <p className="wrap-anywhere whitespace-pre-wrap text-foreground">
            {item.body}
          </p>
        </div>
      ) : null}
    </li>
  );
});

/**
 * The commented lines as they stood, with a little context dimmed around them:
 * enough to see what the comment is about without opening the diff.
 */
function CodeExcerpt({
  code,
}: {
  code: { before: string; exact: string; after: string };
}) {
  // Only whole lines of context: the prefix ends mid-line where the selection
  // began, so its last partial line belongs to the highlighted text.
  const before = code.before.split("\n").slice(-CODE_CONTEXT_LINES - 1);
  const lead = before.pop() ?? "";
  const after = code.after.split("\n").slice(0, CODE_CONTEXT_LINES + 1);
  const tail = after.shift() ?? "";
  return (
    <pre className="overflow-x-auto rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre">
      {before.length > 0 ? (
        <span className="text-muted-foreground">
          {before.join("\n")}
          {"\n"}
        </span>
      ) : null}
      <span className="text-muted-foreground">{lead}</span>
      <mark className="rounded-sm bg-primary/15 text-foreground">
        {code.exact}
      </mark>
      <span className="text-muted-foreground">{tail}</span>
      {after.length > 0 ? (
        <span className="text-muted-foreground">
          {"\n"}
          {after.join("\n")}
        </span>
      ) : null}
    </pre>
  );
}
