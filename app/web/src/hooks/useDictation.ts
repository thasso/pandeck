/**
 * Composer dictation: tap to start, tap to stop, streamed to the server, the
 * transcript handed back to the caller.
 *
 * ONE interaction, deliberately. An earlier version overloaded a single button
 * with press-and-hold AND click-to-latch; once recording moved into the collapsed
 * composer bar (where the control you press to start is not the control you press
 * to stop) holding had no coherent meaning left, and one gesture works the same
 * for pointer, keyboard and assistive tech without a special path.
 *
 * There is exactly ONE dictation owner in the app at a time. `Composer` is
 * mounted in several places simultaneously (chat, new-session landing, dock
 * sheet, inspector), so ownership is tracked in a module-level store rather than
 * per component state; non-owning mic buttons render disabled.
 *
 * The waveform envelope is exposed as a {@link PeakRing} rather than React state:
 * ~40 bars a second through `setState` would re-render the whole composer for a
 * canvas repaint. The waveform component reads the ring in its own animation frame.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SpeechServerMessage,
  SpeechTranscribeResponse,
} from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "../lib/serverOrigin.ts";
import { recordTranscript } from "../lib/recentTranscripts.ts";
import { framePeaks, PEAKS_PER_FRAME, PeakRing } from "../lib/waveform.ts";
import {
  requestScreenWakeLock,
  type ScreenWakeLock,
} from "../lib/screenWakeLock.ts";
import {
  captureUnavailableReason,
  socketAcceptsMore,
  speechSocketUrl,
  startCapture,
  type CaptureHandle,
} from "../lib/speechCapture.ts";

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

/** Seconds of waveform kept on screen (frames are ~200 ms, PEAKS_PER_FRAME bars each). */
const WAVEFORM_SECONDS = 6;
/** Give a backed-up socket this long to drain before falling back to HTTP. */
const DRAIN_TIMEOUT_MS = 4000;
/** Pending bytes above which the UI should say "uploading" rather than spin. */
const BACKLOG_HINT_BYTES = 96 * 1024;

/** Module-level single-owner lock across all mounted composers. */
const owner = {
  id: null as string | null,
  listeners: new Set<() => void>(),
  claim(id: string): boolean {
    if (this.id !== null && this.id !== id) return false;
    this.id = id;
    this.notify();
    return true;
  },
  release(id: string): void {
    if (this.id !== id) return;
    this.id = null;
    this.notify();
  },
  notify(): void {
    for (const listener of this.listeners) listener();
  },
};

export interface UseDictationOptions {
  /** Stable id for this composer instance, used for the single-owner lock. */
  instanceId: string;
  /** Server-reported availability; the button stays disabled when not configured. */
  available: boolean;
  /** Hard cap from settings; recording force-stops here. */
  maxUtteranceSeconds: number;
  /** Called with the final transcript. Never auto-sends. */
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

export interface UseDictationResult {
  phase: DictationPhase;
  /** True while another mounted composer owns dictation. */
  busyElsewhere: boolean;
  /** Seconds recorded so far. */
  elapsedSeconds: number;
  /** Recent input peaks for the waveform; read inside an animation frame, not rendered. */
  peaks: PeakRing;
  /** True when audio is still being uploaded after the user stopped talking. */
  uploading: boolean;
  /** Why dictation cannot run here, when it cannot. */
  unavailableReason?: string;
  /** Start when idle, stop when recording. The only way in or out. */
  toggle: () => void;
  /** Abandon the utterance without transcribing it. */
  cancel: () => void;
}

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const { instanceId, available, maxUtteranceSeconds, onTranscript, onError } =
    options;

  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [ownerId, setOwnerId] = useState<string | null>(owner.id);
  const [elapsedSeconds, setElapsed] = useState(0);
  const [uploading, setUploading] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<CaptureHandle | null>(null);
  // The microphone opens BEFORE the socket is ready (see `begin`), so anything
  // that tears down in that window has a capture on its way and no handle to
  // stop. Held here so it can still be given back.
  const pendingCaptureRef = useRef<Promise<CaptureHandle> | null>(null);
  /**
   * The utterance in flight, and the IDENTITY of that work. Nothing an utterance
   * started can be recalled once it ends — `cancel()` closes the socket, but the
   * HTTP fallback's request is already on the wire — so every completion path
   * captures this id and checks it again before it acts. A stale answer must
   * neither be delivered (it would land in whatever is being written now) nor
   * tear down the utterance that replaced it. Cleared by `teardown`, which is
   * the one place an utterance ends.
   */
  const utteranceRef = useRef<string>("");
  /** The HTTP fallback in flight, so ending an utterance stops the upload too. */
  const uploadRef = useRef<AbortController | null>(null);
  const stoppingRef = useRef(false);
  // One ring per hook instance, reused across utterances.
  const peaksRef = useRef<PeakRing>(
    new PeakRing(Math.round((1000 / 200) * PEAKS_PER_FRAME * WAVEFORM_SECONDS)),
  );
  const timersRef = useRef<{ elapsed?: number; cap?: number }>({});
  // Held only while the microphone is open; see lib/screenWakeLock.ts.
  const wakeLockRef = useRef<ScreenWakeLock | null>(null);

