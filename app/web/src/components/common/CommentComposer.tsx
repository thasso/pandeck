import type { ReactNode, RefObject } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { SpeechToTextStatus } from "@assistant/shared";
import { SendHorizontal, Trash2, WandSparkles, X } from "lucide-react";
import { useDictation } from "../../hooks/useDictation.ts";
import { useTouchComposerMode } from "../../hooks/useTouchComposerMode.ts";
import { insertTranscript } from "../../lib/insertTranscript.ts";
import { refineText, type RefineTextOptions } from "../../lib/refineText.ts";
import { showToast, TOAST_DWELL_MS } from "../../lib/toast.ts";
import {
  DictationDiscardButton,
  DictationLiveRegion,
  DictationToggleButton,
  DictationTrace,
  isDictationRecording,
  type DictationControlsData,
} from "../DictationControls.tsx";
import {
  COMPOSER_ACTION_CLUSTER_CLASS,
  COMPOSER_ACTION_ROW_CLASS,
  COMPOSER_CARD_CLASS,
  COMPOSER_CARD_COLLAPSED_CLASS,
  COMPOSER_CARD_SKIN_CLASS,
  composerFoldClass,
  COMPOSER_FIELD_CLASS,
  COMPOSER_FIELD_MAX_HEIGHT,
  autosizeComposerField,
} from "./composerShell.ts";
import { Button } from "../ui/button.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "../ui/input-group.tsx";
import { IconButton } from "./IconButton.tsx";
import { ErrorNote } from "./load.tsx";

export interface CommentRefineOptions extends RefineTextOptions {
  /** Keep the control visible but disabled, explaining why in its tooltip. */
  disabledReason?: string;
}

export interface CommentDictationOptions {
  /** The user setting: false omits the mic rather than leaving a broken control. */
  enabled: boolean;
  /** Deployment availability and recording limit reported by the server. */
  status: SpeechToTextStatus | null;
  /** Optional host-specific reason the visible mic cannot start here. */
  disabledReason?: string;
}

