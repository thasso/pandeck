/**
 * The credential gateway composition (ADR-0004, `docs/workers.md`
 * "Credentials"): a loopback HTTP model listener that checks lease tokens
 * against its lease table and forwards Claude Messages and Codex responses
 * requests with the bound profile's real credential, plus the control
 * endpoint (`control.ts`) through which the server syncs profiles and grants
 * and revokes leases.
 *
 * With a state directory, the leases and the profile registry are loaded at
 * start and saved on every change (`state.ts`), so a restarted gateway
 * forwards before any control connects. Without one they live in memory.
 *
 * It runs in the process that starts it. Nothing in the server starts it yet:
 * the server's wiring comes with a later slice, so today only tests do,
 * against fake upstreams.
 */
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";
import {
  createForwarder,
  type GatewayStats,
  type UpstreamOverrides,
} from "./forward.ts";
import { createControlEndpoint } from "./control.ts";
import { LeaseTable } from "./leases.ts";
import { ProfileRegistry } from "./profiles.ts";
import { openGatewayState } from "./state.ts";

export interface GatewayOptions {
  /** 0 picks a free port. The host is always `127.0.0.1`. */
  port?: number;
  log?: (line: string) => void;
  /** Per-provider connect address and CA; TLS name and `Host` stay logical. */
  upstreams?: UpstreamOverrides;
  /** Where leases and profiles persist; without it they live in memory. */
  stateDir?: string;
  /** Epoch milliseconds; the clock tests inject. */
  now?: () => number;
}

export interface RunningGateway {
  readonly url: string;
  readonly port: number;
  readonly leases: LeaseTable;
  readonly stats: Readonly<GatewayStats>;
  /** Serves gateway control 1.0 on `endpoint`, as the listener. */
  attachControl(endpoint: ByteEndpoint): void;
  /** Stops listening, ends control connections and destroys open sockets. */
  close(): Promise<void>;
}

export async function startGateway(
  options: GatewayOptions = {},
): Promise<RunningGateway> {
  const log =
    options.log ?? ((line: string) => console.log(`[gateway] ${line}`));
  const state = options.stateDir
    ? openGatewayState(options.stateDir, log)
    : undefined;
  const leases = new LeaseTable({
    now: options.now,
    persist: state?.persistLeases,
  });
  const profiles = new ProfileRegistry(state?.persistProfiles);
  if (state) {
    leases.restore(state.leases);
    profiles.restore(state.profiles);
  }
  const control = createControlEndpoint({ leases, profiles, log });
  const stats: GatewayStats = {
    forwarded: 0,
    refused: 0,
    clientClosed: 0,
    upstreamErrors: 0,
  };
  const agent = new https.Agent({ keepAlive: true });
  const forwarder = createForwarder({
    leases,
    log,
    agent,
    upstreams: options.upstreams ?? {},
    stats,
  });
  const sockets = new Set<net.Socket>();

  const server = http.createServer(forwarder.handleRequest);
  server.on("upgrade", forwarder.handleUpgrade);
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    else socket.destroy();
  });
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  log(`listening on 127.0.0.1:${port}`);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    leases,
    stats,
    attachControl: control.attach,
    async close() {
      control.close();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      agent.destroy();
      await closed;
    },
  };
}
