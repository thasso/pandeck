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
import { WATCH_METHODS } from "../workerProtocol/watchMethods.ts";
import { appToolCalls, type AppToolCaller } from "./appTools.ts";
import { checkoutGitHandlers } from "./checkoutGit.ts";
import { fileHandlers } from "./files.ts";
import { lifecycleHandlers } from "./lifecycle.ts";
import { watchHandlers, type WatchSnapshot } from "./watch.ts";

export interface RunningWorker {
  /**
   * Resolves once the connection has ended and every request the Worker was
   * serving has settled: with the exit receipt, once every git child it
   * started has exited, once every lifecycle handler has made its last
   * deletion or signal, and once every file handle it held is closed. Native
   * opens still awaiting a descriptor are orphaned on end; their eventual
   * descriptors close without registration and do not hold this promise.
   */
  readonly quiescent: Promise<void>;
  /**
   * Resolves once the connection has ended and the Worker holds no native
   * watch: no subscription, no subscribe and no unsubscribe in progress.
   * Separate from {@link quiescent}, which never waits for watch work.
   */
  readonly watchesReleased: Promise<void>;
  /** Asks the server to run one of a session's app tools (`appTools.call`). */
  readonly callAppTool: AppToolCaller;
  /** Test seam: how many file handles the Worker holds. */
  fileHandles(): number;
  /** Test seam: the native watch subscriptions the Worker holds. */
  watches(): WatchSnapshot[];
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
  // Deliveries start only after a subscribe, so after the connection exists.
  const watches = watchHandlers(options.workerId, (payload) =>
    connection.request(WATCH_METHODS.events, payload),
  );
  const appTools = appToolCalls((method, payload, signal) =>
    connection.request(method, payload, signal),
  );
  const handlers = Object.fromEntries(
    Object.entries({
      ...checkoutGitHandlers(options.workerId),
      ...files.handlers,
      ...lifecycleHandlers(options.workerId),
      ...watches.handlers,
      ...appTools.handlers,
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
    onEnd: () => {
      files.end();
      watches.end();
    },
  });
  return {
    quiescent: connection.ended
      .then(() => connection.handlersSettled())
      .then(() => files.sweep()),
    watchesReleased: watches.released,
    callAppTool: appTools.call,
    fileHandles: () => files.size,
    watches: () => watches.snapshot(),
  };
}
