/**
 * Microphone capture for composer dictation.
 *
 * The browser holds the **authoritative** copy of the utterance in `frames` and
 * treats the WebSocket as best-effort delivery. That matters because
 * `WebSocket.send` neither blocks nor drops on a slow link — it queues, and that
 * queue is silently discarded if the socket closes. Since dictation happens from
 * a phone or laptop over the tailnet, a mid-utterance wifi hiccup is a normal
 * event, not an edge case: keeping the samples here means the caller can always
 * fall back to one complete HTTP POST instead of losing what was said.
 *
 * Delivery is therefore watermarked rather than eager: frames go out only while
 * the socket's `bufferedAmount` is below a threshold, and the rest wait in
 * `frames` until stop, where the caller drains them.
 */
import { microphoneGrantPersists } from "./nativeShell.ts";
import { assistantToken } from "./serverOrigin.ts";

/** Bytes allowed to sit in the socket's send queue before we stop feeding it. */
const SEND_WATERMARK_BYTES = 256 * 1024;
/** Recognizer's native rate; the worklet decimates to this when it can. */
const TARGET_SAMPLE_RATE = 16000;

export interface CaptureHandle {
  /** Effective sample rate of the delivered PCM (post-decimation). */
  sampleRate: number;
  /** Every frame captured so far, in order — the authoritative utterance. */
  frames: Int16Array[];
  /** Bytes captured so far. */
  bytes: number;
  /** Bytes not yet handed to the socket. */
  pendingBytes(): number;
  /** Push whatever the watermark held back; false when the transport is still full. */
  flush(): boolean;
  /** Stop capture and release the microphone. Frames are retained. */
  stop(): Promise<void>;
  /** Concatenate every captured frame into one buffer for the HTTP fallback. */
  toBuffer(): ArrayBuffer;
}

export interface CaptureCallbacks {
  /**
   * Every captured frame, in order, BEFORE delivery is attempted — so the
   * waveform reflects what the microphone produced even when the transport is
   * backed up and frames are waiting. The buffer is only borrowed; copy anything
   * you keep.
   */
  onFrame?: (frame: Int16Array) => void;
  /** A frame is ready to send; return false when the transport is backed up. */
  send: (frame: Int16Array) => boolean;
  onError?: (message: string) => void;
}

/**
 * The microphone stream, kept alive BETWEEN utterances.
 *
 * Safari does not persist a microphone grant the way Chromium and Firefox do —
 * in an installed Home Screen web app it prompts again on every single
 * `getUserMedia`, so stopping the tracks after each utterance turned "tap the
 * mic" into "tap the mic, then answer a permission dialog". Keeping the stream
 * is the only thing that avoids it: the grant lives with the track, not with the
 * origin.
 *
 * Holding a microphone open is not free, so it is bounded three ways. Between
 * utterances the tracks are DISABLED, which mutes the source at the browser
 * level — no audio reaches the page even in principle. The stream is handed back
 * entirely when the page is hidden or unloaded, so a backgrounded app never holds
 * the device, and after `PARK_TIMEOUT_MS` of not dictating, so a forgotten tab
 * does not either. And browsers that DO remember the grant never park at all
 * (`permissionIsRemembered`), because there the reuse buys nothing and a live
 * track costs a permanent "recording" indicator on the tab.
 */
let sharedStream: MediaStream | null = null;
let releaseHooked = false;
let parkTimer: number | undefined;
/**
 * The audio graph's context, parked with the stream and for the same reason:
 * latency. Constructing an `AudioContext` and fetching + compiling the worklet
 * module is the bulk of the wait between pressing the mic and recording, and it
 * is pure setup that says nothing about this utterance. Suspended between
 * utterances, closed whenever the microphone is handed back, so a parked graph
 * never outlives the grant it was built for.
 */
let sharedContext: AudioContext | null = null;
/**
 * How long a parked microphone may sit there unused. Long enough that dictating
 * again in the same sitting costs no dialog, short enough that a page left open
 * is not holding the device — Safari shows a capture indicator for a live track
 * even while it is muted, and a lingering one is alarming rather than reassuring.
 */
const PARK_TIMEOUT_MS = 2 * 60_000;

/** The parked stream, if it is still usable — a device change can kill it. */
function parkedStream(): MediaStream | null {
  if (!sharedStream) return null;
  const tracks = sharedStream.getAudioTracks();
  if (tracks.length > 0 && tracks.every((track) => track.readyState === "live"))
    return sharedStream;
  releaseMicrophone();
  return null;
}

