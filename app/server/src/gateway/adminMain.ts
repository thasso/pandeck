/**
 * The gateway's admin command line, its own entry (plan Task-1384 §1). It
 * edits `clients.json` in the gateway's state directory; a running edge reads
 * the change at its next check.
 *
 * - `user add <id> [--label <text>]`
 * - `enroll-code --user <id> --label <text>`: prints a one-time code, valid
 *   15 minutes
 * - `clients list`, `clients revoke <id>`
 * - `clients mcp-token <id>`: mints the client's MCP token (Task-1397),
 *   printed once and kept only as its hash, replacing an earlier one;
 *   `clients mcp-token-revoke <id>` removes it
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
 *
 * The vault's sealed store (plan Task-1395, `sealedStore.ts`), on the vault:
 *
 * - `vault-recipient add --from-piv <slot>` reads the public key from the
 *   YubiKey (no PIN); `--pem <file> --slot <slot>` adds another YubiKey's
 *   exported key, `--pem <file> --private-key <file>` a software key.
 *   `vault-recipient list`, `vault-recipient remove <kid>` (never the last).
 * - `vault-seal-existing`, with the vault stopped: seals today's plaintext
 *   token files and overwrites and removes them.
 * - `vault-reseal` and `unlock` ask the running vault over its control socket
 *   (`--control-socket`, `/run/pandeck-vault/control.sock` unless given).
 *   `unlock` reads the PIN from the terminal with echo off, never from argv
 *   or the environment.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClientRegistry, clientListLine } from "./clientRegistry.ts";
import {
  pivPublicKeyPem,
  readRecipients,
  recipientOf,
  sealExisting,
  writeRecipients,
} from "./sealedStore.ts";
import { askVaultControl } from "./vaultControl.ts";
import {
  edgeVaultLinkFile,
  vaultTlsFile,
  type EdgeVaultLinkFile,
  type VaultTlsFile,
} from "./vaultMethods.ts";
import { selfSignedIdentity } from "./x509.ts";

function usage(): never {
  console.error(
    "usage: gateway-admin --state-dir <dir> (user add <id> [--label <text>] | enroll-code --user <id> --label <text> | clients list | clients revoke <id> | clients mcp-token <id> | clients mcp-token-revoke <id> | ca | vault-init [--host <name>]... [--edge-cert <file>] | vault-pair --vault-cert <file> | vault-recipient (add (--from-piv <slot> | --pem <file> (--slot <slot> | --private-key <file>)) | list | remove <kid>) | vault-seal-existing | vault-reseal | unlock) [--control-socket <path>]",
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
    "from-piv": { type: "string" },
    pem: { type: "string" },
    "private-key": { type: "string" },
    slot: { type: "string" },
    "control-socket": { type: "string" },
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

const controlSocket =
  values["control-socket"] ?? "/run/pandeck-vault/control.sock";

/**
 * The PIN from the terminal with echo off; one line from a pipe otherwise.
 * Never echoed, never in argv or the environment.
 */
function readPin(): Promise<string> {
  const input = process.stdin;
  process.stderr.write("YubiKey PIN: ");
  return new Promise((resolvePin) => {
    let pin = "";
    const finish = (): void => {
      input.removeListener("data", onData);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      resolvePin(pin);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") {
          if (input.isTTY) input.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") pin = pin.slice(0, -1);
        else if (pin.length < 64) pin += ch;
      }
    };
    if (input.isTTY) input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.on("end", finish);
    input.resume();
  });
}

/** Whether a vault answers on the control socket. */
async function vaultRunning(): Promise<boolean> {
  try {
    await askVaultControl(controlSocket, { method: "status" });
    return true;
  } catch {
    return false;
  }
}

