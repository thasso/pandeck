/**
 * Two connected in-memory byte endpoints: the transport between the server and
 * its in-process Worker, and the one dev and tests keep using
 * (`docs/workers.md`). The bytes are the real protocol's; only the wire is
 * memory.
 *
 * Delivery is asynchronous and never re-entrant: a write is handed to the peer
 * from a microtask, in order, so a listener never runs inside the writer's
 * call. Nothing here holds a handle, so an idle pair never keeps a process
 * alive. Bytes written before `close` still arrive, ahead of the close
 * notification; writes after it are dropped.
 *
 * A write's `onFlushed` (Task-1441 P7a, H1) is called exactly once, when its
 * bytes have left this side: here after delivery to the peer's listener,
 * even when that listener throws, and in a microtask for a write after
 * `close`.
 */

/** One end of a byte stream. Listeners are set before the first delivery. */
export interface ByteEndpoint {
  /**
   * Sends `bytes`. `onFlushed`, when given, is called exactly once: when the
   * bytes left this side, or when the endpoint discarded them because it
   * closed. Never synchronously.
   */
  write(bytes: Uint8Array, onFlushed?: () => void): void;
  /** Ends the stream for both ends; idempotent. */
  close(): void;
  onData(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: () => void): void;
}

export function createInProcessTransport(): [ByteEndpoint, ByteEndpoint] {
  let closed = false;
  const listeners = [0, 1].map(() => ({
    data: undefined as ((bytes: Uint8Array) => void) | undefined,
    close: undefined as (() => void) | undefined,
  }));
  const endpoint = (self: 0 | 1): ByteEndpoint => {
    const peer = listeners[1 - self]!;
    return {
      write(bytes, onFlushed) {
        if (closed) {
          if (onFlushed) queueMicrotask(onFlushed);
          return;
        }
        queueMicrotask(() => {
          try {
            peer.data?.(bytes);
          } finally {
            onFlushed?.();
          }
        });
      },
      close() {
        if (closed) return;
        closed = true;
        queueMicrotask(() => {
          for (const end of listeners) end.close?.();
        });
      },
      onData(listener) {
        listeners[self]!.data = listener;
      },
      onClose(listener) {
        listeners[self]!.close = listener;
      },
    };
  };
  return [endpoint(0), endpoint(1)];
}
