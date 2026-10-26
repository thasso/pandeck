/**
 * The Worker that runs inside the server's own process: the default Worker of
 * phase 1, and the one dev and tests keep using afterwards (`docs/workers.md`).
 * It dials the registry over an in-process transport and speaks the real
 * protocol, byte for byte.
 *
 * A connection end is not sticky: the next request dials a fresh Worker on a
 * new connection epoch. Requests the old Worker received are rejected only
 * once it reports quiescence — every git child it started has exited — so a
 * caller never releases a repo lock beside a running git. In-process, the
 * server observes that directly; an out-of-process Worker (phase 2) needs
 * fencing instead.
 *
 * The only module that imports `worker/` (`workerBoundary.test.ts`).
 */
import {
  startWorker,
  type RunningWorker,
  type SubstituteHandler,
} from "../worker/worker.ts";
import type { WorkerConnection } from "../workerProtocol/connection.ts";
import {
  createInProcessTransport,
  type ByteEndpoint,
} from "../workerProtocol/inProcessTransport.ts";
import { DEFAULT_WORKER_ID } from "./placement.ts";
import { workerRegistry } from "./workerRegistry.ts";

let current:
  | {
      connection: WorkerConnection;
      workerEnd: ByteEndpoint;
      worker: RunningWorker;
    }
  | undefined;
let served = 0;
const servedByMethod = new Map<string, number>();
const substitutes = new Map<string, SubstituteHandler>();

/** The server's connection to the in-process Worker, dialing one if needed. */
export function ensureInProcessWorker(): WorkerConnection {
  if (current && !current.connection.isEnded) return current.connection;
  const [serverEnd, workerEnd] = createInProcessTransport();
  // Accept first, as a listening socket would, then let the Worker dial.
  let quiescent: Promise<void> = Promise.resolve();
  const connection = workerRegistry.accept(serverEnd, {
    quiescence: () => quiescent,
  });
  const worker = startWorker({
    workerId: DEFAULT_WORKER_ID,
    transport: workerEnd,
    onRequest: (method) => {
      served += 1;
      servedByMethod.set(method, (servedByMethod.get(method) ?? 0) + 1);
      const substitute = substitutes.get(method);
      substitutes.delete(method);
      return substitute;
    },
  });
  ({ quiescent } = worker);
  current = { connection, workerEnd, worker };
  return connection;
}

/** Boot: dial the in-process Worker before the first checkout needs it. */
export function startInProcessWorker(): void {
  ensureInProcessWorker();
}

/** Test seam: how many requests in-process Workers have decoded and served. */
export function inProcessWorkerServedForTests(): number {
  return served;
}

/** Test seam: how many `method` requests in-process Workers have served. */
export function inProcessWorkerServedMethodForTests(method: string): number {
  return servedByMethod.get(method) ?? 0;
}

/** Test seam: the file handles the current in-process Worker holds. */
export function inProcessWorkerFileHandlesForTests(): number {
  return current?.worker.fileHandles() ?? 0;
}

/** Test seam: the connection epoch of the open in-process connection. */
export function inProcessWorkerEpochForTests(): number | undefined {
  return workerRegistry.epoch(DEFAULT_WORKER_ID);
}

/**
 * Test seam: the next `method` request an in-process Worker serves is served
 * by `substitute`, which receives the real handler. One-shot per method;
 * answers the disarm.
 */
export function answerNextInProcessWorkerCallForTests(
  method: string,
  substitute: SubstituteHandler,
): () => void {
  substitutes.set(method, substitute);
  return () => {
    if (substitutes.get(method) === substitute) substitutes.delete(method);
  };
}

/** Test seam: bytes the server receives as if the Worker had sent them. */
export function writeAsInProcessWorkerForTests(bytes: Uint8Array): void {
  current?.workerEnd.write(bytes);
}
