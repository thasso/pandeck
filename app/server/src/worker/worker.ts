/**
 * A Worker: it dials the server, says `hello` with its Worker id, and serves
 * the server's requests until the connection ends; a refusal ends it too.
 *
 * This folder is the Worker's side of the boundary and imports no server
 * state (`workerBoundary.test.ts`). In phase 1 the only Worker runs in the
 * server's own process (`workers/inProcessWorker.ts`); phase 2 moves this
 * folder into a process of its own (`docs/workers.md`).
 */
import { WorkerConnection } from "../workerProtocol/connection.ts";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";
import { checkoutGitHandlers } from "./checkoutGit.ts";
import { fileHandlers } from "./files.ts";

export interface RunningWorker {
  /**
   * Resolves once the connection has ended and every request the Worker was
   * serving has settled: with the exit receipt, once every git child it
   * started has exited, and once every file handle it held is closed.
   */
  readonly quiescent: Promise<void>;
  /** Test seam: how many file handles the Worker holds. */
  fileHandles(): number;
}

export function startWorker(options: {
  workerId: string;
  /** The Worker's end of a stream the server accepts. */
  transport: ByteEndpoint;
  /** Test seam: sees each request the Worker decoded and serves. */
  onRequest?: (method: string) => void;
}): RunningWorker {
  const files = fileHandlers(options.workerId);
  const handlers = Object.fromEntries(
    Object.entries({
      ...checkoutGitHandlers(options.workerId),
      ...files.handlers,
    }).map(([method, handler]) => [
      method,
      (...args: Parameters<typeof handler>) => {
        options.onRequest?.(method);
        return handler(...args);
      },
    ]),
  );
  const connection = new WorkerConnection(options.transport, {
    handshake: { role: "worker", workerId: options.workerId },
    handlers,
    onEnd: () => files.end(),
  });
  return {
    quiescent: connection.ended
      .then(() => connection.handlersSettled())
      .then(() => files.sweep()),
    fileHandles: () => files.size,
  };
}