/** Hand the microphone back to the OS. The next utterance may have to ask again. */
function releaseMicrophone(): void {
  if (parkTimer !== undefined) window.clearTimeout(parkTimer);
  parkTimer = undefined;
  const stream = sharedStream;
  sharedStream = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  const context = sharedContext;
  sharedContext = null;
  void context?.close().catch(() => {});
}

function hookRelease(): void {
  if (releaseHooked || typeof document === "undefined") return;
  releaseHooked = true;
  // Leaving the app must return the device: a parked stream is a convenience for
  // the next utterance in this sitting, never something to hold in the background.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseMicrophone();
  });
  window.addEventListener("pagehide", releaseMicrophone);
}

/**
 * Whether the browser remembers the grant, so the stream can be dropped the
 * moment we are done with it. Chromium/Firefox answer through the Permissions
 * API; Safari does not implement the `microphone` name at all (it throws), which
 * is the same set of browsers that re-prompt.
 */
async function permissionIsRemembered(): Promise<boolean> {
  // The native shell answers WebKit's capture prompt for our origin, so the grant
  // outlives the process and parking would buy nothing but a standing recording
  // indicator. Checked first because Safari's Permissions API cannot report it.
  if (microphoneGrantPersists()) return true;
  try {
    const status = await navigator.permissions?.query({
      name: "microphone" as PermissionName,
    });
    return status?.state === "granted";
  } catch {
    return false;
  }
}

