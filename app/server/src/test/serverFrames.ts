import { inflateRawSync } from "node:zlib";
import type { ServerMessage } from "@assistant/shared";

/**
 * Parse one frame a `Connection` sent to its socket: JSON text, or that JSON's
 * raw DEFLATE stream once the message is large (`serverFrames.ts`). A fake
 * socket must decode both, or a test's fixture growing past the threshold
 * breaks it.
 */
export function parseServerFrame<T = ServerMessage>(frame: string | Buffer): T {
  return JSON.parse(
    typeof frame === "string" ? frame : inflateRawSync(frame).toString("utf8"),
  ) as T;
}
