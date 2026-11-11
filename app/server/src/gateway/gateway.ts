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
 * the two and owns their timers. With `vault`, the vault is a process of its
 * own (`remoteVault.ts`, `vaultServer.ts`): the edge then holds no token
 * file, renews nothing, and serves no gateway control 1.4, so it is a
 * client-mode edge only.
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
import {
  peerClientId,
  startClientListener,
  type ClientListenerOptions,
  type RunningClientListener,
} from "./clientListener.ts";
import { createControlEndpoint } from "./control.ts";
import type { HoldRecord, WriterLane } from "./holds.ts";
import { LeaseTable } from "./leases.ts";
import type { EdgeTools } from "./edgeTools.ts";
import type { LoginDrivers, VaultPort } from "./vaultPort.ts";
import type { ProcessProbe } from "./processIdentity.ts";
import { ProfileRegistry } from "./profiles.ts";
import type { RefreshLockOptions } from "./refreshLock.ts";
import { RENEW_TICK_MS, type CodexRenewPort } from "./renewal.ts";
import { openGatewayState } from "./state.ts";
import { createRemoteVault, type RemoteVaultOptions } from "./remoteVault.ts";
import { createVault, type Vault } from "./vault.ts";

/** How often a drain looks for streams that have ended. */
const DRAIN_POLL_MS = 100;

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
  /**
   * The edge's mutual-TLS listeners for enrolled clients (`clientListener.ts`);
   * needs `stateDir`. Without it the gateway serves only the loopback port.
   */
  clients?: ClientListenerOptions;
  /** The login drivers enrolled clients' logins run (`logins.ts`). */
  loginDrivers?: LoginDrivers;
  /**
   * A vault in its own process, reached over `gateway-vault/1.0`. Without it
   * the vault runs in this process.
   */
  vault?: RemoteVaultOptions;
  /**
   * The edge's tools (`edgeTools.ts`), injected by the edge's entry: `/mcp`
   * and the integration methods on the client listener. Without them `/mcp`
   * is unknown and the integration methods refuse.
   */
  tools?: EdgeTools;
}

export interface RunningGateway {
  readonly url: string;
  readonly port: number;
  readonly leases: LeaseTable;
  readonly stats: Readonly<GatewayStats>;
  /** The client listener, when `clients` was given. */
  readonly clients: RunningClientListener | undefined;
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
  /**
   * Stops listening and ends control connections. Open model requests get
   * `drainMs` to finish (default none), then their sockets are destroyed.
   */
  close(options?: { drainMs?: number }): Promise<void>;
}

export async function startGateway(
  options: GatewayOptions = {},
): Promise<RunningGateway> {
  const log =
    options.log ?? ((line: string) => console.log(`[gateway] ${line}`));
  const state = options.stateDir
    ? openGatewayState(options.stateDir, log)
    : undefined;
  /** Set with a remote vault: each change of its inputs is sent to it. */
  let remote: ReturnType<typeof createRemoteVault> | undefined;
  const leases = new LeaseTable({
    now: options.now,
    persist: options.vault
      ? (records) => {
          remote?.inputsChanged();
          state?.persistLeases(records);
        }
      : state?.persistLeases,
  });
  const profiles = new ProfileRegistry(
    options.vault
      ? (records) => {
          remote?.inputsChanged();
          state?.persistProfiles(records);
        }
      : state?.persistProfiles,
  );
  if (state) {
    leases.restore(state.leases);
    profiles.restore(state.profiles);
  }
  /** Set once the client listener runs; the vault's reports reach it. */
  let clients: RunningClientListener | undefined;
  const report = (profileId: string, needsLogin: boolean): void => {
    control?.reportCredential({ profileId, needsLogin });
    clients?.accountsChanged();
  };
  if (options.vault)
    remote = createRemoteVault(options.vault, {
      profiles: () => profiles.ids().map((id) => profiles.get(id)!),
      liveLeases: () => profiles.ids().filter((id) => leases.hasLiveLease(id)),
      report,
      log,
    });
  // The vault restores its holds and fences them from the restored registry.
  const local: Vault | undefined = remote
    ? undefined
    : createVault({
        inputs: {
          profiles,
          hasLiveLease: (profileId) => leases.hasLiveLease(profileId),
          report,
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
        logins: {
          stateDir: options.stateDir,
          drivers: options.loginDrivers ?? {},
        },
        integrations: { stateDir: options.stateDir },
      });
  const vault: VaultPort = remote ?? local!;
  const compat = createCompatUpstream();
  // Gateway control 1.4 needs the vault's holds: only an in-process one.
  const control = local
    ? createControlEndpoint({ leases, profiles, compat, log, vault: local })
    : undefined;

  const stats: GatewayStats = {
    forwarded: 0,
    refused: 0,
    clientClosed: 0,
    upstreamErrors: 0,
  };
  const agent = new https.Agent({ keepAlive: true });
  const httpAgent = new http.Agent({ keepAlive: true });
  const forwarderDeps = {
    leases,
    log,
    agent,
    httpAgent,
    upstreams: options.upstreams ?? {},
    compat,
    compatCa: options.compatCa,
    stats,
    vault,
  };
  const forwarder = createForwarder(forwarderDeps);
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
  if (options.clients) {
    if (!options.stateDir)
      throw new Error("The client listener needs stateDir.");
    clients = await startClientListener(
      {
        stateDir: options.stateDir,
        leases,
        profiles,
        needsLogin: () => vault.needsLogin(),
        forwarder: createForwarder({
          ...forwarderDeps,
          clientOf: peerClientId,
        }),
        log,
        ...(options.now ? { now: options.now } : {}),
        vault,
        tools: options.tools,
      },
      options.clients,
    );
  }
  const checkHolds = (): void => control?.checkHolds();
  const holdCheck = setInterval(
    checkHolds,
    options.holdCheckIntervalMs ?? 60_000,
  );
  holdCheck.unref();
  const renewDue = (): Promise<void> => local?.renewDue() ?? Promise.resolve();
  const renewTick = setInterval(() => {
    renewDue().catch(() => log("renewal tick failed"));
  }, options.renewTickMs ?? RENEW_TICK_MS);
  renewTick.unref();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    leases,
    stats,
    clients,
    lane: local?.lane ?? {
      run: () =>
        Promise.reject(new Error("The vault runs in its own process.")),
    },
    attachControl(endpoint) {
      if (control) return control.attach(endpoint);
      log("control refused: this edge's vault runs in its own process");
      endpoint.close();
    },
    lastHello: () => control?.hello(),
    holds: () => local?.holdRecords() ?? [],
    checkHolds,
    renewDue,
    async close({ drainMs = 0 } = {}) {
      clearInterval(holdCheck);
      clearInterval(renewTick);
      control?.close();
      await clients?.close();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      // A stream still answering keeps its credential until it ends or the
      // drain does.
      const drainUntil = Date.now() + drainMs;
      for (;;) {
        server.closeIdleConnections();
        if (sockets.size === 0 || Date.now() >= drainUntil) break;
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
      }
      local?.close();
      remote?.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      agent.destroy();
      httpAgent.destroy();
      await closed;
    },
  };
}
