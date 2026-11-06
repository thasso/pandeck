/**
 * The standalone gateway (Task-1383): the edge and the vault in their own
 * process, serving gateway control on a Unix socket the server dials
 * (`gatewayLink.ts` with `socketPath`). Control stays `gateway-control/1.x`,
 * transitional until `gateway-client/1.0`. `main.ts` is the entry; tests call
 * {@link runGatewayProcess} with their seams.
 *
 * The control socket is taken first, so a second gateway on the same socket
 * refuses before it opens any state. A stop closes the control socket, stops
 * accepting model requests, and lets open streams finish for up to the drain
 * before it closes the rest.
 */
import { listenUnixSocket } from "../workerProtocol/unixSocketTransport.ts";
import {
  startGateway,
  type GatewayOptions,
  type RunningGateway,
} from "./gateway.ts";

/** How long a stop lets open streams finish: two minutes (U6). */
const STOP_DRAIN_MS = 120_000;

export interface GatewayProcessOptions extends Pick<
  GatewayOptions,
  | "stateDir"
  | "port"
  | "log"
  | "renewCodex"
  | "loginDrivers"
  | "upstreams"
  | "claudeTokenEndpoint"
  | "clients"
> {
  stateDir: string;
  port: number;
  /** Where the control socket listens. */
  socketPath: string;
  /** How long a stop lets open streams finish; {@link STOP_DRAIN_MS}. */
  drainMs?: number;
}

export interface RunningGatewayProcess {
  readonly gateway: RunningGateway;
  /** The client listener, when `clients` was given. */
  readonly clients: RunningGateway["clients"];
  /** Closes the control socket, drains and closes the gateway; once. */
  stop(): Promise<void>;
}

export async function runGatewayProcess(
  options: GatewayProcessOptions,
): Promise<RunningGatewayProcess> {
  const { socketPath, drainMs = STOP_DRAIN_MS, ...gatewayOptions } = options;
  let gateway: RunningGateway | undefined;
  const renewals = new Set<Promise<unknown>>();
  const renewCodex: GatewayOptions["renewCodex"] =
    options.renewCodex &&
    ((...args) => {
      const renewing = options.renewCodex!(...args);
      renewals.add(renewing);
      void renewing.then(
        () => renewals.delete(renewing),
        () => renewals.delete(renewing),
      );
      return renewing;
    });
  const control = await listenUnixSocket(socketPath, (endpoint) => {
    // A dial before the gateway is up is turned away; the server dials again.
    if (gateway) gateway.attachControl(endpoint);
    else endpoint.close();
  });
  try {
    gateway = await startGateway({
      ...gatewayOptions,
      ...(renewCodex ? { renewCodex } : {}),
    });
  } catch (err) {
    await control.close();
    throw err;
  }
  const started = gateway;
  let stopping: Promise<void> | undefined;
  return {
    gateway: started,
    clients: started.clients,
    stop() {
      stopping ??= (async () => {
        await control.close();
        await started.close({ drainMs });
        // Vault close aborts renewal. Do not exit before the port has reaped
        // its child, including SIGKILL escalation for a stuck refresh.
        await Promise.allSettled([...renewals]);
      })();
      return stopping;
    },
  };
}

/** SIGTERM or SIGINT stops `running`, then the process exits 0. */
export function stopOnSignals(
  running: RunningGatewayProcess,
  log: (line: string) => void,
): void {
  const stop = (signal: string): void => {
    log(`${signal}: stopping, open streams drain first`);
    void running.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}
