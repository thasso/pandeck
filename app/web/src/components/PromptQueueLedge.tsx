import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ListOrdered,
  Trash2,
} from "lucide-react";
import type {
  PromptQueueState,
  QueuedPeerPrompt,
  QueuedPrompt,
} from "@assistant/shared";
import { sessionPath } from "../lib/sessionRoutes.ts";
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
  /** What other sessions sent this one, waiting behind the user's own rows. */
  peers?: readonly QueuedPeerPrompt[] | undefined;
  /**
   * Background-work updates waiting for the session
   * (`SessionState.queuedBackgroundUpdates`). Counted, never listed: their
   * content is model context. Said only while a Stop holds them.
   */
  backgroundUpdates?: number;
  /** A turn is running, so a queued message can be steered into it. */
  running: boolean;
  /** The provider takes a steer at all. */
  canSteer: boolean;
  onRemove: (id: string) => void;
  /** Steer it into the running turn, or send it next when it cannot. */
  onSendNow: (id: string) => void;
  onResume: () => void;
  /** Deliver a waiting peer prompt now (steer, or send next). */
  onSendPeerNow?: ((id: string) => void) | undefined;
  /** Withdraw a peer prompt before it is delivered. */
  onWithdrawPeer?: ((id: string) => void) | undefined;
  onOpenSession?: ((id: string) => void) | undefined;
}

/**
 * @component PromptQueueLedge
 * @purpose The messages the user queued behind the running turn, in the order
 * they will be sent, on the composer's shelf nearest the field.
 * @useWhen The session on screen has anything queued or a Stop holds it; the
 * host renders nothing otherwise, so the strip costs no space.
 * @avoidWhen Showing what agents have already delivered — those are transcript
 * cards — or agent handoffs, which steer themselves in when they can.
 * @intent Everything typed while a turn runs lands here first, so the strip is
 * OPEN by default and opens again for every new message: the queue is what the
 * user is looking at. Each row does the two things a waiting message needs —
 * steer it into the turn now (or send it next), or drop it — and shows its
 * send while it is under way. A Stop (or a failed send) holds the queue rather
 * than feeding the next message into a session the user just halted, and the
 * strip says so with the one action that lifts it. A Stop also holds what
 * agents and background work queued, so the strip stays for that Resume even
 * with nothing of the user's queued. Peer prompts other sessions
 * sent wait after the user's rows, marked with their sender: the user can steer
 * one in or withdraw it, never edit what another agent wrote. Same object as
 * the session and background-work strips.
 * @related ComposerLedge, Composer, BackgroundWorkLedge, PendingCommentsLedge
 */
/** What a Stop is holding, as the strip's closing sentence. */
function heldSentence(rows: number, backgroundUpdates: number): string {
  const background =
    backgroundUpdates === 1
      ? "1 background update"
      : `${backgroundUpdates} background updates`;
  if (rows > 0)
    return backgroundUpdates > 0
      ? `Nothing is sent until you resume, including ${background}.`
      : "Nothing is sent until you resume.";
  if (backgroundUpdates > 0)
    return `${background} ${backgroundUpdates === 1 ? "waits" : "wait"} until you resume.`;
  return "Agent messages and background updates wait until you resume.";
}

export function PromptQueueLedge({
  queue,
  queuing = [],
  peers = [],
  backgroundUpdates = 0,
  running,
  canSteer,
  onRemove,
  onSendNow,
  onResume,
  onSendPeerNow,
  onWithdrawPeer,
  onOpenSession,
}: PromptQueueLedgeProps) {
  const [open, setOpen] = useState(true);
  // A message just queued is what the user is looking for: reopen for it.
  const knownIds = useRef(
    new Set([
      ...queue.items.map((item) => item.id),
      ...peers.map((peer) => `peer:${peer.id}`),
    ]),
  );
  useEffect(() => {
    const ids = [
      ...queue.items.map((item) => item.id),
      ...peers.map((peer) => `peer:${peer.id}`),
    ];
    const fresh = ids.some((id) => !knownIds.current.has(id));
    knownIds.current = new Set(ids);
    if (fresh) setOpen(true);
  }, [queue.items, peers]);
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

  const count = queue.items.length + queuing.length + peers.length;
  // A Stop holds what agents and background work queued for the session even
  // when the user has nothing queued: the strip stays for its Resume.
  const held = queue.paused || Boolean(queue.automaticTurnsHeld);
  if (count === 0 && !held) return null;
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
        className={`w-full justify-start rounded-none bg-clip-border text-sm ${held ? "text-warning" : "text-muted-foreground"}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ListOrdered aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">
          {held
            ? count > 0
              ? `Queue paused · ${count}`
              : "Stopped"
            : `${count} queued`}
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
            {peers.map((peer) => (
              <QueuedPeerRow
                key={`peer:${peer.id}`}
                peer={peer}
                steering={steering}
                {...(onSendPeerNow ? { onSendNow: onSendPeerNow } : {})}
                {...(onWithdrawPeer ? { onWithdraw: onWithdrawPeer } : {})}
                onOpenSession={onOpenSession}
              />
            ))}
          </ul>
          {held ? (
            <div className="flex h-7 items-center justify-end gap-1.5 pr-1.5 pl-2.5">
              <span>{heldSentence(count, backgroundUpdates)}</span>
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

/**
 * A message another session sent this one, not delivered yet. Its text is the
 * sender's, so it offers no edit: it can go in now (steer, or send next) or be
 * withdrawn. A steer stays here until the turn reads it.
 */
function QueuedPeerRow({
  peer,
  steering,
  onSendNow,
  onWithdraw,
  onOpenSession,
}: {
  peer: QueuedPeerPrompt;
  steering: boolean;
  onSendNow?: (id: string) => void;
  onWithdraw?: (id: string) => void;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  return (
    <li data-queued-peer-prompt={peer.id} className="min-w-0">
      <Item
        size="xs"
        className="flex-nowrap gap-1 rounded-none py-0 pr-1.5 pl-2.5 hover:bg-muted dark:hover:bg-muted/50"
      >
        <ArrowDownLeft
          aria-label="From another session"
          className="size-3.5 shrink-0"
        />
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5">
          <span
            className="min-w-0 truncate text-foreground"
            title={peer.message}
          >
            {peer.message}
          </span>
          <span className="shrink-0 truncate text-xs">
            {"from "}
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
          </span>
        </div>
        <ItemActions className="gap-0.5">
          {peer.sending ? (
            <span className="flex items-center gap-1.5 pr-1 text-xs whitespace-nowrap">
              <Spinner size="xs" />
              {steering ? "Steering…" : "Sending…"}
            </span>
          ) : (
            <>
              {onSendNow ? (
                <IconButton
                  label={steering ? "Steer it in now" : "Send it next"}
                  title={steering ? "Steer" : "Send next"}
                  size="icon-xs"
                  onClick={() => onSendNow(peer.id)}
                >
                  <CornerDownRight />
                </IconButton>
              ) : null}
              {onWithdraw ? (
                <IconButton
                  label="Withdraw message"
                  title="Withdraw"
                  size="icon-xs"
                  onClick={() => onWithdraw(peer.id)}
                >
                  <Trash2 />
                </IconButton>
              ) : null}
            </>
          )}
        </ItemActions>
      </Item>
    </li>
  );
}
