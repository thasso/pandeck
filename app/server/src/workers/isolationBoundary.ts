/**
 * The isolation boundary: what separates the server from what its agents can
 * touch (`docs/workers.md` §"Isolation boundary and secrets"). It supplies the
 * Worker endpoint and the environment the Worker's children inherit, so
 * nothing outside an implementation assumes the Worker runs as the server's
 * own account or as another one.
 *
 * Phase 1 has the server-host implementation, the same account. Phase 2 adds
 * a Worker process and phase 3 a separate agent account; each is another
 * implementation of this port.
 */
import { childProcessEnv } from "../subprocessEnv.ts";
import {
  createInProcessTransport,
  type ByteEndpoint,
} from "../workerProtocol/inProcessTransport.ts";

export interface IsolationBoundary {
  /** A fresh stream pair: the end the server accepts, the end a Worker dials. */
  workerEndpoint(): [server: ByteEndpoint, worker: ByteEndpoint];
  /**
   * The environment a Worker's child inherits. Read it for each child: the
   * package proxy publishes its overlay after the Worker has started.
   */
  workerChildEnv(): NodeJS.ProcessEnv;
}

/** The Worker runs in the server's process, as the server's account. */
const sameAccountBoundary: IsolationBoundary = {
  workerEndpoint: createInProcessTransport,
  workerChildEnv: childProcessEnv,
};

/** The boundary this server runs behind. */
export const isolationBoundary: IsolationBoundary = sameAccountBoundary;
