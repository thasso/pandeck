import { useRef } from "react";
import { Mic, Square, X } from "lucide-react";
import type { DictationPhase } from "../hooks/useDictation.ts";
import type { PeakRing } from "../lib/waveform.ts";
import { WaveformStrip } from "./common/WaveformStrip.tsx";
import { LIVE_PULSE, Spinner } from "./common/load.tsx";

/**
 * The dictation surface, shared by every row that can host it: the chat
 * composer's compact bar, the mobile object dock's action row
 * (`SessionDockActions`), and `common/CommentComposer`.
 *
 * Split into pieces rather than one component because the hosts arrange their
 * idle state differently, while the RECORDING state must be identical in all of
 * them: one look, one set of thresholds, one place to change them. Recording UIs
 * drifting apart is the failure mode this exists to prevent.
 *
 * Two size flags are the only thing a host may vary, and neither changes the LOOK:
 * `dense` (trace, discard) for the pieces the dock renders INSIDE its 36px composer
 * field, and `steady` (the toggle) for a host whose row height is fixed. Nothing else
 * may branch on the host.
 */
export interface DictationControlsData {
  phase: DictationPhase;
  peaks: PeakRing;
  elapsedSeconds: number;
  uploading: boolean;
  /** Non-empty when the mic must be shown disabled WITH a reason (no model deployed, in use elsewhere). */
  disabledReason?: string;
  onToggle: () => void;
  onCancel: () => void;
}

/** The mic itself is occupied: it cannot start (or stop) another utterance. */
function isDictationBusy(phase: DictationPhase): boolean {
  return (
    phase === "recording" || phase === "starting" || phase === "transcribing"
  );
}

/**
 * The row belongs to the AUDIO: the trace takes the field and every unrelated
 * control steps aside.
 *
 * Deliberately narrower than {@link isDictationBusy}: decoding happens on the
 * server (~0.05x realtime plus a cold model load), and taking the composer away
 * for that whole wait meant a slow link froze the bottom edge. While
 * transcribing there is no Stop to protect and nothing to plot, so the composer
 * comes back and only the mic stays busy — the transcript lands in the draft
 * when it arrives.
 */
export function isDictationRecording(phase: DictationPhase): boolean {
  return phase === "recording" || phase === "starting";
}

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Live trace plus status text, filling whatever the buttons leave.
 *
 * `w-0` next to `flex-1`: the trace must never win width against the buttons — it
 * is grown from zero into the remaining space. iOS Safari sized the row from the
 * canvas and pushed the stop button off the right edge; belt to `WaveformStrip`
 * taking the canvas out of flow (Chromium shrank it correctly, so the layout is
 * only reproducible on the device).
 */
export function DictationTrace({
  dictation,
  dense = false,
}: {
  dictation: DictationControlsData;
  dense?: boolean;
}) {
  return (
    <div
      className={`flex w-0 min-w-0 flex-1 items-center rounded-xl ${dense ? "h-8 gap-1.5 pl-1" : "h-10 gap-2 px-2"}`}
    >
      <WaveformStrip
        peaks={dictation.peaks}
        active={dictation.phase === "recording"}
        className={`h-5 min-w-0 flex-1 ${dictation.phase === "recording" ? "text-danger" : "text-faint"}`}
      />
      <span className="shrink-0 tabular-nums text-caption text-muted-foreground">
        {dictation.uploading
          ? "uploading…"
          : dictation.phase === "transcribing"
            ? "transcribing…"
            : dictation.phase === "starting"
              ? "starting…"
              : formatElapsed(dictation.elapsedSeconds)}
      </span>
    </div>
  );
}

/**
 * Discard, deliberately small next to a big stop: the easy tap is the one that
 * keeps what you said. Only while actually recording.
 */
export function DictationDiscardButton({
  onCancel,
  dense = false,
}: {
  onCancel: () => void;
  dense?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onCancel}
      title="Discard recording"
      aria-label="Discard recording"
      className={`flex shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger ${
        dense ? "size-7" : "size-8"
      }`}
    >
      <X size={dense ? 14 : 15} />
    </button>
  );
}

