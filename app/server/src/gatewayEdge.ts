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
 * user-scoped operations (`gateway/userOperations.ts`: accounts, logins, the
 * Atlassian credential, clients and MCP tokens), so the page and enrolled
 * clients run the same implementation.
 *
 * The UI config's OAuth clients (Atlassian, Task-1411; Slack, Task-1452)
 * follow the vault's topology, each on its own (`integrationClientFor`): the
 * in-process vault takes a provider's `clientId` and `clientSecret` together
 * or neither; a remote vault holds its own clients, so the edge keeps only
 * the id (for the page's sign-in link) and never passes or uses a secret it
 * finds.
 *
 * It imports `gateway/`, `gatewayTools/`, `gatewayWeb/` and `node:` only: no
 * login driver, harness or SDK, so the packaged entry's closure holds none
 * (`workerBoundary.test.ts`). It reads no `DATA_DIR`.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { devboxApproval, type DevboxEndpoints } from "./gateway/devboxProof.ts";
import { startGateway, type RunningGateway } from "./gateway/gateway.ts";
import { LoginRefusal, type LoginActor } from "./gateway/logins.ts";
import type { MachinePathMode } from "./gateway/machinePaths.ts";
import type { CodexRenewPort } from "./gateway/renewal.ts";
import { readEdgeVaultLink } from "./gateway/vaultMethods.ts";
import {
  UserOperationRefusal,
  type AtlassianStatus,
  type SlackStatus,
  type UserOperations,
} from "./gateway/userOperations.ts";
import type { EdgeTools } from "./gateway/edgeTools.ts";
import { PAGE_LIMIT, type RequestLog } from "./gateway/requestLog.ts";
import type { IntegrationClients } from "./gateway/integrationClients.ts";
import type { LoginDrivers } from "./gateway/vaultPort.ts";
import { createEdgeTools } from "./gatewayTools/index.ts";
import {
  AccountsRefusal,
  type GatewayWebAccounts,
  type GatewayWebActor,
} from "./gatewayWeb/accounts.ts";
import {
  ClientsRefusal,
  type GatewayWebClients,
} from "./gatewayWeb/clients.ts";
import type { GatewayWebRequests } from "./gatewayWeb/requests.ts";
import {
  GatewayWebConfigError,
  admittedEmail,
  loadGatewayWebConfig,
  requestedAtlassianScopes,
} from "./gatewayWeb/config.ts";
import {
  IntegrationsRefusal,
  type GatewayWebIntegrations,
} from "./gatewayWeb/integrations.ts";
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
  /** `--machine-paths`: the token routes' machine mode; permissive when absent. */
  machinePaths?: MachinePathMode;
}

/**
 * The edge's flags, or `undefined` for a usage error: a missing
 * `--state-dir`, a port out of range, an unknown flag, a `--machine-paths`
 * other than `permissive` or `strict`, or no `--vault-host` when
 * `requireVault`.
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
        "machine-paths": { type: "string" },
      },
    }));
  } catch {
    return undefined;
  }
  const stateDir = values["state-dir"];
  if (!stateDir) return undefined;
  if (requireVault && !values["vault-host"]) return undefined;
  const machinePaths = values["machine-paths"];
  if (
    machinePaths !== undefined &&
    machinePaths !== "permissive" &&
    machinePaths !== "strict"
  )
    return undefined;
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
    ...(machinePaths ? { machinePaths } : {}),
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

/** A seam refusal as the page's fixed code; anything else rethrown. */
function settingsRefusal(err: unknown): never {
  if (err instanceof UserOperationRefusal)
    throw err.code === "unknown_client" ||
      err.code === "limit_reached" ||
      err.code === "unknown_request"
      ? new ClientsRefusal(err.code)
      : new IntegrationsRefusal(err.code);
  throw err;
}

/**
 * What the page shows of a credential: its kind, site, email, Atlassian's
 * display name and a stored record's problem, and how a new connection is
 * made; never the account id or the token.
 */
function browserAtlassian(
  status: AtlassianStatus,
): Awaited<ReturnType<GatewayWebIntegrations["status"]>> {
  const problem =
    "problem" in status &&
    (status.problem === "vault_locked" ||
      status.problem === "vault_unavailable" ||
      status.problem === "invalid" ||
      status.problem === "rejected")
      ? status.problem
      : undefined;
  return {
    connected: status.connected,
    ...(status.kind !== undefined ? { kind: status.kind } : {}),
    connectWith: status.connectWith,
    ...(status.site !== undefined ? { site: status.site } : {}),
    ...("email" in status && status.email !== undefined
      ? { email: status.email }
      : {}),
    ...("displayName" in status && status.displayName !== undefined
      ? { displayName: status.displayName }
      : {}),
    ...(problem ? { problem } : {}),
  };
}

