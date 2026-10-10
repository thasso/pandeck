import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowUp,
  ListOrdered,
  Paperclip,
  Pause,
  Pencil,
  Play,
  X,
  Zap,
} from "lucide-react";
import type {
  PromptQueueState,
  QueuedPeerPrompt,
  QueuedPrompt,
} from "@assistant/shared";
import { IconButton } from "./common/IconButton.tsx";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";

export interface PromptQueueLedgeProps {
  queue: PromptQueueState;
  /** What other sessions sent this one, waiting behind the user's own rows. */
  peers?: QueuedPeerPrompt[] | undefined;
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
  onSendPeerNow: (id: string) => void;
  onWithdrawPeer: (id: string) => void;
  onOpenSession?: ((id: string) => void) | undefined;
}

/**
 * @component PromptQueueLedge
 * @purpose The messages the user queued behind the running turn, in the order
 * they will be sent, on the composer's own top edge.
 * @useWhen The session on screen has anything queued; the host renders nothing
 * otherwise, so the strip costs no space.
 * @avoidWhen Showing what agents have already delivered — those are transcript
 * cards — or agent handoffs, which steer themselves in when they can.
 * @intent Each row stays the user's draft until its turn: edit it in place,
 * move it, send it now or drop it. A Stop (or a failed send) holds the queue
 * rather than feeding the next message into a session the user just halted,
 * and the strip says so with the one action that lifts it. Peer prompts other
 * sessions sent wait after the drafts, marked with their sender; the user can
 * steer one in or withdraw it, never edit what another agent wrote.
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
  peers = [],
  onSendPeerNow,
  onWithdrawPeer,
  onOpenSession,
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
  const total = count + peers.length;
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
          <Pause aria-hidden="true" className="size-3.5 text-warning" />
        ) : (
          <ListOrdered aria-hidden="true" className="size-3.5 text-primary" />
        )}
        <span
          className={`min-w-0 flex-1 truncate ${queue.paused ? "text-warning" : "text-muted-foreground"}`}
        >
          {queue.paused
            ? `Queue paused · ${count} ${count === 1 ? "message" : "messages"}`
            : `${total} queued`}
          {queue.paused ? null : (
            <span className="hidden @md:inline">
              {` · sent ${running ? "after this response" : "next"}`}
            </span>
          )}
        </span>
        {/* Clear is the user's own queue; another agent's message is
            withdrawn one by one, each telling its sender. */}
        {count > 0 ? (
          <Button variant="ghost" size="xs" onClick={onClear}>
            Clear
          </Button>
        ) : null}
        {queue.paused ? (
          <Button variant="secondary" size="xs" onClick={onResume}>
            <Play aria-hidden="true" />
            Send next
          </Button>
        ) : null}
      </div>
      <ol className="flex max-h-60 flex-col gap-1 overflow-y-auto border-t p-1.5">
        {queue.items.map((item, index) => (
          <li key={item.id}>
            {editing?.id === item.id ? (
              <div className="flex items-start gap-2">
                <Textarea
                  ref={editRef}
                  value={editing.text}
                  onChange={(e) =>
                    setEditing({ id: item.id, text: e.target.value })
                  }
                  onKeyDown={onEditKeyDown}
                  aria-label="Edit queued message"
                  className="min-h-0 min-w-0 flex-1 resize-none"
                />
                <Button size="xs" onClick={saveEdit}>
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
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
        {peers.map((peer) => (
          <li key={`peer:${peer.id}`}>
            <QueuedPeerRow
              peer={peer}
              running={running}
              canSteer={canSteer}
              onSendNow={() => onSendPeerNow(peer.id)}
              onWithdraw={() => onWithdrawPeer(peer.id)}
              onOpenSession={onOpenSession}
            />
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
    <Item size="xs" className="flex-wrap">
      <ItemMedia>
        <Badge variant="outline">{index + 1}</Badge>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full font-normal" title={item.text}>
          <span className={item.command ? "truncate font-mono" : "truncate"}>
            {item.text}
          </span>
        </ItemTitle>
        {item.error ? (
          <p className="text-sm text-destructive">{item.error}</p>
        ) : null}
      </ItemContent>
      {attachmentCount > 0 ? (
        <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
          <Paperclip aria-hidden="true" className="size-3" />
          {attachmentCount}
        </span>
      ) : null}
      {/* A send under way is past changing: the server refuses an edit or
          removal, so the row says what is happening instead of offering them. */}
      {item.sending ? (
        <span className="text-sm text-muted-foreground">Sending…</span>
      ) : (
        // Its own line on a narrow ledge, beside the text on a wide one.
        <ItemActions className="basis-full justify-end gap-0 @md:basis-auto">
          <IconButton
            label={item.command ? "Send it next" : sendNowLabel}
            onClick={onSendNow}
          >
            <Zap />
          </IconButton>
          {!item.command ? (
            <IconButton label="Edit queued message" onClick={onEdit}>
              <Pencil />
            </IconButton>
          ) : null}
          <IconButton
            label="Move up"
            onClick={() => onMove(index - 1)}
            disabled={index === 0}
          >
            <ArrowUp />
          </IconButton>
          <IconButton
            label="Move down"
            onClick={() => onMove(index + 1)}
            disabled={last}
          >
            <ArrowDown />
          </IconButton>
          <IconButton label="Remove queued message" onClick={onRemove}>
            <X />
          </IconButton>
        </ItemActions>
      )}
    </Item>
  );
}

/**
 * A message another session sent this one, not delivered yet. Its text is the
 * sender's, so it offers no edit; it can go in now or be withdrawn.
 */
function QueuedPeerRow({
  peer,
  running,
  canSteer,
  onSendNow,
  onWithdraw,
  onOpenSession,
}: {
  peer: QueuedPeerPrompt;
  running: boolean;
  canSteer: boolean;
  onSendNow: () => void;
  onWithdraw: () => void;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  // A turn that takes no mid-turn input reads it when it ends anyway.
  const canSendNow = !running || canSteer;
  return (
    <Item size="xs" className="flex-wrap">
      <ItemMedia>
        <ArrowDownLeft
          aria-label="From another session"
          className="size-3.5 text-muted-foreground"
        />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full font-normal" title={peer.message}>
          <span className="truncate">{peer.message}</span>
        </ItemTitle>
        <p className="truncate text-xs text-muted-foreground">
          {"From "}
          <a
            href={sessionPath(peer.senderSessionId)}
            className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
            onClick={(event) => {
              if (
                !onOpenSession ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onOpenSession(peer.senderSessionId);
            }}
          >
            {peer.senderTitle}
          </a>
          {peer.responseRequested ? " · wants a reply" : null}
          {peer.retrying ? " · delivery failed, retrying" : null}
        </p>
      </ItemContent>
      {/* Being delivered: a steer stays here until the turn reads it, and
          only then shows in the chat. */}
      {peer.sending ? (
        <span className="text-sm text-muted-foreground">
          {running ? "Steering…" : "Sending…"}
        </span>
      ) : (
        <ItemActions className="basis-full justify-end gap-0 @md:basis-auto">
          {canSendNow ? (
            <IconButton
              label={running ? "Steer it in now" : "Send it next"}
              onClick={onSendNow}
            >
              <Zap />
            </IconButton>
          ) : null}
          <IconButton label="Withdraw message" onClick={onWithdraw}>
            <X />
          </IconButton>
        </ItemActions>
      )}
    </Item>
  );
}
