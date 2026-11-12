/**
 * A standalone gateway for local live tests of client mode and gateway
 * logins (Task-1385), and the IDB pilot's gateway until the packaged entry
 * can run logins (Task-1387). It runs `startGateway` with the edge's client
 * listener and both login drivers, in its own state directory:
 *
 *   gateway-dev --state-dir <dir> [--port <n>] [--model-port <n>]
 *     [--client-port <n>] [--enroll-port <n>] [--bind-host <address>]
 *     [--host <name>]... [--vault-host <address> [--vault-port <n>]]
 *
 * With `--vault-host`, the vault runs in its own process (`gateway/vaultMain.ts`,
 * port 8794 unless `--vault-port`), reached over the pinned link that
 * `gateway/adminMain.ts vault-pair` set up in the state directory; this edge
 * then holds no token file and runs no login itself.
 *
 * It is the only entry that loads the edge's tools (`gatewayTools/`): `/mcp`
 * on the model port and the integration methods (Task-1397).
 *
 * Every port defaults to a free one; the ports in use are printed. The edge's
 * three ports bind to `--bind-host`, 127.0.0.1 unless given, and each `--host`
 * is a name or IP in the edge's certificate, which relays connect by; the
 * loopback listener stays on 127.0.0.1. It reads
 * no `DATA_DIR`: the drivers and pi's Codex refresh load no server state.
 * Admin (users, enrollment codes, the CA) is `gateway/adminMain.ts` on the
 * same state directory; the relay is `relay/main.ts`. See `docs/workers.md`
 * "Client mode".
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { claudeLoginDriver } from "./claudeLoginDriver.ts";
import { startGateway } from "./gateway/gateway.ts";
import { readEdgeVaultLink } from "./gateway/vaultMethods.ts";
import { createEdgeTools } from "./gatewayTools/index.ts";
import {
  codexLoginDriver,
  renewCodexCredential,
} from "./harnesses/gatewayPorts.ts";

function usage(): never {
  console.error(
    "usage: gateway-dev --state-dir <dir> [--port <n>] [--model-port <n>] [--client-port <n>] [--enroll-port <n>] [--bind-host <address>] [--host <name>]... [--vault-host <address> [--vault-port <n>]]",
  );
  process.exit(2);
}

const { values } = parseArgs({
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
  },
});
if (!values["state-dir"]) usage();
const port = (value: string | undefined): number => {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) usage();
  return n;
};
const stateDir = resolve(values["state-dir"]);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

/** The remote vault's address and pinned link TLS, when `--vault-host`. */
function remoteVault() {
  const host = values["vault-host"];
  if (!host) return undefined;
  const tls = readEdgeVaultLink(stateDir);
  if (typeof tls === "string") {
    console.error(`[gateway-dev] not paired: ${tls}`);
    process.exit(2);
  }
  return { host, port: port(values["vault-port"] ?? "8794"), tls };
}
const vault = remoteVault();

const gateway = await startGateway({
  stateDir,
  port: port(values.port),
  renewCodex: renewCodexCredential,
  // The edge's tools and MCP endpoint run here only (Task-1397).
  tools: createEdgeTools(),
  clients: {
    modelPort: port(values["model-port"]),
    clientPort: port(values["client-port"]),
    enrollPort: port(values["enroll-port"]),
    ...(values["bind-host"] ? { bindHost: values["bind-host"] } : {}),
    ...(values.host ? { hosts: values.host } : {}),
  },
  ...(vault
    ? { vault }
    : {
        loginDrivers: {
          claude: claudeLoginDriver,
          "openai-codex": codexLoginDriver,
        },
      }),
});
const edge = gateway.clients!;
console.log(
  `[gateway-dev] state ${stateDir}; loopback ${gateway.port}, model ${edge.modelPort}, client ${edge.clientPort}, enroll ${edge.enrollPort}${vault ? `; vault ${vault.host}:${vault.port}` : ""}`,
);

const stop = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
