/**
 * Client mode's integration credentials (Task-1397): Settings → Jira sends
 * the Atlassian email and API token to the gateway (`integrations.*` on
 * gateway client 1.0, through `gatewayClientLink.ts`), which checks it and
 * has its vault keep it. A gateway that signs in with Atlassian (Task-1411,
 * `connectWith: "oauth"`) takes no token: the user connects on its page, and
 * Settings only enables, tests and removes. This server keeps no token: only
 * the last status the gateway told, the site, email, which kind is stored and
 * how the gateway makes a new connection.
 */

/** `integrations.set` and `integrations.status` answers, as the link decodes them. */
export interface IntegrationStatus {
  connected: boolean;
  /** How the stored credential was made. */
  kind?: "token" | "oauth";
  /** How the gateway makes a new connection; absent means an API token. */
  connectWith?: "token" | "oauth";
  site?: string;
  email?: string;
  displayName?: string;
  accountId?: string;
  problem?:
    | "vault_locked"
    | "vault_unavailable"
    | "invalid"
    | "rejected"
    | "unreachable"
    | "failed";
}

/** Why the gateway refused, as this server says it; never the gateway's text. */
const REFUSALS = {
  integration_invalid: "the site, email or API token is not valid.",
  integration_rejected: "Atlassian rejected the email and API token.",
  integration_unreachable:
    "Atlassian could not check the credential; try again.",
  vault_locked: "the gateway's vault is locked.",
  vault_unavailable:
    "the gateway's vault did not answer; check the Jira status.",
  tools_unavailable: "the credential gateway runs no integrations.",
  integration_busy:
    "another change to this credential is still running; try again.",
  integration_sign_in_required:
    "the gateway connects Jira only with Sign in with Atlassian on its page.",
  gateway_unavailable:
    "the credential gateway is unreachable; try again shortly.",
} as const;
export type IntegrationRefusalCode = keyof typeof REFUSALS;

export function isIntegrationRefusalCode(
  code: string,
): code is IntegrationRefusalCode {
  return Object.hasOwn(REFUSALS, code);
}

/** A refused integration call, by code; its text is fixed here. */
export class IntegrationRefusal extends Error {
  constructor(readonly code: IntegrationRefusalCode) {
    super(REFUSALS[code]);
  }
}

/** The gateway's integration API, as the client link offers it. */
export interface RemoteIntegrationPort {
  set(input: {
    site: string;
    email: string;
    token: string;
  }): Promise<IntegrationStatus>;
  clear(): Promise<void>;
  status(check: boolean): Promise<IntegrationStatus>;
}

/** What Settings shows of the gateway's Atlassian credential. */
export interface AtlassianStatus {
  /** A credential is stored on the gateway. */
  stored: boolean;
  /** How the stored credential was made. */
  kind?: "token" | "oauth";
  /** How the gateway makes a new connection, as it last said. */
  connectWith?: "token" | "oauth";
  site?: string;
  email?: string;
}

let port: RemoteIntegrationPort | undefined;
let last: AtlassianStatus = { stored: false };

/** Installs the client link's port; answers its uninstall. */
export function installRemoteIntegrationPort(
  next: RemoteIntegrationPort,
): () => void {
  port = next;
  last = { stored: false };
  return () => {
    if (port !== next) return;
    port = undefined;
    last = { stored: false };
  };
}

/** The installed port, in client mode only. */
export function remoteIntegrationPort(): RemoteIntegrationPort | undefined {
  return port;
}

export function lastAtlassianStatus(): AtlassianStatus {
  return { ...last };
}

/**
 * Records what the gateway answered. A credential is stored when the answer
 * names a site or a kind: a refused OAuth record names no site.
 */
export function rememberAtlassianStatus(status: IntegrationStatus): void {
  last = {
    stored: status.site !== undefined || status.kind !== undefined,
    ...(status.kind !== undefined ? { kind: status.kind } : {}),
    ...(status.connectWith !== undefined
      ? { connectWith: status.connectWith }
      : {}),
    ...(status.site !== undefined ? { site: status.site } : {}),
    ...(status.email !== undefined ? { email: status.email } : {}),
  };
}

/**
 * After a clear: nothing is stored, and the gateway still makes a new
 * connection as it last said until a later answer says otherwise.
 */
export function forgetAtlassianStatus(): void {
  last = {
    stored: false,
    ...(last.connectWith !== undefined
      ? { connectWith: last.connectWith }
      : {}),
  };
}
