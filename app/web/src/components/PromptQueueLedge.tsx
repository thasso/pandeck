import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ListOrdered,
  Trash2,
  Undo2,
} from "lucide-react";
import type {
  HeldInput,
  PromptQueueState,
  QueuedPeerPrompt,
  QueuedPrompt,
} from "@assistant/shared";
import type { HeldInputRemoval } from "../hooks/useAssistant.ts";
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
  /**
   * Background updates given to a turn that did not finish
   * (`SessionState.unhandledBackgroundUpdates`). Never sent again on their
   * own: Recover hands them to a new turn, Dismiss lets them go.
   */
  unhandledBackgroundUpdates?: number;
  onRecoverBackground?: (() => void) | undefined;
  onDismissBackground?: (() => void) | undefined;
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
  /**
   * Put a held input ({@link PromptQueueState.held}) back into the composer;
   * the host removes it on the server once the field has it.
   */
  onPutBackHeld?: ((input: HeldInput) => void) | undefined;
  /** Discard a held input. */
  onDiscardHeld?: ((id: string) => void) | undefined;
  /**
   * The connection the held answers were sent on. A change either way ends an
   * answer whose outcome is unknown: its busy release, and the next snapshot
   * says what landed.
   */
  connected?: boolean;
  /**
   * Held input id → the last removal this browser sent for it
   * (`UIState.heldInputRemovals`). A row settles only from its own request's
   * answer, and a refusal shows on that row alone.
   */
  heldRemovals?: Readonly<Record<string, HeldInputRemoval>> | undefined;
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
 * the session and background-work strips. Held inputs come first: sends a
 * pending runtime selection refused that cannot wait in the queue (a skill
 * command). They never send on their own, so each offers Put back (into the
 * composer, above what is typed) and Discard, and stays on every device until
 * the user picks one.
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
  unhandledBackgroundUpdates = 0,
  onRecoverBackground,
  onDismissBackground,
  running,
  canSteer,
  onRemove,
  onSendNow,
  onResume,
  onSendPeerNow,
  onWithdrawPeer,
  onOpenSession,
  onPutBackHeld,
  onDiscardHeld,
  connected = true,
  heldRemovals = NO_REMOVALS,
}: PromptQueueLedgeProps) {
  const [open, setOpen] = useState(true);
  const heldInputs = queue.held ?? EMPTY_HELD;
  // A message just queued, or one just held, is what the user is looking
  // for: reopen for it.
  const knownIds = useRef(
    new Set([
      ...queue.items.map((item) => item.id),
      ...peers.map((peer) => `peer:${peer.id}`),
      ...heldInputs.map((input) => `held:${input.id}`),
    ]),
  );
  useEffect(() => {
    const ids = [
      ...queue.items.map((item) => item.id),
      ...peers.map((peer) => `peer:${peer.id}`),
      ...heldInputs.map((input) => `held:${input.id}`),
    ];
    const fresh = ids.some((id) => !knownIds.current.has(id));
    knownIds.current = new Set(ids);
    if (fresh) setOpen(true);
  }, [queue.items, peers, heldInputs]);
  // Held inputs the user already answered, by the answer, busy on its button
  // until the request sent for it is answered or the server's queue drops it.
  // A refusal then shows on its row, and both buttons are free again.
  const [settling, setSettling] = useState<ReadonlyMap<string, HeldSettling>>(
    () => new Map(),
  );
  useEffect(() => {
    setSettling((current) => {
      const ids = new Set(heldInputs.map((input) => input.id));
      const next = new Map([...current].filter(([id]) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [heldInputs]);
  // Unknown outcome: an answer in flight on a connection that dropped, or
  // that a reconnect replaced, is released. Its snapshot decides.
  useEffect(() => {
    setSettling((current) => (current.size === 0 ? current : new Map()));
  }, [connected]);
  // Settled by its OWN answer: the request sent since the click (not the one
  // the row held before it) was answered. Nothing else ends it.
  useEffect(() => {
    setSettling((current) => {
      const next = new Map(
        [...current].filter(([id, s]) => {
          const removal = heldRemovals[id];
          return !(removal?.answered && removal.requestId !== s.before);
        }),
      );
      return next.size === current.size ? current : next;
    });
  }, [heldRemovals]);
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
  const unhandled = unhandledBackgroundUpdates;
  const toPutBack = heldInputs.length;
  if (count === 0 && !held && unhandled === 0 && toPutBack === 0) return null;
  const settle = (
    id: string,
    answer: "putBack" | "discard",
    act: () => void,
  ) => {
    setSettling((current) =>
      new Map(current).set(id, {
        answer,
        before: heldRemovals[id]?.requestId,
      }),
    );
    act();
  };
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
          {[
            held
              ? count > 0
                ? `Queue paused · ${count}`
                : "Stopped"
              : count > 0
                ? `${count} queued`
                : toPutBack === 0
                  ? `${unhandled} background ${unhandled === 1 ? "update" : "updates"} not handled`
                  : undefined,
            toPutBack > 0 ? `${toPutBack} to put back` : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <Chevron aria-hidden="true" />
      </Button>
      {open ? (
        <div className="max-h-72 divide-y overflow-y-auto border-t text-sm text-muted-foreground">
          <ul className="divide-y">
            {heldInputs.map((input) => (
              <HeldInputRow
                key={`held:${input.id}`}
                input={input}
                settling={settling.get(input.id)?.answer}
                failure={
                  settling.has(input.id)
                    ? undefined
                    : heldRemovals[input.id]?.error
                }
                {...(onPutBackHeld
                  ? {
                      onPutBack: (chosen: HeldInput) =>
                        settle(chosen.id, "putBack", () =>
                          onPutBackHeld(chosen),
                        ),
                    }
                  : {})}
                {...(onDiscardHeld
                  ? {
                      onDiscard: (id: string) =>
                        settle(id, "discard", () => onDiscardHeld(id)),
                    }
                  : {})}
              />
            ))}
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
          {unhandled > 0 ? (
            <UnhandledBackgroundRow
              count={unhandled}
              blocked={
                held
                  ? "Resume the session first."
                  : running
                    ? "Recover once the running turn ends."
                    : undefined
              }
              onRecover={onRecoverBackground}
              onDismiss={onDismissBackground}
            />
          ) : null}
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

const EMPTY_HELD: readonly HeldInput[] = [];

const NO_REMOVALS: Readonly<Record<string, HeldInputRemoval>> = {};

/** A held-input answer the user gave, until its own request is answered. */
interface HeldSettling {
  answer: "putBack" | "discard";
  /**
   * The request the row held when the user answered: its answer is an
   * earlier one's, so it does not settle this.
   */
  before: string | undefined;
}

/**
 * A held input: what the user sent that a pending runtime selection refused
 * and that cannot wait in the queue. It never sends on its own; Put back
 * hands it to the composer, Discard drops it.
 */
const HeldInputRow = memo(function HeldInputRow({
  input,
  settling,
  failure,
  onPutBack,
  onDiscard,
}: {
  input: HeldInput;
  /** The user's answer, while the server has not dropped it yet. */
  settling: "putBack" | "discard" | undefined;
  /** Why the last answer failed, until the user gives an answer again. */
  failure: string | undefined;
  onPutBack?: (input: HeldInput) => void;
  onDiscard?: (id: string) => void;
}) {
  return (
    <li data-held-input={input.id} className="min-w-0">
      <Item
        size="xs"
        className="flex-nowrap gap-1.5 rounded-none py-0 pr-1.5 pl-2.5 hover:bg-muted dark:hover:bg-muted/50"
      >
        <Undo2 aria-hidden="true" className="size-3.5 shrink-0" />
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span
            className="min-w-0 flex-1 truncate text-foreground"
            title={input.text}
          >
            {input.text}
          </span>
          {failure ? (
            <span
              role="alert"
              className="min-w-0 truncate text-xs text-destructive"
              title={failure}
            >
              {failure}
            </span>
          ) : (
            <span className="shrink-0 text-xs">did not run</span>
          )}
        </div>
        <ItemActions className="shrink-0 gap-0.5">
          {onDiscard ? (
            <Button
              variant="ghost"
              size="xs"
              busy={settling === "discard"}
              disabled={settling === "putBack"}
              onClick={() => onDiscard(input.id)}
            >
              Discard
            </Button>
          ) : null}
          {onPutBack ? (
            <Button
              variant="secondary"
              size="xs"
              title="Put it back into your message box"
              busy={settling === "putBack"}
              disabled={settling === "discard"}
              onClick={() => onPutBack(input)}
            >
              Put back
            </Button>
          ) : null}
        </ItemActions>
      </Item>
    </li>
  );
});

/**
 * Background updates a turn was given and did not finish handling. Nothing
 * sends them again by itself — not Resume, not the next message — so the row
 * carries the user's two answers: Recover (a new turn picks them up from the
 * conversation) or Dismiss (let them go).
 */
function UnhandledBackgroundRow({
  count,
  blocked,
  onRecover,
  onDismiss,
}: {
  count: number;
  /** Why Recover cannot run now, if it cannot. */
  blocked: string | undefined;
  onRecover: (() => void) | undefined;
  onDismiss: (() => void) | undefined;
}) {
  return (
    <div
      data-unhandled-background
      className="flex min-h-7 items-center justify-end gap-1.5 py-0.5 pr-1.5 pl-2.5"
    >
      <span className="min-w-0 flex-1">
        {count === 1
          ? "1 background update was given to a turn that did not finish."
          : `${count} background updates were given to a turn that did not finish.`}
      </span>
      {onDismiss ? (
        <Button variant="ghost" size="xs" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
      {onRecover ? (
        <Button
          variant="secondary"
          size="xs"
          disabled={blocked !== undefined}
          title={blocked}
          onClick={onRecover}
        >
          Recover
        </Button>
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
          className="h-7 min-w-0 flex-1 shrink justify-start rounded-none bg-clip-border text-sm font-normal text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-muted-foreground dark:hover:bg-transparent"
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
        <ItemActions className="shrink-0 gap-0.5">
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
 * withdrawn. A steer stays here until the turn reads it. A spawned session's
 * opening prompt waiting for its coordinator's slot says so; sending it now
 * starts it ahead of the cap.
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
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span
            className="min-w-0 flex-1 truncate text-foreground"
            title={peer.message}
          >
            {peer.message}
          </span>
          <span className="min-w-0 max-w-1/2 truncate text-xs">
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
            {peer.waitingForSlot ? " · Waiting for a slot" : null}
          </span>
        </div>
        <ItemActions className="shrink-0 gap-0.5">
          {peer.sending ? (
            <span className="flex items-center gap-1.5 pr-1 text-xs whitespace-nowrap">
              <Spinner size="xs" />
              {steering ? "Steering…" : "Sending…"}
            </span>
          ) : (
            <>
              {onSendNow ? (
                <IconButton
                  label={
                    steering
                      ? "Steer it in now"
                      : peer.waitingForSlot
                        ? "Send it now"
                        : "Send it next"
                  }
                  title={
                    steering
                      ? "Steer"
                      : peer.waitingForSlot
                        ? "Send now"
                        : "Send next"
                  }
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
