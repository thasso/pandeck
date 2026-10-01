import { Buffer } from "node:buffer";

export interface BackgroundMonitorBatch {
  lines: string[];
  bytes: number;
  droppedEventCount: number;
}

/**
 * A bounded line-event buffer for noisy command and WebSocket monitors.
 * Producers never wait on a model turn. Once either cap is full, later events
 * become one dropped count until the consumer takes the batch.
 */
export class BoundedBackgroundMonitorBuffer {
  private readonly lines: string[] = [];
  private bytes = 0;
  private droppedEventCount = 0;

  constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxLines) || maxLines < 1)
      throw new Error("maxLines must be a positive safe integer");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("maxBytes must be a positive safe integer");
  }

  push(line: string): void {
    const bytes = Buffer.byteLength(line, "utf8");
    if (
      this.lines.length >= this.maxLines ||
      bytes > this.maxBytes - this.bytes
    ) {
      this.droppedEventCount += 1;
      return;
    }
    this.lines.push(line);
    this.bytes += bytes;
  }

  take(): BackgroundMonitorBatch {
    const batch = {
      lines: this.lines.splice(0),
      bytes: this.bytes,
      droppedEventCount: this.droppedEventCount,
    };
    this.bytes = 0;
    this.droppedEventCount = 0;
    return batch;
  }
}
