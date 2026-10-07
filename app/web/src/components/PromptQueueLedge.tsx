import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ListOrdered,
  Paperclip,
  Pause,
  Pencil,
  Play,
  X,
  Zap,
} from "lucide-react";
import type { PromptQueueState, QueuedPrompt } from "@assistant/shared";

export interface PromptQueueLedgeProps {
  queue: PromptQueueState;
  /** A turn is running, so "send now" steers rather than starting one. */
  running: boolean;
  /** The running turn takes mid-turn input. */
  canSteer: boolean;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onSendNow: (id: string) => void;
  onClear: () => void;
  onResume: () => void;
}

const ROW_ACTION_CLASS =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-30";
const HEADER_ACTION_CLASS =
  "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

/**
 * @component PromptQueueLedge
 * @purpose The messages the user queued behind the running turn, in the order
 * they will be sent, on the composer's own top edge.
 * @useWhen The session on screen has anything queued; the host renders nothing
 * otherwise, so the strip costs no space.
 * @avoidWhen Showing what agents queued for the session — peer prompts and
 * handoffs have their own cards; this is only the user's own drafts.
 * @intent Each row stays the user's draft until its turn: edit it in place,
 * move it, send it now or drop it. A Stop (or a failed send) holds the queue
 * rather than feeding the next message into a session the user just halted,
 * and the strip says so with the one action that lifts it.
 * @related ComposerLedge, Composer, BackgroundWorkLedge
 */
export function PromptQueueLedge({
  queue,
  running,
  canSteer,
  onEdit,
  onRemove,
  onMove,
  onSendNow,
  onClear,
  onResume,
}: PromptQueueLedgeProps) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  const editRef = useRef<HTMLTextAreaElement>(null);
  const editingId = editing?.id;
  // The user just asked to edit this row: put the caret in it.
  useEffect(() => {
    if (editingId) editRef.current?.focus();
  }, [editingId]);
  const count = queue.items.length;
  const saveEdit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (text) onEdit(editing.id, text);
    setEditing(null);
  };
  const onEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      saveEdit();
    }
  };
  const sendNowLabel = running && canSteer ? "Steer it in now" : "Send it next";

  return (
    // A container, because the ledge is inset from the composer and a phone's
    // row is too narrow for the text and five actions side by side.
    <div data-prompt-queue-ledge className="@container min-w-0">
      <div className="flex h-8 min-w-0 items-center gap-2 px-3 text-sm">
        {queue.paused ? (
          <Pause
            size={13}
            className="shrink-0 text-warning"
            aria-hidden="true"
          />
        ) : (
          <ListOrdered
            size={13}
            className="shrink-0 text-primary"
            aria-hidden="true"
          />
        )}
        <span
          className={`min-w-0 flex-1 truncate ${queue.paused ? "text-warning" : "text-muted-foreground"}`}
        >
          {queue.paused
            ? `Queue paused · ${count} ${count === 1 ? "message" : "messages"}`
            : `${count} queued`}
          {queue.paused ? null : (
            <span className="hidden text-faint @md:inline">
              {` · sent ${running ? "after this response" : "next"}`}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onClear}
          className={`${HEADER_ACTION_CLASS} text-muted-foreground hover:text-fg`}
        >
          Clear
        </button>
        {queue.paused ? (
          <button
            type="button"
            onClick={onResume}
            className={`${HEADER_ACTION_CLASS} text-primary`}
          >
            <Play size={11} className="fill-current" aria-hidden="true" />
            Send next
          </button>
        ) : null}
      </div>
      <ol className="max-h-[30vh] overflow-y-auto border-t border-line px-1.5 py-1">
        {queue.items.map((item, index) => (
          <li
            key={item.id}
            className="rounded-lg px-1.5 py-1 hover:bg-raised/60"
          >
            {editing?.id === item.id ? (
              <div className="flex items-start gap-2">
                <textarea
                  ref={editRef}
                  value={editing.text}
                  onChange={(e) =>
                    setEditing({ id: item.id, text: e.target.value })
                  }
                  onKeyDown={onEditKeyDown}
                  rows={Math.min(
                    5,
                    Math.max(1, editing.text.split("\n").length),
                  )}
                  aria-label="Edit queued message"
                  className="min-w-0 flex-1 resize-none rounded-md border border-line-strong bg-surface px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                />
                <button
                  type="button"
                  onClick={saveEdit}
                  className={`${HEADER_ACTION_CLASS} text-primary`}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className={`${HEADER_ACTION_CLASS} text-muted-foreground`}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <QueuedRow
                item={item}
                index={index}
                last={index === count - 1}
                sendNowLabel={sendNowLabel}
                onEdit={() => setEditing({ id: item.id, text: item.text })}
                onRemove={() => onRemove(item.id)}
                onMove={(to) => onMove(item.id, to)}
                onSendNow={() => onSendNow(item.id)}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function QueuedRow({
  item,
  index,
  last,
  sendNowLabel,
  onEdit,
  onRemove,
  onMove,
  onSendNow,
}: {
  item: QueuedPrompt;
  index: number;
  last: boolean;
  sendNowLabel: string;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (toIndex: number) => void;
  onSendNow: () => void;
}) {
  const attachmentCount = item.attachments?.length ?? 0;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-line bg-surface px-1 text-xs font-semibold text-muted-foreground">
          {index + 1}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-sm text-fg ${item.command ? "font-mono" : ""}`}
          title={item.text}
        >
          {item.text}
        </span>
        {attachmentCount > 0 ? (
          <span className="flex shrink-0 items-center gap-0.5 text-xs text-faint">
            <Paperclip size={11} aria-hidden="true" />
            {attachmentCount}
          </span>
        ) : null}
        {/* A send under way is past changing: the server refuses an edit or
          removal, so the row says what is happening instead of offering them. */}
        {item.sending ? (
          <span className="shrink-0 text-sm text-faint">Sending…</span>
        ) : (
          // Its own line on a narrow ledge, beside the text on a wide one.
          <div className="flex basis-full justify-end @md:basis-auto">
            <button
              type="button"
              onClick={onSendNow}
              title={item.command ? "Send it next" : sendNowLabel}
              aria-label={item.command ? "Send it next" : sendNowLabel}
              className={ROW_ACTION_CLASS}
            >
              <Zap size={13} />
            </button>
            {!item.command ? (
              <button
                type="button"
                onClick={onEdit}
                title="Edit"
                aria-label="Edit queued message"
                className={ROW_ACTION_CLASS}
              >
                <Pencil size={13} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onMove(index - 1)}
              disabled={index === 0}
              title="Move up"
              aria-label="Move up"
              className={ROW_ACTION_CLASS}
            >
              <ArrowUp size={13} />
            </button>
            <button
              type="button"
              onClick={() => onMove(index + 1)}
              disabled={last}
              title="Move down"
              aria-label="Move down"
              className={ROW_ACTION_CLASS}
            >
              <ArrowDown size={13} />
            </button>
            <button
              type="button"
              onClick={onRemove}
              title="Remove"
              aria-label="Remove queued message"
              className={ROW_ACTION_CLASS}
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
      {item.error ? (
        <p className="mt-0.5 pl-7 text-sm text-danger">{item.error}</p>
      ) : null}
    </div>
  );
}
