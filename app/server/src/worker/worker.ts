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

export interface RunningWorker {
  /**
   * Resolves once the connection has ended and every request the Worker was
   * serving has settled: with the exit receipt, once every git child it
   * started has exited.
   */
  readonly quiescent: Promise<void>;
}

export function startWorker(options: {
  workerId: string;
  /** The Worker's end of a stream the server accepts. */
  transport: ByteEndpoint;
  /** Test seam: sees each request the Worker decoded and serves. */
  onRequest?: (method: string) => void;
}): RunningWorker {
  const handlers = Object.fromEntries(
    Object.entries(checkoutGitHandlers(options.workerId)).map(
      ([method, handler]) => [
        method,
        (...args: Parameters<typeof handler>) => {
          options.onRequest?.(method);
          return handler(...args);
        },
      ],
    ),
  );
  const connection = new WorkerConnection(options.transport, {
    handshake: { role: "worker", workerId: options.workerId },
    handlers,
  });
  return {
    quiescent: connection.ended.then(() => connection.handlersSettled()),
  };
}
