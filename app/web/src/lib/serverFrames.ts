/**
 * Decoding of session-socket frames. The server sends a large message as a
 * binary frame holding the raw DEFLATE stream of its JSON
 * (`COMPRESSED_SERVER_FRAME_MIN_BYTES` in `@assistant/shared`), every other
 * one as plain JSON text.
 */

/** Inflate one binary server frame back to its JSON text. */
export async function inflateServerFrame(data: ArrayBuffer): Promise<string> {
  return new Response(
    new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw")),
  ).text();
}

/**
 * Turns one socket's frames into JSON text in ARRIVAL order. Inflating is
 * asynchronous, so a small text frame arriving behind a large binary one waits
 * for it; while nothing is inflating, a text frame is delivered synchronously,
 * as before compression existed. A frame that cannot be inflated leaves the
 * client behind the server, so the reader reports it once and delivers nothing
 * after it: the owner reconnects and resyncs.
 */
export class ServerFrameReader {
  private pending: Promise<void> | undefined;
  private failed = false;

  constructor(
    private readonly deliver: (json: string) => void,
    private readonly onUnreadable: (error: unknown) => void,
  ) {}

  push(data: string | ArrayBuffer): void {
    if (this.failed) return;
    if (typeof data === "string" && !this.pending) {
      this.deliver(data);
      return;
    }
    // Start inflating at once; only DELIVERY waits for the frames before it.
    const json = typeof data === "string" ? data : inflateServerFrame(data);
    const next = (this.pending ?? Promise.resolve())
      .then(async () => {
        const text = await json;
        if (!this.failed) this.deliver(text);
      })
      .catch((error: unknown) => {
        if (this.failed) return;
        this.failed = true;
        this.onUnreadable(error);
      })
      .finally(() => {
        if (this.pending === next) this.pending = undefined;
      });
    this.pending = next;
  }
}
