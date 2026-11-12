/**
 * The edge's composition, shared by its two entries (Task-1401): the
 * packaged `gatewayEdgeMain.ts` (`gateway-edge.js`, remote vault only) and the
 * dev entry `gatewayDevMain.ts` (either mode, with the login drivers).
 *
 * `parseEdgeArgs` reads the flags both take; `startEdge` runs `startGateway`
 * with the edge's client listener and tools (`gatewayTools/`: `/mcp` and the
 * integration methods), with either the remote vault over the pinned link
 * (`--vault-host`) or the vault in this process with the caller's login
 * drivers, and, with `--ui-config`, the gateway's sign-in and page
 * (`gatewayWeb/`) over the running gateway's own client registry and its
 * user-scoped account and login operations (`gateway/userOperations.ts`), so
 * the page and enrolled clients run the same implementation.
 *
 * It imports `gateway/`, `gatewayTools/`, `gatewayWeb/` and `node:` only: no
 * login driver, harness or SDK, so the packaged entry's closure holds none
 * (`workerBoundary.test.ts`). It reads no `DATA_DIR`.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { startGateway, type RunningGateway } from "./gateway/gateway.ts";
import { LoginRefusal, type LoginActor } from "./gateway/logins.ts";
import type { CodexRenewPort } from "./gateway/renewal.ts";
import { readEdgeVaultLink } from "./gateway/vaultMethods.ts";
import type { UserOperations } from "./gateway/userOperations.ts";
import type { LoginDrivers } from "./gateway/vaultPort.ts";
import { createEdgeTools } from "./gatewayTools/index.ts";
import {
  AccountsRefusal,
  type GatewayWebAccounts,
  type GatewayWebActor,
} from "./gatewayWeb/accounts.ts";
import {
  GatewayWebConfigError,
  loadGatewayWebConfig,
} from "./gatewayWeb/config.ts";
import type { OidcTestOptions } from "./gatewayWeb/oidc.ts";
import { startGatewayWeb } from "./gatewayWeb/server.ts";

/** The vault's port when `--vault-port` is not given. */
const VAULT_PORT = 8794;

export interface EdgeOptions {
  stateDir: string;
  /** The loopback listener's port; 0 picks a free one, as do the others. */
  port: number;
  modelPort: number;
  clientPort: number;
  enrollPort: number;
  bindHost?: string;
  hosts?: string[];
  /** The remote vault's address, when `--vault-host`. */
  vault?: { host: string; port: number };
  /** The UI's config file, when `--ui-config`. */
  uiConfig?: string;
}

/**
 * The edge's flags, or `undefined` for a usage error: a missing
 * `--state-dir`, a port out of range, an unknown flag, or no `--vault-host`
 * when `requireVault`.
 */
export function parseEdgeArgs(
  argv: string[],
  { requireVault }: { requireVault: boolean },
): EdgeOptions | undefined {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "state-dir": { type: "string" },
        port: { type: "string" },
        "model-port": { type: "string" },
        "client-port": { type: "string" },
        "enroll-port": { type: "string" },
        "bind-host": { type: "string" },
        host: { type: "string", multiple: true },
        "vault-host": { type: "string" },
        "vault-port": { type: "string" },
        "ui-config": { type: "string" },
      },
    }));
  } catch {
    return undefined;
  }
  const stateDir = values["state-dir"];
  if (!stateDir) return undefined;
  if (requireVault && !values["vault-host"]) return undefined;
  const ports = [
    values.port,
    values["model-port"],
    values["client-port"],
    values["enroll-port"],
    values["vault-port"] ?? String(VAULT_PORT),
  ].map((value) => Number(value ?? 0));
  if (ports.some((n) => !Number.isInteger(n) || n < 0 || n > 65_535))
    return undefined;
  const [port, modelPort, clientPort, enrollPort, vaultPort] = ports as [
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    stateDir: resolve(stateDir),
    port,
    modelPort,
    clientPort,
    enrollPort,
    ...(values["bind-host"] ? { bindHost: values["bind-host"] } : {}),
    ...(values.host ? { hosts: values.host } : {}),
    ...(values["vault-host"]
      ? { vault: { host: values["vault-host"], port: vaultPort } }
      : {}),
    ...(values["ui-config"] ? { uiConfig: resolve(values["ui-config"]) } : {}),
  };
}

/** A refusal of the seam as the page's fixed code; anything else rethrown. */
function refused<T>(call: () => T): T {
  try {
    return call();
  } catch (err) {
    if (err instanceof LoginRefusal) throw new AccountsRefusal(err.code);
    throw err;
  }
}