/**
 * Mic → stop → spinner, in one control. Stop is deliberately bigger than the mic
 * that started it: it is the one button you reach for one-handed, mid-sentence,
 * without looking. `steady` is the exception, and it has no choice — the dock's row
 * is exactly `BOTTOM_CARD_ROW_PX` tall and the surface behind reserves that, so a
 * recording there must not grow the bar. In that host stop is told apart by its FILL
 * (a red square where a ghost mic was) rather than by growing.
 */
export function DictationToggleButton({
  dictation,
  disabled = false,
  idleSize = "sm",
  steady = false,
}: {
  dictation: DictationControlsData;
  disabled?: boolean;
  /** Match the host row's other controls: `sm` for the composer bar, `md` for the dock's row. */
  idleSize?: "sm" | "md";
  /** Keep `idleSize` in every phase, for a host whose row height is fixed. */
  steady?: boolean;
}) {
  const { phase } = dictation;
  const busy = isDictationBusy(phase);
  // Set when a press already ran on `pointerdown`, so the click it leaves behind
  // does not run it a second time. Cleared by every press, so a keyboard
  // activation (which produces a click with no pointer press) still works.
  const actuatedByPointer = useRef(false);
  return (
    <button
      type="button"
      // STOP acts on the press, not on the click it eventually produces. This is
      // the one control aimed at mid-sentence, one-handed, and a touch click
      // arrives only after the browser has finished deciding the gesture was not
      // a drag or a double tap — which is exactly the lag that made stopping feel
      // like it had missed. Safe here because the dock cannot be dragged while a
      // recording holds it (`expandBlocked`), and stopping is not destructive:
      // it delivers the utterance. Starting deliberately stays on the click.
      onPointerDown={(event) => {
        actuatedByPointer.current = false;
        if (phase !== "recording" || event.button !== 0) return;
        actuatedByPointer.current = true;
        dictation.onToggle();
      }}
      onClick={() => {
        if (actuatedByPointer.current) {
          actuatedByPointer.current = false;
          return;
        }
        dictation.onToggle();
      }}
      disabled={
        disabled ||
        phase === "starting" ||
        phase === "transcribing" ||
        Boolean(dictation.disabledReason)
      }
      // Only `transcribing` is a BUSY control in R5's sense: the user pressed
      // stop and this button is waiting on the answer. Arming is not — nothing
      // was asked for yet — so it disables without claiming to be busy.
      aria-busy={phase === "transcribing" || undefined}
      title={
        dictation.disabledReason ??
        (phase === "recording" ? "Stop and transcribe" : "Dictate")
      }
      aria-label={
        phase === "recording"
          ? "Stop recording and transcribe"
          : "Start dictation"
      }
      className={`flex shrink-0 items-center justify-center rounded-xl transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        busy && !steady ? "size-10" : idleSize === "md" ? "size-9" : "size-8"
      } ${phase === "recording" ? "bg-danger text-primary-foreground hover:bg-danger/90" : "text-muted-foreground hover:bg-raised hover:text-fg"}`}
    >
      {/* Arming is NOT a spinner: a spinner says "waiting for an answer", and
          there is no request here — the microphone and the socket are opening.
          The mic simply pulses until it is live (`LIVE_PULSE`, the primitive
          module's token for exactly this), so the button says what it is about
          to be rather than posing a question the user cannot answer. Only
          `transcribing`, which really is a server wait, spins. */}
      {phase === "transcribing" ? (
        <Spinner size="md" />
      ) : phase === "recording" ? (
        <Square size={16} className="fill-current" />
      ) : (
        <Mic
          size={16}
          className={phase === "starting" ? LIVE_PULSE : undefined}
        />
      )}
    </button>
  );
}

/** Screen-reader announcement of the phase, for a host that shows it visually only. */
export function DictationLiveRegion({ phase }: { phase: DictationPhase }) {
  return (
    <span className="sr-only" aria-live="polite">
      {phase === "recording"
        ? "Recording"
        : phase === "transcribing"
          ? "Transcribing"
          : ""}
    </span>
  );
}
