/**
 * The server's side of the checkout git methods: a git run for a checkout
 * becomes a request to the Worker its location names, and the Worker's raw
 * outcome comes back for the executor family (`gitExec.ts`) to settle as it
 * settles a local one.
 *
 * Any failure to get an answer — the connection ending, a refused handshake,
 * an unknown Worker id, a protocol error, the Worker refusing the location —
 * rejects, which the family reports as an execution failure in each
 * executor's own shape, as it does a dead spawn broker.
 */
import type {
  GitBoundedRequest,
  GitRawRequest,
  GitRunRequest,
} from "../gitProcess.ts";
import type {
  BrokerBoundedOutcome,
  BrokerExecOutcome,
} from "../spawnBroker.ts";
import {
  CHECKOUT_GIT_METHODS,
  decodeBoundedOutcome,
  decodeExecOutcome,
  decodeRawOutcome,
  encodeBounded,
  encodeRun,
  type CheckoutLocation,
} from "../workerProtocol/checkoutMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerRequestNotSentError,
  type WorkerConnection,
} from "../workerProtocol/connection.ts";
import { ensureInProcessWorker } from "./inProcessWorker.ts";
import { DEFAULT_WORKER_ID } from "./placement.ts";
import { workerRegistry } from "./workerRegistry.ts";

/** What a spawn broker answers for a request cancelled before it ran. */
const NOT_STARTED = { code: "ABORT_ERR", message: "The operation was aborted" };

/** The server's connection to `workerId`, dialing the in-process Worker if needed. */
export function workerConnection(workerId: string): WorkerConnection {
  if (workerId === DEFAULT_WORKER_ID) return ensureInProcessWorker();
  const connection = workerRegistry.connection(workerId);
  if (!connection) throw new Error(`Worker "${workerId}" is not connected.`);
  return connection;
}

/**
 * Send one request; `notSent` answers a request cancelled before the Worker
 * saw it, as the broker answers one cancelled before it spawned.
 */
async function ask<T>(
  location: CheckoutLocation,
  method: string,
  payload: Payload,
  signal: AbortSignal | undefined,
  notSent: () => T,
  decode: (answer: Payload) => T,
): Promise<T> {
  let answer: Payload;
  try {
    answer = await workerConnection(location.workerId).request(
      method,
      payload,
      signal,
    );
  } catch (err) {
    if (err instanceof WorkerRequestNotSentError) return notSent();
    throw err;
  }
  return decode(answer);
}

function command(
  location: CheckoutLocation,
  req: GitRunRequest | GitRawRequest | GitBoundedRequest,
) {
  return {
    location,
    args: req.args,
    mode: req.mode,
    ...(req.env ? { env: req.env } : {}),
  };
}

export const workerGitRunner = {
  run(
    location: CheckoutLocation,
    req: GitRunRequest,
  ): Promise<BrokerExecOutcome<string>> {
    const { method, payload } = encodeRun({
      ...command(location, req),
      maxBuffer: req.maxBuffer,
      // The bytes the broker would write: a string goes as UTF-8.
      ...(req.input !== undefined ? { input: Buffer.from(req.input) } : {}),
    });
    return ask<BrokerExecOutcome<string>>(
      location,
      method,
      payload,
      req.signal,
      () => ({ error: NOT_STARTED, stdout: "", stderr: "" }),
      decodeExecOutcome,
    );
  },

  raw(
    location: CheckoutLocation,
    req: GitRawRequest,
  ): Promise<BrokerExecOutcome<Buffer>> {
    const { payload } = encodeRun({
      ...command(location, req),
      maxBuffer: req.maxBuffer,
    });
    return ask<BrokerExecOutcome<Buffer>>(
      location,
      CHECKOUT_GIT_METHODS.raw,
      payload,
      req.signal,
      () => ({ error: NOT_STARTED, stdout: Buffer.alloc(0), stderr: "" }),
      decodeRawOutcome,
    );
  },

  bounded(
    location: CheckoutLocation,
    req: GitBoundedRequest,
  ): Promise<BrokerBoundedOutcome> {
    return ask<BrokerBoundedOutcome>(
      location,
      CHECKOUT_GIT_METHODS.bounded,
      encodeBounded({
        ...command(location, req),
        maxChars: req.maxChars,
        maxStderr: req.maxStderr,
      }),
      req.signal,
      () => ({
        code: null,
        aborted: true,
        patch: "",
        totalChars: 0,
        stderr: "",
      }),
      decodeBoundedOutcome,
    );
  },
};