/**
 * What the page's status gets of the user's Slack record: connected, the
 * workspace's name (the route applies the display rule) and a stored
 * record's problem; never a token.
 */
function browserSlack(
  status: SlackStatus,
): Awaited<ReturnType<GatewayWebIntegrations["slackStatus"]>> {
  return status.connected
    ? {
        connected: true,
        ...(status.teamName !== undefined ? { teamName: status.teamName } : {}),
      }
    : {
        connected: false,
        ...(status.problem !== undefined ? { problem: status.problem } : {}),
      };
}

/**
 * The page's Atlassian credential and Slack record over the edge's
 * user-scoped operations.
 */
function webIntegrations(operations: UserOperations): GatewayWebIntegrations {
  return {
    status: (userId) =>
      operations
        .atlassianStatus(userId, { check: false })
        .then(browserAtlassian, settingsRefusal),
    set: (userId, input) =>
      operations
        .setAtlassian(userId, input)
        .then(browserAtlassian, settingsRefusal),
    clear: (userId) => operations.clearAtlassian(userId).catch(settingsRefusal),
    connect: (userId, request) =>
      operations
        .connectAtlassian(userId, request)
        .then(browserAtlassian, settingsRefusal),
    slackStatus: (userId) =>
      operations.slackStatus(userId).then(browserSlack, settingsRefusal),
    connectSlack: (userId, request) =>
      operations.connectSlack(userId, request).then(() => {}, settingsRefusal),
    clearSlack: (userId) =>
      operations.clearSlack(userId).catch(settingsRefusal),
  };
}

/** The page's clients over the edge's user-scoped operations. */
/**
 * The session user's records from the request log: the log's projection,
 * which never holds a user id, at most `PAGE_LIMIT` per answer.
 */
function webRequests(log: RequestLog | undefined): GatewayWebRequests {
  return {
    since: (userId, epoch, after) => {
      if (!log) throw new Error("The edge has no request log.");
      const { epoch: current, records } = log.since(
        userId,
        epoch,
        after,
        PAGE_LIMIT,
      );
      return { epoch: current, requests: records };
    },
  };
}

function webClients(operations: UserOperations): GatewayWebClients {
  const call = <T>(run: () => T): T => {
    try {
      return run();
    } catch (err) {
      return settingsRefusal(err);
    }
  };
  return {
    list: (userId) => operations.clients(userId),
    createCode: (userId, label) =>
      call(() => operations.createEnrollmentCode(userId, label)),
    revoke: (userId, clientId) =>
      call(() => operations.revokeClient(userId, clientId)),
    mintMcpToken: (userId, clientId) => ({
      token: call(() => operations.mintMcpToken(userId, clientId)),
    }),
    revokeMcpToken: (userId, clientId) =>
      call(() => operations.revokeMcpToken(userId, clientId)),
    enrollment: (userId, userCode) =>
      call(() => operations.enrollmentRequest(userId, userCode)),
    decideEnrollment: (userId, userCode, approve) =>
      call(() => operations.decideEnrollment(userId, userCode, approve)),
  };
}

/** A start the operator must fix (exit 2): not paired, a bad UI config. */
export class EdgeStartRefusal extends Error {}

/** The OAuth providers whose client the UI config may name. */
type OAuthProvider = keyof IntegrationClients;

/**
 * The UI config's OAuth client of `provider` for this vault topology: with
 * the vault in this process, both halves or neither (else
 * `EdgeStartRefusal`) and the pair goes to it; with a remote vault nothing
 * goes anywhere, and a configured secret only earns the fixed `warning`. No
 * text holds a value.
 */
