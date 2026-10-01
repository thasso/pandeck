/**
 * AudioWorklet that turns live microphone input into the wire format the server's
 * recognizer wants: mono, little-endian signed 16-bit PCM.
 *
 * Runs on the audio thread, so it must stay allocation-light and never block.
 * Two jobs beyond the format conversion:
 *
 *  - Framing. Raw render quanta are 128 samples (~2.7 ms at 48 kHz); posting one
 *    message per quantum would be ~375 frames/s of pure overhead. Samples are
 *    accumulated into ~200 ms frames instead.
 *  - Optional integer decimation. Browsers do not always honour a requested
 *    16 kHz `AudioContext` (Safari in particular), and 48 kHz PCM is 3× the
 *    bytes for no accuracy gain. When the context rate is an exact multiple of
 *    the target, average each group of `factor` samples — a crude but adequate
 *    anti-alias box filter for speech. Otherwise pass the audio through
 *    unchanged and let the server-side recognizer resample; never resample at a
 *    non-integer ratio here.
 *
 * Loaded as a plain asset (no imports, no build step), because AudioWorklet
 * modules are fetched and evaluated by the audio thread, not bundled into the app.
 */
class Pcm16Worklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const targetRate =
      typeof opts.targetRate === "number" ? opts.targetRate : 16000;
    const frameMs = typeof opts.frameMs === "number" ? opts.frameMs : 200;

    // Exact integer ratio only; 1 means pass-through.
    this.factor =
      sampleRate % targetRate === 0 ? Math.max(1, sampleRate / targetRate) : 1;
    this.outRate = sampleRate / this.factor;
    this.frameSize = Math.max(256, Math.round((this.outRate * frameMs) / 1000));
    this.buffer = new Int16Array(this.frameSize);
    this.filled = 0;
    // Partial decimation group carried across render quanta (128 is not a
    // multiple of every factor), so no sample is dropped or double-counted.
    this.groupSum = 0;
    this.groupCount = 0;
    this.peak = 0;

    // Stop must not lose the tail. `flush` delivers the partial frame and any
    // half-finished decimation group, then acknowledges so the caller can tear
    // the graph down knowing the last word made it out.
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "flush") {
        if (this.groupCount > 0) {
          this.push(this.groupSum / this.groupCount);
          this.groupSum = 0;
          this.groupCount = 0;
        }
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };

    this.port.postMessage({ type: "ready", sampleRate: this.outRate });
  }

  /** Clamp to the int16 range and scale; -32768 is deliberately never emitted. */
  static toInt16(value) {
    const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
    return Math.round(clamped * 32767);
  }

  push(value) {
    const magnitude = value < 0 ? -value : value;
    if (magnitude > this.peak) this.peak = magnitude;
    this.buffer[this.filled++] = Pcm16Worklet.toInt16(value);
    if (this.filled === this.frameSize) this.flush();
  }

  flush() {
    if (this.filled === 0) return;
    // Copy: the buffer is reused, and the copy is transferred to the main thread.
    const frame = this.buffer.slice(0, this.filled);
    this.filled = 0;
    const peak = this.peak;
    this.peak = 0;
    this.port.postMessage({ type: "audio", frame, peak }, [frame.buffer]);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet (or the track ended): keep the processor alive regardless.
    if (!channel) return true;

    if (this.factor === 1) {
      for (let i = 0; i < channel.length; i++) this.push(channel[i]);
      return true;
    }
    for (let i = 0; i < channel.length; i++) {
      this.groupSum += channel[i];
      this.groupCount++;
      if (this.groupCount === this.factor) {
        this.push(this.groupSum / this.factor);
        this.groupSum = 0;
        this.groupCount = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-worklet", Pcm16Worklet);
