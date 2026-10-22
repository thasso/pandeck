import { WebSocket } from "ws";

export interface StreamingTranscript {
  segment: number;
  text: string;
  isFinal: boolean;
}

/** Online sherpa replies are JSON updates, not the offline utterance protocol. */
export function parseStreamingReply(raw: string): StreamingTranscript {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    typeof parsed.text !== "string" ||
    !Number.isSafeInteger(parsed.segment) ||
    (parsed.segment as number) < 0 ||
    typeof parsed.is_final !== "boolean"
  ) {
    throw new Error("Invalid streaming recognizer reply.");
  }
  return {
    text: parsed.text,
    segment: parsed.segment as number,
    isFinal: parsed.is_final,
  };
}

/** One live stream. No audio or transcript history survives this connection. */
export class StreamingSttConnection {
  private ws: WebSocket | undefined;
  private closed = false;
  private finishing = false;
  private finishTimer: NodeJS.Timeout | undefined;
  private last: StreamingTranscript | undefined;

  constructor(
    private readonly onTranscript: (result: StreamingTranscript) => void,
    private readonly onError: (error: Error) => void,
    private readonly onDone: () => void,
    private readonly onClose: () => void,
  ) {}

  async connect(url: string, timeoutMs = 2_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        perMessageDeflate: false,
        maxPayload: 1_048_576,
      });
      this.ws = ws;
      let connected = false;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Streaming recognizer connection timed out."));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        connected = true;
        resolve();
      });
      // Bun can emit two errors for one refused connection. Keep this listener.
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
        if (connected && !this.closed) this.fail(error);
      });
      ws.on("message", (raw, isBinary) => {
        if (this.closed || isBinary) return;
        try {
          if (raw.toString() === "Done!") {
            if (this.last && !this.last.isFinal)
              this.onTranscript({ ...this.last, isFinal: true });
            this.onDone();
            this.close();
          } else {
            const result = parseStreamingReply(raw.toString());
            this.last = result;
            this.onTranscript(result);
          }
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      ws.on("close", () => {
        clearTimeout(timer);
        reject(new Error("Streaming recognizer connection closed."));
        if (!this.closed)
          this.fail(
            new Error("Streaming recognizer connection closed unexpectedly."),
          );
      });
    });
  }

  /** Browser PCM is fixed 16 kHz Int16 LE; sherpa expects Float32 LE without a header. */
  sendPcm16(pcm: Buffer): void {
    const ws = this.ws;
    if (this.closed || this.finishing || ws?.readyState !== WebSocket.OPEN)
      throw new Error("Streaming recognizer is not accepting audio.");
    if (ws.bufferedAmount > 128_000)
      throw new Error("Streaming recognizer cannot keep up with audio.");
    const frame = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length / 2; i++)
      frame.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, i * 4);
    ws.send(frame);
  }

  finish(): void {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    this.ws?.send("Done");
    this.finishTimer = setTimeout(
      () =>
        this.fail(new Error("Timed out finishing the streaming utterance.")),
      10_000,
    );
    this.finishTimer.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.finishTimer);
    this.ws?.terminate();
    this.ws = undefined;
    this.last = undefined;
    this.onClose();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.onError(error);
    this.close();
  }
}
