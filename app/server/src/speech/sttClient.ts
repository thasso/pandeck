/**
 * Client for the recognizer's own WebSocket protocol
 * (`sherpa-onnx-offline-websocket-server`).
 *
 * Wire format, per its `OnMessage` implementation: the first binary frame of an
 * utterance carries an 8-byte header — `int32le sampleRate`, then
 * `int32le byteLength` of the float32 sample payload — optionally followed by
 * the start of that payload. Further binary frames are payload continuation. The
 * recognizer decodes once the promised byte count has arrived, replies with a
 * single JSON text frame, then resets its per-connection accumulator, so one
 * connection serves any number of sequential utterances. The text frame `"Done"`
 * asks it to close.
 *
 * Because the byte count is required up front, live partial results are not
 * possible with this model — the caller buffers a whole utterance and decodes
 * once. That is exactly what push-to-talk gives us.
 */
import { WebSocket } from "ws";

/** Parsed recognizer reply. Only `text` is used today; the rest is diagnostic. */
export interface SttDecodeResult {
  text: string;
}

/** ~200 ms of 16 kHz float32 audio per frame: few frames, no per-frame overhead. */
const CHUNK_BYTES = 3200 * 4;

/** Header is `int32le sampleRate` + `int32le payloadByteLength`. */
export function encodeSttHeader(
  sampleRate: number,
  payloadByteLength: number,
): Buffer {
  const header = Buffer.alloc(8);
  header.writeInt32LE(sampleRate, 0);
  header.writeInt32LE(payloadByteLength, 4);
  return header;
}

/** Extract the transcript from the recognizer's reply frame (JSON, or bare text). */
export function parseSttReply(raw: string): SttDecodeResult {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return { text: typeof parsed.text === "string" ? parsed.text : "" };
  } catch {
    return { text: raw };
  }
}

/** Split a sample payload into recognizer frames (header first, then chunks). */
export function encodeSttFrames(
  samples: Float32Array,
  sampleRate: number,
): Buffer[] {
  const body = Buffer.from(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  const frames: Buffer[] = [encodeSttHeader(sampleRate, samples.byteLength)];
  for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
    frames.push(
      body.subarray(offset, Math.min(offset + CHUNK_BYTES, body.length)),
    );
  }
  return frames;
}

/**
 * A single connection to the recognizer, reused across utterances. One decode at
 * a time — the caller ({@link SttEngine}) serializes, since the recognizer has
 * one model instance and its accumulator is per connection.
 */
export class SttConnection {
  private ws: WebSocket | undefined;
  private pending:
    | {
        resolve: (result: SttDecodeResult) => void;
        reject: (err: Error) => void;
      }
    | undefined;
  private closedReason: string | undefined;

  constructor(private readonly url: string) {}

  /** Resolves once the socket is open, or rejects on connect failure/timeout. */
  async connect(timeoutMs = 10_000): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const ws = new WebSocket(this.url, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(
          new Error(`Timed out connecting to the recognizer at ${this.url}.`),
        );
      }, timeoutMs);

      ws.once("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        resolvePromise();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        this.settle(parseSttReply(raw.toString()));
      });
      ws.on("close", () => {
        this.ws = undefined;
        this.fail(
          new Error(
            this.closedReason ?? "The recognizer connection closed mid-decode.",
          ),
        );
      });
    });
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Send one utterance and await its transcript. */
  async decode(
    samples: Float32Array,
    sampleRate: number,
  ): Promise<SttDecodeResult> {
    // Nothing to decode needs no recognizer: answer before touching the socket.
    if (samples.length === 0) return { text: "" };
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN)
      throw new Error("The recognizer connection is not open.");
    if (this.pending)
      throw new Error("A decode is already in flight on this connection.");

    return await new Promise<SttDecodeResult>((resolvePromise, reject) => {
      this.pending = { resolve: resolvePromise, reject };
      try {
        for (const frame of encodeSttFrames(samples, sampleRate))
          ws.send(frame);
      } catch (err) {
        this.pending = undefined;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Ask the recognizer to close this connection, then drop it. */
  close(reason = "Closed by the assistant."): void {
    this.closedReason = reason;
    const ws = this.ws;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send("Done");
      ws.close();
    } catch {
      ws.terminate();
    }
    this.ws = undefined;
  }

  private settle(result: SttDecodeResult): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(result);
  }

  private fail(err: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(err);
  }
}

/** Per-attempt connect budget while waiting for the model to finish loading. */
const READY_ATTEMPT_TIMEOUT_MS = 2_000;
/** Gap between connect attempts. */
const READY_RETRY_DELAY_MS = 200;

/**
 * Wait for a starting recognizer by retrying the REAL handshake.
 *
 * A bare TCP probe would also detect the open port, but the recognizer logs a
 * connection that dies before the WebSocket handshake as
 * `[error] handle_read_handshake error: … (End of File)` — a scary line in the
 * one log you would check when something is actually wrong. Until the model
 * finishes loading nothing is listening, so these attempts are refused by the
 * kernel and never reach the recognizer at all; the attempt that succeeds is an
 * ordinary connection it logs as such.
 */
export async function connectSttWhenReady(
  url: string,
  timeoutMs: number,
  alive: () => boolean,
): Promise<SttConnection> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  for (;;) {
    if (!alive()) throw new Error("The recognizer exited before it was ready.");
    const connection = new SttConnection(url);
    try {
      await connection.connect(READY_ATTEMPT_TIMEOUT_MS);
      return connection;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The recognizer did not accept connections within ${Math.round(timeoutMs / 1000)}s (last error: ${lastError}).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, READY_RETRY_DELAY_MS));
  }
}
