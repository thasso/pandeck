/**
 * The vault as its own process (Task-1394, Task-1387), `vault.js` in the Bun
 * package: `startVaultServer` serving one edge over `gateway-vault/1.0`:
 *
 *   vault --state-dir <dir> [--bind-host <address>] [--port <n>]
 *     [--control-socket <path>]
 *
 * It listens on `--bind-host` (127.0.0.1 unless given) and `--port` (8794
 * unless given). The state directory holds the token files under
 * `accounts/`, the mirrored inputs and `vault-tls.json`, which
 * `gateway-admin vault-init` makes and pairs first. It reads no `DATA_DIR`.
 * See `docs/workers.md` "Remote vault".
 *
 * Its pi and the Claude CLI run only in children, one per renewal or login,
 * beside this entry (`childEntries.ts`): `codex-renew` behind
 * `codexChild.ts`, `claude-login` and `codex-login` behind `loginChild.ts`.
 *
 * With recipients (`gateway-admin vault-recipient add`) it seals: `accounts/`
 * must be a tmpfs, it starts locked, and `gateway-admin unlock` unlocks it
 * over `--control-socket` (`/run/pandeck-vault/control.sock` unless given).
 * SIGTERM or SIGINT stops it once every login and renewal it started has
 * ended and been sealed; then it exits 0.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { childEntry } from "./childEntries.ts";
import { codexChildPort } from "./codexChild.ts";
import { loginChildDriver } from "./loginChild.ts";
import { readVaultTls } from "./vaultMethods.ts";
import { startVaultServer } from "./vaultServer.ts";

const log = (line: string): void => console.log(`[vault] ${line}`);

function usage(): never {
  console.error(
    "usage: vault --state-dir <dir> [--bind-host <address>] [--port <n>] [--control-socket <path>]",
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
  console.error(`[vault] not paired: ${tls}`);
  process.exit(2);
}

let vault: Awaited<ReturnType<typeof startVaultServer>>;
try {
  vault = await startVaultServer({
    stateDir,
    host: values["bind-host"] ?? "127.0.0.1",
    port,
    tls,
    renewCodex: codexChildPort(childEntry("codex-renew")),
    loginDrivers: {
      claude: loginChildDriver(childEntry("claude-login"), { log }),
      "openai-codex": loginChildDriver(childEntry("codex-login"), { log }),
    },
    controlSocket:
      values["control-socket"] ?? "/run/pandeck-vault/control.sock",
    requireTmpfs: true,
    log,
  });
} catch (err) {
  console.error(
    `[vault] did not start: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
log(`state ${stateDir}; port ${vault.port}`);

let stopping = false;
const stop = (signal: string): void => {
  // A second signal starts no second stop and does not cut the first short.
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping once logins and renewals have ended`);
  void vault.close().then(
    () => process.exit(0),
    (err: unknown) => {
      // Fixed text and account ids only (`vaultServer.ts`).
      console.error(
        `[vault] stop failed, ${err instanceof Error ? err.message : "unknown"}: their last renewal or login may be lost`,
      );
      process.exit(1);
    },
  );
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
