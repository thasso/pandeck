/**
 * A {@link ByteEndpoint} over a socket: how gateway client 1.0 runs over TLS
 * at the edge and over the relay's Unix socket in the server.
 */
import type { Duplex } from "node:stream";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";

export function socketEndpoint(socket: Duplex): ByteEndpoint {
  let closeListener: (() => void) | undefined;
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    closeListener?.();
  };
  socket.on("close", closeOnce);
  socket.on("error", () => socket.destroy());
  return {
    write(bytes) {
      if (!closed && !socket.destroyed) socket.write(bytes);
    },
    close() {
      // Written bytes go out first; a peer that never closes is cut off.
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
    },
    onData(listener) {
      socket.on("data", (chunk: Buffer) => listener(chunk));
    },
    onClose(listener) {
      closeListener = listener;
    },
  };
}