if (command === "vault-recipient") {
  const recipients = readRecipients(stateDir);
  if (sub === "add") {
    const slot = values["from-piv"];
    const recipient = slot
      ? recipientOf(await pivPublicKeyPem(slot), { slot })
      : values.pem
        ? recipientOf(
            readFileSync(values.pem, "utf8"),
            values["private-key"]
              ? { privateKeyFile: values["private-key"] }
              : values.slot
                ? { slot: values.slot }
                : usage(),
          )
        : usage();
    if (recipients.some((r) => r.kid === recipient.kid)) {
      console.log(`recipient ${recipient.kid} already present`);
    } else {
      writeRecipients(stateDir, [...recipients, recipient]);
      console.log(`recipient ${recipient.kid} (${recipient.kind}) added`);
    }
  } else if (sub === "list") {
    for (const r of recipients)
      console.log(
        `${r.kid}\t${r.kind}\t${r.kind === "piv" ? `slot ${r.slot}` : r.privateKeyFile}`,
      );
  } else if (sub === "remove" && arg) {
    const kept = recipients.filter((r) => r.kid !== arg);
    if (kept.length === recipients.length) console.log("no change");
    else if (kept.length === 0) {
      console.error("refused: the vault keeps at least one recipient");
      process.exit(1);
    } else {
      writeRecipients(stateDir, kept);
      console.log(`recipient ${arg} removed; run vault-reseal`);
    }
  } else usage();
  process.exit(0);
}
if (command === "vault-seal-existing") {
  if (await vaultRunning()) {
    console.error("refused: stop the vault first");
    process.exit(1);
  }
  try {
    const { sealed } = await sealExisting(stateDir);
    console.log(`${sealed} token files sealed; the plaintext is removed`);
  } catch (err) {
    // Fixed texts from `sealExisting`, naming ID-checked directories only.
    console.error(
      `vault-seal-existing failed: ${err instanceof Error ? err.message : "unknown error"}`,
    );
    process.exit(1);
  }
  process.exit(0);
}
if (command === "vault-reseal" || command === "unlock") {
  const request =
    command === "unlock"
      ? { method: "unlock", pin: await readPin() }
      : { method: "reseal" };
  const answer = await askVaultControl(controlSocket, request);
  if (answer.ok === true) {
    console.log(
      command === "unlock"
        ? `unlocked: ${String(answer.opened)} records opened, ${String(answer.unopened)} did not (those accounts need a login)`
        : `resealed ${String(answer.resealed)} records`,
    );
    process.exit(0);
  }
  console.error(
    answer.wrong_pin === true
      ? `wrong PIN; ${String(answer.triesLeft)} tries left`
      : answer.blocked === true
        ? "the PIN is blocked: unblock it with the PUK"
        : `refused (${typeof answer.failed === "string" ? answer.failed : "failed"})`,
  );
  process.exit(1);
}

const registry = new ClientRegistry(stateDir);
if (command === "user" && sub === "add" && arg) {
  registry.addUser(arg, values.label ?? arg);
  console.log(`user ${arg} added`);
} else if (command === "enroll-code") {
  if (!values.user || !values.label) usage();
  console.log(registry.createCode(values.user, values.label));
} else if (command === "clients" && sub === "list") {
  for (const client of registry.clients()) console.log(clientListLine(client));
} else if (command === "clients" && sub === "revoke" && arg) {
  console.log(registry.revoke(arg) ? `client ${arg} revoked` : "no change");
} else if (command === "clients" && sub === "mcp-token" && arg) {
  // Shown once, on stdout only; the registry keeps its hash.
  process.stdout.write(`${registry.setMcpToken(arg)}\n`);
} else if (command === "clients" && sub === "mcp-token-revoke" && arg) {
  console.log(
    registry.clearMcpToken(arg)
      ? `client ${arg} MCP token revoked`
      : "no change",
  );
} else if (command === "ca") {
  const state = JSON.parse(
    readFileSync(join(stateDir, "edge-tls.json"), "utf8"),
  ) as { caCertPem: string };
  process.stdout.write(state.caCertPem);
} else usage();