  // Keep callbacks fresh without re-creating the handlers on every render.
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;

  useEffect(() => {
    const listener = () => setOwnerId(owner.id);
    owner.listeners.add(listener);
    return () => {
      owner.listeners.delete(listener);
    };
  }, []);

  const clearTimers = useCallback(() => {
    if (timersRef.current.elapsed)
      window.clearInterval(timersRef.current.elapsed);
    if (timersRef.current.cap) window.clearTimeout(timersRef.current.cap);
    timersRef.current = {};
  }, []);

  /** Whether work started under `utteranceId` is still the utterance in flight. */
  const isCurrent = useCallback(
    (utteranceId: string) =>
      utteranceId !== "" && utteranceRef.current === utteranceId,
    [],
  );

  /** Tear everything down and return to idle, optionally reporting a message. */
  const teardown = useCallback(
    async (message?: string) => {
      clearTimers();
      // This utterance is over: nothing it started may deliver or tear down
      // anything after this point, and its upload is abandoned rather than left
      // running against a microphone that has already been given back.
      utteranceRef.current = "";
      const upload = uploadRef.current;
      uploadRef.current = null;
      upload?.abort();
      const capture = captureRef.current;
      captureRef.current = null;
      const pendingCapture = pendingCaptureRef.current;
      pendingCaptureRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      stoppingRef.current = false;
      wakeLockRef.current?.release();
      wakeLockRef.current = null;
      if (capture) await capture.stop();
      // A capture still on its way belongs to nobody now: stop it when it lands,
      // or the microphone stays open behind a torn-down utterance.
      else if (pendingCapture)
        void pendingCapture.then(
          (late) => late.stop().catch(() => {}),
          () => {},
        );
      if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
      setPhase("idle");
      setElapsed(0);
      peaksRef.current.clear();
      setUploading(false);
      owner.release(instanceId);
      if (message) onErrorRef.current(message);
    },
    [clearTimers, instanceId],
  );

