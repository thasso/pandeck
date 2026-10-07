import { memo, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ListOrdered,
  Trash2,
} from "lucide-react";
import type { PromptQueueState, QueuedPrompt } from "@assistant/shared";
import { IconButton } from "./common/IconButton.tsx";
import { Spinner } from "./common/load.tsx";
import { Button } from "@/components/ui/button";
import { Item, ItemActions } from "@/components/ui/item";

export interface PromptQueueLedgeProps {
  queue: PromptQueueState;
  /**
   * Messages this browser just queued that the server's queue does not carry
   * yet; shown at the end as "Queuing…" so queueing answers at once.
   */
  queuing?: readonly { key: string; text: string }[];
  /** A turn is running, so a queued message can be steered into it. */
  running: boolean;
  /** The provider takes a steer at all. */
  canSteer: boolean;
  onRemove: (id: string) => void;
  /** Steer it into the running turn, or send it next when it cannot. */
  onSendNow: (id: string) => void;
  onResume: () => void;
}

/**
 * @component PromptQueueLedge
 * @purpose The messages the user queued behind the running turn, in the order
 * they will be sent, on the composer's shelf nearest the field.
 * @useWhen The session on screen has anything queued; the host renders nothing
 * otherwise, so the strip costs no space.
 * @avoidWhen Showing what agents queued for the session — peer prompts and
 * handoffs have their own cards; this is only the user's own messages.
 * @intent Everything typed while a turn runs lands here first, so the strip is
 * OPEN by default and opens again for every new message: the queue is what the
 * user is looking at. Each row does the two things a waiting message needs —
 * steer it into the turn now (or send it next), or drop it — and shows its
 * send while it is under way. A Stop (or a failed send) holds the queue rather
 * than feeding the next message into a session the user just halted, and the
 * strip says so with the one action that lifts it. Same object as the session
 * and background-work strips.
 * @related ComposerLedge, Composer, BackgroundWorkLedge, PendingCommentsLedge
 */
export function PromptQueueLedge({
  queue,
  queuing = [],
  running,
  canSteer,
  onRemove,
  onSendNow,
  onResume,
}: PromptQueueLedgeProps) {
  const [open, setOpen] = useState(true);
  // A message just queued is what the user is looking for: reopen for it.
  const knownIds = useRef(new Set(queue.items.map((item) => item.id)));
  useEffect(() => {
    const fresh = queue.items.some((item) => !knownIds.current.has(item.id));
    knownIds.current = new Set(queue.items.map((item) => item.id));
    if (fresh) setOpen(true);
  }, [queue.items]);
  // Sends this browser asked for, shown as under way before the server's
  // `sending` arrives; a row leaves the set when it leaves the queue.
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set());
  // A row also leaves it when its send failed: the server names the error on
  // the row, and the row is the user's to act on again.
  useEffect(() => {
    setAsked((current) => {
      const waiting = new Set(
        queue.items.filter((item) => !item.error).map((item) => item.id),
      );
      const next = new Set([...current].filter((id) => waiting.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [queue.items]);
  useEffect(() => {
    if (queuing.length > 0) setOpen(true);
  }, [queuing.length]);

  const count = queue.items.length + queuing.length;
  if (count === 0) return null;
  const steering = running && canSteer;
  const Chevron = open ? ChevronDown : ChevronRight;
  const sendNow = (id: string) => {
    setAsked((current) => new Set(current).add(id));
    onSendNow(id);
  };
  return (
    <div data-prompt-queue-ledge className="min-w-0">
      <Button
        variant="ghost"
        size="sm"
        // As the other strips' headers: square, filled under Button's
        // transparent border, muted (warning while the queue is held).
        className={`w-full justify-start rounded-none bg-clip-border text-sm ${queue.paused ? "text-warning" : "text-muted-foreground"}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ListOrdered aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">
          {queue.paused ? `Queue paused · ${count}` : `${count} queued`}
        </span>
        <Chevron aria-hidden="true" />
      </Button>
      {open ? (
        <div className="max-h-72 divide-y overflow-y-auto border-t text-sm text-muted-foreground">
          <ul className="divide-y">
            {queue.items.map((item) => (
              <QueuedRow
                key={item.id}
                item={item}
                sending={Boolean(item.sending) || asked.has(item.id)}
                steering={steering && !item.command}
                onRemove={onRemove}
                onSendNow={sendNow}
              />
            ))}
            {queuing.map((local) => (
              <li key={local.key} className="min-w-0">
                <div className="flex h-7 min-w-0 items-center gap-1 pr-1.5 pl-2.5">
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 shrink-0 opacity-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {local.text}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 pr-1 text-xs">
                    <Spinner size="xs" />
                    Queuing…
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {queue.paused ? (
            <div className="flex h-7 items-center justify-end gap-1.5 pr-1.5 pl-2.5">
              <span>Nothing is sent until you resume.</span>
              <Button variant="secondary" size="xs" onClick={onResume}>
                Resume
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One queued message: its first line unfolding to the whole text, then Steer
 * (or Send next) and Remove — or, while its send is under way, that it is.
 */
const QueuedRow = memo(function QueuedRow({
  item,
  sending,
  steering,
  onRemove,
  onSendNow,
}: {
  item: QueuedPrompt;
  sending: boolean;
  /** Sending now steers it into the running turn (else: it goes next). */
  steering: boolean;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const attachments = item.attachments?.length ?? 0;
  return (
    <li data-queued-prompt={item.id} className="min-w-0">
      <Item
        size="xs"
        className="flex-nowrap gap-1 rounded-none py-0 pr-1.5 pl-0 hover:bg-muted dark:hover:bg-muted/50"
      >
        <Button
          variant="ghost"
          size="sm"
          // The whole row takes the hover (its `Item`); open is not a hover
          // state.
          className="h-7 min-w-0 flex-1 justify-start rounded-none bg-clip-border text-sm font-normal text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-muted-foreground dark:hover:bg-transparent"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? "Hide the message" : item.text}
        >
          <Chevron aria-hidden="true" />
          <span className="min-w-0 truncate text-foreground">{item.text}</span>
          {attachments > 0 ? (
            <span className="shrink-0">
              +{attachments} file{attachments === 1 ? "" : "s"}
            </span>
          ) : null}
        </Button>
        <ItemActions className="gap-0.5">
          {sending ? (
            <span className="flex items-center gap-1.5 pr-1 text-xs whitespace-nowrap">
              <Spinner size="xs" />
              {steering ? "Steering…" : "Sending…"}
            </span>
          ) : (
            <>
              <IconButton
                label={steering ? "Steer it in now" : "Send it next"}
                title={steering ? "Steer" : "Send next"}
                size="icon-xs"
                onClick={() => onSendNow(item.id)}
              >
                <CornerDownRight />
              </IconButton>
              <IconButton
                label="Remove queued message"
                title="Remove"
                size="icon-xs"
                onClick={() => onRemove(item.id)}
              >
                <Trash2 />
              </IconButton>
            </>
          )}
        </ItemActions>
      </Item>
      {item.error ? (
        <p className="pr-2.5 pb-1.5 pl-7 text-xs text-destructive">
          {item.error}
        </p>
      ) : null}
      {open ? (
        // Under the title (`pl-7`: the toggle's padding, chevron and gap).
        <p className="pt-0.5 pr-2.5 pb-2 pl-7 text-xs wrap-anywhere whitespace-pre-wrap text-foreground">
          {item.text}
        </p>
      ) : null}
    </li>
  );
});
