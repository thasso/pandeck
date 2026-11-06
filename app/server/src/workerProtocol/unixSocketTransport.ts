/**
 * The worker protocol's byte stream over a socket: a Unix socket between
 * processes on one host (the server and the relay's client-protocol socket),
 * or a `tls.TLSSocket` (the gateway edge's mutual-TLS client port). Frame
 * reassembly stays in `FrameDecoder`; this only moves bytes.
 *
 * Shared shape with the standalone gateway's transport (Task-1383); only the
 * parts client mode needs are here so far.
 */
import net from "node:net";
import type { ByteEndpoint } from "./inProcessTransport.ts";

/** A peer that never closes after `close` is cut off after this long. */
const CLOSE_GRACE_MS = 1000;

export function socketEndpoint(socket: net.Socket): ByteEndpoint {
  let closeListener: (() => void) | undefined;
  let closed = false;
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    closeListener?.();
  });
  socket.on("error", () => socket.destroy());
  return {
    write(bytes) {
      if (!closed && !socket.destroyed) socket.write(bytes);
    },
    close() {
      // Written bytes go out first.
      socket.end();
      setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
    },
    onData(listener) {
      socket.on("data", (chunk: Buffer) => listener(chunk));
    },
    onClose(listener) {
      closeListener = listener;
    },
  };
}

/** Connects to the Unix socket at `path`; rejects on failure or timeout. */
export function dialUnixSocket(
  path: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<ByteEndpoint> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No answer on ${path} within ${timeoutMs} ms.`));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socketEndpoint(socket));
    });
  });
}
