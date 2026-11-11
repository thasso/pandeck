/**
 * The gateway's admin command line, its own entry (plan Task-1384 §1). It
 * edits `clients.json` in the gateway's state directory; a running edge reads
 * the change at its next check.
 *
 * - `user add <id> [--label <text>]`
 * - `enroll-code --user <id> --label <text>`: prints a one-time code, valid
 *   15 minutes
 * - `clients list`, `clients revoke <id>`
 * - `ca`: prints the gateway's CA, which a relay's enrollment trusts
 *
 * Pairing a vault in its own process (`gateway-vault/1.0`, plan Task-1394).
 * Certificates are public and the operator copies them across; keys never
 * leave their machine:
 *
 * - on the vault, `vault-init [--host <name>]... [--edge-cert <file>]`: makes
 *   the vault's key and self-signed certificate once (naming every `--host`),
 *   pins the edge's certificate when given, and prints the vault's;
 * - on the edge, `vault-pair --vault-cert <file>`: makes the edge's link key
 *   and certificate once, pins the vault's, and prints the edge's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClientRegistry } from "./clientRegistry.ts";
import {
  edgeVaultLinkFile,
  vaultTlsFile,
  type EdgeVaultLinkFile,
  type VaultTlsFile,
} from "./vaultMethods.ts";
import { selfSignedIdentity } from "./x509.ts";

function usage(): never {
  console.error(
    "usage: gateway-admin --state-dir <dir> (user add <id> [--label <text>] | enroll-code --user <id> --label <text> | clients list | clients revoke <id> | ca | vault-init [--host <name>]... [--edge-cert <file>] | vault-pair --vault-cert <file>)",
  );
  process.exit(2);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "state-dir": { type: "string" },
    user: { type: "string" },
    label: { type: "string" },
    host: { type: "string", multiple: true },
    "edge-cert": { type: "string" },
    "vault-cert": { type: "string" },
  },
});
const stateDir = values["state-dir"];
if (!stateDir) usage();
const [command, sub, arg] = positionals;

/** A PEM certificate read from `file`, or the usage. */
function certificateAt(file: string | undefined): string {
  if (!file) usage();
  const pem = readFileSync(file, "utf8");
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) usage();
  return pem;
}

if (command === "vault-init") {
  const file = vaultTlsFile(stateDir);
  let tls = file.read<VaultTlsFile, VaultTlsFile | undefined>((v) => v);
  if (!tls) {
    const hosts = values.host ?? ["localhost", "127.0.0.1"];
    tls = {
      v: 1,
      ...selfSignedIdentity("pandeck-gateway-vault", "server", hosts),
      hosts,
    };
  }
  if (values["edge-cert"])
    tls = { ...tls, edgeCertPem: certificateAt(values["edge-cert"]) };
  file.write(tls);
  process.stdout.write(tls.certPem);
  process.exit(0);
}
if (command === "vault-pair") {
  const vaultCertPem = certificateAt(values["vault-cert"]);
  const file = edgeVaultLinkFile(stateDir);
  const existing = file.read<EdgeVaultLinkFile, EdgeVaultLinkFile | undefined>(
    (v) => v,
  );
  const link: EdgeVaultLinkFile = {
    v: 1,
    ...(existing
      ? { keyPem: existing.keyPem, certPem: existing.certPem }
      : selfSignedIdentity("pandeck-gateway-edge", "client")),
    vaultCertPem,
  };
  file.write(link);
  process.stdout.write(link.certPem);
  process.exit(0);
}

const registry = new ClientRegistry(stateDir);
if (command === "user" && sub === "add" && arg) {
  registry.addUser(arg, values.label ?? arg);
  console.log(`user ${arg} added`);
} else if (command === "enroll-code") {
  if (!values.user || !values.label) usage();
  console.log(registry.createCode(values.user, values.label));
} else if (command === "clients" && sub === "list") {
  for (const client of registry.clients())
    console.log(
      `${client.id}\tuser=${client.userId}\t${client.revokedAt !== undefined ? "revoked" : "active"}\t${client.label}`,
    );
} else if (command === "clients" && sub === "revoke" && arg) {
  console.log(registry.revoke(arg) ? `client ${arg} revoked` : "no change");
} else if (command === "ca") {
  const state = JSON.parse(
    readFileSync(join(stateDir, "edge-tls.json"), "utf8"),
  ) as { caCertPem: string };
  process.stdout.write(state.caCertPem);
} else usage();
