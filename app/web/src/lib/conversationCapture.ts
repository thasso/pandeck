import {
  captureUnavailableReason,
  effectiveCaptureRate,
} from "./speechCapture.ts";

/** Stateful interpolation for the non-integer browser rates the worklet passes through. */
export class ConversationResampler {
  private index = 0;
  private next = 0;
  private previous = 0;
  constructor(private readonly inputRate: number) {}

  push(frame: Int16Array): Int16Array {
    if (this.inputRate === 16000) return frame;
    const output: number[] = [];
    for (const sample of frame) {
      while (this.next <= this.index) {
        const fraction = this.next - (this.index - 1);
        output.push(
          Math.round(
            this.index === 0
              ? sample
              : this.previous + (sample - this.previous) * fraction,
          ),
        );
        this.next += this.inputRate / 16000;
      }
      this.previous = sample;
      this.index++;
    }
    return Int16Array.from(output);
  }
}

/** Continuous capture has no dictation buffer or parked microphone. Frames are
 * delivered at the worklet's real-time 200 ms cadence, or discarded before admission.
 */
export async function startConversationCapture(
  signal: AbortSignal,
  onFrame: (frame: Int16Array) => void,
  onError: (message: string) => void,
): Promise<() => void> {
  const unavailable = captureUnavailableReason();
  if (unavailable) throw new Error(unavailable);
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: 16000 });
  } catch {
    context = new AudioContext();
  }
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  const stop = () => {
    if (node) node.port.onmessage = null;
    source?.disconnect();
    node?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => {});
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) throw new Error("Conversation capture cancelled.");
    // Construct/resume on the gesture, before permission spends it.
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (signal.aborted) throw new Error("Conversation capture cancelled.");
    for (const track of stream.getAudioTracks())
      track.addEventListener(
        "ended",
        () => {
          if (!signal.aborted)
            onError("The conversation microphone disconnected.");
        },
        { once: true },
      );
    const module = await import("./pcm16Worklet.js?url");
    await context.audioWorklet.addModule(module.default);
    if (signal.aborted) throw new Error("Conversation capture cancelled.");
    const resampler = new ConversationResampler(
      effectiveCaptureRate(context.sampleRate),
    );
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "pcm16-worklet", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { targetRate: 16000, frameMs: 200 },
    });
    node.onprocessorerror = () => {
      if (!signal.aborted) onError("Conversation audio capture failed.");
    };
    node.port.onmessage = (
      event: MessageEvent<{ type: string; frame?: Int16Array }>,
    ) => {
      if (signal.aborted || event.data.type !== "audio" || !event.data.frame)
        return;
      const frame = resampler.push(event.data.frame);
      // Defensive split; never send more than the protocol's one-second limit.
      for (let offset = 0; offset < frame.length; offset += 3200)
        onFrame(frame.subarray(offset, offset + 3200));
    };
    source.connect(node);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
