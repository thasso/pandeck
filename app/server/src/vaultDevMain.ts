/**
 * The vault as its own process (plan Task-1394), for the vault VM until the
 * packaged entry (Task-1387): `startVaultServer` with both login drivers and
 * pi's Codex refresh, serving one edge over `gateway-vault/1.0`:
 *
 *   vault-dev --state-dir <dir> [--bind-host <address>] [--port <n>]
 *     [--control-socket <path>]
 *
 * It listens on `--bind-host` (127.0.0.1 unless given) and `--port` (8794
 * unless given). The state directory holds the token files under
 * `accounts/`, the mirrored inputs and `vault-tls.json`, which
 * `gateway/adminMain.ts vault-init` makes and pairs first. It reads no
 * `DATA_DIR`. The edge is `gatewayDevMain.ts --vault-host`. See
 * `docs/workers.md` "Credentials".
 *
 * With recipients (`gateway-admin vault-recipient add`) it seals: `accounts/`
 * must be a tmpfs, it starts locked, and `gateway-admin unlock` unlocks it
 * over `--control-socket` (`/run/pandeck-vault/control.sock` unless given).
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { claudeLoginDriver } from "./claudeLoginDriver.ts";
import { readVaultTls } from "./gateway/vaultMethods.ts";
import { startVaultServer } from "./gateway/vaultServer.ts";
import {
  codexLoginDriver,
  renewCodexCredential,
} from "./harnesses/gatewayPorts.ts";

function usage(): never {
  console.error(
    "usage: vault-dev --state-dir <dir> [--bind-host <address>] [--port <n>] [--control-socket <path>]",
  );
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "bind-host": { type: "string" },
    port: { type: "string" },
    "control-socket": { type: "string" },
  },
});
if (!values["state-dir"]) usage();
const port = Number(values.port ?? 8794);
if (!Number.isInteger(port) || port < 0 || port > 65_535) usage();
const stateDir = resolve(values["state-dir"]);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const tls = readVaultTls(stateDir);
if (typeof tls === "string") {
  console.error(`[vault-dev] not paired: ${tls}`);
  process.exit(2);
}

const vault = await startVaultServer({
  stateDir,
  host: values["bind-host"] ?? "127.0.0.1",
  port,
  tls,
  renewCodex: renewCodexCredential,
  loginDrivers: { claude: claudeLoginDriver, "openai-codex": codexLoginDriver },
  controlSocket: values["control-socket"] ?? "/run/pandeck-vault/control.sock",
  requireTmpfs: true,
});
console.log(`[vault-dev] state ${stateDir}; port ${vault.port}`);

const stop = (): void => {
  void vault.close().then(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
