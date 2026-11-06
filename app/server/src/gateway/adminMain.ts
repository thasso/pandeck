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
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClientRegistry } from "./clientRegistry.ts";

function usage(): never {
  console.error(
    "usage: gateway-admin --state-dir <dir> (user add <id> [--label <text>] | enroll-code --user <id> --label <text> | clients list | clients revoke <id> | ca)",
  );
  process.exit(2);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "state-dir": { type: "string" },
    user: { type: "string" },
    label: { type: "string" },
  },
});
const stateDir = values["state-dir"];
if (!stateDir) usage();
const registry = new ClientRegistry(stateDir);
const [command, sub, arg] = positionals;

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
