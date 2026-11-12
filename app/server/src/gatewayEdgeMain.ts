/**
 * The packaged edge (Task-1401), `gateway-edge.js` in the Bun package: the
 * credential gateway's edge with its vault in its own process, as the IDB
 * edge VM runs it.
 *
 *   gateway-edge --state-dir <dir> [--port <n>] [--model-port <n>]
 *     [--client-port <n>] [--enroll-port <n>] [--bind-host <address>]
 *     [--host <name>]... --vault-host <address> [--vault-port <n>]
 *     [--ui-config <file>]
 *
 * The flags mean what they mean for `gatewayDevMain.ts`, except that
 * `--vault-host` is required: the vault (`vault.js`, port 8794 unless
 * `--vault-port`) is reached over the pinned link that `gateway-admin.js
 * vault-pair` set up in the state directory, and this edge runs no login and
 * holds no token file. It runs the client listener, the edge's tools and
 * `/mcp`, and with `--ui-config` the gateway's sign-in and page; the UI's
 * built files default to `gateway-web/` beside this bundle
 * (`gatewayWeb/config.ts`). The composition is `gatewayEdge.ts`.
 *
 * It reads no `DATA_DIR`. A usage error, an unpaired state directory or a bad
 * UI config exits 2; any other start failure exits 1. SIGTERM and SIGINT
 * close it without a drain and exit 0, or 1 if closing failed. See
 * `docs/workers.md` "Client mode" and `docs/deployment.md#bun-package`.
 */
import { EdgeStartRefusal, parseEdgeArgs, startEdge } from "./gatewayEdge.ts";

const log = (line: string): void => console.log(`[gateway-edge] ${line}`);

const options = parseEdgeArgs(process.argv.slice(2), { requireVault: true });
if (!options) {
  console.error(
    "usage: gateway-edge --state-dir <dir> [--port <n>] [--model-port <n>] [--client-port <n>] [--enroll-port <n>] [--bind-host <address>] [--host <name>]... --vault-host <address> [--vault-port <n>] [--ui-config <file>]",
  );
  process.exit(2);
}

let edge;
try {
  edge = await startEdge(options, { log });
} catch (err) {
  if (err instanceof EdgeStartRefusal) {
    console.error(`[gateway-edge] ${err.message}`);
    process.exit(2);
  }
  console.error(
    `[gateway-edge] did not start: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  edge.close().then(
    () => process.exit(0),
    () => {
      console.error("[gateway-edge] close failed");
      process.exit(1);
    },
  );
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
