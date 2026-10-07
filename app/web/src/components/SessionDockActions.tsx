import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  ClipboardList,
  FileText,
  FolderKanban,
  GitBranch,
  MessageSquareQuote,
  Paperclip,
  Plus,
  SendHorizontal,
  Square,
} from "lucide-react";
import type { SpeechToTextStatus } from "@assistant/shared";
import { useDictation } from "../hooks/useDictation.ts";
import { showToast, TOAST_DWELL_MS } from "../lib/toast.ts";
import { COMPOSER_PLACEHOLDER, COMPOSER_STREAMING_LABEL } from "./Composer.tsx";
import { Button } from "@/components/ui/button";
import {
  DockAction,
  DockComposerField,
  DockComposerFace,
} from "./shell/ObjectDock.tsx";
import {
  DictationDiscardButton,
  DictationLiveRegion,
  DictationToggleButton,
  DictationTrace,
  isDictationRecording,
} from "./DictationControls.tsx";

/**
 * What the left pair's second slot offers, resolved by the host: the object this
 * conversation is about (`lib/sessionDockContext.ts` owns that priority order), the
 * new-session screen's staged-context picker before any object exists, or — for a
 * session that hangs off nothing at all — the composer's paperclip, since putting
 * something into a message is the nearest thing left to "where this goes".
 */
export type SessionDockContextSlot =
  | { kind: "add-context"; onRun: () => void }
  | { kind: "attach"; onRun: () => void }
  | {
      kind: "worktree" | "task" | "project" | "file";
      /** The worktree's uncommitted-changes dot, the one indicator worth seeing here. */
      dirty?: boolean;
      onOpen: () => void;
    };

/**
 * @component SessionDockActions
 * @purpose The trailing side of the mobile object dock's action row on a session
 * screen: the bottom bar the composer used to collapse into (app/web/docs/ui-shell.md,
 * Small Screens).
 * @useWhen Mobile layout, on a session route. The wide layout keeps these controls
 * in the chat header and the composer.
 * @avoidWhen Any other object screen — those rows carry the object's own primary
 * action instead.
 * @intent It owns `useDictation` because it renders the recording UI, and the
 * recorder has to live where its trace does: peaks arrive ~40x a second through a
 * ring buffer that `WaveformStrip` reads in its own animation frame, so routing
 * that state up through App would re-render the whole transcript instead. The
 * transcript text is the only thing that leaves here, and it leaves as data (the
 * host hands it to the composer, which inserts it at the caret and opens).
 *
 * What makes this row a CHAT screen's bottom edge rather than another object's is
 * the composer's bordered box (`DockComposerField`): the row is the resting composer,
 * so it looks like one and shows the draft waiting in it. An icon-only row was
 * legible only if you already knew the pen opened a message — and on the new-session
 * screen it left nothing input-shaped on the page at all.
 *
 * The row is BOOKENDED, two controls a side, and that symmetry is a hard rule rather
 * than a preference: the field sits between equal clusters (8px padding, 36px control,
 * 4px gap, each end) so it lands on the same axis as the card's grabber above it. A
 * field inset 44px on one side and 4px on the other read as shoved sideways, its
 * corner colliding with the card's own.
 *
 *   [back][context]  [ field ]  [mic][send]
 *
 * The sides are split by what they act on. The left pair LEAVES this conversation:
 * back, then the `contextSlot` jump — the session's worktree if it has one, else
 * whatever object it hangs off, because that is the screen a session is left for most.
 * (On the new-session screen there is no such object yet, so that slot carries the
 * staged-context picker: the same "set up where this goes", before the fact.) The
 * right pair belongs to the MESSAGE, in the order the composer's own toolbar has them:
 * the mic, then Send — the draft resting in the field can leave from here rather than
 * only after opening the composer to press the same button again.
 *
 * Both right slots keep their place in every state: a turn puts Stop in Send's slot
 * (it is the same primary action the composer swaps in place) and greys the mic beside
 * it, a recording puts the trace in the field and its Stop in the mic's slot. Nothing
 * moves, which is why `onActiveChange` no longer stands the row down mid-recording —
 * it only blocks the SHEET, since nothing may cover the Stop the thumb is aiming for.
 */
