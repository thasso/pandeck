/**
 * A standalone gateway for local live tests of client mode and gateway
 * logins (Task-1385), until the gateway's own entry and unit land
 * (Task-1383, which replaces this file). It runs `startGateway` with the
 * edge's client listener and both login drivers, in its own state
 * directory, on 127.0.0.1 only:
 *
 *   gateway-dev --state-dir <dir> [--port <n>] [--model-port <n>]
 *     [--client-port <n>] [--enroll-port <n>]
 *
 * Every port defaults to a free one; the ports in use are printed. It reads
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
import {
  codexLoginDriver,
  renewCodexCredential,
} from "./harnesses/gatewayPorts.ts";

function usage(): never {
  console.error(
    "usage: gateway-dev --state-dir <dir> [--port <n>] [--model-port <n>] [--client-port <n>] [--enroll-port <n>]",
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

const gateway = await startGateway({
  stateDir,
  port: port(values.port),
  renewCodex: renewCodexCredential,
  clients: {
    modelPort: port(values["model-port"]),
    clientPort: port(values["client-port"]),
    enrollPort: port(values["enroll-port"]),
  },
  loginDrivers: { claude: claudeLoginDriver, "openai-codex": codexLoginDriver },
});
const edge = gateway.clients!;
console.log(
  `[gateway-dev] state ${stateDir}; loopback ${gateway.port}, model ${edge.modelPort}, client ${edge.clientPort}, enroll ${edge.enrollPort}`,
);

const stop = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