async function acquireStream(): Promise<MediaStream> {
  if (parkTimer !== undefined) window.clearTimeout(parkTimer);
  parkTimer = undefined;
  const parked = parkedStream();
  if (parked) {
    for (const track of parked.getAudioTracks()) track.enabled = true;
    return parked;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  sharedStream = stream;
  hookRelease();
  return stream;
}

/** Done with the stream: mute and keep it, or give it back where that is free. */
async function parkOrRelease(stream: MediaStream): Promise<void> {
  if (stream !== sharedStream || (await permissionIsRemembered())) {
    if (stream === sharedStream) releaseMicrophone();
    else for (const track of stream.getTracks()) track.stop();
    return;
  }
  for (const track of stream.getAudioTracks()) track.enabled = false;
  parkTimer = window.setTimeout(releaseMicrophone, PARK_TIMEOUT_MS);
}

/** Human-readable reason capture is unavailable, or undefined when it is. */
export function captureUnavailableReason(): string | undefined {
  if (typeof navigator === "undefined")
    return "Audio capture is unavailable in this environment.";
  if (!window.isSecureContext) {
    return "Dictation needs a secure context (https or localhost). Open the app over https.";
  }
  if (!navigator.mediaDevices?.getUserMedia)
    return "This browser does not expose microphone capture.";
  if (typeof AudioWorkletNode === "undefined")
    return "This browser does not support AudioWorklet.";
  return undefined;
}

/**
 * The rate the worklet will actually deliver, computed with the SAME rule it
 * uses. This must be derived synchronously rather than learned from the
 * worklet's async "ready" message: the caller sends its `start` frame (carrying
 * the rate) the instant capture begins, and a race there would tell the server
 * 48 kHz for audio decimated to 16 kHz — chipmunk audio and a garbled
 * transcript, on exactly the browsers that ignore the requested rate.
 */
export function effectiveCaptureRate(contextRate: number): number {
  return contextRate % TARGET_SAMPLE_RATE === 0
    ? TARGET_SAMPLE_RATE
    : contextRate;
}

/** URL of the worklet module, emitted as a standalone asset by Vite. */
async function workletUrl(): Promise<string> {
  const module = await import("./pcm16Worklet.js?url");
  return module.default;
}

/**
 * The context to build this utterance's graph in, with the worklet module already
 * registered. Reuses the parked one when it can, and falls back to a fresh context
 * if resuming does not take: Safari only lets a USER GESTURE start audio, so a
 * parked context that stayed suspended would capture silence — a fresh one built
 * inside the same gesture is the honest recovery, not a retry loop.
 */
async function acquireContext(): Promise<AudioContext> {
  const parked = sharedContext;
  if (parked && parked.state !== "closed") {
    if (parked.state === "suspended") await parked.resume().catch(() => {});
    if (parked.state === "running") return parked;
    sharedContext = null;
    void parked.close().catch(() => {});
  }
  let context: AudioContext;
  try {
    // Ask for the recognizer's rate; browsers may ignore it (Safari), in which
    // case the worklet decimates by an integer factor or passes through.
    context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    context = new AudioContext();
  }
  try {
    await context.audioWorklet.addModule(await workletUrl());
  } catch (err) {
    void context.close().catch(() => {});
    throw err;
  }
  sharedContext = context;
  hookRelease();
  return context;
}

/**
 * Open the microphone and start delivering frames. Rejects if permission is
 * denied or the audio graph cannot be built; the caller shows the message.
 */
export async function startCapture(
  callbacks: CaptureCallbacks,
): Promise<CaptureHandle> {
  const unavailable = captureUnavailableReason();
  if (unavailable) throw new Error(unavailable);

  // The context first, and NOT after the `getUserMedia` await: on Safari only a
  // user gesture may start audio, and an awaited permission prompt spends it.
  const context = await acquireContext();
  let stream: MediaStream;
  try {
    stream = await acquireStream();
  } catch (err) {
    // No grant, no reason to keep a graph for it.
    releaseMicrophone();
    throw err;
  }

  const frames: Int16Array[] = [];
  const handle: CaptureHandle = {
    sampleRate: effectiveCaptureRate(context.sampleRate),
    frames,
    bytes: 0,
    pendingBytes: () => 0,
    flush: () => true,
    stop: async () => {},
    toBuffer: () => concatFrames(frames),
  };

  try {
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "pcm16-worklet", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { targetRate: TARGET_SAMPLE_RATE, frameMs: 200 },
    });

    // Frames captured but not yet accepted by the transport. They stay in
    // `frames` regardless; this only tracks how far delivery has got.
    let sentIndex = 0;
    // Resolver for the worklet's flush acknowledgement, set only while stopping.
    let flushAck: (() => void) | undefined;

    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        type: string;
        sampleRate?: number;
        frame?: Int16Array;
        peak?: number;
      };
      if (data.type === "ready") {
        // Advisory only — `handle.sampleRate` is already derived synchronously.
        // A mismatch means the two decimation rules drifted apart.
        if (
          typeof data.sampleRate === "number" &&
          data.sampleRate !== handle.sampleRate
        ) {
          callbacks.onError?.(
            `Capture rate mismatch: worklet reports ${data.sampleRate} Hz, expected ${handle.sampleRate} Hz.`,
          );
        }
        return;
      }
      if (data.type === "flushed") {
        flushAck?.();
        return;
      }
      if (data.type !== "audio" || !data.frame) return;
      frames.push(data.frame);
      handle.bytes += data.frame.byteLength;
      callbacks.onFrame?.(data.frame);
      // Feed the transport in order, stopping as soon as it pushes back.
      while (sentIndex < frames.length) {
        const frame = frames[sentIndex]!;
        if (!callbacks.send(frame)) break;
        sentIndex++;
      }
    };

    source.connect(node);

    handle.pendingBytes = () => {
      let pending = 0;
      for (let i = sentIndex; i < frames.length; i++)
        pending += frames[i]!.byteLength;
      return pending;
    };
    handle.flush = () => {
      while (sentIndex < frames.length) {
        const frame = frames[sentIndex]!;
        if (!callbacks.send(frame)) return false;
        sentIndex++;
      }
      return true;
    };
    handle.stop = async () => {
      // Drain the worklet's partial frame first: without this the final up-to-
      // 200 ms of audio is discarded, which clips the last word of every
      // utterance.
      await new Promise<void>((resolveFlush) => {
        // Bounded: if the worklet never answers, tearing down is still correct.
        const timer = window.setTimeout(resolveFlush, 250);
        flushAck = () => {
          window.clearTimeout(timer);
          resolveFlush();
        };
        node.port.postMessage({ type: "flush" });
      });
      flushAck = undefined;
      node.port.onmessage = null;
      try {
        source.disconnect();
        node.disconnect();
      } catch {
        /* already torn down */
      }
      await parkOrRelease(stream);
      // The context is parked with the stream (`releaseMicrophone` closes both),
      // so this only quiets it — closing here would put the whole worklet setup
      // back on the next utterance's critical path.
      if (context === sharedContext) await context.suspend().catch(() => {});
      else await context.close().catch(() => {});
    };
    return handle;
  } catch (err) {
    // The graph failed, not the grant — but a microphone nobody is recording
    // with is not ours to keep, so this path gives it back rather than parking.
    // `releaseMicrophone` closes the parked context with it.
    releaseMicrophone();
    throw err;
  }
}

/** One contiguous PCM buffer for the HTTP fallback. */
export function concatFrames(frames: Int16Array[]): ArrayBuffer {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out.buffer;
}

/** True while the socket's send queue is small enough to accept another frame. */
export function socketAcceptsMore(socket: WebSocket): boolean {
  return (
    socket.readyState === WebSocket.OPEN &&
    socket.bufferedAmount < SEND_WATERMARK_BYTES
  );
}

/** `wss?token=` URL for the dictation socket, derived from the API origin. */
export function speechSocketUrl(httpOrigin: string): string {
  const url = new URL(httpOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/speech";
  const token = assistantToken();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
