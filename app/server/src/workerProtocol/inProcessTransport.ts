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
 */

/** One end of a byte stream. Listeners are set before the first delivery. */
export interface ByteEndpoint {
  write(bytes: Uint8Array): void;
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
      write(bytes) {
        if (closed) return;
        queueMicrotask(() => peer.data?.(bytes));
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