  /**
   * Last-resort delivery: POST the authoritative buffer the capture kept. Used
   * when the socket died mid-utterance or its backlog never drained, so a wifi
   * hiccup costs a round trip instead of the whole dictation.
   */
  const transcribeOverHttp = useCallback(
    async (capture: CaptureHandle, utteranceId: string) => {
      const body = capture.toBuffer();
      if (body.byteLength === 0) {
        if (isCurrent(utteranceId)) await teardown();
        return;
      }
      const upload = new AbortController();
      uploadRef.current = upload;
      try {
        const res = await fetch(
          `${serverHttpOrigin()}/api/speech/transcribe?sampleRate=${Math.round(capture.sampleRate)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/octet-stream",
              ...authHeaders(),
            },
            body,
            signal: upload.signal,
          },
        );
        const payload = (await res
          .json()
          .catch(() => ({}))) as Partial<SpeechTranscribeResponse> & {
          error?: string;
        };
        if (!res.ok)
          throw new Error(
            payload.error || `Transcription failed (${res.status}).`,
          );
        const text = payload.text?.trim() ?? "";
        // Cancelling could not recall this request, so the ANSWER is what gets
        // dropped — including the teardown, which would otherwise stop the
        // recording that has started since.
        if (!isCurrent(utteranceId)) return;
        await teardown();
        if (text) {
          // Remembered so Settings can show what the recognizer actually wrote;
          // authoring a vocabulary rule needs the misheard phrase, and it is
          // otherwise gone the moment you fix the word in the draft.
          recordTranscript(text);
          onTranscriptRef.current(text);
        } else onErrorRef.current("No speech detected.");
      } catch (err) {
        // Same for a failure, and an abort IS the cancellation: it has nothing
        // left to report.
        if (!isCurrent(utteranceId)) return;
        await teardown(err instanceof Error ? err.message : String(err));
      } finally {
        if (uploadRef.current === upload) uploadRef.current = null;
      }
    },
    [isCurrent, teardown],
  );

  /**
   * Stop recording and deliver. The user is done talking, but the audio may not
   * be — flush the watermarked backlog and wait briefly for the socket to drain
   * before giving up on it. A slow link must never cancel the utterance.
   */
  const finish = useCallback(async () => {
    if (stoppingRef.current) return;
    const capture = captureRef.current;
    const socket = socketRef.current;
    if (!capture) return;
    const utteranceId = utteranceRef.current;
    stoppingRef.current = true;
    clearTimers();
    setPhase("transcribing");

    await capture.stop();
    // Delivery is a sequence of waits, and a cancel can land in any of them.
    // Past that point this utterance speaks for nobody: it must not upload, must
    // not touch the shared phase, and must not send a frame for an id the socket
    // it is holding no longer knows.
    if (!isCurrent(utteranceId)) return;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      await transcribeOverHttp(capture, utteranceId);
      return;
    }

    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (!capture.flush()) {
      if (Date.now() > deadline || socket.readyState !== WebSocket.OPEN) {
        await transcribeOverHttp(capture, utteranceId);
        return;
      }
      // Only claim "uploading" once the backlog is big enough to be worth
      // explaining; a brief drain just looks like normal transcribing.
      if (capture.pendingBytes() > BACKLOG_HINT_BYTES) setUploading(true);
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      if (!isCurrent(utteranceId)) return;
    }
    setUploading(false);
    socket.send(JSON.stringify({ type: "stop", utteranceId }));
  }, [clearTimers, isCurrent, transcribeOverHttp]);

  const begin = useCallback(async () => {
    if (!owner.claim(instanceId)) return;
    const unavailable = captureUnavailableReason();
    if (unavailable) {
      owner.release(instanceId);
      onErrorRef.current(unavailable);
      return;
    }

    setPhase("starting");
    peaksRef.current.clear();
    const utteranceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    utteranceRef.current = utteranceId;
    stoppingRef.current = false;

    let socket: WebSocket;
    try {
      socket = new WebSocket(speechSocketUrl(serverHttpOrigin()));
    } catch (err) {
      await teardown(err instanceof Error ? err.message : String(err));
      return;
    }
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    // THIS socket belongs to THIS utterance, and closing it races the server: it
    // can still deliver after the cancel that ended the utterance, by which time
    // another may be recording. So both handlers are dead the moment their own
    // utterance is over — checked before anything is read, because an error frame
    // carries no id of its own to check (`utteranceId` is optional on it) and the
    // native `error` event carries nothing at all.
    const socketIsCurrent = () => isCurrent(utteranceId);
    socket.onmessage = (event: MessageEvent) => {
      if (!socketIsCurrent()) return;
      let msg: SpeechServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as SpeechServerMessage;
      } catch {
        return;
      }
      // A labelled frame must also be about this utterance and not some other.
      if (msg.type !== "error" && msg.utteranceId !== utteranceId) return;
      if (msg.type === "transcript") {
        const text = msg.text.trim();
        void teardown().then(() => {
          if (text) {
            recordTranscript(text);
            onTranscriptRef.current(text);
          } else onErrorRef.current("No speech detected.");
        });
        return;
      }
      if (msg.type === "error") {
        if (msg.utteranceId && msg.utteranceId !== utteranceId) return;
        void teardown(msg.message);
      }
    };
    socket.onerror = () => {
      if (!socketIsCurrent()) return;
      // Only surface a socket failure when there is nothing to fall back to;
      // `finish` handles the mid-utterance death via the HTTP path.
      if (!captureRef.current)
        void teardown("Could not reach the dictation service.");
    };

    // Audio must never precede the `start` frame — the server treats that as a
    // protocol violation and closes the socket. Capture begins delivering as soon
    // as the graph connects, which is BEFORE the socket is open and before we know
    // the rate to announce, so hold delivery until `start` is out. Held frames stay
    // in the capture's authoritative buffer and go out on the next flush, so
    // nothing is lost by starting the microphone first.
    let startSent = false;
    // The microphone is opened NOW, in the same task as the press, for two
    // reasons: Safari only lets a user gesture start audio, so spending the
    // gesture on the socket handshake first can leave the graph suspended and
    // recording silence; and the two setups are independent, so overlapping them
    // makes starting cost max(socket, microphone) rather than their sum. That
    // wait is the whole reason the button used to sit there spinning.
    const capturing = startCapture({
      // Envelope for the waveform, derived here rather than in the worklet so
      // the audio thread stays untouched. Written into a ring, never state.
      onFrame: (frame) => peaksRef.current.push(framePeaks(frame)),
      send: (frame) => {
        if (!startSent || !socketAcceptsMore(socket)) return false;
        // Send the exact bytes of this frame. `Int16Array` is not a
        // `BufferSource` under TS's SharedArrayBuffer-aware typing, and the
        // worklet transfers each frame with its own dedicated buffer.
        socket.send(
          new Uint8Array(
            frame.buffer as ArrayBuffer,
            frame.byteOffset,
            frame.byteLength,
          ),
        );
        return true;
      },
    });
    pendingCaptureRef.current = capturing;

    try {
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        const failed = () =>
          reject(new Error("Could not reach the dictation service."));
        socket.addEventListener("close", failed, { once: true });
        socket.addEventListener("error", failed, { once: true });
      });
    } catch (err) {
      // A handshake this utterance no longer owns has nothing to report: the
      // close it just saw IS the cancellation that ended it.
      if (!isCurrent(utteranceId)) return;
      await teardown(err instanceof Error ? err.message : String(err));
      return;
    }
    // Cancelled while the socket was opening. `teardown` has already given back
    // the microphone (including this still-pending capture) and the socket, and
    // every ref below now belongs to whatever started after it.
    if (!isCurrent(utteranceId)) return;

    try {
      // Start the expensive server-side model load while browser microphone
      // permission and AudioContext setup run. It needs no sample rate yet, and
      // the server keeps the warm-up reservation until this utterance finishes.
      // A cold model is never a UI state: recording and streaming go ahead, and
      // the load is simply over by the time the utterance is submitted.
      socket.send(JSON.stringify({ type: "warm", utteranceId }));

      const capture = await capturing;
      // The microphone is the longest wait there is — a permission prompt can
      // sit there for as long as the user ignores it — so it is the likeliest
      // place for a cancel to land. Adopting this capture now would hand a dead
      // utterance's microphone to the live one, announce `start` for an id its
      // socket never opened, and put the app back into `recording` with nothing
      // behind it. `teardown` already stopped this capture on arrival.
      if (!isCurrent(utteranceId)) return;
      captureRef.current = capture;
      pendingCaptureRef.current = null;
      socket.send(
        JSON.stringify({
          type: "start",
          utteranceId,
          sampleRate: Math.round(capture.sampleRate),
        }),
      );
      startSent = true;
      capture.flush();
      setPhase("recording");
      // Talking at a phone is the one state where nobody touches the screen, so
      // the display timeout would otherwise dim and lock mid-sentence — which
      // hides the page and cancels the utterance.
      void requestScreenWakeLock().then((lock) => {
        if (captureRef.current === capture) wakeLockRef.current = lock;
        else lock?.release();
      });

      timersRef.current.elapsed = window.setInterval(
        () => setElapsed((prev) => prev + 1),
        1000,
      );
      timersRef.current.cap = window.setTimeout(
        () => void finish(),
        Math.max(5, maxUtteranceSeconds) * 1000,
      );
    } catch (err) {
      // Same rule for a failed start: a denial for an utterance already ended
      // must not tear down the one that replaced it, nor explain itself over it.
      if (!isCurrent(utteranceId)) return;
      const message = err instanceof Error ? err.message : String(err);
      await teardown(
        /permission|denied|NotAllowed/i.test(message)
          ? "Microphone permission was denied."
          : message,
      );
    }
  }, [finish, instanceId, isCurrent, maxUtteranceSeconds, teardown]);

  const cancel = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({ type: "cancel", utteranceId: utteranceRef.current }),
      );
    }
    void teardown();
  }, [teardown]);

  /** The only entry point: start when idle, stop when recording. */
  const toggle = useCallback(() => {
    if (phase === "recording") {
      void finish();
      return;
    }
    if (phase === "idle") void begin();
  }, [begin, finish, phase]);

  // Escape aborts and discards; a hidden tab suspends the AudioContext, so a
  // backgrounded recording would silently capture nothing.
  useEffect(() => {
    if (phase !== "recording") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cancel, phase]);

  // Never leave the microphone open or the lock held when a composer unmounts —
  // and never leave its WORK running either. Unmounting ends the utterance as
  // surely as cancelling does (a diff comment composer closes mid-transcription
  // and the row is gone), so it invalidates the id, aborts the upload and clears
  // the timers exactly as `teardown` would. `teardown` itself cannot be called
  // here: it sets state on a component that is going away.
  useEffect(
    () => () => {
      utteranceRef.current = "";
      const upload = uploadRef.current;
      uploadRef.current = null;
      upload?.abort();
      clearTimers();
      if (owner.id === instanceId) {
        captureRef.current?.stop().catch(() => {});
        void pendingCaptureRef.current?.then(
          (late) => late.stop().catch(() => {}),
          () => {},
        );
        wakeLockRef.current?.release();
        socketRef.current?.close();
        owner.release(instanceId);
      }
    },
    [clearTimers, instanceId],
  );

  // Evaluated ONLY when available: `captureUnavailableReason` touches `window`.
  const unavailableReason = available ? captureUnavailableReason() : undefined;
  return {
    phase,
    busyElsewhere: ownerId !== null && ownerId !== instanceId,
    elapsedSeconds,
    peaks: peaksRef.current,
    uploading,
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    toggle,
    cancel,
  };
}