export function integrationClientFor(
  provider: OAuthProvider,
  preset: { clientId?: string; clientSecret?: string } | undefined,
  remoteVault: boolean,
): { integrationClients?: IntegrationClients; warning?: string } {
  const clientId = preset?.clientId;
  const clientSecret = preset?.clientSecret;
  const name = provider === "atlassian" ? "Atlassian" : "Slack";
  if (remoteVault)
    return clientSecret !== undefined
      ? {
          warning: `${provider}.clientSecret in the UI config is ignored: the remote vault holds the ${name} client secret; remove it from this file`,
        }
      : {};
  if (clientId === undefined && clientSecret === undefined) return {};
  if (clientId === undefined || clientSecret === undefined)
    throw new EdgeStartRefusal(
      `${provider}.clientId and ${provider}.clientSecret must both be set, or neither, with the vault in this process`,
    );
  return { integrationClients: { [provider]: { clientId, clientSecret } } };
}

/**
 * Every provider's client for this vault topology (`integrationClientFor`),
 * merged: what goes to an in-process vault, and the fixed warnings to log.
 */
export function integrationClientsFor(
  presets: Partial<
    Record<OAuthProvider, { clientId?: string; clientSecret?: string }>
  >,
  remoteVault: boolean,
): { integrationClients?: IntegrationClients; warnings: string[] } {
  const each = (["atlassian", "slack"] as const).map((provider) =>
    integrationClientFor(provider, presets[provider], remoteVault),
  );
  const clients: IntegrationClients = Object.assign(
    {},
    ...each.map((one) => one.integrationClients ?? {}),
  );
  return {
    ...(Object.keys(clients).length > 0 ? { integrationClients: clients } : {}),
    warnings: each.flatMap((one) => (one.warning ? [one.warning] : [])),
  };
}

export interface EdgeExtras {
  /** The entry's own lines: the ports line, the topology warning. */
  log: (line: string) => void;
  /** The in-process vault's login drivers, without `--vault-host`. */
  loginDrivers?: LoginDrivers;
  /** pi's Codex refresh for the in-process vault. */
  renewCodex?: CodexRenewPort;
  /** Tests only; no entry passes it, and nothing reads it from a flag or file. */
  oidcTestOptions?: OidcTestOptions;
  /** Tests only, as `oidcTestOptions`: the UI's clock, for session expiry. */
  uiNow?: () => number;
  /** Tests only, as `oidcTestOptions`: tools in place of the real ones. */
  tools?: EdgeTools;
  /**
   * Tests only, as `oidcTestOptions`: where a devbox proof reaches Google's
   * two hosts (their names, URLs and TLS names stay the real ones).
   */
  devboxEndpoints?: DevboxEndpoints;
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
  const oauthClients = integrationClientsFor(ui ?? {}, vault !== undefined);
  for (const warning of oauthClients.warnings) extras.log(warning);

  const gateway = await startGateway({
    stateDir,
    port: options.port,
    ...(options.machinePaths ? { machinePaths: options.machinePaths } : {}),
    ...(extras.renewCodex ? { renewCodex: extras.renewCodex } : {}),
    tools:
      extras.tools ??
      createEdgeTools({ atlassianScopes: requestedAtlassianScopes(ui) }),
    clients: {
      modelPort: options.modelPort,
      clientPort: options.clientPort,
      enrollPort: options.enrollPort,
      ...(options.bindHost ? { bindHost: options.bindHost } : {}),
      ...(options.hosts ? { hosts: options.hosts } : {}),
      // The page approves enrollment requests, so only with it may machines
      // start them; the link they show points at it.
      ...(ui ? { approvalOrigin: ui.publicOrigin } : {}),
      // D2: with an Atlassian OAuth client the page is the only way to
      // connect Jira; new API tokens are refused on page and client.
      ...(ui?.atlassian?.clientId !== undefined
        ? { atlassianSignIn: true }
        : {}),
      // Zero-click enrollment (Task-1410 PR2): a devbox's Google token for
      // Coder's client, admitted by the page's own allow rule, approves its
      // request; the users it finds or creates are the page issuer's. One
      // verifier, so one bound on proofs in flight, per edge process.
      ...(ui?.coder?.automaticApproval
        ? {
            devboxApproval: devboxApproval({
              issuer: ui.oidc.issuer,
              googleClientId: ui.coder.googleClientId,
              admit: (claims) => admittedEmail(ui.allow, claims),
              endpoints: extras.devboxEndpoints,
            }),
          }
        : {}),
    },
    ...(vault
      ? { vault }
      : extras.loginDrivers
        ? { loginDrivers: extras.loginDrivers }
        : {}),
    ...(oauthClients.integrationClients
      ? { integrationClients: oauthClients.integrationClients }
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
          integrations: webIntegrations(edge.userOperations),
          clients: webClients(edge.userOperations),
          requests: webRequests(gateway.requests),
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
