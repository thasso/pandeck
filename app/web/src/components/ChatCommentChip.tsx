import { useState, type ReactNode } from "react";
import { ChevronDown, MessageSquareText, Pencil, Trash2 } from "lucide-react";
import {
  commentDocumentLabel,
  type PendingChatComment,
} from "../lib/chatCommentPrompt.ts";
import type { PendingChatCommentsController } from "../hooks/usePendingChatComments.ts";

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
    <div className="mb-2 overflow-hidden rounded-xl border border-primary/25 bg-accent">
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          onClick={() => {
            setExpanded((value) => !value);
            setConfirmingClear(false);
          }}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left text-sm font-medium text-primary hover:bg-primary/10"
        >
          <MessageSquareText size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">Comments</span>
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-xs font-semibold tabular-nums">
            {comments.length}
          </span>
          <ChevronDown
            size={13}
            className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        {action ? <div className="shrink-0 pr-1">{action}</div> : null}
      </div>
      {expanded ? (
        <div className="border-t border-primary/20 p-1">
          <ul className="flex flex-col">
            {comments.map((comment) => {
              const editing = comment.id === activeCommentId;
              return (
                <li
                  key={comment.id}
                  className={`flex min-w-0 items-center gap-1 rounded-lg pl-2 pr-1 ${
                    editing ? "bg-primary/10" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onReveal?.(comment)}
                    disabled={!onReveal}
                    // The whole comment on hover: the row shows one line, and
                    // the rest is worth reading without opening the editor.
                    title={comment.body}
                    className="min-w-0 flex-1 truncate py-1.5 text-left text-sm text-foreground hover:text-primary disabled:cursor-default disabled:hover:text-foreground"
                  >
                    {labelSources && comment.anchor.kind === "document" ? (
                      <span className="text-muted-foreground">
                        {commentDocumentLabel(comment.anchor.document)} ·{" "}
                      </span>
                    ) : null}
                    {comment.body}
                  </button>
                  <RowAction
                    icon={<Pencil size={13} />}
                    label={editing ? "Editing in the composer" : "Edit comment"}
                    active={editing}
                    onClick={() => onSelect(editing ? null : comment.id)}
                  />
                  <RowAction
                    danger
                    icon={<Trash2 size={13} />}
                    label="Remove comment"
                    onClick={() => onRemove(comment.id)}
                  />
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-end gap-1.5 border-t border-primary/20 px-1 pt-1 text-sm">
            {confirmingClear ? (
              <>
                <span className="mr-auto pl-1 text-muted-foreground">
                  Remove all {comments.length}?
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onClear();
                    setConfirmingClear(false);
                  }}
                  className="rounded-lg px-2 py-1 font-medium text-destructive hover:bg-destructive/10"
                >
                  Remove all
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingClear(false)}
                  className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingClear(true)}
                className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Remove all
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One ghost icon action at the end of a comment row. */
function RowAction({
  icon,
  label,
  onClick,
  active = false,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
        active ? "text-primary" : "text-muted-foreground"
      } ${danger ? "hover:bg-destructive/10 hover:text-destructive" : "hover:bg-primary/10 hover:text-foreground"}`}
    >
      {icon}
    </button>
  );
}