export function SessionDockActions({
  disabled,
  streaming,
  acceptsInputWhileRunning = false,
  onAbort,
  draft,
  onCompose,
  onSubmit,
  commentSelection,
  onComment,
  contextSlot,
  dictation,
  startRequest,
  onStartHandled,
  onTranscript,
  onActiveChange,
}: {
  /** No live session to talk to yet (connecting, or the route's session is still loading). */
  disabled: boolean;
  streaming: boolean;
  /**
   * A running turn can still take a message: the harness steers, or the user's
   * queue holds it for after (`promptQueue.ts`). False keeps the row inert for
   * the length of the turn.
   */
  acceptsInputWhileRunning?: boolean;
  onAbort: () => void;
  /**
   * The unsent draft waiting in the closed composer, shown on the field's face —
   * empty when there is none. It replaces the dot the compose glyph used to carry:
   * the text itself says both that something is waiting and what it was.
   */
  draft: string;
  onCompose: () => void;
  /**
   * Send that draft, without opening the composer on the way. The composer owns the
   * text (this row only ever sees the bounded preview above), so this reaches into it
   * — see its `submitRef`, which also handles a send the composer is refusing.
   */
  onSubmit: () => void;
  /** A live transcript selection owns the resting field until it is commented on. */
  commentSelection?: { quote: string } | null;
  onComment?: (() => void) | undefined;
  /**
   * The left pair's second control, beside back. Which one it is belongs to the
   * ROUTE and the session, so the host resolves it and this row owns the glyph.
   * Omitted only when the host can offer none of them — the row then runs 1/2.
   */
  contextSlot?: SessionDockContextSlot | undefined;
  /** `enabled` is the user setting; `status` is what the server reported at connect. */
  dictation: { enabled: boolean; status: SpeechToTextStatus | null };
  /**
   * A pending hand-over from the expanded composer's toolbar mic, which closes the
   * composer and hands over to this row so there is one recorder and one recording
   * UI either way. It is a REQUEST the host holds until this row consumes it, not a
   * token bump: closing the composer is what mounts this row (the bottom edge is one
   * slot), so the row that has to act on the mic press does not exist when it happens
   * — an "only a change while mounted counts" token was therefore always seeded with
   * the new value and never fired.
   */
  startRequest: { at: number } | null;
  /** Consume the request above, whether or not this row could act on it. */
  onStartHandled: () => void;
  onTranscript: (spoken: string) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const instanceId = useId();
  const speech = useDictation({
    instanceId,
    available: Boolean(dictation.status?.configured),
    maxUtteranceSeconds: dictation.status?.maxUtteranceSeconds ?? 120,
    onTranscript,
    // Transient feedback about a gesture belongs in the toast stack, not in the
    // composer's error slot (which is about the draft you are about to send).
    onError: (message) =>
      showToast(message, {
        tone: "error",
        durationMs: TOAST_DWELL_MS,
        key: "dictation",
      }),
  });

  // The user setting hides the mic; a server that cannot dictate (no model
  // deployed, e.g. a PR preview) shows it DISABLED with the reason instead. An
  // absent button reads as an unbuilt feature.
  const available = Boolean(dictation.enabled);
  const disabledReason =
    speech.unavailableReason ??
    (dictation.status?.configured === false
      ? (dictation.status.reason ??
        "Dictation is not configured on this server.")
      : undefined) ??
    (speech.busyElsewhere
      ? "Dictation is in use in another composer"
      : undefined);
  // Only RECORDING owns the row (and blocks the sheet over Stop); while the
  // utterance decodes the field goes back to the draft with the mic spinning.
  const busy = isDictationRecording(speech.phase);

  useEffect(() => {
    onActiveChange(busy);
  }, [busy, onActiveChange]);

  // Hand-over from the expanded composer: it has already remembered its caret and
  // dropped focus, so all that is left is to start. Consumed exactly once (the ref
  // guards a second run before the host's clear commits, which would open a second
  // socket), and ignored if it somehow went stale — a request whose row never
  // mounted must not start recording when one eventually does.
  const handledRequest = useRef<{ at: number } | null>(null);
  useEffect(() => {
    if (!startRequest || handledRequest.current === startRequest) return;
    handledRequest.current = startRequest;
    onStartHandled();
    if (Date.now() - startRequest.at > DICTATION_HANDOVER_MAX_AGE_MS) return;
    if (!available || disabledReason || speech.phase !== "idle") return;
    speech.toggle();
  }, [startRequest, onStartHandled, available, disabledReason, speech]);

  const controls = {
    phase: speech.phase,
    peaks: speech.peaks,
    elapsedSeconds: speech.elapsedSeconds,
    uploading: speech.uploading,
    ...(disabledReason !== undefined ? { disabledReason } : {}),
    onToggle: speech.toggle,
    onCancel: speech.cancel,
  };

  // Left pair, second slot. It holds its place in every state, dictation included: a
  // row that rearranges itself is what the field was introduced to stop.
  const leadSlot = contextSlot ? (
    <ContextSlotAction slot={contextSlot} />
  ) : null;

  // Recording keeps the row exactly where it is: the trace takes the FIELD (the text
  // cannot be read while talking anyway), discard sits small inside it, and Stop is in
  // the mic's own slot. It used to take the whole row, which made the bottom edge a
  // different bar for the duration and cost back its place to make width for it.
  // Send stays where it is too, inert: there is nothing to send until the sentence
  // being spoken lands in the draft.
  if (busy) {
    return (
      <>
        {leadSlot}
        <DockComposerField>
          <DictationTrace dictation={controls} dense />
          {speech.phase === "recording" ? (
            <DictationDiscardButton onCancel={speech.cancel} dense />
          ) : null}
        </DockComposerField>
        <DictationToggleButton dictation={controls} idleSize="md" steady />
        <DockPrimaryAction action="send" disabled onRun={onSubmit} />
      </>
    );
  }

  // A running turn that takes a message keeps the row live: the field opens the
  // composer, where Steer or Queue decides what the message does, and the mic records
  // into it. Stop still holds Send's slot — the draft leaves from the composer, whose
  // own row has both — so the primary action under the thumb never changes mid-turn.
  if (streaming && acceptsInputWhileRunning) {
    return (
      <>
        {leadSlot}
        <DockComposerField>
          <DockComposerFace
            text={
              draft
                ? { value: draft, placeholder: false }
                : { value: COMPOSER_BUSY_PLACEHOLDER, placeholder: true }
            }
            label={
              draft
                ? "Continue your message"
                : "Write a message for this response"
            }
            disabled={disabled}
            onRun={onCompose}
          />
        </DockComposerField>
        {available ? (
          <DictationToggleButton
            dictation={controls}
            disabled={disabled}
            idleSize="md"
            steady
          />
        ) : null}
        <DockPrimaryAction action="stop" onRun={onAbort} />
        <DictationLiveRegion phase={speech.phase} />
      </>
    );
  }

  // A running turn that accepts no input: the composer can neither steer nor queue, so
  // a mic would record into a surface that cannot send. So the field states the turn
  // and goes inert — a bottom edge that loses its input for the length of a turn is
  // worse than one that says why it is unavailable — the mic greys out in place, and
  // Stop takes Send's own slot, the way the composer swaps the two in one button. It is
  // not toned as a danger: interrupting a turn is ordinary.
  if (streaming) {
    return (
      <>
        {leadSlot}
        <DockComposerField>
          <DockComposerFace
            text={{ value: COMPOSER_STREAMING_LABEL, placeholder: true }}
            label="Waiting for this response to finish"
            disabled
            onRun={onCompose}
          />
        </DockComposerField>
        {available ? (
          <DictationToggleButton
            dictation={controls}
            disabled
            idleSize="md"
            steady
          />
        ) : null}
        <DockPrimaryAction action="stop" onRun={onAbort} />
      </>
    );
  }

  return (
    <>
      {leadSlot}
      <DockComposerField>
        <DockComposerFace
          text={
            commentSelection
              ? {
                  value: `Comment on “${commentSelection.quote}”`,
                  placeholder: false,
                }
              : draft
                ? { value: draft, placeholder: false }
                : { value: COMPOSER_PLACEHOLDER, placeholder: true }
          }
          label={
            commentSelection
              ? "Comment on selected text"
              : draft
                ? "Continue your message"
                : "Write a message"
          }
          disabled={disabled}
          commentActuation={Boolean(commentSelection)}
          onRun={commentSelection ? (onComment ?? onCompose) : onCompose}
        />
      </DockComposerField>
      {available ? (
        <DictationToggleButton
          dictation={controls}
          disabled={disabled}
          idleSize="md"
          steady
        />
      ) : null}
      {/* Enabled exactly when there is a prompt to send. The draft above is the
          composer's own trimmed preview, so its emptiness IS "nothing to send" —
          attachments never reach this row, since staging one opens the composer. */}
      <DockPrimaryAction
        action={commentSelection ? "comment" : "send"}
        disabled={
          commentSelection
            ? disabled || !onComment
            : disabled || draft.length === 0
        }
        onRun={commentSelection ? (onComment ?? onCompose) : onSubmit}
      />
      <DictationLiveRegion phase={speech.phase} />
    </>
  );
}

/** The resting field's face while a running turn still takes a message. */
const COMPOSER_BUSY_PLACEHOLDER = "Steer or queue a message…";

/**
 * The slot beside back, whichever of its three answers the host resolved to. Every
 * glyph is the one its destination wears elsewhere in the app (the nav bar's section
 * icons, the composer's context `+` and paperclip), because an action should show
 * where it lands — a WORKTREE glyph rather than a diff one, since this leaves the
 * session for that worktree's screen.
 */
function ContextSlotAction({ slot }: { slot: SessionDockContextSlot }) {
  if (slot.kind === "add-context")
    return (
      <DockAction
        icon={<Plus size={18} />}
        label="Attach a Task, worktree, or project"
        onRun={slot.onRun}
      />
    );
  if (slot.kind === "attach")
    return (
      <DockAction
        icon={<Paperclip size={18} />}
        label="Attach files or images"
        onRun={slot.onRun}
      />
    );
  return (
    <DockAction
      icon={CONTEXT_GLYPH[slot.kind]}
      label={CONTEXT_LABEL[slot.kind]}
      marked={slot.dirty}
      onRun={slot.onOpen}
    />
  );
}

/**
 * The row's last control: the composer's PRIMARY action, at the thumb's end of the
 * bottom edge. One button with two faces, exactly as the composer's own toolbar has
 * it — Send while a draft can leave, Stop while a turn runs — because a control that
 * changes place when it changes meaning is a control you have to find again mid-turn.
 *
 * Drawn as the composer draws them (the default button for send, the secondary
 * one for stop) rather than as one more ghost glyph: this is the one thing in the row that is
 * not navigation, and 36px like everything else beside it.
 */
function DockPrimaryAction({
  action,
  disabled = false,
  onRun,
}: {
  action: "send" | "stop" | "comment";
  disabled?: boolean;
  onRun: () => void;
}) {
  const label =
    action === "stop"
      ? "Stop response"
      : action === "comment"
        ? "Comment"
        : "Send message";
  return (
    <Button
      variant={action === "stop" ? "secondary" : "default"}
      size="icon-lg"
      onPointerDown={
        action === "comment" ? (event) => event.preventDefault() : undefined
      }
      onClick={onRun}
      data-comment-actuation={action === "comment" || undefined}
      disabled={disabled}
      title={
        action === "stop"
          ? "Stop"
          : action === "comment"
            ? "Comment"
            : "Send message"
      }
      aria-label={label}
    >
      {action === "stop" ? (
        <Square className="fill-current" />
      ) : action === "comment" ? (
        <MessageSquareQuote />
      ) : (
        <SendHorizontal />
      )}
    </Button>
  );
}

/**
 * How long a pending dictation hand-over may wait for this row to mount. The row
 * mounts in the same commit that closes the composer, so this only ever discards a
 * request whose screen went away before it could be acted on.
 */
const DICTATION_HANDOVER_MAX_AGE_MS = 5000;

/** Each object's own glyph, so the slot says where it lands (`primaryNavSections`). */
const CONTEXT_GLYPH: Record<
  "worktree" | "task" | "project" | "file",
  ReactNode
> = {
  worktree: <GitBranch size={18} />,
  task: <ClipboardList size={18} />,
  project: <FolderKanban size={18} />,
  file: <FileText size={18} />,
};

const CONTEXT_LABEL: Record<"worktree" | "task" | "project" | "file", string> =
  {
    worktree: "View this session's worktree changes",
    task: "Open this session's task",
    project: "Open this session's project",
    file: "Open this session's file",
  };
