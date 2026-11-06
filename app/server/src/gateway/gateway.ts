/**
 * The credential gateway composition (ADR-0005, `docs/workers.md`
 * "Credentials"): a loopback HTTP model listener that checks lease tokens
 * against its lease table and forwards Claude Messages and Codex responses
 * requests with the bound profile's real credential, and OpenAI-compatible
 * chat completions to the bound profile's endpoint with the key the server
 * pushed for it, plus the control endpoint (`control.ts`) through which the
 * server syncs profiles, grants and revokes leases, and pushes each
 * compatible profile's endpoint and key.
 *
 * With a state directory, the leases, the profile registry and the login
 * holds are loaded at start and saved on every change (`state.ts`), so a
 * restarted gateway forwards before any control connects and keeps every
 * hold. Without one they live in memory. The pushed endpoints and keys live
 * only in memory either way (`compatUpstream.ts`): a restarted gateway
 * answers 503 on `/compat` until the next push. A timer rechecks the holds
 * once a minute (`holds.ts`), and another renews the leased login profiles' tokens
 * (`renewal.ts`), from the saved leases even before a control connects. Every
 * hold that ends has its profile's file re-read at once.
 *
 * The edge (listener, forwarding, leases, compatible endpoints, control)
 * reaches the vault (renewal, the writer lane and the login holds,
 * `vault.ts`) only through `VaultPort` (`vaultPort.ts`); this module wires
 * the two and owns their timers.
 *
 * It runs in the process that starts it: the server's, through
 * `gatewayLink.ts` under `ASSISTANT_GATEWAY=1`, and tests', against fake
 * upstreams.
 */
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";
import type { ControlHello } from "./controlMethods.ts";
import {
  createForwarder,
  type GatewayStats,
  type UpstreamOverrides,
} from "./forward.ts";
import { createCompatUpstream } from "./compatUpstream.ts";
import type { TokenEndpoint } from "./claudeRenewal.ts";
import { createControlEndpoint } from "./control.ts";
import type { HoldRecord, WriterLane } from "./holds.ts";
import { LeaseTable } from "./leases.ts";
import type { ProcessProbe } from "./processIdentity.ts";
import { ProfileRegistry } from "./profiles.ts";
import type { RefreshLockOptions } from "./refreshLock.ts";
import { RENEW_TICK_MS, type CodexRenewPort } from "./renewal.ts";
import { openGatewayState } from "./state.ts";
import { createVault } from "./vault.ts";

export interface GatewayOptions {
  /** 0 picks a free port. The host is always `127.0.0.1`. */
  port?: number;
  log?: (line: string) => void;
  /** Per-provider connect address and CA; TLS name and `Host` stay logical. */
  upstreams?: UpstreamOverrides;
  /** Test seam: the CA an https compatible endpoint is checked against. */
  compatCa?: string | string[];
  /** Where leases and profiles persist; without it they live in memory. */
  stateDir?: string;
  /** Epoch milliseconds; the clock tests inject. */
  now?: () => number;
  /** How often the login holds are rechecked; 60 s. */
  holdCheckIntervalMs?: number;
  /** Test seam: how hold owners and writers are observed. */
  processProbe?: ProcessProbe;
  /** pi's Codex refresh; without it a Codex renewal fails (`no_port`). */
  renewCodex?: CodexRenewPort;
  /** Test seam: where the Claude token endpoint is reached. */
  claudeTokenEndpoint?: TokenEndpoint;
  /** How often leased profiles are checked for renewal; 60 s. */
  renewTickMs?: number;
  /** Test seam: the Claude refresh lock's clock and retry sleeps. */
  refreshLockOptions?: RefreshLockOptions;
}

export interface RunningGateway {
  readonly url: string;
  readonly port: number;
  readonly leases: LeaseTable;
  readonly stats: Readonly<GatewayStats>;
  /** The profiles' writer lane, for in-gateway writers (G4, G5). */
  readonly lane: Pick<WriterLane, "run">;
  /** Serves gateway control 1.4 on `endpoint`, as the listener. */
  attachControl(endpoint: ByteEndpoint): void;
  /** The last `control.hello` a control connection said, as recorded. */
  lastHello(): ControlHello | undefined;
  /** The login holds, as records; tests and the probe read them. */
  holds(): HoldRecord[];
  /** Rechecks the holds now, as the timer does; tests and the probe. */
  checkHolds(): void;
  /** Runs one renewal tick now, as the timer does; tests and the probe. */
  renewDue(): Promise<void>;
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
  // The vault restores its holds and fences them from the restored registry.
  const vault = createVault({
    inputs: {
      profiles,
      hasLiveLease: (profileId) => leases.hasLiveLease(profileId),
      report: (profileId, needsLogin) =>
        control.reportCredential({ profileId, needsLogin }),
    },
    log,
    now: options.now,
    holds: {
      persist: state?.persistHolds,
      probe: options.processProbe,
      fenced: state?.holdsUnreadable,
      restored: state?.holds,
    },
    renewal: {
      claudeEndpoint: options.claudeTokenEndpoint,
      renewCodex: options.renewCodex,
      lockOptions: options.refreshLockOptions,
    },
  });
  const compat = createCompatUpstream();
  const control = createControlEndpoint({
    leases,
    profiles,
    compat,
    log,
    vault,
  });

  const stats: GatewayStats = {
    forwarded: 0,
    refused: 0,
    clientClosed: 0,
    upstreamErrors: 0,
  };
  const agent = new https.Agent({ keepAlive: true });
  const httpAgent = new http.Agent({ keepAlive: true });
  const forwarder = createForwarder({
    leases,
    log,
    agent,
    httpAgent,
    upstreams: options.upstreams ?? {},
    compat,
    compatCa: options.compatCa,
    stats,
    vault,
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
  const holdCheck = setInterval(
    control.checkHolds,
    options.holdCheckIntervalMs ?? 60_000,
  );
  holdCheck.unref();
  const renewTick = setInterval(() => {
    vault.renewDue().catch(() => log("renewal tick failed"));
  }, options.renewTickMs ?? RENEW_TICK_MS);
  renewTick.unref();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    leases,
    stats,
    lane: vault.lane,
    attachControl: control.attach,
    lastHello: control.hello,
    holds: vault.holdRecords,
    checkHolds: control.checkHolds,
    renewDue: vault.renewDue,
    async close() {
      clearInterval(holdCheck);
      clearInterval(renewTick);
      vault.close();
      control.close();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      agent.destroy();
      httpAgent.destroy();
      await closed;
    },
  };
}