/** The page's accounts over the edge's user-scoped operations. */
function webAccounts(operations: UserOperations): GatewayWebAccounts {
  const actor = ({ actorId, userId, active }: GatewayWebActor): LoginActor => ({
    kind: "session",
    id: actorId,
    userId,
    active,
  });
  return {
    list: (userId) =>
      operations.accounts(userId).map(({ id, provider, name, needsLogin }) => ({
        id,
        provider,
        name,
        needsLogin,
      })),
    remove: (userId, accountId) =>
      refused(() => operations.removeAccount(userId, accountId)),
    start: (session, start) =>
      refused(() => operations.startLogin(actor(session), start)),
    input: (session, loginId, text) =>
      refused(() => operations.inputLogin(actor(session), loginId, text)),
    cancel: (session, loginId) =>
      refused(() => operations.cancelLogin(actor(session), loginId)),
    read: (session, loginId, cursor) =>
      refused(() => operations.readLogin(actor(session), loginId, cursor)),
    endActor: (actorId) =>
      operations.endActor({ kind: "session", id: actorId }),
  };
}

/** A start the operator must fix (exit 2): not paired, a bad UI config. */
export class EdgeStartRefusal extends Error {}

export interface EdgeExtras {
  /** The entry's own lines: the ports line. */
  log: (line: string) => void;
  /** The in-process vault's login drivers, without `--vault-host`. */
  loginDrivers?: LoginDrivers;
  /** pi's Codex refresh for the in-process vault. */
  renewCodex?: CodexRenewPort;
  /** Tests only; no entry passes it, and nothing reads it from a flag or file. */
  oidcTestOptions?: OidcTestOptions;
  /** Tests only, as `oidcTestOptions`: the UI's clock, for session expiry. */
  uiNow?: () => number;
}

export interface RunningEdge {
  readonly gateway: RunningGateway;
  /** The UI's port, when `--ui-config`. */
  readonly uiPort: number | undefined;
  /** Closes the UI and the gateway, once; later calls share the first. */
  close(): Promise<void>;
}

export async function startEdge(
  options: EdgeOptions,
  extras: EdgeExtras,
): Promise<RunningEdge> {
  const { stateDir } = options;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let vault;
  if (options.vault) {
    const tls = readEdgeVaultLink(stateDir);
    if (typeof tls === "string")
      throw new EdgeStartRefusal(`not paired: ${tls}`);
    vault = { ...options.vault, tls };
  }
  // The UI's config is checked before anything listens.
  let ui;
  if (options.uiConfig) {
    try {
      ui = loadGatewayWebConfig(options.uiConfig);
    } catch (err) {
      if (err instanceof GatewayWebConfigError)
        throw new EdgeStartRefusal(err.message);
      throw err;
    }
  }

  const gateway = await startGateway({
    stateDir,
    port: options.port,
    ...(extras.renewCodex ? { renewCodex: extras.renewCodex } : {}),
    tools: createEdgeTools(),
    clients: {
      modelPort: options.modelPort,
      clientPort: options.clientPort,
      enrollPort: options.enrollPort,
      ...(options.bindHost ? { bindHost: options.bindHost } : {}),
      ...(options.hosts ? { hosts: options.hosts } : {}),
    },
    ...(vault
      ? { vault }
      : extras.loginDrivers
        ? { loginDrivers: extras.loginDrivers }
        : {}),
  });
  const edge = gateway.clients!;
  const registry = edge.registry;
  let web;
  try {
    web = ui
      ? await startGatewayWeb({
          config: ui,
          users: {
            signIn: (identity) => registry.signIn(identity),
            user: (id) => registry.user(id),
          },
          accounts: webAccounts(edge.userOperations),
          log: (line) => console.log(`[gateway] ${line}`),
          ...(options.bindHost ? { bindHost: options.bindHost } : {}),
          ...(extras.oidcTestOptions
            ? { oidcTestOptions: extras.oidcTestOptions }
            : {}),
          ...(extras.uiNow ? { now: extras.uiNow } : {}),
        })
      : undefined;
  } catch (err) {
    await gateway.close();
    throw err;
  }
  extras.log(
    `state ${stateDir}; loopback ${gateway.port}, model ${edge.modelPort}, client ${edge.clientPort}, enroll ${edge.enrollPort}${web ? `, ui ${web.port}` : ""}${vault ? `; vault ${vault.host}:${vault.port}` : ""}`,
  );
  let closing: Promise<void> | undefined;
  return {
    gateway,
    uiPort: web?.port,
    close() {
      closing ??= Promise.all([gateway.close(), web?.close()]).then(
        () => undefined,
      );
      return closing;
    },
  };
}
