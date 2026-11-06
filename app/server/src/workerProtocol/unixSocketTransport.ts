/**
 * The worker protocol's byte stream over a socket: a Unix socket between
 * processes on one host (the server and the relay's client-protocol socket),
 * or a `tls.TLSSocket` (the gateway edge's mutual-TLS client port). Frame
 * reassembly stays in `FrameDecoder`; this only moves bytes.
 *
 * The standalone gateway listens for its control connection here
 * (`gateway/process.ts`), and the server dials it.
 */
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
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

/**
 * Listens on the Unix socket at `path` and hands each accepted connection to
 * `onEndpoint`. Refuses when another process answers on `path`; a stale file
 * no one answers on is removed first. The file gets mode 0600, and `close`
 * stops listening, ends open connections and removes the file.
 */
export async function listenUnixSocket(
  path: string,
  onEndpoint: (endpoint: ByteEndpoint) => void,
): Promise<{ close(): Promise<void> }> {
  if (existsSync(path)) {
    const answered = await new Promise<boolean>((resolve, reject) => {
      const probe = net.createConnection(path);
      const timer = setTimeout(() => {
        probe.destroy();
        reject(new Error(`Cannot probe the control socket at ${path}.`));
      }, 1000);
      probe.once("connect", () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(true);
      });
      probe.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ECONNREFUSED" || err.code === "ENOENT")
          resolve(false);
        else reject(err);
      });
    });
    if (answered) throw new Error(`Another process listens on ${path}.`);
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onEndpoint(socketEndpoint(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw err;
  }
  const bound = statSync(path);
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        try {
          const current = statSync(path);
          if (current.ino === bound.ino && current.dev === bound.dev)
            unlinkSync(path);
        } catch {
          // Removed already.
        }
      });
      return closing;
    },
  };
}