export interface CommentComposerProps {
  onSubmit: (body: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  /** Controlled draft value, for hosts that persist drafts outside this component. */
  value?: string;
  /** Updates a controlled draft value. */
  onChange?: (value: string) => void;
  /** Anchor identity/actions rendered above the shared field. */
  header?: ReactNode;
  /** Show refinement, optionally with session context for the endpoint. */
  refine?: CommentRefineOptions | undefined;
  /** Show dictation when enabled; one recorder is shared across every composer. */
  dictation?: CommentDictationOptions | undefined;
  /**
   * Whether the draft currently holds anything. Hosts use it to decide how
   * disposable this composer is: an EMPTY one can be dismissed or moved by the
   * next tap, while one with text must be closed deliberately.
   */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  /** The composer is visible as context but no reply target is selected yet. */
  disabled?: boolean;
  /** The append request started by this composer is still in flight. */
  busy?: boolean;
  /** Inline failure for that append; the draft remains available to retry. */
  error?: string | undefined;
  /** Keep the draft until a busy cycle settles successfully. */
  deferUntilSettled?: boolean;
  /**
   * How it presents:
   * - `row` (default): one bordered row inside a list or thread card.
   * - `card`: the chat composer's card, for a composer that OWNS a surface's
   *   bottom edge — field on top, every control in the action row beneath it.
   */
  layout?: "row" | "card";
  /**
   * `card` only: mounted, holding no height. The host keeps the field in the DOM
   * so it can focus it inside the tap that opens the composer (the only way iOS
   * raises the keyboard), and un-collapses it in that same tap.
   */
  collapsed?: boolean;
  /** The field itself, for a host that focuses or measures it. */
  fieldRef?: RefObject<HTMLTextAreaElement | null>;
  /** Leave without submitting. The host owns what that discards. */
  onCancel?: () => void;
  /** The surrounding context surface already supplies its own close action. */
  hideCancel?: boolean;
  /**
   * Destroy what is being edited. Offered ONLY when the composer holds an
   * existing comment — there is nothing to delete about a draft, which is what
   * cancel is for.
   */
  onDelete?: (() => void) | undefined;
  /** Names that destructive act, e.g. "Delete comment" or "Delete thread". */
  deleteLabel?: string | undefined;
  /** Names the submit control when it is not a send, e.g. "Save comment". */
  submitLabel?: string | undefined;
}

/**
 * @component CommentComposer
 * @purpose The app's one shape for "write a comment and send it": an optional
 *   anchor header plus ONE row, with refine/dictation when the host enables them
 *   and the send button inside it.
 * @useWhen Any surface that appends a comment to a list or anchored passage —
 *   document trays, diffs, and transcript comments.
 * @avoidWhen Composing a chat prompt (`Composer.tsx` owns attachments, staged
 *   context, slash commands and runtime controls).
 * @intent Deliberately the chat composer's silhouette, because it is the same
 *   act — and in `card` layout literally its shell (`composerShell.ts`), because
 *   a phone's bottom edge holds one or the other and they must not read as two
 *   different objects. Enter sends and Shift+Enter breaks the line, the chat
 *   composer's rule and its touch exception (`useTouchComposerMode`): two
 *   different Enters in one app is a coin toss every time.
 */
export function CommentComposer({
  onSubmit,
  placeholder = "Add a comment…",
  ariaLabel = "Add a comment",
  autoFocus = false,
  value,
  onChange,
  header,
  refine,
  dictation,
  onDirtyChange,
  disabled = false,
  busy = false,
  error,
  deferUntilSettled = false,
  layout = "row",
  collapsed = false,
  fieldRef,
  onCancel,
  hideCancel = false,
  onDelete,
  deleteLabel = "Delete comment",
  submitLabel,
}: CommentComposerProps) {
  const [uncontrolledDraft, setUncontrolledDraft] = useState("");
  const controlled = value !== undefined;
  const draft = value ?? uncontrolledDraft;
  const setDraft = onChange ?? setUncontrolledDraft;
  const [refinementError, setRefinementError] = useState<string | null>(null);
  const [isRefining, setIsRefining] = useState(false);
  const ownDraftRef = useRef<HTMLTextAreaElement | null>(null);
  const draftRef = fieldRef ?? ownDraftRef;
  const card = layout === "card";
  const touch = useTouchComposerMode();
  const caretBeforeDictationRef = useRef<{
    start: number;
    end: number;
  } | null>(null);
  const awaitingRef = useRef(false);
  const sawBusyRef = useRef(false);
  const dirty = Boolean(draft.trim());
  /**
   * A collapsed card is CLOSED — the host cancelled, saved or deleted, and the
   * draft is gone. Nothing this composer started may write to it after that, so
   * everything asynchronous checks this and every close bumps `workEpoch`. A
   * `row` composer gets the same guarantee for free by unmounting; this one
   * stays mounted on purpose (its field is what the next tap focuses).
   */
  const closed = card && collapsed;
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const workEpoch = useRef(0);
  /**
   * Whether work STARTED in `epoch` still belongs to the composer on screen.
   * Reopening does not make an old answer welcome again — `refineText`'s request
   * cannot be recalled — so the epoch, not "is it closed", is what says this is
   * no longer the same piece of work. Dictation needs no epoch here: an
   * utterance is identified inside `useDictation`, which is the only thing that
   * can tell two of them apart.
   */
  const stillCurrent = (epoch: number) =>
    epoch === workEpoch.current && !closedRef.current;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const insertDictated = (spoken: string) => {
    // A cancelled utterance never reaches this (the hook drops its own stale
    // answers); this is the draft's side of the rule — a closed card has none.
    if (closedRef.current) return;
    // Decoding does not lock the draft. Prefer a live caret if the user resumed
    // editing; otherwise use the selection captured before recording took focus.
    const node = draftRef.current;
    const live =
      node && document.activeElement === node
        ? { start: node.selectionStart, end: node.selectionEnd }
        : null;
    const remembered = caretBeforeDictationRef.current;
    const start = Math.min(
      live?.start ?? remembered?.start ?? draft.length,
      draft.length,
    );
    const end = Math.min(live?.end ?? remembered?.end ?? start, draft.length);
    const next = insertTranscript(draft, spoken, start, end);
    setDraft(next.text);
    caretBeforeDictationRef.current = null;
    requestAnimationFrame(() => {
      const textarea = draftRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(next.selectionStart, next.selectionStart);
    });
  };

  const dictationInstanceId = useId();
  const speech = useDictation({
    instanceId: dictationInstanceId,
    available: Boolean(dictation?.status?.configured),
    maxUtteranceSeconds: dictation?.status?.maxUtteranceSeconds ?? 120,
    onTranscript: insertDictated,
    onError: (message) => {
      // Same rule for the failure: nothing this card was doing is worth a toast
      // over whatever took the screen after it closed.
      if (closedRef.current) return;
      showToast(message, {
        tone: "error",
        durationMs: TOAST_DWELL_MS,
        key: "dictation",
      });
    },
  });
  const dictationVisible = Boolean(dictation?.enabled);
  const recording = isDictationRecording(speech.phase);
  const dictationDisabledReason =
    speech.unavailableReason ??
    dictation?.disabledReason ??
    (dictation?.status?.configured === false
      ? (dictation.status.reason ??
        "Dictation is not configured on this server.")
      : undefined) ??
    (speech.busyElsewhere
      ? "Dictation is in use in another composer"
      : undefined) ??
    (busy && speech.phase === "idle"
      ? "Wait for the current comment to finish sending"
      : undefined);
  const toggleDictation = () => {
    if (speech.phase === "idle") {
      const textarea = draftRef.current;
      caretBeforeDictationRef.current = textarea
        ? { start: textarea.selectionStart, end: textarea.selectionEnd }
        : { start: draft.length, end: draft.length };
      textarea?.blur();
    }
    speech.toggle();
  };
  const dictationControls: DictationControlsData = {
    phase: speech.phase,
    peaks: speech.peaks,
    elapsedSeconds: speech.elapsedSeconds,
    uploading: speech.uploading,
    ...(dictationDisabledReason !== undefined
      ? { disabledReason: dictationDisabledReason }
      : {}),
    onToggle: toggleDictation,
    onCancel: speech.cancel,
  };

  // Closing ENDS this composer's work, because nothing of it is on screen any
  // more: a microphone left open behind a collapsed card records with no visible
  // Stop, and a refinement left running answers into a discarded draft. Read
  // through a ref so this fires on the close, not on every render behind it.
  const speechRef = useRef(speech);
  speechRef.current = speech;
  useEffect(() => {
    if (!closed) return;
    workEpoch.current += 1;
    setIsRefining(false);
    setRefinementError(null);
    if (speechRef.current.phase !== "idle") speechRef.current.cancel();
  }, [closed]);

  // Grow with the text, capped, the same way the chat composer's textarea does.
  // `recording` is a dependency because the field remounts when the audio trace
  // gives the row back after recording.
  useLayoutEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    autosizeComposerField(el, card ? COMPOSER_FIELD_MAX_HEIGHT : 160);
    // `draftRef` too: a host swapping its `fieldRef` hands this a different
    // textarea, which needs measuring again.
  }, [card, draft, recording, draftRef]);

  useEffect(() => {
    if (!awaitingRef.current) return;
    if (busy) {
      sawBusyRef.current = true;
      return;
    }
    if (sawBusyRef.current && !error) {
      awaitingRef.current = false;
      sawBusyRef.current = false;
      setDraft("");
    }
    // The two refs gate this to "a submit we started has settled", so listing
    // `setDraft` costs nothing when a controlled host passes a fresh `onChange`.
  }, [busy, error, setDraft]);

  const submit = () => {
    const body = draft.trim();
    if (!body || busy || recording) return;
    if (deferUntilSettled) {
      awaitingRef.current = true;
      sawBusyRef.current = false;
    }
    onSubmit(body);
    if (!deferUntilSettled && !controlled) setDraft("");
  };

  const runRefinement = async () => {
    if (!refine || busy || isRefining) return;
    const text = draft.trim();
    if (!text || refine.disabledReason) return;

    const { disabledReason: _disabledReason, ...options } = refine;
    // Whose refinement this is: a request that lands after a close must not
    // rewrite the draft, raise an error over nothing, or clear a busy state a
    // newly reopened composer now owns.
    const epoch = workEpoch.current;
    setRefinementError(null);
    setIsRefining(true);
    try {
      const refined = await refineText(text, options);
      if (!stillCurrent(epoch)) return;
      setDraft(refined);
      requestAnimationFrame(() =>
        draftRef.current?.focus({ preventScroll: true }),
      );
    } catch (refineError) {
      if (!stillCurrent(epoch)) return;
      setRefinementError(
        refineError instanceof Error
          ? refineError.message
          : String(refineError),
      );
    } finally {
      if (stillCurrent(epoch)) setIsRefining(false);
    }
  };

  const refinementDisabledReason =
    refine?.disabledReason ??
    (busy
      ? "Wait for the current comment to finish sending"
      : !dirty
        ? "Enter a comment to refine"
        : undefined);

  const field = (
    <InputGroupTextarea
      ref={draftRef}
      value={draft}
      readOnly={disabled}
      onChange={(event) => {
        setDraft(event.target.value);
        setRefinementError(null);
      }}
      rows={1}
      autoFocus={autoFocus}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        // Enter sends and Shift+Enter breaks the line, exactly as the chat
        // composer does: writing a comment is the same act as writing a prompt,
        // and two different Enters in one app is a coin toss every time. The
        // ⌘/Ctrl form keeps working for the fingers that learned it.
        const chord = event.metaKey || event.ctrlKey;
        if (event.shiftKey || event.nativeEvent.isComposing) return;
        if (!chord && touch) return;
        event.preventDefault();
        submit();
      }}
      className={card ? COMPOSER_FIELD_CLASS : "max-h-40 min-h-8 py-1.5"}
    />
  );

  const refineControl = refine ? (
    <IconButton
      label="Refine comment"
      onClick={() => void runRefinement()}
      disabled={
        disabled || isRefining || Boolean(refinementDisabledReason) || !dirty
      }
      busy={isRefining}
      {...(refinementDisabledReason ? { title: refinementDisabledReason } : {})}
    >
      <WandSparkles />
    </IconButton>
  ) : null;

  // Cancel, delete and submit sit together at the trailing end: the surface's own
  // three answers, in the order they escalate.
  const surfaceActions = (
    <>
      {onCancel && !hideCancel ? (
        <IconButton label="Cancel comment" onClick={onCancel}>
          <X />
        </IconButton>
      ) : null}
      {onDelete ? (
        <IconButton
          label={deleteLabel}
          onClick={onDelete}
          className="hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 />
        </IconButton>
      ) : null}
      <Button
        type="submit"
        size="icon-sm"
        disabled={disabled || !dirty || (card && recording)}
        busy={busy}
        title={
          touch
            ? (submitLabel ?? "Send")
            : `${submitLabel ?? "Send"} (Enter · Shift+Enter for a new line)`
        }
        aria-label={submitLabel ?? ariaLabel}
      >
        <SendHorizontal />
      </Button>
    </>
  );

  if (card) {
    return (
      <div className="flex flex-col gap-2">
        <form
          // Collapsed is INERT, not unmounted: the field must survive so the host
          // can focus it in the tap that opens this card, and nothing behind a
          // zero-height card may still take a tab stop.
          aria-hidden={collapsed || undefined}
          inert={collapsed || undefined}
          className={`${COMPOSER_CARD_CLASS} ${
            collapsed
              ? COMPOSER_CARD_COLLAPSED_CLASS
              : `p-3 ${COMPOSER_CARD_SKIN_CLASS}`
          }`}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {/* The card collapses by FOLDING this body away, never by cutting its
              own height: the chat composer's collapse is the same act, and a
              height cut from `auto` is the one version of it that cannot
              animate. */}
          <div className={composerFoldClass(collapsed)}>
            <div
              className={`min-h-0 min-w-0 ${collapsed ? "overflow-hidden" : "overflow-visible"}`}
            >
              {header}
              {recording ? (
                <div className="flex min-h-[32px] items-center gap-1">
                  <DictationTrace dictation={dictationControls} />
                  {speech.phase === "recording" ? (
                    <DictationDiscardButton onCancel={speech.cancel} />
                  ) : null}
                </div>
              ) : (
                field
              )}
              <div className={COMPOSER_ACTION_ROW_CLASS}>
                <div className={COMPOSER_ACTION_CLUSTER_CLASS} />
                <div className={COMPOSER_ACTION_CLUSTER_CLASS}>
                  {refineControl}
                  {dictationVisible ? (
                    <DictationToggleButton
                      dictation={dictationControls}
                      disabled={busy}
                    />
                  ) : null}
                  {surfaceActions}
                </div>
              </div>
              {dictationVisible ? (
                <DictationLiveRegion phase={speech.phase} />
              ) : null}
            </div>
          </div>
        </form>
        {collapsed ? null : (
          <>
            {refinementError ? <ErrorNote message={refinementError} /> : null}
            {error ? <ErrorNote message={error} /> : null}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {header}
      <form
        className="relative z-10"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <InputGroup className="items-end">
          {recording ? (
            <InputGroupAddon align="inline-start" className="flex-1">
              <DictationTrace dictation={dictationControls} />
              {speech.phase === "recording" ? (
                <DictationDiscardButton onCancel={speech.cancel} />
              ) : null}
            </InputGroupAddon>
          ) : (
            field
          )}
          <InputGroupAddon align="inline-end" className="gap-1">
            {recording ? (
              <DictationToggleButton dictation={dictationControls} />
            ) : disabled ? null : (
              <>
                {refineControl}
                {dictationVisible ? (
                  <DictationToggleButton
                    dictation={dictationControls}
                    disabled={busy}
                  />
                ) : null}
                {surfaceActions}
              </>
            )}
          </InputGroupAddon>
          {dictationVisible ? (
            <DictationLiveRegion phase={speech.phase} />
          ) : null}
        </InputGroup>
      </form>
      {refinementError ? <ErrorNote message={refinementError} /> : null}
      {error ? <ErrorNote message={error} /> : null}
    </div>
  );
}
