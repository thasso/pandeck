/**
 * A standalone gateway for local live tests of client mode and gateway
 * logins (Task-1385), and the IDB pilot's gateway until the packaged entry
 * can run logins (Task-1387). It runs `startGateway` with the edge's client
 * listener and both login drivers, in its own state directory:
 *
 *   gateway-dev --state-dir <dir> [--port <n>] [--model-port <n>]
 *     [--client-port <n>] [--enroll-port <n>] [--bind-host <address>]
 *     [--host <name>]... [--vault-host <address> [--vault-port <n>]]
 *     [--ui-config <file>]
 *
 * With `--vault-host`, the vault runs in its own process (`gateway/vaultMain.ts`,
 * port 8794 unless `--vault-port`), reached over the pinned link that
 * `gateway/adminMain.ts vault-pair` set up in the state directory; this edge
 * then holds no token file and runs no login itself.
 *
 * Like the packaged entry, it loads the edge's tools (`gatewayTools/`): `/mcp`
 * on the model port and the integration methods (Task-1397), and the
 * gateway's own sign-in and page (`gatewayWeb/`, Task-1402): with
 * `--ui-config`, an HTTPS port for browsers on `--bind-host`, configured by
 * that 0600 file.
 *
 * Every port defaults to a free one; the ports in use are printed. The edge's
 * three ports bind to `--bind-host`, 127.0.0.1 unless given, and each `--host`
 * is a name or IP in the edge's certificate, which relays connect by; the
 * loopback listener stays on 127.0.0.1. It reads
 * no `DATA_DIR`: the drivers and pi's Codex refresh load no server state.
 * Admin (users, enrollment codes, the CA) is `gateway/adminMain.ts` on the
 * same state directory; the relay is `relay/main.ts`. See `docs/workers.md`
 * "Client mode". The composition is `gatewayEdge.ts`, shared with the
 * packaged entry (`gatewayEdgeMain.ts`), which has no in-process vault.
 */
import { claudeLoginDriver } from "./claudeLoginDriver.ts";
import { EdgeStartRefusal, parseEdgeArgs, startEdge } from "./gatewayEdge.ts";
import {
  codexLoginDriver,
  renewCodexCredential,
} from "./harnesses/gatewayPorts.ts";

const options = parseEdgeArgs(process.argv.slice(2), { requireVault: false });
if (!options) {
  console.error(
    "usage: gateway-dev --state-dir <dir> [--port <n>] [--model-port <n>] [--client-port <n>] [--enroll-port <n>] [--bind-host <address>] [--host <name>]... [--vault-host <address> [--vault-port <n>]] [--ui-config <file>]",
  );
  process.exit(2);
}

let edge;
try {
  edge = await startEdge(options, {
    log: (line) => console.log(`[gateway-dev] ${line}`),
    renewCodex: renewCodexCredential,
    loginDrivers: {
      claude: claudeLoginDriver,
      "openai-codex": codexLoginDriver,
    },
  });
} catch (err) {
  if (!(err instanceof EdgeStartRefusal)) throw err;
  console.error(`[gateway-dev] ${err.message}`);
  process.exit(2);
}

const stop = (): void => {
  void edge.close().then(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
