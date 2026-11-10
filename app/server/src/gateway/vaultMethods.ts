/**
 * `gateway-vault/1.0` (plan Task-1394, ADR-0005): what the edge and a vault
 * running as its own process send each other over the worker protocol's
 * framing, on mutual TLS where each side trusts exactly the other's
 * self-signed certificate. The edge dials (`remoteVault.ts`); the vault
 * serves one edge connection at a time, a newer one replacing the older
 * (`vaultServer.ts`). Every JSON body is in `payload.json`.
 *
 * Edge to vault:
 *
 * - `vault.hello {}` answers `{needsLogin, accountsDir, loginKinds}`.
 * - `inputs.profiles {profiles}`: the edge's whole registry, on connect and
 *   on every change; `inputs.liveLeases {profileIds}` likewise. Both `{}`.
 * - `credential.for {binding}` answers `{credential}`, a `VaultCredential`:
 *   an access token and headers, a refusal, or locked. Never a refresh token.
 * - `credential.upstream401 {binding, sentToken}` answers `{}`.
 * - `accounts.discard {accountId}` answers `{}`.
 * - `logins.start {loginId, kind, accountId, tokenFile}` answers `{}`;
 *   `logins.input {loginId, text}` and `logins.cancel {loginId}` answer
 *   `{}`. A cancel also withdraws the run: its credential is never moved in.
 *
 * Vault to edge, each answered `{}`: `credential.report {profileId,
 * needsLogin}`, `logins.event {loginId, type, text}` (`output`, `url` or
 * `code`), `logins.done {loginId, ok, error?}`.
 *
 * The vault takes a binding or a token file only under `<stateDir>/accounts/`
 * (`accountTokenFile`), so an edge cannot point it at any other file.
 */
import { join } from "node:path";
import { createPrivateJsonFile } from "../privateJsonFile.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import type { ConnectionProtocol } from "../workerProtocol/connection.ts";
import type { LeaseProvider } from "./leases.ts";

export const GATEWAY_VAULT_VERSION = "gateway-vault/1.0";

const VAULT_VERSION_RE = /^gateway-vault\/(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export const GATEWAY_VAULT_PROTOCOL: ConnectionProtocol = {
  version: GATEWAY_VAULT_VERSION,
  compatible: (version) => VAULT_VERSION_RE.exec(version)?.[1] === "1",
};

export const VAULT_METHODS = {
  hello: "vault.hello",
  profiles: "inputs.profiles",
  liveLeases: "inputs.liveLeases",
  credentialFor: "credential.for",
  upstream401: "credential.upstream401",
  discard: "accounts.discard",
  loginStart: "logins.start",
  loginInput: "logins.input",
  loginCancel: "logins.cancel",
  /** Vault → edge. */
  report: "credential.report",
  loginEvent: "logins.event",
  loginDone: "logins.done",
} as const;

/** The vault takes no binding or token file outside its accounts. */
export const OUTSIDE_ACCOUNTS = "outside_accounts";
/** A request did not decode. */
export const VAULT_INVALID_PARAMS = "invalid_params";

/** The file a login leaves its credential in, in its account's directory. */
export const LOGIN_CREDENTIAL_FILE: Record<LeaseProvider, string> = {
  claude: ".credentials.json",
  "openai-codex": "auth.json",
};

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The token file of `accountId` for `kind` under `accountsDir`, or undefined
 * when the id is not one the vault keeps files for.
 */
export function accountTokenFile(
  accountsDir: string,
  kind: LeaseProvider,
  accountId: string,
): string | undefined {
  return ACCOUNT_ID_RE.test(accountId)
    ? join(accountsDir, accountId, LOGIN_CREDENTIAL_FILE[kind])
    : undefined;
}

export function vaultMessage(json: unknown): Payload {
  return { json };
}

/** The payload's JSON object, or an empty one. */
export function vaultBody(payload: Payload): Record<string, unknown> {
  const { json } = payload;
  return typeof json === "object" && json !== null && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {};
}

// --- pairing files --------------------------------------------------------

/** One side's key and certificate, and the peer certificate it pins. */
export interface VaultLinkTls {
  keyPem: string;
  certPem: string;
  peerCertPem: string;
}

/** The vault's side: `<stateDir>/vault-tls.json`, made by `vault-init`. */
export interface VaultTlsFile {
  v: 1;
  keyPem: string;
  certPem: string;
  hosts: string[];
  /** The edge's certificate, once paired. */
  edgeCertPem?: string;
}

/** The edge's side: `<stateDir>/vault-link.json`, made by `vault-pair`. */
export interface EdgeVaultLinkFile {
  v: 1;
  keyPem: string;
  certPem: string;
  vaultCertPem: string;
}

export function vaultTlsFile(stateDir: string) {
  return createPrivateJsonFile(join(stateDir, "vault-tls.json"), "vault TLS", {
    privateDirectory: "enforce",
  });
}

export function edgeVaultLinkFile(stateDir: string) {
  return createPrivateJsonFile(
    join(stateDir, "vault-link.json"),
    "edge vault link",
    { privateDirectory: "enforce" },
  );
}

/** The vault's link TLS, or a reason it is not paired yet. */
export function readVaultTls(stateDir: string): VaultLinkTls | string {
  const file = vaultTlsFile(stateDir).read<VaultTlsFile, VaultTlsFile | null>(
    (value) => value ?? null,
  );
  if (!file) return "no vault-tls.json: run gateway-admin vault-init";
  if (!file.edgeCertPem)
    return "no edge certificate: run gateway-admin vault-init --edge-cert <file>";
  return {
    keyPem: file.keyPem,
    certPem: file.certPem,
    peerCertPem: file.edgeCertPem,
  };
}

/** The edge's link TLS, or a reason it is not paired yet. */
export function readEdgeVaultLink(stateDir: string): VaultLinkTls | string {
  const file = edgeVaultLinkFile(stateDir).read<
    EdgeVaultLinkFile,
    EdgeVaultLinkFile | null
  >((value) => value ?? null);
  if (!file) return "no vault-link.json: run gateway-admin vault-pair";
  return {
    keyPem: file.keyPem,
    certPem: file.certPem,
    peerCertPem: file.vaultCertPem,
  };
}
