import { SPEECH_SYNTHESIS_LIMITS } from "@assistant/shared";

export type TtsFrame =
  | { type: "ready" }
  | { type: "audio"; id: number; pcm: Buffer }
  | { type: "cancelled" | "error"; id: number };
const MAX_PCM =
  SPEECH_SYNTHESIS_LIMITS.sampleRate *
  SPEECH_SYNTHESIS_LIMITS.maxAudioSeconds *
  2;

/** A length-prefixed JSON header followed by the header's declared PCM bytes.
 * Incremental across arbitrary pipe chunks, bounded before buffering payloads.
 */
export class TtsFrameReader {
  private buffer = Buffer.alloc(0);
  private header: Record<string, unknown> | undefined;

  feed(chunk: Buffer, onFrame: (frame: TtsFrame) => void): void {
    if (this.buffer.length + chunk.length > MAX_PCM + 8192)
      throw new Error("TTS frame exceeds limits.");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (!this.header) {
        if (this.buffer.length < 4) return;
        const size = this.buffer.readUInt32LE(0);
        if (size < 2 || size > 4096)
          throw new Error("Invalid TTS header length.");
        if (this.buffer.length < size + 4) return;
        const header: unknown = JSON.parse(
          this.buffer.subarray(4, size + 4).toString("utf8"),
        );
        if (
          typeof header !== "object" ||
          header === null ||
          Array.isArray(header)
        )
          throw new Error("Invalid TTS header.");
        this.header = header as Record<string, unknown>;
        this.buffer = this.buffer.subarray(size + 4);
      }
      const header = this.header;
      let frame: TtsFrame;
      if (header.type === "ready") frame = { type: "ready" };
      else {
        if (!Number.isSafeInteger(header.id) || (header.id as number) < 1)
          throw new Error("Invalid TTS request id.");
        const id = header.id as number;
        if (header.type === "audio") {
          const bytes = header.bytes as number;
          if (
            header.sampleRate !== 24000 ||
            !Number.isInteger(bytes) ||
            bytes < 2 ||
            bytes > MAX_PCM ||
            bytes % 2 !== 0
          )
            throw new Error("Invalid TTS audio frame.");
          if (this.buffer.length < bytes) return;
          frame = {
            type: "audio",
            id,
            pcm: Buffer.from(this.buffer.subarray(0, bytes)),
          };
          this.buffer = this.buffer.subarray(bytes);
        } else if (header.type === "cancelled" || header.type === "error")
          frame = { type: header.type, id };
        else throw new Error("Unknown TTS frame.");
      }
      this.header = undefined;
      onFrame(frame);
    }
  }
}

export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
