/**
 * The standalone gateway's entry (`process.ts`), `gateway.js` in the Bun
 * package. It reads only its environment:
 *
 * - `DATA_DIR` (required): state in `DATA_DIR/gateway/`;
 * - `ASSISTANT_GATEWAY_PORT`: the loopback model port, 8788;
 * - `ASSISTANT_GATEWAY_SOCKET`: the control socket,
 *   `DATA_DIR/gateway/control.sock`;
 * - `ASSISTANT_GATEWAY_CLIENTS` (optional): the client listener's options as
 *   JSON (`clientListener.ts`). Without it there is no client listener, the
 *   self-hosted default.
 *
 * Codex renews through one child per renewal (`codexChild.ts`): the renewal
 * entry beside this one, run by the same runtime.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientListenerOptions } from "./clientListener.ts";
import { codexChildPort } from "./codexChild.ts";
import { runGatewayProcess, stopOnSignals } from "./process.ts";

const log = (line: string): void => console.log(`[gateway] ${line}`);

function fail(message: string): never {
  console.error(`[gateway] ${message}`);
  process.exit(2);
}

const dataDir = process.env.DATA_DIR?.trim();
if (!dataDir) fail("DATA_DIR is required.");
const stateDir = join(dataDir, "gateway");
const port = Number(process.env.ASSISTANT_GATEWAY_PORT ?? 8788);
if (!Number.isInteger(port) || port < 0 || port > 65_535)
  fail("ASSISTANT_GATEWAY_PORT is not a port.");
const socketPath =
  process.env.ASSISTANT_GATEWAY_SOCKET?.trim() ||
  join(stateDir, "control.sock");

function clientOptions(): ClientListenerOptions | undefined {
  const value = process.env.ASSISTANT_GATEWAY_CLIENTS;
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("ASSISTANT_GATEWAY_CLIENTS is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    fail("ASSISTANT_GATEWAY_CLIENTS is not a JSON object.");
  return parsed as ClientListenerOptions;
}

/** The renewal entry beside this one: source under tsx, else the bundle. */
const renewEntry = fileURLToPath(
  import.meta.url.endsWith(".ts")
    ? new URL("../codexRenewMain.ts", import.meta.url)
    : new URL("./codex-renew.js", import.meta.url),
);

const clients = clientOptions();
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
try {
  const running = await runGatewayProcess({
    stateDir,
    port,
    socketPath,
    log,
    renewCodex: codexChildPort({
      file: process.execPath,
      args: [...process.execArgv, renewEntry],
    }),
    ...(clients ? { clients } : {}),
  });
  stopOnSignals(running, log);
  log(`control on ${socketPath}`);
} catch (err) {
  console.error(
    `[gateway] did not start: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
