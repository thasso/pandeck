/**
 * A Worker: it dials the server, says `hello` with its Worker id, and serves
 * the server's requests until the connection ends; a refusal ends it too.
 *
 * This folder is the Worker's side of the boundary and imports no server
 * state (`workerBoundary.test.ts`). In phase 1 the only Worker runs in the
 * server's own process (`workers/inProcessWorker.ts`); phase 2 moves this
 * folder into a process of its own (`docs/workers.md`).
 */
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";
import { checkoutGitHandlers } from "./checkoutGit.ts";
import { fileHandlers } from "./files.ts";

export interface RunningWorker {
  /**
   * Resolves once the connection has ended and every request the Worker was
   * serving has settled: with the exit receipt, once every git child it
   * started has exited, and once every file handle it held is closed. Native
   * opens still awaiting a descriptor are orphaned on end; their eventual
   * descriptors close without registration and do not hold this promise.
   */
  readonly quiescent: Promise<void>;
  /** Test seam: how many file handles the Worker holds. */
  fileHandles(): number;
}

/**
 * Test seam: serves one request in place of its handler, which it receives so
 * it can run the real effect first. Its answer or failure goes back over the
 * real codec like the handler's would.
 */
export type SubstituteHandler = (
  payload: Payload,
  signal: AbortSignal,
  real: MethodHandler,
) => Promise<Payload>;

export function startWorker(options: {
  workerId: string;
  /** The Worker's end of a stream the server accepts. */
  transport: ByteEndpoint;
  /**
   * Test seam: sees each request the Worker decoded and serves, and may
   * answer a substitute that serves that one request instead.
   */
  onRequest?: (method: string) => SubstituteHandler | undefined;
}): RunningWorker {
  const files = fileHandlers(options.workerId);
  const handlers = Object.fromEntries(
    Object.entries({
      ...checkoutGitHandlers(options.workerId),
      ...files.handlers,
    }).map(([method, handler]) => [
      method,
      (payload: Payload, signal: AbortSignal) => {
        const substitute = options.onRequest?.(method);
        return substitute
          ? substitute(payload, signal, handler)
          : handler(payload, signal);
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
